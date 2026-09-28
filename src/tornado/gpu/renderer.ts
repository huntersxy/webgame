/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/renderer.ts — 《龙卷风成长记》vgpu/WebGPU 渲染器
 *
 *  与 Canvas 2D 路径（game.ts 的 renderState）共用同一份派生状态，
 *  因此相机构图、转场进度、换手时序、龙卷风屏幕位置在两个后端上一致。
 *
 *  每帧一个 frame，四趟：
 *    ① pass(scene)  地表 effect（逐像素程序化地貌）
 *    ② pass(scene)  实例化精灵（地形障碍 / 物体 emoji / 粒子 / 环）
 *    ③ pass(scene)  龙卷风（程序化）
 *    ④ pass(canvas) 合成 effect：风眼擦除遮罩 + 暗角
 *  转场字卡是中文，无法进 emoji 图集，仍走一张 2D 覆盖画布贴成全屏四边形。
 *
 *  两套坐标系：
 *    · 逻辑坐标 TORNADO_VIEW×TORNADO_VIEW：与模拟层、Canvas 路径一致；
 *    · 设备像素：画布的真实分辨率（逻辑尺寸 × DPR）。
 *  渲染器在写入实例数据时统一乘以 pxRatio，着色器全程按设备像素工作。
 *  Canvas 路径靠 ctx.setTransform(dpr,...) 做同一件事，两条路径因此同样清晰。
 *
 *  数据通道：uniform 与实例数据都用 core 层的 Buffer（可写原始字节），
 *  每帧只做 buffer 上传，不做逐字段反射打包。
 * ──────────────────────────────────────────────────────────── */

import {
  draw as vgpuDraw,
  effect as vgpuEffect,
  frame as vgpuFrame,
  geometry as vgpuGeometry,
  init as vgpuInit,
  sampler as vgpuSampler,
  surface as vgpuSurface,
  target as vgpuTarget,
  texture as vgpuTexture,
  type Draw,
  type Effect,
  type Geometry,
  type GeometryBuffer,
  type Gpu,
  type Surface,
  type Target,
  type Texture,
} from 'vgpu';

import type { Buffer } from '@vgpu/core';

import {
  TORNADO_VIEW, TIERS, GROUND, WIPE_SPAN, wipeStatesFor, vignetteAlpha,
  type GroundCol, type Obj, type Particle, type Ring, type Terrain, type TornadoRenderState,
} from '../game';
import { buildAtlas, glyphsFor, type Atlas } from './atlas';
import { CG_FINALE_WGSL, CG_INTRO_WGSL } from './cg';
import { buildDecorCanvas, DECOR_PX, DECOR_WORLD } from './decor';
import { COMPOSITE_WGSL, FLOOR_WGSL, SPRITE_WGSL, TORNADO_WGSL } from './shaders';

/* 实例里 kind 字段的取值，与 SPRITE_WGSL 的分支一一对应 */
const K_TEXTURE = 0;
const K_ROUND_RECT = 1;
const K_ROUND_RECT_STROKE = 2;
const K_ELLIPSE = 3;
const K_ELLIPSE_RING = 4;
const K_TRIANGLE = 5;

/**
 * 单个实例的浮点数：rect(4) + misc(4) + tint(4) + param(4) + uvrect(4) = 20，
 * 再补 4 个填充凑满 96 字节。
 *
 * 为什么补到 96：Geometry.write 要求写入长度按 32 字节对齐，而 20 float = 80 字节
 * 不是 32 的倍数——实例数为奇数时写入长度就不合法。96 = 32×3，任何实例数都成立。
 */
const FLOATS_PER_INSTANCE = 24;
/** 实例流步长（字节）：与 FLOATS_PER_INSTANCE 对应 */
const INSTANCE_STRIDE = FLOATS_PER_INSTANCE * 4;
/** 实例缓冲容量：粒子 160 + 环 + 物体 + 地形，留足余量 */
const MAX_INSTANCES = 1024;
/** 每量级的调色板槽位数（base/arable/forest/town/water） */
const PALETTE_SLOTS = 5;
/**
 * 地表 uniform 布局（与 FLOOR_WGSL 的 FloorU 严格对应）：
 *   cam(2) view(2) scale tile tier gridPx = 8 个 float，
 *   然后 gridCol 是 vec4，按 WGSL 对齐规则必须落在 16 字节边界 → float 8..11，
 *   cols 数组（vec4[N]）从 float 12 开始。
 */
const FLOOR_GRIDCOL_OFFSET = 8;
const FLOOR_PALETTE_OFFSET = 12;
/** cols 数组之后：decorWorld, decorMix, pad, pad */
const FLOOR_DECOR_OFFSET = FLOOR_PALETTE_OFFSET + TIERS.length * PALETTE_SLOTS * 4;
const FLOOR_UNIFORM_FLOATS = FLOOR_DECOR_OFFSET + 4;

export interface GpuWorld {
  objects: Obj[];
  terrain: Terrain[];
  particles: Particle[];
  rings: Ring[];
  tier: number;
  time: number;
}

