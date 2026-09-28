/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/mesh-shaders.ts — 立体网格、贴花与碎屑的 WGSL
 *
 *  MESH          实例化立体网格：物体底座、地形障碍（山/巨石/林）。
 *                顶点格式 position + normal，实例流给 位置/缩放/色调。
 *  FUNNEL        龙卷风漏斗：网格 + 程序化旋转螺纹，双面绘制。
 *  DECAL         emoji 贴花：贴在底座顶面的水平面片，带 uv。
 *  SHADOW        仅深度：把投影体画进阴影贴图。
 *  DEBRIS_SIM    碎屑模拟（compute）：绕轴旋转上升，落到顶部后重生。
 *  DEBRIS_DRAW   碎屑绘制：顶点阶段直接读 storage，不走顶点缓冲。
 *
 *  坐标约定：x / y 是地面，z 向上。与 camera.ts 的主相机严格配套。
 * ──────────────────────────────────────────────────────────── */

/**
 * 共享的光照与阴影工具，拼进各支网格着色器。
 * 光照模型是「太阳 + 半球环境光」，足够读，又不需要额外的光照贴图。
 */
const MESH_COMMON = /* wgsl */ `
struct Scene {
  viewProj: mat4x4f,
  sunViewProj: mat4x4f,
  cam: vec4f,        // xy = 相机世界位置（俯视投影下的相机中心）
  sun: vec4f,        // xyz = 指向太阳的方向，w = 环境光强度
  params: vec4f,     // x = 阴影强度, y = 阴影贴图纹素, z = 高度雾起点, w = 高度雾强度
  fog: vec4f,        // rgb = 雾色, a = 雾最远处
};

/* 2x2 的 PCF：在阴影贴图上取 4 个点平均，避免硬边锯齿。
   比较采样器直接返回 0/1，四次平均得到 0 / .25 / .5 / .75 / 1 五档。

   注意：textureSampleCompare 必须在**一致控制流**里调用，所以这里不做提前
   return，而是无条件采完再 select——越界时靠采样器的 clamp 行为兜住。 */
fn shadowFactor(worldPos: vec3f, s: Scene) -> f32 {
  let lightClip = s.sunViewProj * vec4f(worldPos, 1.0);
  let ndc = lightClip.xyz / lightClip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let depth = ndc.z;
  let t = s.params.y;
  var sum = 0.0;
  for (var i = 0; i < 2; i = i + 1) {
    for (var j = 0; j < 2; j = j + 1) {
      let o = (vec2f(f32(i), f32(j)) - vec2f(0.5)) * t;
      sum = sum + textureSampleCompare(shadowMap, shadowSamp, uv + o, depth - 0.0022);
    }
  }
  let avg = sum * 0.25;
  // 阴影贴图没覆盖到的地方视为全亮，否则画面边缘会出现一条假阴影带
  let inBounds = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  return select(1.0, avg, inBounds);
}

/* 太阳直射 + 半球环境光 + 掠射补光。
   系数经过配平：白色反照率（0.93）在受光最强的顶面约落在 0.95，
   不会溢出到 1.0 被截断——截断会把「受光」和「过曝」压成同一个值，
   立体感就没了。 */
fn shadeSurface(normal: vec3f, albedo: vec3f, worldPos: vec3f, s: Scene, shadow: f32) -> vec3f {
  let n = normalize(normal);
  let l = max(dot(n, normalize(s.sun.xyz)), 0.0);
  // 半球环境光：朝上的面接天光，朝下的面只接地面反弹
  let sky = 0.5 + 0.5 * n.z;
  let ambient = mix(0.30, 0.62, sky) * s.sun.w;
  // 阴影强度 s.params.x 用来在「全亮」与「实测阴影」之间插值
  var lit = albedo * (ambient + l * mix(1.0, shadow, s.params.x) * 0.62);
  // 掠射角轻微提亮，模拟大气散射，避免背光面死黑
  lit = lit + albedo * pow(1.0 - abs(n.z), 3.0) * 0.08;
  return lit;
}
`;

/**
 * 场景 uniform 的字节布局（与上面 Scene 结构体严格对应）。
 * 两个 mat4x4f 各 64 字节 → 前 32 个 float；随后 4 个 vec4f → 共 48 个 float = 192 字节。
 */
export const SCENE_UNIFORM_FLOATS = 48;
export const SCENE_VIEWPROJ_OFFSET = 0;
export const SCENE_SUNVP_OFFSET = 16;
export const SCENE_CAM_OFFSET = 32;
export const SCENE_SUN_OFFSET = 36;
export const SCENE_PARAMS_OFFSET = 40;
export const SCENE_FOG_OFFSET = 44;

