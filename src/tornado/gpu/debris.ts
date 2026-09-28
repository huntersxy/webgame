/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/debris.ts — 龙卷风碎屑（GPU 端模拟）
 *
 *  碎屑是龙卷风最直观的「力量感」来源：被卷起的尘土与杂物绕着涡管旋转上升。
 *  整条链路都在 GPU 上：
 *    · compute 着色器每帧推进粒子状态（角度、半径、高度），写在 storage buffer；
 *    · 顶点阶段直接读同一块 buffer 定位粒子，不走顶点缓冲、也不回 CPU。
 *
 *  为什么值得这么做：粒子数随龙卷风半径增长（最多 512 个），
 *  若每帧在 CPU 上算完再上传，就是一个持续增长的上传带宽开销；
 *  放进 compute 后 CPU 每帧只更新一个 48 字节的 uniform。
 * ──────────────────────────────────────────────────────────── */

import {
  compute as vgpuCompute,
  draw as vgpuDraw,
  geometry as vgpuGeometry,
  sampler as vgpuSampler,
  storage as vgpuStorage,
  type Compute,
  type Draw,
  type Gpu,
  type Geometry,
  type StorageBuffer,
} from 'vgpu';
import type { Buffer } from '@vgpu/core';

import { DEBRIS_DRAW_WGSL, DEBRIS_MAX, DEBRIS_SIM_WGSL, DEBRIS_STRIDE } from './mesh-shaders';

/** 模拟 uniform：center(4) + shape(4) + misc(4) = 12 个 float */
const SIM_FLOATS = 12;
/** 绘制 uniform：center(4) + view(4) + misc(4) = 12 个 float */
const DRAW_FLOATS = 12;

export interface DebrisFrame {
  /** 风眼世界位置 */
  x: number;
  y: number;
  /** 龙卷风世界半径（模拟用：决定碎屑云铺开的范围） */
  radius: number;
  /** 漏斗世界高度 */
  height: number;
  /** 单块碎屑在屏幕上的边长（设备像素） */
  size: number;
  /** 目标尺寸（设备像素）：把碎屑的屏幕偏移换算成裁剪空间 */
  viewW: number;
  viewH: number;
  /** 时间（秒） */
  time: number;
  /** 本帧时间步长（秒） */
  dt: number;
  /** 活跃粒子数 */
  count: number;
}

export interface DebrisLayer {
  /** 推进模拟（必须在绘制前调用；内部自带一次 compute dispatch） */
  update(f: DebrisFrame): void;
  /** 把碎屑画进场景目标 */
  drawColor(pass: { draw(d: Draw, o?: { instances?: number }): void }): void;
  dispose(): void;
}

export function createDebrisLayer(gpu: Gpu, sceneBuf: Buffer, shadowDepth: unknown): DebrisLayer {
  const particles: StorageBuffer = vgpuStorage(gpu, DEBRIS_MAX * DEBRIS_STRIDE, 'read-write');
  const simBuf: Buffer = gpu.device.createBuffer({
    size: SIM_FLOATS * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-debris-sim',
  });
  const drawBuf: Buffer = gpu.device.createBuffer({
    size: DRAW_FLOATS * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-debris-draw',
  });

  const sim: Compute = vgpuCompute(gpu, DEBRIS_SIM_WGSL, {
    label: 'tornado-debris-sim',
    set: { parts: particles, u: simBuf },
  });

  // 无顶点缓冲的 draw：位置完全由顶点阶段从 storage 里取
  const geo: Geometry = vgpuGeometry(gpu, {
    buffers: [],
    vertexCount: 6,
    topology: 'triangle-list',
    instanceCount: DEBRIS_MAX,
    label: 'tornado-debris-quad',
  });

  const draw: Draw = vgpuDraw(gpu, {
    shader: DEBRIS_DRAW_WGSL,
    geometry: geo,
    instances: DEBRIS_MAX,
    blend: 'alpha',
    // 碎屑是半透明薄片：不参与深度写入，否则会互相遮挡出硬边
    depth: { write: false },
    label: 'tornado-debris',
    set: {
      parts: particles,
      u: drawBuf,
      s: sceneBuf,
      shadowMap: shadowDepth,
      shadowSamp: vgpuSampler(gpu, { compare: 'less-equal' }),
    },
  });

  const simU = new Float32Array(SIM_FLOATS);
  const drawU = new Float32Array(DRAW_FLOATS);
  let simTime = 0;

  return {
    update(f): void {
      const count = Math.max(0, Math.min(DEBRIS_MAX, Math.round(f.count)));
      if (count === 0) return;

      // 模拟：dt 用固定步长并夹住，避免掉帧时粒子瞬移穿过整个涡管
      const dt = Math.max(0, Math.min(0.05, f.dt));
      simTime += dt;
      simU[0] = f.x; simU[1] = f.y; simU[2] = simTime; simU[3] = dt;
      simU[4] = f.radius; simU[5] = f.height; simU[6] = count;
      // 抖动种子随时间变化：粒子重生位置才不会每帧都一样
      simU[7] = Math.floor(simTime * 7);
      simU[8] = 1; simU[9] = 1; simU[10] = 0; simU[11] = 0;
      simBuf.write(simU, 0);
      sim.dispatch(Math.ceil(DEBRIS_MAX / 64));

      // 绘制：粒子坐标是相对风眼的，所以这里也传风眼位置；
      // 尺寸与目标分辨率都用设备像素，billboard 的屏幕偏移才换算得对。
      drawU[0] = f.x; drawU[1] = f.y; drawU[2] = f.time;
      drawU[3] = Math.max(1.5, f.size);
      drawU[4] = Math.max(1, f.viewW); drawU[5] = Math.max(1, f.viewH);
      drawU[6] = 0; drawU[7] = 0;
      drawU[8] = count; drawU[9] = 0.9; drawU[10] = 0; drawU[11] = 0;
      drawBuf.write(drawU, 0);
    },
    drawColor(pass): void {
      pass.draw(draw, { instances: DEBRIS_MAX });
    },
    dispose(): void {
      // storage buffer 由 gpu.dispose() 释放（它注册在 kernel 的 resource 阶段），
      // 这里只回收本层自己创建的几何。
      geo.destroy();
    },
  };
}