/**
 * 叙事状态：CG 画面与过场动画。
 *
 * 由控制器驱动（控制器知道玩法时序），渲染器只负责把它画出来。
 *   · cg: 当前要全屏播放的 CG（开场 / 结局），非 null 时整帧只有 CG
 *   · cgProgress: CG 自身的时间轴 0..1，用于淡入淡出
 *   · cine: 过场动画叠加层（量级跃迁时的运镜/字卡），与游戏画面合成
 */
export interface NarrativeState {
  cg: 'intro' | 'finale' | null;
  cgProgress: number;
  /** 过场动画强度 0..1（0 表示不叠加） */
  cine: number;
  /** 过场动画阶段 0..1 */
  cinePhase: number;
  /** 过场字幕（中文，走 2D 覆盖层） */
  cineTitle: string;
  cineSubtitle: string;
}

export interface GpuRenderer {
  /** 用 GPU 画一帧 */
  render(): void;
  /** 画布像素尺寸变化后调用（控制器改完 canvas.width/height 再调这里） */
  resize(): void;
  /** 释放全部 GPU 资源；调用后实例不可再用 */
  dispose(): void;
  /** 画布逻辑尺寸（CSS 像素），供输入换算 */
  readonly viewSize: number;
}

/** WebGPU 是否可用（仅能力检测，不申请设备） */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}

/**
 * 建立 GPU 渲染器。任何一步失败都抛错，由调用方回退到 Canvas 2D——
 * 站点承诺「任何浏览器都能玩」，所以这里不做硬性假设。
 */