/**
 * 实例化立体网格。
 * 顶点流 0：position + normal；实例流：pos(4) + tint(4)。
 * 实例的 pos.w 是**统一缩放**，pos.xyz 是世界位置（z 为底面对齐后的中心高度）。
 */
export const MESH_WGSL = /* wgsl */ `
${MESH_COMMON}

@group(0) @binding(0) var<uniform> s: Scene;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSamp: sampler_comparison;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) nrm: vec3f,
  @location(1) col: vec3f,
  @location(2) world: vec3f,
};

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) instPos: vec4f,    // xyz = 世界位置
  @location(3) instScale: vec4f,  // xyz = 三轴缩放（单位网格是 1×1×1，缩放即尺寸）
  @location(4) tint: vec4f,       // rgb = 色调
) -> VSOut {
  var o: VSOut;
  let world = position * instScale.xyz + instPos.xyz;
  o.pos = s.viewProj * vec4f(world, 1.0);
  o.nrm = normal;
  o.col = tint.rgb;
  o.world = world;
  return o;
}

/* 阴影必须在片元阶段求：textureSampleCompare 只允许在片元着色器里调用
   （顶点阶段没有纹理采样能力），放在 vs 里会被 naga 直接拒掉。 */
@fragment fn fs_main(i: VSOut) -> @location(0) vec4f {
  let s2 = s;
  let sh = shadowFactor(i.world, s2);
  var rgb = shadeSurface(i.nrm, i.col, i.world, s2, sh);
  // 高度雾：离相机越远淡入雾色，制造空气透视
  let far = smoothstep(s.fog.a * 0.35, s.fog.a, distance(i.world.xy, s.cam.xy));
  rgb = mix(rgb, s.fog.rgb, far * s.params.w);
  return vec4f(rgb, 1.0);
}
`;

/**
 * emoji 贴花：贴在底座顶面的水平面片。
 * 不参与阴影投射，但**接收**阴影——这正是「物体落在地面上」的关键。
 */
export const DECAL_WGSL = /* wgsl */ `
${MESH_COMMON}

@group(0) @binding(0) var<uniform> s: Scene;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSamp: sampler_comparison;
@group(0) @binding(3) var atlas: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec3f,
};

@vertex fn vs_main(
  @location(0) position: vec3f,   // 单位面片 x/y ∈ -0.5..0.5
  @location(1) uv: vec2f,
  @location(2) instPos: vec4f,    // xyz = 世界位置
  @location(3) instScale: vec4f,  // xyz = 三轴缩放
  @location(4) uvrect: vec4f,     // 图集格心与格宽
  @location(5) tint: vec4f,
) -> VSOut {
  var o: VSOut;
  let world = position * instScale.xyz + instPos.xyz;
  o.pos = s.viewProj * vec4f(world, 1.0);
  o.uv = uvrect.xy + (uv - 0.5) * uvrect.zw;
  o.world = world;
  return o;
}

@fragment fn fs_main(i: VSOut) -> @location(0) vec4f {
  let texel = textureSample(atlas, samp, i.uv);
  if (texel.a <= 0.004) { discard; }
  let sh = shadowFactor(i.world, s);
  // 贴花是「自发光的美术贴图」，只接收阴影与环境光，不再做漫反射——
  // 否则 emoji 的固有色会被法线朝上带来的强光冲淡，认不出来。
  let shade = (0.30 + 0.72 * s.sun.w) * mix(0.55, 1.0, sh);
  var rgb = texel.rgb * shade;
  let far = smoothstep(s.fog.a * 0.35, s.fog.a, distance(i.world.xy, s.cam.xy));
  rgb = mix(rgb, s.fog.rgb, far * s.params.w);
  return vec4f(rgb, texel.a);
}
`;

/**
 * 龙卷风漏斗：真实网格 + 程序化旋转螺纹。
 *
 * 双面绘制（cull: 'none'）——漏斗是薄壳，从斜上方看进去会看到内壁，
 * 剔掉背面会让上半截凭空消失。内壁靠法线与视线的关系自动压暗，
 * 于是「能看穿」的薄壳读起来反而像有厚度的涡管。
 */
