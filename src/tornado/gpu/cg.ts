/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/cg.ts — 程序化 CG 着色器
 *
 *  《龙卷风成长记》的叙事画面：开场标题、量级跃迁、通关结局。
 *  全部由片元着色器实时生成，不引入任何图片资源——
 *  站点承诺「程序化美术，仓库不存第三方 UI 素材」，CG 也遵循这条。
 *
 *  统一的视觉语言：天空渐变 + 地平线 + 龙卷风剪影 + 星尘/浮尘，
 *  以「世界尺度」为参数，从街道级的贴地视角一路拉到星球级。
 * ──────────────────────────────────────────────────────────── */

/** 共享的噪声与调色工具，拼进各支 CG 着色器 */
const CG_COMMON = /* wgsl */ `
fn hash21(p: vec2f) -> f32 {
  var h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

fn noise21(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var v = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 5; i = i + 1) {
    v = v + amp * noise21(p);
    p = p * 2.02;
    amp = amp * 0.5;
  }
  return v;
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(vec3f(c.x) + k.xyz) * 6.0 - vec3f(k.w));
  return c.z * mix(vec3f(k.x), clamp(p - vec3f(k.x), vec3f(0.0), vec3f(1.0)), c.y);
}

/* 龙卷风剪影：漏斗形（上宽下窄），返回覆盖度。
   注意坐标系：uv 原点在左上、y 向下，所以「向上」是 y 减小。
   groundY 是地面所在的 y，height 是漏斗向上延伸的高度。 */
fn tornadoSilhouette(p: vec2f, cx: f32, groundY: f32, height: f32, width: f32, time: f32) -> f32 {
  let up = groundY - p.y;                          // 向上为正
  if (up < 0.0 || up > height) { return 0.0; }
  let t = clamp(up / height, 0.0, 1.0);            // 0 = 地面，1 = 顶端
  // 漏斗：底部窄、顶部宽，带轻微摆动
  let w = width * (0.28 + 0.72 * t) * (1.0 + 0.05 * sin(time * 1.7 + t * 4.0));
  let sway = sin(time * 0.9 + t * 2.2) * width * 0.18 * t;
  let d = abs(p.x - cx - sway);
  return 1.0 - smoothstep(w * 0.72, w, d);
}
`;

/** 开场 CG：远景地平线 + 远处正在成形的龙卷风 + 标题留白 */
export const CG_INTRO_WGSL = /* wgsl */ `
struct CgU {
  view: vec2f,
  time: f32,
  progress: f32,   // 0..1 画面自身的时间轴（用于淡入淡出）
  tier: f32,       // 当前量级（决定天空配色与地平线高度）
  _pad: f32,
};
@group(0) @binding(0) var<uniform> u: CgU;

${CG_COMMON}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * u.view;
  let aspect = u.view.x / u.view.y;
  var q = (p - u.view * 0.5) / u.view.y;      // 归一化，y 向下
  q.x = q.x * aspect;

  // q.y ∈ [-0.5, 0.5]（正方形画布）。地平线放在略低于中线处，
  // 让天空占约 6 成、地面 4 成——龙卷风立在地平线上才有压迫感。
  let horizon = 0.10 - u.tier * 0.012;

  // ── 天空：从高空深蓝到地平线暖色 ──
  let sky = smoothstep(-0.5, horizon, q.y);
  let lo = vec3f(0.98, 0.86, 0.70);
  let hi = vec3f(0.24, 0.42, 0.66);
  var col = mix(hi, lo, pow(sky, 0.85));

  // 落日辉光
  let sun = vec2f(0.16 * aspect, horizon + 0.02);
  let sd = length(q - sun);
  col = col + vec3f(1.0, 0.72, 0.42) * 0.35 * exp(-sd * 3.4);

  // 云带：fbm 拉长
  let cl = fbm(vec2f(q.x * 2.6 + u.time * 0.012, q.y * 7.0));
  let cloudMask = smoothstep(0.52, 0.78, cl) * smoothstep(horizon - 0.34, horizon - 0.04, q.y);
  col = mix(col, vec3f(0.86, 0.80, 0.80), cloudMask * 0.55);

  // ── 地面：深色剪影 + 远景层次 ──
  // 过渡带留够宽度：太窄会在 fbm 纹理上切出一条硬边
  let groundMask = smoothstep(horizon - 0.012, horizon + 0.012, q.y);
  let gTex = fbm(vec2f(q.x * 5.0, q.y * 12.0 + u.tier));
  let ground = mix(vec3f(0.16, 0.22, 0.24), vec3f(0.26, 0.31, 0.30), gTex);
  col = mix(col, ground, groundMask);

  // 地平线上第二层远山（更暗，制造纵深）
  let ridge = horizon - 0.045 - 0.05 * fbm(vec2f(q.x * 1.7 + 11.0, u.tier * 3.0));
  let ridgeMask = smoothstep(ridge - 0.008, ridge + 0.008, q.y) * (1.0 - groundMask);
  col = mix(col, vec3f(0.20, 0.27, 0.30), ridgeMask * 0.85);

  // ── 龙卷风剪影：从地平线拔起，高度接近画面全高 ──
  let grow = smoothstep(0.0, 0.55, u.progress);
  let sil = tornadoSilhouette(q, 0.02 * aspect, horizon + 0.002, 0.46 * grow, 0.058 * grow, u.time);
  col = mix(col, vec3f(0.13, 0.17, 0.20), sil * 0.92);
  // 漏斗边缘的亮描边（逆光）
  let silWide = tornadoSilhouette(q, 0.02 * aspect, horizon + 0.002, 0.46 * grow, 0.070 * grow, u.time);
  col = col + vec3f(0.28, 0.24, 0.20) * max(0.0, silWide - sil) * 0.7;

  // ── 浮尘：贴着地平线的一层细碎亮点，不铺满天空 ──
  let dustBand = smoothstep(horizon - 0.26, horizon - 0.02, q.y) * (1.0 - groundMask);
  let dust = vec2f(q.x * 22.0, q.y * 22.0 - u.time * 0.5);
  let dn = noise21(dust);
  let dustMask = smoothstep(0.86, 0.99, dn) * dustBand * grow;
  col = col + vec3f(1.0, 0.94, 0.82) * dustMask * 0.55;

  // ── 整体淡入淡出与暗角 ──
  let fade = smoothstep(0.0, 0.18, u.progress) * (1.0 - smoothstep(0.86, 1.0, u.progress));
  // 暗角按到画面中心的距离算，两个方向一致，不会出现横向接缝
  let vig = 1.0 - 0.40 * smoothstep(0.22, 0.62, length(q));
  col = col * clamp(vig, 0.35, 1.0);
  return vec4f(col * fade, 1.0);
}
`;

