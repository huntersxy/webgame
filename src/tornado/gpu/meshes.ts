/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/meshes.ts — 立体网格层
 *
 *  把「可卷走的物体」与「不可破坏的地形障碍」从屏幕对齐的贴纸
 *  升级为真实的立体网格：底座 / 山 / 巨石 / 林都是带法线的几何体，
 *  走深度测试、接受光照、投出并接收阴影。
 *
 *  每类网格一条 draw call，实例流携带 世界位置 + 三轴缩放 + 色调。
 *  实例数据每帧重建（物体数量在百级，重建成本可忽略）。
 * ──────────────────────────────────────────────────────────── */

import {
  draw as vgpuDraw,
  geometry as vgpuGeometry,
  sampler as vgpuSampler,
  type Draw,
  type Geometry,
  type Gpu,
} from 'vgpu';
import type { Buffer } from '@vgpu/core';

import { MESH_WGSL, SHADOW_WGSL, FUNNEL_WGSL } from './mesh-shaders';
import { unitBox, unitCone, unitCylinder, unitFunnel } from './mesh';

/**
 * 网格种类：与 meshDefs 里注册的顺序一一对应。
 * MESH_CYLINDER 目前没有调用点（山与树用锥体、底座与巨石用盒体），
 * 但几何已在注册表里就位，留给柱状物（塔、烟囱）备用。
 */
export const MESH_BOX = 0;
export const MESH_CYLINDER = 1;
export const MESH_CONE = 2;
export const MESH_FUNNEL = 3;
export const MESH_KINDS = 4;

/** 单个实例的 float 数：inst0(4) + inst1(4) + tint(4) = 12 */
export const MESH_FLOATS_PER_INSTANCE = 12;
/** 实例流步长（字节） */
export const MESH_INSTANCE_STRIDE = MESH_FLOATS_PER_INSTANCE * 4;
/** 单类网格的实例上限 */
const MAX_PER_KIND = 512;

export interface MeshLayerOptions {
  /** 场景 uniform（主相机 + 太阳 + 光照参数） */
  sceneBuf: Buffer;
  /** 阴影 pass 的光源矩阵 uniform */
  shadowBuf: Buffer;
  /** 阴影贴图的深度纹理视图，作为 texture_depth_2d 绑定 */
  shadowDepth: unknown;
  /** emoji 图集（贴花用） */
  atlasTex: unknown;
}

/** 一个绘制通道：能接收 draw 调用（FramePass 或等价对象） */
export interface MeshPass {
  draw(d: Draw, o?: { instances?: number }): void;
}

export interface MeshLayer {
  /** 每帧开始前清空实例计数 */
  begin(): void;
  /** 追加一个实例（世界位置、三轴缩放、色调 0..1） */
  add(
    kind: number,
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    r: number, g: number, b: number,
  ): void;
  /** 把本帧所有实例画进阴影贴图（仅深度） */
  drawShadow(pass: MeshPass): void;
  /** 把本帧所有实例画进场景目标 */
  drawColor(pass: MeshPass): void;
  /** 把实例数据上传到 GPU（必须在绘制前调用一次） */
  upload(): void;
  /** 各类网格当前的实例数（只读） */
  readonly counts: Int32Array;
  dispose(): void;
}

/**
 * 建立网格层。每种网格一条 Draw；实例流缓冲按上限预分配，
 * 每帧只上传实际用到的那一段。
 */