export const FUNNEL_WGSL = /* wgsl */ `
${MESH_COMMON}

@group(0) @binding(0) var<uniform> s: Scene;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSamp: sampler_comparison;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) nrm: vec3f,
  @location(1) world: vec3f,
  @location(2) local: vec3f,   // 单位漏斗坐标：xy 径向、z 高度 0..1
};

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) instPos: vec4f,
  @location(3) instScale: vec4f,   // x = 半径, z = 高度
  @location(4) tint: vec4f,        // rgb = 色调, a = 整体不透明度
) -> VSOut {
  var o: VSOut;
  let world = position * instScale.xyz + instPos.xyz;
  o.pos = s.viewProj * vec4f(world, 1.0);
  o.nrm = normal;
  o.world = world;
  o.local = position;
  return o;
}

@fragment fn fs_main(i: VSOut) -> @location(0) vec4f {
  let s2 = s;
  let t = clamp(i.local.z, 0.0, 1.0);
  let rad = length(i.local.xy);

  // ── 旋转螺纹：沿高度绕轴扭转的螺旋带 ──
  // 角度随时间旋转，越靠近顶部转得越慢（角动量守恒的观感）。
  // 时间复用 params.z —— 该槽原本留给「雾起点」但从未使用，cam.xyz 要留给视线方向。
  let ang = atan2(i.local.y, i.local.x);
  let spin = s2.params.z * (1.4 - 0.5 * t);
  let thread = sin((ang + spin) * 6.0 - t * 14.0);
  let threadMask = smoothstep(0.55, 1.0, thread);

  // ── 基础色：底部偏暗偏暖（卷起尘土）、顶部偏冷稍亮 ──
  // 整体压得比地面暗：龙卷风必须靠明度差从浅色地表上「浮」出来，
  // 尘卷风的真实观感本来也是灰暗的柱体，不是白色。
  let base = mix(vec3f(0.20, 0.18, 0.17), vec3f(0.38, 0.43, 0.51), t);
  var albedo = base + vec3f(0.12) * threadMask * (1.0 - t * 0.4);

  /* 涡管的受光不能照搬实心物体的那套：
     漏斗的法线全是水平的（nz=0），而太阳几乎垂直（z 分量 0.82），
     用 shadeSurface 会让半个筒壁只剩环境光、糊成一团黑。
     真实的尘卷风本来也主要是散射与透射，所以这里改成
     「天光 + 边缘透光 + 一点点太阳」的组合。 */
  let sky = 0.55 + 0.45 * t;
  var rgb = albedo * (0.78 + 0.34 * sky);

  // ── 边缘透光：法线越垂直于视线越亮，做出涡管的圆柱感 ──
  let viewDir = normalize(s2.cam.xyz - i.world);
  let rim = pow(1.0 - abs(dot(normalize(i.nrm), viewDir)), 2.0);
  rgb = rgb + vec3f(0.20, 0.23, 0.29) * rim * 0.55;

  // ── 太阳方向上的那半边再补一点直射，保留与场景一致的光位 ──
  let l = max(dot(normalize(i.nrm), normalize(s2.sun.xyz)), 0.0);
  rgb = rgb + albedo * l * 0.20;

  // ── 透明度：底端更实、顶端更透（散开的尘土），螺纹处更浓 ──
  // 不透明度要够高：漏斗是画面主体，太透就会被浅色地表透过来冲淡成「一缕烟」。
  let a = (0.80 + 0.20 * rad) * mix(1.0, 0.80, t) + threadMask * 0.12;
  return vec4f(rgb, clamp(a, 0.0, 0.94));
}
`;

/**
 * 阴影投射：只需要深度，但 WebGPU 的 pass 仍需要一个颜色附件，
 * 所以片段着色器写一个不参与后续读取的颜色（vGPU 的 target 默认带颜色附件）。
 */
export const SHADOW_WGSL = /* wgsl */ `
struct ShadowU { lightViewProj: mat4x4f };
@group(0) @binding(0) var<uniform> u: ShadowU;

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) instPos: vec4f,
  @location(3) instScale: vec4f,
  @location(4) tint: vec4f,
) -> @builtin(position) vec4f {
  let world = position * instScale.xyz + instPos.xyz;
  return u.lightViewProj * vec4f(world, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 1.0, 1.0);
}
`;

/* ══════════════════════════════════════════════════════════════
 *  龙卷风碎屑：GPU 端模拟 + 实例化绘制
 *
 *  碎屑状态存在 storage buffer 里，由 compute 着色器每帧推进
 *  （绕轴旋转 + 向上卷升 + 落到地面后重生），顶点阶段直接读同一块
 *  buffer 定位粒子——全程不经过 CPU，粒子数可以随龙卷风成长而增加。
 * ══════════════════════════════════════════════════════════════ */

/** 碎屑粒子数上限（实例数 = 当前活跃数，随半径增长） */
export const DEBRIS_MAX = 512;
/** 单个碎屑的状态：pos(4) + seed(4) = 32 字节 */
export const DEBRIS_FLOATS_PER_PARTICLE = 8;
export const DEBRIS_STRIDE = DEBRIS_FLOATS_PER_PARTICLE * 4;

/**
 * 碎屑模拟。每个粒子在圆柱坐标里描述：半径、角度、高度，
 * 每帧角度推进（角速度随高度衰减）、高度上升、到达顶部后重生。
 * 重生时按风眼半径重新散布，于是龙卷风变大时碎屑云也跟着铺开。
 */