/** 通关结局 CG：从太空俯瞰地球，龙卷风已成为行星级涡旋 */
export const CG_FINALE_WGSL = /* wgsl */ `
struct CgU {
  view: vec2f,
  time: f32,
  progress: f32,
  tier: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> u: CgU;

${CG_COMMON}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * u.view;
  let aspect = u.view.x / u.view.y;
  var q = (p - u.view * 0.5) / u.view.y;
  q.x = q.x * aspect;

  // ── 深空背景 + 星场 ──
  var col = vec3f(0.016, 0.022, 0.045);
  let star = hash21(floor(q * 420.0));
  let twinkle = 0.6 + 0.4 * sin(u.time * 2.2 + star * 40.0);
  col = col + vec3f(0.9, 0.94, 1.0) * step(0.9975, star) * twinkle;
  // 星云
  col = col + vec3f(0.10, 0.08, 0.20) * pow(fbm(q * 2.2 + u.time * 0.01), 2.4) * 0.55;

  // ── 地球：球体 + 大气边缘 ──
  let planet = vec2f(0.0, 0.06);
  let R = 0.30;
  let d = length(q - planet);
  if (d < R) {
    // 球面法线 → 经纬度，贴一层程序化大陆
    let nz = sqrt(max(0.0, R * R - d * d)) / R;
    let n = vec3f((q.x - planet.x) / R, (q.y - planet.y) / R, nz);
    let lat = asin(clamp(n.y, -1.0, 1.0));
    let lon = atan2(n.x, n.z);
    let land = fbm(vec2f(lon * 2.4, lat * 3.4) + 3.7);
    let isLand = smoothstep(0.48, 0.53, land);
    let detail = fbm(vec2f(lon * 9.0, lat * 12.0));
    var surf = mix(vec3f(0.05, 0.22, 0.44), vec3f(0.20, 0.42, 0.20), isLand);
    surf = mix(surf, vec3f(0.42, 0.40, 0.26), isLand * smoothstep(0.55, 0.8, detail) * 0.7);
    // 极冠
    let ice = smoothstep(0.86, 0.99, abs(n.y));
    surf = mix(surf, vec3f(0.92, 0.95, 0.98), ice);
    // 云层
    let cl = fbm(vec2f(lon * 3.1 + u.time * 0.03, lat * 4.2));
    surf = mix(surf, vec3f(0.95), smoothstep(0.55, 0.8, cl) * 0.55);
    // 光照：左上方向光
    let lightDir = normalize(vec3f(-0.55, -0.5, 0.67));
    let lam = clamp(dot(n, lightDir), 0.0, 1.0);
    col = surf * (0.14 + 0.95 * lam);
    // 大气散射边缘
    col = col + vec3f(0.25, 0.45, 0.85) * pow(1.0 - nz, 3.0) * lam * 0.75;
  } else {
    // 大气外辉光
    let glow = exp(-(d - R) * 16.0);
    col = col + vec3f(0.22, 0.42, 0.85) * glow * 0.42;
  }

  // ── 行星级龙卷风：盘踞在大陆上空的白色涡旋 ──
  let storm = vec2f(-0.10 * aspect, -0.02);
  let sd = length(q - storm);
  let spiral = atan2(q.y - storm.y, q.x - storm.x) + sd * 26.0 - u.time * 1.6;
  let band = 0.5 + 0.5 * sin(spiral * 2.0);
  let envelope = exp(-sd * 7.5) * smoothstep(R * 1.5, R * 0.2, length(storm - planet));
  let stormMask = band * envelope * smoothstep(0.0, 0.35, u.progress);
  col = mix(col, vec3f(0.97, 0.97, 1.0), stormMask * 0.55);
  // 风眼
  col = mix(col, vec3f(0.05, 0.09, 0.16), smoothstep(0.028, 0.012, sd) * envelope * 0.7);

  // ── 收尾：淡入 + 暗角 ──
  let fade = smoothstep(0.0, 0.22, u.progress);
  let vig = 1.0 - 0.5 * length(q * vec2f(1.0, 1.2));
  col = col * clamp(vig, 0.3, 1.0);
  return vec4f(col * fade, 1.0);
}
`;
