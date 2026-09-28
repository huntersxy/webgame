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
  TORNADO_VIEW, TIERS, GROUND, WIPE_SPAN, wipeStatesFor, vignetteAlpha, TILT_COS,
  type GroundCol, type Obj, type Particle, type Ring, type Terrain, type TornadoRenderState,
} from '../game';
import { buildAtlas, glyphsFor, type Atlas } from './atlas';
import { SUN_DIR, sunViewProj, tornadoViewProj } from './camera';
import { CG_FINALE_WGSL, CG_INTRO_WGSL } from './cg';
import { buildDecorCanvas, DECOR_PX, DECOR_WORLD } from './decor';
import { createDebrisLayer, type DebrisLayer } from './debris';
import { DEBRIS_MAX } from './mesh-shaders';
import { createDecalLayer, createMeshLayer, MESH_BOX, MESH_CONE, MESH_FUNNEL, type DecalLayer, type MeshLayer } from './meshes';
import {
  SCENE_CAM_OFFSET, SCENE_FOG_OFFSET, SCENE_PARAMS_OFFSET, SCENE_SUN_OFFSET,
  SCENE_SUNVP_OFFSET, SCENE_UNIFORM_FLOATS, SCENE_VIEWPROJ_OFFSET,
} from './mesh-shaders';
import { BLOOM_WGSL, COMPOSITE_MAIN_WGSL, FLOOR_WGSL, SPRITE_WGSL } from './shaders';

/* 实例里 kind 字段的取值，与 SPRITE_WGSL 的分支一一对应。
   1 / 2（圆角矩形及其描边）在立体化之后不再使用——物体底座已改为真实网格，
   贴地的圆形与三角仍在用。 */
const K_TEXTURE = 0;
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
/**
 * cols 数组之后：decorWorld, decorMix, tiltSin, shadowStrength 共 4 个 float。
 * 随后是 sunViewProj(mat4x4f)，WGSL 要求 16 字节对齐 —— 偏移正好落在 16 的倍数上，
 * 无需额外填充。整块 = 4 + 4 + 6*5*4 + 4 + 16 = 148 个 float。
 */
const FLOOR_DECOR_OFFSET = FLOOR_PALETTE_OFFSET + TIERS.length * PALETTE_SLOTS * 4;
const FLOOR_SUNVP_OFFSET = FLOOR_DECOR_OFFSET + 4;
/**
 * sunViewProj(mat4x4f) 之后：sunDir(vec4) + relief(vec4) = 8 个 float。
 * 两者都是 vec4，天然 16 字节对齐，接在 mat4 之后无需填充。
 */
const FLOOR_SUNDIR_OFFSET = FLOOR_SUNVP_OFFSET + 16;
const FLOOR_RELIEF_OFFSET = FLOOR_SUNDIR_OFFSET + 4;
const FLOOR_UNIFORM_FLOATS = FLOOR_RELIEF_OFFSET + 4;

/**
 * 阴影正交盒要罩住的最大建筑高度（世界单位）。
 * 取得比实际最高建筑略大即可：盒子越大，同样的阴影贴图分辨率下阴影越糊。
 */
const MAX_BUILD_HEIGHT = 140;
/** 阴影贴图边长（设备像素） */
const SHADOW_SIZE = 1024;

/* ── 地表质感参数 ──────────────────────────────────────── */

/**
 * 地面起伏强度。地面占画面九成以上，纯色格子加多少颜色都还是「平的」；
 * 这一层用 fbm 高度场求法线，按太阳方向出明暗，才有地貌的体积感。
 * 必须克制：求法线的差分对噪声极敏感，强度偏大时地面会退化成电视雪花。
 * 0.28 左右是「看得出起伏、又不像噪声」。
 */
const GROUND_RELIEF = 0.28;
/**
 * 地貌边界过渡宽度（格内归一化距离）。硬边的色块正是「像色板」的直接原因，
 * 在边界附近把相邻地貌混起来就消掉了。0.22 只影响边界一带。
 */
const GROUND_BLEND = 0.22;
/**
 * 水面高光强度。实测（REL=0.28 下统计近白像素占比）：
 * 0.85 → 7.6% 的像素被冲白（水面读成白云），0.45 → 2.7%，0.25 → 0%。
 * 取 0.40：有明确的反光带，又不至于整片过曝。
 */
const WATER_SPECULAR = 0.40;