export function createMeshLayer(gpu: Gpu, opts: MeshLayerOptions): MeshLayer {
  const meshDefs = [unitBox(), unitCylinder(12), unitCone(12), unitFunnel(24, 14)];

  const shadowSamp = vgpuSampler(gpu, { compare: 'less-equal' });

  const instData = new Float32Array(MESH_KINDS * MAX_PER_KIND * MESH_FLOATS_PER_INSTANCE);
  const counts = new Int32Array(MESH_KINDS);

  const draws: Draw[] = [];
  const shadowDraws: Draw[] = [];
  const geos: Geometry[] = [];
  const instBufs: Array<{ write(d: Float32Array, o?: number): void }> = [];

  for (let k = 0; k < MESH_KINDS; k++) {
    const mesh = meshDefs[k];
    const geo = vgpuGeometry(gpu, {
      buffers: [
        {
          attributes: { position: 'float32x3', normal: 'float32x3' },
          data: mesh.data,
          stride: 24,
        },
        {
          attributes: {
            instPos: { format: 'float32x4', location: 2 },
            instScale: { format: 'float32x4', location: 3 },
            tint: { format: 'float32x4', location: 4 },
          },
          data: instData,
          stride: MESH_INSTANCE_STRIDE,
          stepMode: 'instance',
        },
      ],
      vertexCount: mesh.vertexCount,
      topology: 'triangle-list',
      instanceCount: 0,
      label: `tornado-mesh-${k}`,
    });
    geos.push(geo);
    // 实例流是 buffer[1]（buffer[0] 是顶点流）
    instBufs.push(geo.buffers[1] as unknown as { write(d: Float32Array, o?: number): void });

    const isFunnel = k === MESH_FUNNEL;
    draws.push(vgpuDraw(gpu, {
      // 漏斗用专用着色器（程序化旋转螺纹 + 双面），其余走通用光照
      shader: isFunnel ? FUNNEL_WGSL : MESH_WGSL,
      geometry: geo,
      // 主相机把世界 y 翻成屏幕 y（y 向下），这一次取反会翻转三角形绕序，
      // 于是几何上的「正面」在帧缓冲里被判成背面。必须显式声明 frontFace: 'cw'，
      // 否则 cull: 'back' 会把该看见的那几个面剔掉，画面只剩背光的内壁。
      // 漏斗是薄壳，从斜上方能看进内壁，所以不剔除（cull: 'none'）。
      cull: isFunnel ? 'none' : 'back',
      frontFace: 'cw',
      blend: isFunnel ? 'alpha' : undefined,
      label: `tornado-mesh-draw-${k}`,
      set: { s: opts.sceneBuf, shadowMap: opts.shadowDepth, shadowSamp },
    }));
    shadowDraws.push(vgpuDraw(gpu, {
      shader: SHADOW_WGSL,
      geometry: geo,
      // 阴影 pass 剔除正面：背面更靠近光源，能减少自阴影痤疮。
      // 绕序同样按 frontFace: 'cw' 判定（见上）。
      cull: 'front',
      frontFace: 'cw',
      label: `tornado-shadow-${k}`,
      set: { u: opts.shadowBuf },
    }));
  }

  return {
    counts,
    begin(): void {
      counts.fill(0);
    },
    add(kind, x, y, z, sx, sy, sz, r, g, b): void {
      if (kind < 0 || kind >= MESH_KINDS) return;
      if (counts[kind] >= MAX_PER_KIND) return;
      // 每类网格的实例在缓冲里连续分段存放，上传时按类各写一段
      const slot = kind * MAX_PER_KIND + counts[kind];
      const o = slot * MESH_FLOATS_PER_INSTANCE;
      instData[o] = x; instData[o + 1] = y; instData[o + 2] = z; instData[o + 3] = sx;
      instData[o + 4] = sy; instData[o + 5] = sz; instData[o + 6] = 0; instData[o + 7] = 0;
      instData[o + 8] = r; instData[o + 9] = g; instData[o + 10] = b; instData[o + 11] = 1;
      counts[kind]++;
    },
    upload(): void {
      for (let k = 0; k < MESH_KINDS; k++) {
        const n = counts[k];
        if (n <= 0) continue;
        const from = k * MAX_PER_KIND * MESH_FLOATS_PER_INSTANCE;
        instBufs[k].write(instData.subarray(from, from + n * MESH_FLOATS_PER_INSTANCE), 0);
      }
    },
    drawShadow(pass): void {
      for (let k = 0; k < MESH_KINDS; k++) {
        if (counts[k] > 0) pass.draw(shadowDraws[k], { instances: counts[k] });
      }
    },
    drawColor(pass): void {
      for (let k = 0; k < MESH_KINDS; k++) {
        if (counts[k] > 0) pass.draw(draws[k], { instances: counts[k] });
      }
    },
    dispose(): void {
      for (const g of geos) g.destroy();
    },
  };
}