export async function createGpuRenderer(
  canvas: HTMLCanvasElement,
  getState: () => TornadoRenderState,
  getWorld: () => GpuWorld,
  getNarrative: () => NarrativeState,
  onFatal: (err: unknown) => void,
): Promise<GpuRenderer> {
  const gpu: Gpu = await vgpuInit();
  // 传 size：画布尺寸由控制器按 DPR 设定（与 Canvas 2D 路径同一支 applyDpr），
  // 渲染器只读取实际像素尺寸，不再自己改画布——两条路径的尺寸归属保持一致。
  const surface: Surface = vgpuSurface(gpu, canvas, {
    size: [Math.max(1, canvas.width), Math.max(1, canvas.height)],
    alphaMode: 'premultiplied',
  });

  // 设备丢失（驱动重置、标签页被系统回收）时通知外层回退，避免画面永久静止
  gpu.device.gpu.lost.then((info) => {
    onFatal(new Error(`WebGPU device lost: ${info.reason} ${info.message}`));
  });

  const atlasInfo: Atlas = buildAtlas(glyphsFor(TIERS.map((t) => t.pool)), '"Segoe UI Emoji","Noto Color Emoji",serif');

  /* ── 渲染尺寸（设备像素，由 surface 维护） ────────────── */

  let size: [number, number] = [surface.size[0], surface.size[1]];

  /* ── 贴图 ────────────────────────────────────────────── */

  const atlasTex: Texture = vgpuTexture(gpu, {
    kind: '2d', size: [atlasInfo.width, atlasInfo.height], format: 'rgba8unorm',
    usage: ['texture_binding', 'copy_dst'], label: 'tornado-atlas',
  });
  writeTexture(atlasTex, atlasInfo.data, atlasInfo.width, atlasInfo.height);

  const linearSampler = vgpuSampler(gpu, { magFilter: 'linear', minFilter: 'linear' });
  const nearestSampler = vgpuSampler(gpu, { magFilter: 'nearest', minFilter: 'nearest' });
  // 装饰贴图按世界坐标平铺：必须在两个方向都 repeat
  const repeatSampler = vgpuSampler(gpu, {
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat',
  });

  /* ── 地表装饰贴图（每量级一张，懒建） ───────────────── */

  const decorTextures: Array<Texture | null> = TIERS.map(() => null);

  /** 取得某量级的装饰贴图，首次使用时栅格化并上传 */
  function decorFor(index: number): Texture {
    const i = Math.max(0, Math.min(TIERS.length - 1, index | 0));
    const hit = decorTextures[i];
    if (hit) return hit;
    const canvas = buildDecorCanvas(i);
    const ctx = canvas.getContext('2d');
    const img = ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
    const tex = vgpuTexture(gpu, {
      kind: '2d', size: [DECOR_PX, DECOR_PX], format: 'rgba8unorm',
      usage: ['texture_binding', 'copy_dst'], label: `tornado-decor-${i}`,
    });
    if (img) writeTexture(tex, new Uint8Array(img.data.buffer.slice(0)), DECOR_PX, DECOR_PX);
    decorTextures[i] = tex;
    return tex;
  }

  /* ── 渲染目标 ────────────────────────────────────────── */

  const scene: Target = vgpuTarget(gpu, { size, format: 'rgba8unorm', label: 'tornado-scene' });

  /* ── uniform 缓冲（core Buffer：可写原始字节） ───────── */

  const floorBuf: Buffer = gpu.device.createBuffer({
    size: FLOOR_UNIFORM_FLOATS * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-floor-u',
  });
  const spriteBuf: Buffer = gpu.device.createBuffer({
    size: 4 * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-sprite-u',
  });
  const tornadoBuf: Buffer = gpu.device.createBuffer({
    size: 8 * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-cone-u',
  });
  const compBuf: Buffer = gpu.device.createBuffer({
    // 16 个 float = 64 字节，与 WGSL 的 CompU 结构体等大
    size: 16 * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-comp-u',
  });
  const cgBuf: Buffer = gpu.device.createBuffer({
    size: 8 * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-cg-u',
  });

  const floorU = new Float32Array(FLOOR_UNIFORM_FLOATS);
  const spriteU = new Float32Array(4);
  const tornadoU = new Float32Array(8);
  const compU = new Float32Array(16);
  const cgU = new Float32Array(8);
  fillPalette(floorU, TIERS, GROUND);

  /* ── 实例缓冲 ────────────────────────────────────────── */

  const instData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  let instCount = 0;

  const spriteGeo: Geometry = vgpuGeometry(gpu, {
    buffers: [
      {
        attributes: { corner: 'float32x2' },
        // 三角带单位四边形
        data: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      },
      {
        attributes: {
          rect: { format: 'float32x4', location: 1 },
          misc: { format: 'float32x4', location: 2 },
          tint: { format: 'float32x4', location: 3 },
          param: { format: 'float32x4', location: 4 },
          uvrect: { format: 'float32x4', location: 5 },
        },
        data: instData,
        stride: INSTANCE_STRIDE,
        stepMode: 'instance',
      },
    ],
    vertexCount: 4,
    topology: 'triangle-strip',
    instanceCount: 0,
    label: 'tornado-sprites',
  });
  /** 实例流缓冲句柄：每帧写入用（Geometry.write() 写的是 vertex buffer 0，不是这一条） */
  const spriteInstBuf = spriteGeo.buffers[1];

  /* ── 管线 ────────────────────────────────────────────── */

  const floorFx: Effect = vgpuEffect(gpu, FLOOR_WGSL, {
    label: 'tornado-floor',
    set: { u: floorBuf, decor: decorFor(0), decorSamp: repeatSampler },
  });

  const spriteFx: Draw = vgpuDraw(gpu, {
    shader: SPRITE_WGSL, geometry: spriteGeo, blend: 'alpha', label: 'tornado-sprite',
    set: { u: spriteBuf, atlas: atlasTex, samp: nearestSampler },
  });

  // 龙卷风是全屏 effect：绘制范围由 pass 的 scissor 限定在包围盒内
  const tornadoFx: Effect = vgpuEffect(gpu, TORNADO_WGSL, {
    label: 'tornado-cone', blend: 'alpha', set: { u: tornadoBuf },
  });

  const compositeFx: Effect = vgpuEffect(gpu, COMPOSITE_WGSL, {
    label: 'tornado-composite',
    set: { u: compBuf, src: scene, samp: linearSampler },
  });

  /* ── CG：开场 / 结局（程序化全屏画面，不引入图片资源） ── */

  const cgIntroFx: Effect = vgpuEffect(gpu, CG_INTRO_WGSL, {
    label: 'tornado-cg-intro', set: { u: cgBuf },
  });
  const cgFinaleFx: Effect = vgpuEffect(gpu, CG_FINALE_WGSL, {
    label: 'tornado-cg-finale', set: { u: cgBuf },
  });

  /* ── 文字覆盖层（中文字卡走 2D 画布） ────────────────── */

  const overlay = document.createElement('canvas');
  overlay.width = size[0];
  overlay.height = size[1];
  const overlayCtx = overlay.getContext('2d', { willReadFrequently: true });
  let overlayTex: Texture = vgpuTexture(gpu, {
    kind: '2d', size, format: 'rgba8unorm', usage: ['texture_binding', 'copy_dst'], label: 'tornado-overlay',
  });
  const overlayInst = new Float32Array(FLOATS_PER_INSTANCE);
  let overlayGeo: Geometry | null = null;
  let overlayInstBuf: GeometryBuffer | null = null;
  let overlayFx: Draw | null = null;
  let overlayVisible = false;

  function rebuildOverlayDraw(): void {
    overlayGeo?.destroy();
    overlayGeo = vgpuGeometry(gpu, {
      buffers: [
        { attributes: { corner: 'float32x2' }, data: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]) },
        {
          attributes: {
            rect: { format: 'float32x4', location: 1 },
            misc: { format: 'float32x4', location: 2 },
            tint: { format: 'float32x4', location: 3 },
            param: { format: 'float32x4', location: 4 },
            uvrect: { format: 'float32x4', location: 5 },
          },
          data: overlayInst, stride: INSTANCE_STRIDE, stepMode: 'instance',
        },
      ],
      vertexCount: 4,
      topology: 'triangle-strip', instanceCount: 1, label: 'tornado-overlay-quad',
    });
    overlayInstBuf = overlayGeo.buffers[1];
    overlayFx = vgpuDraw(gpu, {
      shader: SPRITE_WGSL, geometry: overlayGeo, blend: 'alpha', label: 'tornado-overlay',
      set: { u: spriteBuf, atlas: overlayTex, samp: linearSampler },
    });
  }

  /* ── 尺寸变化：scene 目标 + 覆盖层贴图一起换 ─────────── */

  /**
   * 画布像素尺寸变化后重建依赖尺寸的资源。
   * 由控制器在改完 canvas.width/height 之后调用（surface 不会自己动画布）。
   */
  function resize(): void {
    const next: [number, number] = [Math.max(1, canvas.width), Math.max(1, canvas.height)];
    if (next[0] === size[0] && next[1] === size[1]) return;
    size = next;
    surface.resize(size);
    scene.resize(size);
    compositeFx.set({ src: scene });
    overlay.width = size[0];
    overlay.height = size[1];
    // Texture 不支持 resize：重建后重新绑定
    overlayTex.destroy();
    overlayTex = vgpuTexture(gpu, {
      kind: '2d', size, format: 'rgba8unorm', usage: ['texture_binding', 'copy_dst'], label: 'tornado-overlay',
    });
    rebuildOverlayDraw();
    overlayVisible = false;
  }

  /* ── 实例写入 ────────────────────────────────────────── */

  /** 逻辑坐标 → 设备像素的比例（高分屏 >1） */
  let pxRatio = Math.max(1e-4, size[0] / TORNADO_VIEW);

  /**
   * 写入一个实例。`cx/cy/hw/hh` 与 `p0/p1` 都是屏幕长度，
   * 传逻辑坐标，这里统一换算到设备像素，调用点不必关心 DPR。
   */
  function push(
    cx: number, cy: number, hw: number, hh: number,
    rot: number, kind: number, alpha: number,
    col: { r: number; g: number; b: number },
    p0: number, p1: number,
    u0: number, v0: number, du: number, dv: number,
  ): void {
    if (instCount >= MAX_INSTANCES) return;
    const o = instCount * FLOATS_PER_INSTANCE;
    instData[o] = cx * pxRatio; instData[o + 1] = cy * pxRatio;
    instData[o + 2] = hw * pxRatio; instData[o + 3] = hh * pxRatio;
    instData[o + 4] = rot; instData[o + 5] = kind; instData[o + 6] = alpha; instData[o + 7] = 0;
    instData[o + 8] = col.r / 255; instData[o + 9] = col.g / 255; instData[o + 10] = col.b / 255; instData[o + 11] = 0;
    instData[o + 12] = p0 * pxRatio; instData[o + 13] = p1 * pxRatio; instData[o + 14] = 0; instData[o + 15] = 0;
    instData[o + 16] = u0; instData[o + 17] = v0; instData[o + 18] = du; instData[o + 19] = dv;
    instCount++;
  }

  const rgb = (r: number, g: number, b: number) => ({ r, g, b });

  /* ── 每帧收集 ────────────────────────────────────────── */

  function collect(rs: TornadoRenderState, w: GpuWorld): void {
    instCount = 0;
    const s = rs.floorScale;
    const cx0 = rs.floorCam.x;
    const cy0 = rs.floorCam.y;
    // 世界 → 逻辑屏幕坐标（与 Canvas 路径同一支变换）
    const toX = (wx: number): number => TORNADO_VIEW / 2 + (wx - cx0) * s;
    const toY = (wy: number): number => TORNADO_VIEW / 2 + (wy - cy0) * s;

    // ① 地形障碍
    for (const t of w.terrain) {
      const sx = toX(t.x);
      const sy = toY(t.y);
      const sr = t.r * s;
      if (!visible(sx, sy, sr * 3)) continue;
      push(sx, sy + sr * 0.72, sr * 0.92, sr * 0.28, 0, K_ELLIPSE, 0.16, rgb(28, 43, 51), 0, 0, 0, 0, 0, 0);
      pushTerrain(t, sx, sy, sr);
    }

    // ② 物体：可食/不可食决定底座配色与锁标
    for (const o of w.objects) {
      if (o.dead && !o.suck) continue;
      const slot = atlasInfo.slots.get(o.e);
      const edible = rs.radius > o.r;

      if (o.suck) {
        // 螺旋吸入：向风眼收拢、旋转、缩小
        const e = ease(o.suck.t);
        const ang = o.suck.t * 9 + o.seed;
        const rad = (1 - e) * o.r * 2.2 * s;
        const sc = 1 - e * 0.85;
        const bx = toX(o.suck.sx);
        const by = toY(o.suck.sy);
        const px = bx + (rs.sx - bx) * e + Math.cos(ang) * rad;
        const py = by + (rs.sy - by) * e + Math.sin(ang) * rad * 0.55 - e * rs.screenR * 0.9;
        const half = o.r * 1.15 * s * sc;
        if (slot && visible(px, py, half * 2)) {
          push(px, py, half, half, ang * 0.8, K_TEXTURE, 1, rgb(255, 255, 255), 0, 0, slot.u, slot.v, slot.du, slot.dv);
        }
        continue;
      }

      const sx = toX(o.x);
      const sy = toY(o.y);
      const half = o.r * 1.15 * s;
      if (!visible(sx, sy, half * 2.4)) continue;
      const bob = Math.sin(w.time * 1.4 + o.seed) * 1.6;

      // 地基：深色底板 + 浅色面（不可食时面色偏灰）
      push(sx, sy, o.r * 1.02 * s, o.r * 0.81 * s, 0, K_ROUND_RECT, 0.20, rgb(38, 52, 60), o.r * 0.34 * s, 0, 0, 0, 0, 0);
      const face = edible ? rgb(244, 246, 243) : rgb(230, 228, 224);
      push(sx, sy - o.r * 0.05 * s, o.r * 0.94 * s, o.r * 0.75 * s, 0, K_ROUND_RECT, 0.88, face, o.r * 0.3 * s, 0, 0, 0, 0, 0);

      // 不可食：灰描边 + 锁标，提示「现在还卷不动」
      if (!edible) {
        push(sx, sy - o.r * 0.05 * s, o.r * 0.94 * s, o.r * 0.75 * s, 0, K_ROUND_RECT_STROKE, 0.45, rgb(140, 120, 110), o.r * 0.3 * s, 2, 0, 0, 0, 0);
        const lock = atlasInfo.slots.get('🔒');
        if (lock) {
          const ls = Math.max(12, o.r * 0.55) * s * 0.5;
          push(sx + o.r * 0.62 * s, sy - o.r * 0.42 * s + bob, ls, ls, 0, K_TEXTURE, 0.45,
            rgb(255, 255, 255), 0, 0, lock.u, lock.v, lock.du, lock.dv);
        }
      }

      if (slot) {
        push(sx, sy + bob, half, half, 0, K_TEXTURE, 1, rgb(255, 255, 255), 0, 0, slot.u, slot.v, slot.du, slot.dv);
      }
    }

    // ③ 环与粒子
    for (const rg of w.rings) {
      const sx = toX(rg.x);
      const sy = toY(rg.y);
      const sr = Math.max(0.5, rg.r * s);
      if (!visible(sx, sy, sr * 1.4)) continue;
      const a = Math.max(0, rg.life / 0.45) * rg.c.a;
      // 线宽 3px → 占半径的比例（着色器按归一化半径算环宽）
      push(sx, sy, sr, sr, 0, K_ELLIPSE_RING, a, rg.c, Math.min(0.9, 1.5 / Math.max(sr, 1)), 0, 0, 0, 0, 0);
    }
    for (const p of w.particles) {
      const sx = toX(p.x);
      const sy = toY(p.y);
      const sr = Math.max(0.5, p.sz * s);
      if (!visible(sx, sy, sr * 2)) continue;
      const a = Math.max(0, p.life / p.max) * p.c.a;
      push(sx, sy, sr, sr, 0, K_ELLIPSE, a, p.c, 0, 0, 0, 0, 0, 0);
    }
  }

  /** 地形障碍形状：湖 / 巨石 / 山 / 森林（与 drawTerrain 的图元对应） */
  function pushTerrain(t: Terrain, sx: number, sy: number, sr: number): void {
    switch (t.kind) {
      case 'lake': {
        // 湖面：扁椭圆 + 亮色岸线（Canvas 用 ellipse + stroke）
        push(sx, sy, sr, sr * 0.72, 0.3, K_ELLIPSE, 1, rgb(125, 180, 214), 0, 0, 0, 0, 0, 0);
        push(sx, sy, sr, sr * 0.72, 0.3, K_ELLIPSE_RING, 0.8, rgb(235, 246, 250), 0.055, 0, 0, 0, 0, 0);
        break;
      }
      case 'boulder': {
        // 巨石：三块叠在一起的岩体 + 左上高光（Canvas 用三个 ellipse + 高光弧）
        const rocks: Array<[number, number, number]> = [
          [0, 0, 0.72], [-0.55, 0.18, 0.45], [0.5, 0.22, 0.38],
        ];
        for (const [dx, dy, rr] of rocks) {
          push(sx + sr * dx, sy + sr * dy, sr * rr, sr * rr * 0.86, 0, K_ELLIPSE, 1, rgb(141, 151, 158), 0, 0, 0, 0, 0, 0);
          push(sx + sr * (dx - rr * 0.25), sy + sr * (dy - rr * 0.35), sr * rr * 0.45, sr * rr * 0.28, -0.5, K_ELLIPSE, 0.28, rgb(255, 255, 255), 0, 0, 0, 0, 0, 0);
        }
        break;
      }
      case 'mount': {
        // 三座山峰：三角形底 + 雪顶（Canvas 用两条三角形路径）
        const peaks: Array<[number, number, number]> = [
          [-0.42, 1.15, 0.75], [0.05, 1.5, 0.95], [0.55, 1.0, 0.65],
        ];
        for (const [dx, ph, pw] of peaks) {
          const halfH = sr * ph * 0.5;
          const cyA = sy + sr * 0.5 - halfH;
          // 山体：顶点高度按 ph 换算成包围盒比例
          push(sx + sr * dx, cyA, sr * pw, halfH, 0, K_TRIANGLE, 1, rgb(127, 140, 150), 1, 0, 0, 0, 0, 0);
          // 雪顶：叠一个较小的三角形，顶点同高
          push(sx + sr * dx, cyA + halfH * 0.24, sr * pw * 0.26, halfH * 0.76, 0, K_TRIANGLE, 1, rgb(238, 244, 247), 1, 0, 0, 0, 0, 0);
        }
        break;
      }
      case 'forest': {
        const rnd = mulberry32((t.seed * 1000) | 0);
        for (let i = 0; i < 7; i++) {
          const a = rnd() * Math.PI * 2;
          const dd = rnd() * sr * 0.62;
          const rr = sr * (0.3 + rnd() * 0.22);
          push(sx + Math.cos(a) * dd, sy + Math.sin(a) * dd * 0.8, rr, rr, 0, K_ELLIPSE, 1,
            i % 2 ? rgb(93, 139, 96) : rgb(77, 122, 82), 0, 0, 0, 0, 0, 0);
        }
        break;
      }
    }
  }

  /** 视口裁剪（逻辑坐标） */
  function visible(cx: number, cy: number, r: number): boolean {
    return cx + r > 0 && cy + r > 0 && cx - r < TORNADO_VIEW && cy - r < TORNADO_VIEW;
  }

  /* ── 文字覆盖层 ──────────────────────────────────────── */

  /**
   * 字卡：中文无法进 emoji 图集，统一画在这张 2D 覆盖画布上，
   * 再作为一个全屏四边形贴在合成结果之上。
   * 两种来源：量级跃迁的转场字卡、过场动画的字幕。
   */
  function drawOverlay(rs: TornadoRenderState, w: GpuWorld, nar: NarrativeState): void {
    if (!overlayCtx) return;

    const cineText = nar.cine > 0.01 && (nar.cineTitle || nar.cineSubtitle);
    // 过场演出已经承担了字幕职责，此时不再叠加转场字卡（两套文案会叠在一起）
    const zoomText = !cineText && rs.zooming && rs.p > 0.3;

    if (!cineText && !zoomText) {
      if (overlayVisible) {
        overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
        overlayCtx.clearRect(0, 0, size[0], size[1]);
        uploadOverlay();
        overlayVisible = false;
      }
      return;
    }

    // 覆盖层画布是设备像素，按 pxRatio 放大后仍用逻辑坐标布局
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, size[0], size[1]);
    overlayCtx.setTransform(pxRatio, 0, 0, pxRatio, 0, 0);
    overlayCtx.save();
    overlayCtx.textAlign = 'center';
    overlayCtx.textBaseline = 'middle';

    if (cineText) {
      // 过场字幕：居中大字 + 副标，上下淡入淡出
      const a = Math.sin(Math.min(1, Math.max(0, nar.cinePhase)) * Math.PI) * nar.cine;
      overlayCtx.globalAlpha = Math.max(0, Math.min(1, a));
      overlayCtx.fillStyle = '#fff';
      overlayCtx.font = 'bold 30px "PingFang SC","Microsoft YaHei",system-ui';
      overlayCtx.shadowColor = 'rgba(0,0,0,.55)';
      overlayCtx.shadowBlur = 14;
      overlayCtx.fillText(nar.cineTitle, TORNADO_VIEW / 2, TORNADO_VIEW / 2 - 12);
      if (nar.cineSubtitle) {
        overlayCtx.font = '14px system-ui';
        overlayCtx.fillStyle = 'rgba(255,255,255,.82)';
        overlayCtx.fillText(nar.cineSubtitle, TORNADO_VIEW / 2, TORNADO_VIEW / 2 + 24);
      }
      overlayCtx.shadowBlur = 0;
      overlayCtx.restore();
      uploadOverlay();
      overlayVisible = true;
      return;
    }

    // 转场字卡（与 Canvas 路径的 drawTransitionText 同文案同位置）
    overlayCtx.globalAlpha = Math.min(1, (rs.p - 0.3) * 2.4) * (1 - Math.max(0, (rs.p - 0.92) / 0.08));
    overlayCtx.fillStyle = 'rgba(28,43,51,.55)';
    overlayCtx.fillRect(0, TORNADO_VIEW / 2 + TORNADO_VIEW * 0.31, TORNADO_VIEW, 80);
    overlayCtx.fillStyle = '#fff';
    const nxt = TIERS[Math.min(w.tier + 1, TIERS.length - 1)];
    const cur = TIERS[Math.min(w.tier, TIERS.length - 1)];
    overlayCtx.font = 'bold 22px "PingFang SC","Microsoft YaHei",system-ui';
    overlayCtx.fillText(`镜头拉远 · 前方进入「${w.tier + 1 >= TIERS.length ? '？' : nxt.name}」`,
      TORNADO_VIEW / 2, TORNADO_VIEW / 2 + TORNADO_VIEW * 0.31 + 26);
    overlayCtx.font = '13px system-ui';
    overlayCtx.fillStyle = 'rgba(255,255,255,.75)';
    overlayCtx.fillText(`${cur.en} → ${nxt.en} · 脚下的世界正在铺展开来`,
      TORNADO_VIEW / 2, TORNADO_VIEW / 2 + TORNADO_VIEW * 0.31 + 56);
    overlayCtx.restore();
    uploadOverlay();
    overlayVisible = true;
  }

  function uploadOverlay(): void {
    if (!overlayCtx) return;
    const img = overlayCtx.getImageData(0, 0, size[0], size[1]);
    writeTexture(overlayTex, new Uint8Array(img.data.buffer.slice(0)), size[0], size[1]);
  }

  function writeTexture(tex: Texture, data: Uint8Array, w: number, h: number): void {
    gpu.gpu.queue.writeTexture(
      { texture: tex.gpu }, data,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h },
    );
  }

  /* ── 渲染 ────────────────────────────────────────────── */

  let disposed = false;
  /** 当前绑定到 floor effect 的装饰贴图量级（换关时才重新绑定） */
  let boundDecor = 0;

  function render(): void {
    if (disposed) return;
    const rs = getState();
    const w = getWorld();
    const nar = getNarrative();
    pxRatio = Math.max(1e-4, size[0] / TORNADO_VIEW);

    // ── CG 全屏画面：整帧只有它，不叠加游戏世界 ──
    if (nar.cg) {
      cgU[0] = size[0]; cgU[1] = size[1];
      cgU[2] = w.time;
      cgU[3] = nar.cgProgress;
      cgU[4] = w.tier;
      cgU[5] = 0; cgU[6] = 0; cgU[7] = 0;
      cgBuf.write(cgU, 0);
      const cgFx = nar.cg === 'finale' ? cgFinaleFx : cgIntroFx;
      vgpuFrame(gpu, (f) => {
        f.pass({ target: surface, clear: [0, 0, 0, 1] }, cgFx);
      });
      return;
    }

    // 地表：世界 → 设备像素的比例尺（逻辑比例尺 × DPR）
    floorU[0] = rs.floorCam.x; floorU[1] = rs.floorCam.y;
    floorU[2] = size[0]; floorU[3] = size[1];
    floorU[4] = rs.floorScale * pxRatio;
    // 地貌格边长与 Canvas 路径的 size 同式：clamp(150/s, 96, 420)（世界单位）
    floorU[5] = biomeCellWorld(rs.floorScale);
    floorU[6] = rs.idx;
    floorU[7] = 1.4 * pxRatio;
    // 网格线颜色随量级变化（与 GROUND[].grid 同源）
    writeGridColor(floorU, GROUND[Math.min(rs.idx, GROUND.length - 1)].grid);
    // 装饰贴图平铺的世界尺寸与混入强度（Canvas 里装饰整层画在拼块之上）
    floorU[FLOOR_DECOR_OFFSET] = DECOR_WORLD;
    floorU[FLOOR_DECOR_OFFSET + 1] = 1;
    floorBuf.write(floorU, 0);
    // 量级切换时换绑装饰贴图（贴图按量级缓存，只在真正换关那帧改绑定）
    if (boundDecor !== rs.idx) {
      boundDecor = rs.idx;
      floorFx.set({ decor: decorFor(rs.idx) });
    }

    // 精灵
    spriteU[0] = size[0]; spriteU[1] = size[1]; spriteU[2] = atlasInfo.cols; spriteU[3] = atlasInfo.rows;
    spriteBuf.write(spriteU, 0);

    collect(rs, w);
    // 写实例流：注意必须用 buffers[1]（实例流），Geometry.write() 写的是 vertex buffer 0
    // （那个只有 8 个 float 的角点缓冲），会以「超出容量」被拒。
    if (instCount > 0) {
      spriteInstBuf.write(instData.subarray(0, instCount * FLOATS_PER_INSTANCE), 0);
    }

    // 龙卷风：以风眼为中心，向上覆盖锥体高度（全部设备像素）
    const r = Math.max(3, rs.screenR) * pxRatio;
    const h = r * 2.1;
    const tcx = rs.sx * pxRatio;
    const tcy = rs.sy * pxRatio;
    tornadoU[0] = tcx; tornadoU[1] = tcy;
    tornadoU[2] = size[0]; tornadoU[3] = size[1];
    tornadoU[4] = r; tornadoU[5] = h;
    tornadoU[6] = w.time; tornadoU[7] = 1;
    tornadoBuf.write(tornadoU, 0);

    // 龙卷风的绘制区间：只覆盖它真正占用的矩形，其余片元不参与着色
    const pad = r * 0.45;
    const bx0 = Math.max(0, Math.floor(tcx - r * 1.05 - pad));
    const by0 = Math.max(0, Math.floor(tcy - h - pad));
    const bx1 = Math.min(size[0], Math.ceil(tcx + r * 1.05 + pad));
    const by1 = Math.min(size[1], Math.ceil(tcy + r * 0.35 + pad));
    const tornadoClip: [number, number, number, number] = [bx0, by0, Math.max(1, bx1 - bx0), Math.max(1, by1 - by0)];

    // 合成：风眼擦除遮罩 + 暗角
    const wipe = wipeStatesFor(rs);
    compU[0] = size[0]; compU[1] = size[1];
    // 半径换算到设备像素并夹到跨度内：达到跨度即「完全铺满」，与 Canvas 同语义
    const spanPx = WIPE_SPAN * pxRatio;
    compU[2] = rs.zooming ? Math.min(wipe.current.radius * pxRatio, spanPx) : spanPx;
    compU[3] = wipe.current.invert ? 1 : 0;
    compU[4] = 0.72;
    compU[5] = vignetteAlpha();
    compU[6] = wipe.current.alpha;
    compU[7] = nar.cine;
    compU[8] = spanPx;
    compU[9] = 0;
    // 底色 = 当前量级的地面暗色（Canvas 的 TIERS[idx].ground[1]）：
    // 转场淡出与地表之外的缝隙都露出它，而不是页面白。
    // 偏移 12 起是一个 vec4（WGSL 要求 16 字节对齐），与 base: vec4f 对应。
    const g = TIERS[Math.min(rs.idx, TIERS.length - 1)].ground[1];
    const [br, bg, bb] = hexRgb(g);
    compU[12] = br / 255; compU[13] = bg / 255; compU[14] = bb / 255; compU[15] = 1;
    compBuf.write(compU, 0);

    drawOverlay(rs, w, nar);
    if (overlayFx && overlayInstBuf) {
      overlayInst[0] = size[0] / 2; overlayInst[1] = size[1] / 2;
      overlayInst[2] = size[0] / 2; overlayInst[3] = size[1] / 2;
      overlayInst[4] = 0; overlayInst[5] = K_TEXTURE; overlayInst[6] = 1; overlayInst[7] = 0;
      overlayInst[8] = 1; overlayInst[9] = 1; overlayInst[10] = 1; overlayInst[11] = 0;
      overlayInst[12] = 0; overlayInst[13] = 0; overlayInst[14] = 0; overlayInst[15] = 0;
      overlayInst[16] = 0.5; overlayInst[17] = 0.5; overlayInst[18] = 1; overlayInst[19] = 1;
      overlayInstBuf.write(overlayInst, 0);
    }

    vgpuFrame(gpu, (f) => {
      f.pass({ target: scene, clear: [0, 0, 0, 0] }, floorFx);
      if (instCount > 0) {
        f.pass({ target: scene, clear: false }, (p) => p.draw(spriteFx, { instances: instCount }));
      }
      f.pass({ target: scene, clear: false, scissor: tornadoClip }, (p) => p.draw(tornadoFx));
      // 合成（含过场信箱边条与暗角）先落到画布，字卡再叠在最上层——
      // 否则字幕会被信箱条压住，读者只看到半行字。
      f.pass({ target: surface, clear: [0, 0, 0, 0] }, compositeFx);
      const ov = overlayVisible ? overlayFx : null;
      if (ov) f.pass({ target: surface, clear: false }, (p) => p.draw(ov, { instances: 1 }));
    });
  }

  /**
   * 地貌格边长（世界单位）：与 Canvas 路径的 size = clamp(150/s, 96, 420) 同式。
   * 地貌种类由世界坐标在该网格上的整数索引哈希决定（biomeKind(cx, cy, tier)），
   * 两个后端因此铺出同一片地貌。
   */
  function biomeCellWorld(scale: number): number {
    const s = Math.max(scale, 1e-4);
    return Math.min(420, Math.max(96, 150 / s));
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try { overlayGeo?.destroy(); } catch { /* 释放顺序不影响退出 */ }
    gpu.dispose();
  }

  rebuildOverlayDraw();

  return {
    render,
    resize,
    dispose,
    get viewSize() { return TORNADO_VIEW; },
  };
}