/* ── 后期参数 ──────────────────────────────────────────── */

/** 泛光强度：过高会让浅色地表糊成一片，0.34 左右是「发光但不刺眼」 */
const BLOOM_STRENGTH = 0.30;
/**
 * 亮部阈值。地表是明亮粉彩（亮度常在 0.7~0.85），阈值必须明显高于它，
 * 否则整片地面都算亮部，泛光退化成给全屏加白。
 * 0.90 只留下高光、碎屑与龙卷风边缘。
 */
const BLOOM_THRESHOLD = 0.90;
/** 软膝：阈值附近的过渡宽度，避免出现硬边光斑 */
const BLOOM_KNEE = 0.22;
/** 模糊半径倍数（纹素）：半分辨率上 1.6 约等于全分辨率的 3px 柔光 */
const BLOOM_RADIUS = 1.6;
/**
 * 移轴景深强度。俯视视角下这一项把画面读成「微缩模型」，
 * 是收益最高的一招；0 即关闭。
 * 但要克制：虚化区里放着的正是玩家要吃的东西，糊过头就没法玩了。
 */
const DOF_AMOUNT = 0.62;
/** 聚焦带半高（归一化屏幕高度 0..1）：带内保持锐利。
 *  0.55 表示屏幕中间约 55% 高度完全清晰，只有最上下缘才明显虚化。 */
const DOF_BAND = 0.55;
/** 过渡带宽度：从清晰到最糊的过渡距离 */
const DOF_FALLOFF = 0.45;

export interface GpuWorld {
  objects: Obj[];
  terrain: Terrain[];
  particles: Particle[];
  rings: Ring[];
  tier: number;
  time: number;
  /** 龙卷风的世界位置与半径（网格漏斗要用世界坐标，不能只给屏幕位置） */
  tornadoX: number;
  tornadoY: number;
  tornadoR: number;
  /** 冲刺特效强度 0..1（漏斗会随之拉长） */
  dashFx: number;
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

  /**
   * 场景目标带深度附件：立体网格需要深度测试才能正确互相遮挡。
   * 格式 rgba8unorm（不用 HDR：本机核显上 rgba16float + MSAA 的填充率代价
   * 换来的收益有限，泛光改为在合成阶段按阈值提取亮部实现）。
   */
  const scene: Target = vgpuTarget(gpu, {
    size, format: 'rgba8unorm', depth: 'depth24plus', label: 'tornado-scene',
  });

  /* ── 阴影贴图（独立深度目标，只用于投影） ─────────────── */

  const shadowTarget: Target = vgpuTarget(gpu, {
    size: [SHADOW_SIZE, SHADOW_SIZE], format: 'rgba8unorm', depth: 'depth32float', label: 'tornado-shadow-map',
  });
  const shadowMatrix = new Float32Array(16);
  const shadowBuf: Buffer = gpu.device.createBuffer({
    size: 16 * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-shadow-u',
  });
  const shadowSamp = vgpuSampler(gpu, { compare: 'less-equal' });

  /* ── uniform 缓冲（core Buffer：可写原始字节） ───────── */

  const floorBuf: Buffer = gpu.device.createBuffer({
    size: FLOOR_UNIFORM_FLOATS * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-floor-u',
  });
  const spriteBuf: Buffer = gpu.device.createBuffer({
    size: 4 * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-sprite-u',
  });
  // 龙卷风漏斗现在是立体网格（见 meshes.ts），不再需要全屏 SDF 的 uniform。

  const compBuf: Buffer = gpu.device.createBuffer({
    // 20 个 float = 80 字节，与 WGSL 的 CompU 结构体等大
    size: 20 * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-comp-u',
  });
  /**
   * 泛光 uniform：**每趟一个独立缓冲**。
   *
   * 不能三趟共用一个缓冲再逐趟改写：`set()`/`Buffer.write()` 底层是
   * `queue.writeBuffer`，它在提交前就全部生效，而三个 pass 是提交后才执行的——
   * 于是三趟都会读到最后一次写入的值（提取模式被当成模糊模式），
   * 泛光结果整片糊白。一个缓冲配一趟，内容才是各自想要的。
   */
  const bloomBufs: Buffer[] = [0, 1, 2].map((i) => gpu.device.createBuffer({
    size: 8 * 4, usage: ['uniform', 'copy_dst'], label: `tornado-bloom-u${i}`,
  }));
  const cgBuf: Buffer = gpu.device.createBuffer({
    size: 8 * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-cg-u',
  });
  /** 立体网格的场景 uniform：主相机 + 太阳矩阵 + 光照/雾参数 */
  const sceneBuf: Buffer = gpu.device.createBuffer({
    size: SCENE_UNIFORM_FLOATS * 4, usage: ['uniform', 'copy_dst'], label: 'tornado-scene-u',
  });