export const DEBRIS_SIM_WGSL = /* wgsl */ `
struct Particle {
  pos: vec4f,    // xyz = 世界位置（相对风眼），w = 归一化生命 0..1
  seed: vec4f,   // x = 半径, y = 角度, z = 角速度, w = 高度速度
};
@group(0) @binding(0) var<storage, read_write> parts: array<Particle>;

struct SimU {
  center: vec4f,   // xy = 风眼世界位置, z = 时间, w = dt
  shape: vec4f,    // x = 半径, y = 高度, z = 活跃粒子数, w = 抖动种子
  misc: vec4f,     // x = 碎屑尺寸, y = 时间缩放, zw 备用
};
@group(0) @binding(1) var<uniform> u: SimU;

fn hash11(p: f32) -> f32 {
  var h = fract(p * 0.1031);
  h = h * (h + 33.33);
  return fract(h * (h + h));
}

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (f32(i) >= u.shape.z) { return; }
  var p = parts[i];

  // 新生（生命走完，或还没初始化过）
  if (p.pos.w <= 0.0 || p.pos.w >= 1.0) {
    let r0 = hash11(f32(i) * 1.7 + u.shape.w);
    let a0 = hash11(f32(i) * 3.1 + u.shape.w + 11.0) * 6.2831853;
    p.seed = vec4f(
      0.25 + r0 * 0.85,            // 半径：贴壁到外缘
      a0,
      1.2 + hash11(f32(i) * 5.3) * 1.1,
      0.35 + hash11(f32(i) * 7.9) * 0.5,
    );
    p.pos.w = 0.001;
  }

  let dt = u.misc.y;
  let t = p.pos.w;
  // 角速度随高度衰减：越靠顶部转得越慢（角动量守恒的观感）
  let ang = p.seed.y + p.seed.z * dt * (1.35 - 0.7 * t);
  // 高度随时间上升；半径随高度先扩后收，形成漏斗轮廓
  let h = clamp(t + p.seed.w * dt, 0.0, 1.0);
  let prof = 0.35 + 0.75 * pow(h, 0.7);
  let rad = p.seed.x * u.shape.x * prof;

  p.pos = vec4f(
    cos(ang) * rad,
    sin(ang) * rad,
    h * u.shape.y,
    h,
  );
  parts[i] = p;
}
`;

/**
 * 碎屑绘制：顶点阶段直接从 storage 读粒子，不经过顶点缓冲。
 * 每个实例是一个朝向相机的四边形（billboard），色调随高度由暖转冷。
 */
export const DEBRIS_DRAW_WGSL = /* wgsl */ `
${MESH_COMMON}

struct Particle {
  pos: vec4f,
  seed: vec4f,
};
@group(0) @binding(0) var<storage, read> parts: array<Particle>;

struct DrawU {
  center: vec4f,   // xy = 风眼世界位置（粒子坐标是相对量）, z = 时间, w = 尺寸
  view: vec4f,     // xy = 屏幕尺寸, zw 备用
  misc: vec4f,     // x = 活跃粒子数, y = 不透明度, zw 备用
};
@group(0) @binding(1) var<uniform> u: DrawU;
@group(0) @binding(2) var<uniform> s: Scene;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowSamp: sampler_comparison;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) shade: f32,
};

@vertex fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var o: VSOut;
  if (f32(ii) >= u.misc.x) {
    // 未启用的实例推到裁剪空间外，避免它们堆在原点
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    o.world = vec3f(0.0);
    o.shade = 0.0;
    return o;
  }
  let p = parts[ii];
  let world = vec3f(u.center.xy + p.pos.xy, p.pos.z);
  // billboard：屏幕空间的正方形，尺寸随高度略缩（越靠顶部越远越小）
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let clip = s.viewProj * vec4f(world, 1.0);
  let size = u.center.w * (1.0 - 0.35 * p.pos.w);
  let px = vec2f(corners[vi].x * size / u.view.x * 2.0, corners[vi].y * size / u.view.y * 2.0);
  o.pos = vec4f(clip.xy + px * clip.w, clip.z, clip.w);
  o.world = world;
  // 用高度做明暗：底部（刚被卷起）偏暖偏暗，顶部偏冷偏亮
  o.shade = p.pos.w;
  return o;
}

@fragment fn fs_main(i: VSOut) -> @location(0) vec4f {
  let s2 = s;
  let warm = vec3f(0.52, 0.42, 0.33);
  let cool = vec3f(0.62, 0.66, 0.72);
  var rgb = mix(warm, cool, i.shade);
  let sh = shadowFactor(i.world, s2);
  rgb = rgb * (0.55 + 0.45 * sh);
  // 越靠顶部越透明（散开的尘土）
  let a = u.misc.y * mix(0.95, 0.45, i.shade);
  return vec4f(rgb, a);
}
`;