/* ══════════════════════════════════════════════════════════════
 *  emoji 贴花层：贴在底座顶面的水平面片
 * ══════════════════════════════════════════════════════════════ */

import { DECAL_WGSL } from './mesh-shaders';
import { unitDecalQuad } from './mesh';

/** 贴花实例的 float 数：instPos(4) + instScale(4) + uvrect(4) + tint(4) = 16 */
const DECAL_FLOATS = 16;
const DECAL_STRIDE = DECAL_FLOATS * 4;
const MAX_DECALS = 512;

export interface DecalLayer {
  begin(): void;
  /** 在 (x, y, z) 放一张边长 size 的 emoji 贴花；uvrect 指向图集格 */
  add(
    x: number, y: number, z: number, size: number,
    u: number, v: number, du: number, dv: number,
    r: number, g: number, b: number, a: number,
  ): void;
  upload(): void;
  drawColor(pass: MeshPass): void;
  readonly count: { value: number };
  dispose(): void;
}

/**
 * 建立贴花层。贴花**接收**阴影但不投射——这正是「物体落在地面上」的关键，
 * 也是它比原来的平面贴纸多出来的那层信息。
 */
export function createDecalLayer(gpu: Gpu, opts: MeshLayerOptions): DecalLayer {
  const quad = unitDecalQuad();
  const instData = new Float32Array(MAX_DECALS * DECAL_FLOATS);
  const counter = { value: 0 };

  const geo = vgpuGeometry(gpu, {
    buffers: [
      {
        attributes: { position: 'float32x3', uv: 'float32x2' },
        data: quad.data,
        stride: 20,
      },
      {
        attributes: {
          instPos: { format: 'float32x4', location: 2 },
          instScale: { format: 'float32x4', location: 3 },
          uvrect: { format: 'float32x4', location: 4 },
          tint: { format: 'float32x4', location: 5 },
        },
        data: instData,
        stride: DECAL_STRIDE,
        stepMode: 'instance',
      },
    ],
    vertexCount: quad.vertexCount,
    topology: 'triangle-list',
    instanceCount: 0,
    label: 'tornado-decal',
  });
  const instBuf = geo.buffers[1] as unknown as { write(d: Float32Array, o?: number): void };

  const draw = vgpuDraw(gpu, {
    shader: DECAL_WGSL,
    geometry: geo,
    blend: 'alpha',
    cull: 'none',
    label: 'tornado-decal-draw',
    set: {
      s: opts.sceneBuf,
      shadowMap: opts.shadowDepth,
      shadowSamp: vgpuSampler(gpu, { compare: 'less-equal' }),
      atlas: opts.atlasTex,
      samp: vgpuSampler(gpu, { magFilter: 'linear', minFilter: 'linear' }),
    },
  });

  return {
    count: counter,
    begin(): void { counter.value = 0; },
    add(x, y, z, size, u, v, du, dv, r, g, b, a): void {
      if (counter.value >= MAX_DECALS) return;
      const o = counter.value * DECAL_FLOATS;
      instData[o] = x; instData[o + 1] = y; instData[o + 2] = z; instData[o + 3] = 1;
      instData[o + 4] = size; instData[o + 5] = size; instData[o + 6] = 1; instData[o + 7] = 0;
      instData[o + 8] = u; instData[o + 9] = v; instData[o + 10] = du; instData[o + 11] = dv;
      instData[o + 12] = r; instData[o + 13] = g; instData[o + 14] = b; instData[o + 15] = a;
      counter.value++;
    },
    upload(): void {
      if (counter.value > 0) {
        instBuf.write(instData.subarray(0, counter.value * DECAL_FLOATS), 0);
      }
    },
    drawColor(pass): void {
      if (counter.value > 0) pass.draw(draw, { instances: counter.value });
    },
    dispose(): void { geo.destroy(); },
  };
}