  const floorU = new Float32Array(FLOOR_UNIFORM_FLOATS);
  const spriteU = new Float32Array(4);

  const compU = new Float32Array(20);
  const cgU = new Float32Array(8);
  const sceneU = new Float32Array(SCENE_UNIFORM_FLOATS);
  fillPalette(floorU, TIERS, GROUND);

  /* ── 立体网格层（物体底座 / 地形障碍 / 龙卷风锥体） ──── */

  const meshes: MeshLayer = createMeshLayer(gpu, {
    sceneBuf,
    shadowBuf,
    shadowDepth: shadowTarget.depth,
    atlasTex,
  });
  const decals: DecalLayer = createDecalLayer(gpu, {
    sceneBuf,
    shadowBuf,
    shadowDepth: shadowTarget.depth,
    atlasTex,
  });
  /** 碎屑：compute 推进 + 顶点阶段读 storage，CPU 每帧只写 48 字节 uniform */
  const debris: DebrisLayer = createDebrisLayer(gpu, sceneBuf, shadowTarget.depth);

  /* ── 泛光目标：半分辨率 ping-pong（提取 → 横糊 → 纵糊） ── */

  const bloomSize: [number, number] = [
    Math.max(1, Math.floor(size[0] / 2)),
    Math.max(1, Math.floor(size[1] / 2)),
  ];
  const bloomA: Target = vgpuTarget(gpu, { size: bloomSize, format: 'rgba8unorm', label: 'tornado-bloom-a' });
  const bloomB: Target = vgpuTarget(gpu, { size: bloomSize, format: 'rgba8unorm', label: 'tornado-bloom-b' });

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

  // 全屏地表与合成现在是**显式 draw**（带顶点阶段）并关掉深度：
  // effect 自带的顶点阶段输出 z=0（最近），会挡住带深度的立体网格。
  // 无顶点缓冲的 draw：顶点阶段完全靠 @builtin(vertex_index) 定位。
  const fullscreenGeo: Geometry = vgpuGeometry(gpu, {
    buffers: [],
    vertexCount: 3,
    topology: 'triangle-list',
    instanceCount: 1,
    label: 'tornado-fullscreen',
  });

  const floorFx: Draw = vgpuDraw(gpu, {
    shader: FLOOR_WGSL, geometry: fullscreenGeo, depth: false,
    label: 'tornado-floor',
    set: {
      u: floorBuf, decor: decorFor(0), decorSamp: repeatSampler,
      shadowMap: shadowTarget.depth, shadowSamp,
    },
  });

  const spriteFx: Draw = vgpuDraw(gpu, {
    shader: SPRITE_WGSL, geometry: spriteGeo, blend: 'alpha', depth: false, label: 'tornado-sprite',
    set: { u: spriteBuf, atlas: atlasTex, samp: nearestSampler },
  });

  const compositeFx: Effect = vgpuEffect(gpu, COMPOSITE_MAIN_WGSL, {
    label: 'tornado-composite',
    set: { u: compBuf, src: scene, samp: linearSampler, bloomTex: bloomA, bloomSamp: linearSampler },
  });

  /* ── 泛光：半分辨率的提取 + 两趟可分离模糊 ────────────── */