/* ── 调色板 ──────────────────────────────────────────── */

/**
 * 把各量级的地表配色写进地表 uniform 的 cols 数组。
 * 布局：前 16 个 float 是标量/向量字段，之后是 TIERS.length × 5 个 vec4。
 */
export function fillPalette(buf: Float32Array, tiers: readonly unknown[], ground: readonly GroundCol[]): void {
  const off = FLOOR_PALETTE_OFFSET;
  for (let t = 0; t < tiers.length; t++) {
    const g = ground[Math.min(t, ground.length - 1)];
    const order = [g.base, g.arable, g.forest, g.town, g.water];
    for (let k = 0; k < PALETTE_SLOTS; k++) {
      const [r, gg, b] = hexRgb(order[k]);
      const o = off + (t * PALETTE_SLOTS + k) * 4;
      buf[o] = r; buf[o + 1] = gg; buf[o + 2] = b; buf[o + 3] = 1;
    }
  }
}

/** 把网格线颜色（CSS rgba/hex）写进地表 uniform */
export function writeGridColor(buf: Float32Array, css: string): void {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return;
  const parts = m[1].split(',').map((v) => parseFloat(v.trim()));
  buf[FLOOR_GRIDCOL_OFFSET] = parts[0] ?? 0;
  buf[FLOOR_GRIDCOL_OFFSET + 1] = parts[1] ?? 0;
  buf[FLOOR_GRIDCOL_OFFSET + 2] = parts[2] ?? 0;
  buf[FLOOR_GRIDCOL_OFFSET + 3] = parts[3] ?? 1;
}

/* ── 小工具 ──────────────────────────────────────────── */

function ease(t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexRgb(h: string): [number, number, number] {
  const s = h.charAt(0) === '#' ? h.slice(1) : h;
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