  // 三趟各用一支 Effect 实例（绑定各自的 uniform 缓冲），避免共享状态被覆盖
  const bloomExtractFx: Effect = vgpuEffect(gpu, BLOOM_WGSL, {
    label: 'tornado-bloom-extract',
    set: { b: bloomBufs[0], bsrc: scene, bsamp: linearSampler },
  });
  const bloomBlurXFx: Effect = vgpuEffect(gpu, BLOOM_WGSL, {
    label: 'tornado-bloom-blur-x',
    set: { b: bloomBufs[1], bsrc: bloomA, bsamp: linearSampler },
  });
  const bloomBlurYFx: Effect = vgpuEffect(gpu, BLOOM_WGSL, {
    label: 'tornado-bloom-blur-y',
    set: { b: bloomBufs[2], bsrc: bloomB, bsamp: linearSampler },
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
    // 泛光目标是半分辨率，跟着场景一起改尺寸
    const half: [number, number] = [Math.max(1, Math.floor(size[0] / 2)), Math.max(1, Math.floor(size[1] / 2))];
    bloomSize[0] = half[0]; bloomSize[1] = half[1];
    bloomA.resize(half);
    bloomB.resize(half);
    // Target.resize 会重建纹理对象，所有绑定过它们的 Effect 都要重新指认，
    // 否则会继续采样已被销毁的旧视图（画面直接变黑）。
    compositeFx.set({ src: scene, bloomTex: bloomA });
    bloomExtractFx.set({ bsrc: scene });
    bloomBlurXFx.set({ bsrc: bloomA });
    bloomBlurYFx.set({ bsrc: bloomB });
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
   * 上一帧的世界时间，用来推导碎屑模拟的 dt。
   * 渲染器不持有帧时钟（vgpu 的 clock 只给 GPU 侧），而 world.time 由模拟层
   * 按真实 dt 累加，所以它的差分就是最准确的帧间隔，不必改接口传参。
   */
  let lastDebrisTime = -1;

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
    meshes.begin();
    decals.begin();
    const s = rs.floorScale;
    // 倾斜正交：横向比例尺 s，纵向 s·sinθ。与 Canvas 路径同一支变换。
    const sy = s * rs.tiltSin;
    const cx0 = rs.floorCam.x;
    const cy0 = rs.floorCam.y;
    // 世界 → 逻辑屏幕坐标（与 Canvas 路径同一支变换）
    const toX = (wx: number): number => TORNADO_VIEW / 2 + (wx - cx0) * s;
    const toY = (wy: number): number => TORNADO_VIEW / 2 + (wy - cy0) * sy;
    /** 立着的图元要抵消地面压扁，否则 emoji 会被拉扁 */
    const upright = 1 / Math.max(rs.tiltSin, 1e-4);

    // ① 地形障碍：立体网格（山 = 锥、巨石 = 盒、林 = 锥簇、湖 = 贴地水面）
    const ts = rs.tiltSin;
    for (const t of w.terrain) {
      const sx = toX(t.x);
      const sy = toY(t.y);
      const sr = t.r * s;
      if (!visible(sx, sy, sr * 3)) continue;
      // 接触阴影：贴地椭圆，让障碍"坐"在地面上
      push(sx, sy + sr * 0.72 * ts, sr * 0.92, sr * 0.28 * ts, 0, K_ELLIPSE, 0.16, rgb(28, 43, 51), 0, 0, 0, 0, 0, 0);
      pushTerrainMesh(t);
      pushTerrain(t, sx, sy, sr, ts);
    }

    // ② 物体：真实立体底座 + 顶面 emoji 贴花
    //    （被卷起的仍走广告牌：它在飞向风眼，平面贴图反而更自然）
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
          push(px, py, half, half * upright, ang * 0.8, K_TEXTURE, 1, rgb(255, 255, 255), 0, 0, slot.u, slot.v, slot.du, slot.dv);
        }
        continue;
      }

      const sx = toX(o.x);
      const sy = toY(o.y);
      const half = o.r * 1.15 * s;
      if (!visible(sx, sy, half * 2.4)) continue;

      // 底座：盒体，宽深按物体半径，高度按「层级」给——
      // 低量级的小物件是矮墩、高量级的大建筑是高楼，体量自然拉开。
      //
      // 高度必须是屏幕像素的函数，不能只跟世界半径走：实测各量级的
      // 屏幕尺寸其实**恒定**（camScale = 22/r 抵消了 r），所以
      // bh = 0.95r 在每一关都只有约 10px 高的侧面——底座退化成一条白边，
      // 看上去仍是一张白卡片。改成按屏幕半径反推世界高度，
      // 让侧面稳定落在约 20px（物体自身高度的三分之一），才读得出是个「台子」。
      const bw = o.r * 1.9;
      const bd = o.r * 1.55;
      const screenR = o.r * s;                       // 该物体在屏幕上的半径（逻辑像素）
      const bh = Math.min(o.r * 1.9, (screenR * 0.62) / Math.max(TILT_COS, 1e-3) / s);
      // 台身用偏灰的「石/木」色而不是近白：白台面配 emoji 就是一张卡片，
      // 压暗一点才有材质感，也让顶面贴花更跳。
      const cr = edible ? 0.80 : 0.66;
      const cg = edible ? 0.79 : 0.64;
      const cb = edible ? 0.74 : 0.60;
      meshes.add(MESH_BOX, o.x, o.y, bh * 0.5, bw, bd, bh, cr, cg, cb);

      // 顶面贴花：emoji 躺在底座顶上，随视角一起透视压缩
      if (slot) {
        decals.add(
          o.x, o.y, bh + 0.02,
          o.r * 1.55,
          slot.u, slot.v, slot.du, slot.dv,
          1, 1, 1, 1,
        );
      }

      // 不可食：底边加一圈灰描边（用贴地椭圆环表示），提示「现在还卷不动」
      if (!edible) {
        push(sx, sy, o.r * 1.02 * s, o.r * 0.82 * s * rs.tiltSin, 0, K_ELLIPSE_RING, 0.5, rgb(150, 130, 120), 0.06, 0, 0, 0, 0, 0);
      }
    }

    // ③ 环与粒子（都在地面平面上，纵向同样乘 tiltSin）
    for (const rg of w.rings) {
      const sx = toX(rg.x);
      const sy = toY(rg.y);
      const sr = Math.max(0.5, rg.r * s);
      if (!visible(sx, sy, sr * 1.4)) continue;
      const a = Math.max(0, rg.life / 0.45) * rg.c.a;
      // 线宽 3px → 占半径的比例（着色器按归一化半径算环宽）
      push(sx, sy, sr, sr * ts, 0, K_ELLIPSE_RING, a, rg.c, Math.min(0.9, 1.5 / Math.max(sr, 1)), 0, 0, 0, 0, 0);
    }
    for (const p of w.particles) {
      const sx = toX(p.x);
      const sy = toY(p.y);
      const sr = Math.max(0.5, p.sz * s);
      if (!visible(sx, sy, sr * 2)) continue;
      const a = Math.max(0, p.life / p.max) * p.c.a;
      push(sx, sy, sr, sr, 0, K_ELLIPSE, a, p.c, 0, 0, 0, 0, 0, 0);
    }

    // ④ 龙卷风漏斗：真实立体网格，走深度与光照，会遮挡城市也被城市遮挡。
    //
    //    高宽比是算出来的：龙卷风的**屏幕**半径被设计成各量级恒定（约 22px），
    //    所以 th ∝ tr 时屏幕高度也恒定。屏幕高 = th·camScale·cosθ，
    //    屏幕宽 = 2·tr·0.95·camScale，代入 camScale = 22/tr：
    //      th = 9r  → 高 ≈ 99px、宽 ≈ 42px ≈ 2.4:1（实拍龙卷风大致就是这个比例）
    //      th = 13r → 3.4:1，屏幕上显得又细又长，像一缕烟
    //    取 9r。早先用 5r/1.15r 只有 1.1:1，整个糊成竖椭圆。
    const tr = Math.max(1, w.tornadoR);
    const th = tr * 9 * (1 + w.dashFx * 0.18);
    meshes.add(MESH_FUNNEL, w.tornadoX, w.tornadoY, 0, tr * 1.0, tr * 1.0, th, 1, 1, 1);

    // ⑤ 碎屑：粒子数随半径增长（最多 DEBRIS_MAX），推进与定位都在 GPU 上。
    //    这里只更新 uniform，不碰粒子数据。
    const dt = Math.max(0, Math.min(0.05, w.time - lastDebrisTime));
    lastDebrisTime = w.time;
    debris.update({
      x: w.tornadoX,
      y: w.tornadoY,
      radius: tr * 1.15,
      height: th,
      // 碎屑的屏幕尺寸跟随龙卷风在屏幕上的半径，而不是世界半径——
      // 否则高量级（世界半径上百）时每块碎屑会盖住整个屏幕。
      size: Math.max(2, rs.screenR * 0.22 * pxRatio),
      viewW: size[0],
      viewH: size[1],
      time: w.time,
      dt,
      // 半径越大碎屑越多：小街道上是几粒尘，全地球时是漫天碎块
      count: Math.min(DEBRIS_MAX, Math.round(28 + tr * 1.6)),
    });
  }

  /**
   * 地形障碍的立体部分。
   *   山   → 三座锥体（保留原来「三峰 + 雪顶」的构图）
   *   巨石 → 三块叠放的盒体
   *   林   → 一簇锥体（树冠）
   *   湖   → 只画贴地水面（见 pushTerrain），不产生立体
   */
  function pushTerrainMesh(t: Terrain): void {
    const rnd = mulberry32((t.seed * 1000) | 0);
    switch (t.kind) {
      case 'mount': {
        const peaks: Array<[number, number, number]> = [
          [-0.42, 1.15, 0.75], [0.05, 1.5, 0.95], [0.55, 1.0, 0.65],
        ];
        for (const [dx, ph, pw] of peaks) {
          const h = t.r * ph;
          // 山体：锥体底面半径 t.r·pw，高 h
          meshes.add(MESH_CONE, t.x + t.r * dx, t.y, h * 0.5, t.r * pw * 2, t.r * pw * 2, h, 0.50, 0.55, 0.59);
          // 雪顶：同轴再叠一个小锥，位置抬高到接近山顶
          meshes.add(MESH_CONE, t.x + t.r * dx, t.y, h * 0.62, t.r * pw * 0.5, t.r * pw * 0.5, h * 0.76, 0.93, 0.96, 0.97);
        }
        break;
      }
      case 'boulder': {
        const rocks: Array<[number, number, number]> = [
          [0, 0, 0.72], [-0.55, 0.18, 0.45], [0.5, 0.22, 0.38],
        ];
        for (const [dx, dy, rr] of rocks) {
          const w = t.r * rr * 2;
          meshes.add(MESH_BOX, t.x + t.r * dx, t.y + t.r * dy, w * 0.35, w, w * 0.9, w * 0.7, 0.55, 0.59, 0.62);
        }
        break;
      }
      case 'forest': {
        for (let i = 0; i < 7; i++) {
          const a = rnd() * Math.PI * 2;
          const dd = rnd() * t.r * 0.62;
          const rr = t.r * (0.3 + rnd() * 0.22);
          const h = rr * 2.4;
          meshes.add(
            MESH_CONE,
            t.x + Math.cos(a) * dd, t.y + Math.sin(a) * dd * 0.8, h * 0.5,
            rr * 2, rr * 2, h,
            i % 2 ? 0.36 : 0.30, i % 2 ? 0.55 : 0.48, i % 2 ? 0.38 : 0.32,
          );
        }
        break;
      }
      default:
        break;   // 湖不产生立体
    }
  }

  /** 地形障碍形状：湖 / 巨石 / 山 / 森林（与 drawTerrain 的图元对应） */
  function pushTerrain(t: Terrain, sx: number, sy: number, sr: number, ts: number): void {
    switch (t.kind) {
      case 'lake': {
        // 湖面：扁椭圆 + 亮色岸线（Canvas 用 ellipse + stroke）
        push(sx, sy, sr, sr * 0.72 * ts, 0.3, K_ELLIPSE, 1, rgb(125, 180, 214), 0, 0, 0, 0, 0, 0);
        push(sx, sy, sr, sr * 0.72 * ts, 0.3, K_ELLIPSE_RING, 0.8, rgb(235, 246, 250), 0.055, 0, 0, 0, 0, 0);
        break;
      }
      case 'boulder': {
        // 巨石：三块叠在一起的岩体 + 左上高光（Canvas 用三个 ellipse + 高光弧）
        const rocks: Array<[number, number, number]> = [
          [0, 0, 0.72], [-0.55, 0.18, 0.45], [0.5, 0.22, 0.38],
        ];
        for (const [dx, dy, rr] of rocks) {
          push(sx + sr * dx, sy + sr * dy * ts, sr * rr, sr * rr * 0.86 * ts, 0, K_ELLIPSE, 1, rgb(141, 151, 158), 0, 0, 0, 0, 0, 0);
          push(sx + sr * (dx - rr * 0.25), sy + sr * (dy - rr * 0.35) * ts, sr * rr * 0.45, sr * rr * 0.28 * ts, -0.5, K_ELLIPSE, 0.28, rgb(255, 255, 255), 0, 0, 0, 0, 0, 0);
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
          const cyA = sy + sr * 0.5 * ts - halfH * ts;
          // 山体：顶点高度按 ph 换算成包围盒比例（高度同样随视角压缩）
          push(sx + sr * dx, cyA, sr * pw, halfH * ts, 0, K_TRIANGLE, 1, rgb(127, 140, 150), 1, 0, 0, 0, 0, 0);
          // 雪顶：叠一个较小的三角形，顶点同高
          push(sx + sr * dx, cyA + halfH * ts * 0.24, sr * pw * 0.26, halfH * ts * 0.76, 0, K_TRIANGLE, 1, rgb(238, 244, 247), 1, 0, 0, 0, 0, 0);
        }
        break;
      }
      case 'forest': {
        const rnd = mulberry32((t.seed * 1000) | 0);
        for (let i = 0; i < 7; i++) {
          const a = rnd() * Math.PI * 2;
          const dd = rnd() * sr * 0.62;
          const rr = sr * (0.3 + rnd() * 0.22);
          push(sx + Math.cos(a) * dd, sy + Math.sin(a) * dd * 0.8 * ts, rr, rr * ts, 0, K_ELLIPSE, 1,
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
    // 纵向压缩：地表着色器用它把屏幕 y 还原成世界 y（倾斜正交的逆）
    floorU[FLOOR_DECOR_OFFSET + 2] = rs.tiltSin;
    floorU[FLOOR_DECOR_OFFSET + 3] = 1;   // 阴影强度
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
    meshes.upload();
    decals.upload();

    /* ── 相机与光照 ──────────────────────────────────────── */

    // 主相机：与 game.ts 那条二维投影式严格等价（只是补上了 z 轴）。
    // 深度范围取 ±一个世界跨度：相机在场景内部，视线深度有正有负，
    // 范围不够会把相机附近的地面整片裁掉。
    const depthSpan = TORNADO_VIEW / rs.floorScale * 2.5;
    const vp = tornadoViewProj(
      rs.floorCam, rs.floorScale * pxRatio, size[0],
      rs.tiltSin, TILT_COS, -depthSpan, depthSpan,
    );
    sceneU.set(vp, SCENE_VIEWPROJ_OFFSET);

    // 太阳正交投影：只罩住当前屏幕可见的地面范围 + 最大建筑高度，
    // 范围取得越紧，同样的贴图分辨率下阴影越锐利。
    const halfW = TORNADO_VIEW / (2 * rs.floorScale);
    const halfH = TORNADO_VIEW / (2 * rs.floorScale * rs.tiltSin);
    const sunVP = sunViewProj(rs.floorCam, halfW, halfH, MAX_BUILD_HEIGHT);
    sceneU.set(sunVP, SCENE_SUNVP_OFFSET);
    // 地面也要这份太阳矩阵才能接收阴影
    floorU.set(sunVP, FLOOR_SUNVP_OFFSET);
    // 地面起伏用同一支太阳方向，明暗才与立体物体一致
    floorU[FLOOR_SUNDIR_OFFSET] = SUN_DIR[0];
    floorU[FLOOR_SUNDIR_OFFSET + 1] = SUN_DIR[1];
    floorU[FLOOR_SUNDIR_OFFSET + 2] = SUN_DIR[2];
    floorU[FLOOR_SUNDIR_OFFSET + 3] = 0.62;
    // 起伏强度 / 地貌过渡宽度 / 水面高光 / 时间（水波流动用）
    floorU[FLOOR_RELIEF_OFFSET] = GROUND_RELIEF;
    floorU[FLOOR_RELIEF_OFFSET + 1] = GROUND_BLEND;
    floorU[FLOOR_RELIEF_OFFSET + 2] = WATER_SPECULAR;
    floorU[FLOOR_RELIEF_OFFSET + 3] = w.time;
    floorBuf.write(floorU, 0);

    sceneU[SCENE_CAM_OFFSET] = rs.floorCam.x;
    sceneU[SCENE_CAM_OFFSET + 1] = rs.floorCam.y;
    sceneU[SCENE_CAM_OFFSET + 2] = 0;
    sceneU[SCENE_CAM_OFFSET + 3] = 0;
    sceneU[SCENE_SUN_OFFSET] = SUN_DIR[0];
    sceneU[SCENE_SUN_OFFSET + 1] = SUN_DIR[1];
    sceneU[SCENE_SUN_OFFSET + 2] = SUN_DIR[2];
    sceneU[SCENE_SUN_OFFSET + 3] = 0.62;              // 环境光强度
    sceneU[SCENE_PARAMS_OFFSET] = 1;                  // 阴影强度
    sceneU[SCENE_PARAMS_OFFSET + 1] = 1 / SHADOW_SIZE; // 阴影贴图纹素（PCF 步长）
    sceneU[SCENE_PARAMS_OFFSET + 2] = w.time;          // 时间（漏斗旋转螺纹用）
    sceneU[SCENE_PARAMS_OFFSET + 3] = 0.16;           // 雾强度（只做轻微空气透视）
    const fogCol = hexRgb(TIERS[Math.min(rs.idx, TIERS.length - 1)].ground[0]);
    sceneU[SCENE_FOG_OFFSET] = fogCol[0] / 255 * 0.92;
    sceneU[SCENE_FOG_OFFSET + 1] = fogCol[1] / 255 * 0.94;
    sceneU[SCENE_FOG_OFFSET + 2] = fogCol[2] / 255 * 0.98;
    sceneU[SCENE_FOG_OFFSET + 3] = TORNADO_VIEW / rs.floorScale * 1.1;  // 雾最远处（世界单位）
    sceneBuf.write(sceneU, 0);
    shadowMatrix.set(sunVP);
    shadowBuf.write(shadowMatrix, 0);

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
    compU[9] = BLOOM_STRENGTH;      // 泛光强度
    compU[10] = DOF_AMOUNT;         // 移轴景深强度
    compU[11] = 0;
    compU[16] = DOF_BAND;           // 聚焦带半高（归一化屏幕高度）
    compU[17] = DOF_FALLOFF;        // 过渡带宽度
    compU[18] = 0; compU[19] = 0;
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
      // ① 阴影：只写深度，先把所有立体网格的投影烘进阴影贴图
      f.pass({ target: shadowTarget, clear: [1, 1, 1, 1], clearDepth: 1 }, (p) => {
        meshes.drawShadow(p);
      });
      // ② 场景：地表（关深度）→ 立体网格（含龙卷风漏斗）→ emoji 贴花 → 精灵
      f.pass({ target: scene, clear: [0, 0, 0, 0] }, (p) => p.draw(floorFx));
      f.pass({ target: scene, clear: false }, (p) => {
        meshes.drawColor(p);
        decals.drawColor(p);
        if (instCount > 0) p.draw(spriteFx, { instances: instCount });
        // 碎屑最后画：它是半透明薄片，且不写深度，压在场景之上最自然
        debris.drawColor(p);
      });
      // ③ 泛光：从场景提取亮部 → 横向模糊 → 纵向模糊（全在半分辨率上）。
      //    三趟各有独立的 uniform 缓冲，内容在提交前一次性写好。
      if (BLOOM_STRENGTH > 0.001) {
        const bw = bloomSize[0];
        const bh = bloomSize[1];
        // 提取：源 = 场景（全分辨率），目标 = bloomA
        bloomBufs[0].write(new Float32Array([
          1 / size[0], 1 / size[1], BLOOM_THRESHOLD, BLOOM_KNEE,
          1 / bw, 1 / bh, BLOOM_RADIUS, 0,
        ]), 0);
        // 横向：源 = bloomA，目标 = bloomB
        bloomBufs[1].write(new Float32Array([
          1 / bw, 1 / bh, BLOOM_THRESHOLD, BLOOM_KNEE,
          1 / bw, 0, BLOOM_RADIUS, 1,
        ]), 0);
        // 纵向：源 = bloomB，目标 = bloomA
        bloomBufs[2].write(new Float32Array([
          1 / bw, 1 / bh, BLOOM_THRESHOLD, BLOOM_KNEE,
          0, 1 / bh, BLOOM_RADIUS, 2,
        ]), 0);
        f.pass({ target: bloomA, clear: [0, 0, 0, 1] }, (p) => p.draw(bloomExtractFx));
        f.pass({ target: bloomB, clear: [0, 0, 0, 1] }, (p) => p.draw(bloomBlurXFx));
        f.pass({ target: bloomA, clear: [0, 0, 0, 1] }, (p) => p.draw(bloomBlurYFx));
      }
      // ④ 合成（含过场信箱边条与暗角）先落到画布，字卡再叠在最上层——
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
    // 碎屑的 storage buffer 与几何由本层自己持有；其余资源随 gpu.dispose() 一并释放
    try { debris.dispose(); } catch { /* 同上 */ }
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
