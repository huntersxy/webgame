/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/shaders.ts — vgpu 渲染管线的 WGSL 源码
 *
 *  分工（与 Canvas 2D 路径的绘制步骤一一对应）：
 *    FLOOR   无限程序化地表：地貌拼块 + 细网格。原先每帧在 CPU 上
 *            嵌套 fillRect 铺格子，现在改成逐像素计算——地貌种类与
 *            明暗都由世界坐标整数哈希决定，天生适合放进片元着色器。
 *    SPRITE  实例化四边形：emoji 物体、地形障碍、粒子、环、转场文字。
 *            贴图来自离屏画布，所以美术与 Canvas 路径完全一致。
 *    TORNADO 龙卷风：锥体 + 旋转螺纹 + 环绕碎屑，程序化解析绘制。
 *    COMPOSITE 合成：风眼擦除遮罩 + 暗角，输出到画布。
 *
 *  坐标约定：vgpu 注入的 uv 原点在左上、v 向下，与 WebGPU 一致。
 * ──────────────────────────────────────────────────────────── */

/** 地貌调色板：每个量级 5 种地貌，共 6 档 */
export const FLOOR_WGSL = /* wgsl */ `
struct FloorU {
  cam: vec2f,
  view: vec2f,
  scale: f32,
  tile: f32,
  tier: f32,
  gridPx: f32,
  gridCol: vec4f,
  cols: array<vec4f, 30>,
  decorWorld: f32,
  decorMix: f32,
  _pad0: f32,
  _pad1: f32,
};
@group(0) @binding(0) var<uniform> u: FloorU;
@group(0) @binding(1) var decor: texture_2d<f32>;
@group(0) @binding(2) var decorSamp: sampler;

/* 与 game.ts 的 hashInt 逐位一致：同一世界坐标在两个后端得到同一片地貌。
   JS 侧用 Math.imul（32 位回绕），WGSL 的 u32 乘法同样回绕，位模式相同。 */
fn hashInt(x: i32, y: i32, lvl: i32) -> u32 {
  var h: u32 = (bitcast<u32>(x) * 374761393u)
             ^ (bitcast<u32>(y) * 668265263u)
             ^ (bitcast<u32>(lvl) * 2246822519u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return h;
}

/* 地貌索引 → 调色板位置（waste 0 / arable 1 / forest 2 / town 3 / water 4） */
fn biomeIndex(cx: i32, cy: i32, lvl: i32) -> i32 {
  let h = f32(hashInt(cx, cy, lvl)) / 4294967296.0;
  if (h < 0.16) { return 4; }
  if (h < 0.30) { return 3; }
  if (h < 0.62) { return 0; }
  if (h < 0.84) { return 1; }
  return 2;
}

/* 与 game.ts 的 shade() 同语义：amt<0 压暗、>0 提亮，输入输出都是 0..255 */
fn shade(c: vec3f, amt: f32) -> vec3f {
  let goal = select(255.0, 0.0, amt < 0.0);
  let k = abs(amt);
  return c + (vec3f(goal) - c) * k;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // 屏幕像素 → 世界坐标
  let screen = uv * u.view;
  let world = u.cam + (screen - u.view * 0.5) / u.scale;

  // ① 地貌拼块：格子边长随镜头缩放（贴近「每屏约 4 个地貌格」的 LOD）
  let cell = world / u.tile;
  let cx = i32(floor(cell.x));
  let cy = i32(floor(cell.y));
  let kind = biomeIndex(cx, cy, i32(u.tier));

  // 格内位置哈希 → 明暗抖动，让地表读起来像地图而不是色板
  let jitter = f32(hashInt(cx, cy, i32(u.tier) + 5)) / 4294967296.0;
  // 数组下标必须是整数：先算整型槽位再索引
  let slot = i32(u.tier) * 5 + kind;
  let base = u.cols[slot].rgb / 255.0;
  var col = shade(base * 255.0, (jitter - 0.5) * 0.1) / 255.0;

  // ② 地表装饰：路网 / 田块 / 海浪，按世界坐标平铺（repeat 采样）
  let duv = world / u.decorWorld;
  let dec = textureSample(decor, decorSamp, duv);
  col = mix(col, dec.rgb, dec.a * u.decorMix);

  // ③ 细网格：线宽固定为屏幕像素，任何镜头下都读作 1.4px 的路网
  let g0 = 64.0;
  let halfW = (u.gridPx * 0.5) / u.scale;          // 世界单位下的半线宽
  let aa = 0.75 / u.scale;                          // 抗锯齿过渡带
  let dw = abs(world / g0 - round(world / g0)) * g0;
  let gd = min(dw.x, dw.y);
  let cov = 1.0 - smoothstep(halfW - aa, halfW + aa, gd);
  col = mix(col, u.gridCol.rgb / 255.0, cov * u.gridCol.a);
  return vec4f(col, 1.0);
}
`;

/**
 * 实例化精灵。一个 draw 覆盖画面上所有四边形图元：
 * 贴图精灵（emoji/地形/装饰/文字）与程序化图元（圆、环、圆角底板）走同一支着色器，
 * 靠实例里的 kind 分流——省掉每种图元一个 draw call。
 */
export const SPRITE_WGSL = /* wgsl */ `
struct SpriteU { view: vec2f, cols: f32, rows: f32 };
@group(0) @binding(0) var<uniform> u: SpriteU;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,   // 图元局部坐标，范围随图元而定
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) kind: f32,
  @location(3) tint: vec4f,
  @location(4) param: vec4f,   // 圆角半径 / 环宽比例 / 备用
  @location(5) half: vec2f,    // 半宽高（px），供圆角与圆形判定
};

@vertex fn vs_main(
  @location(0) corner: vec2f,
  @location(1) rect: vec4f,    // cx, cy, hw, hh（屏幕像素）
  @location(2) misc: vec4f,    // rot, kind, alpha, _
  @location(3) tint: vec4f,    // r,g,b, _
  @location(4) param: vec4f,   // 圆角半径, 环宽比例, _, _
  @location(5) uvrect: vec4f,  // u0, v0, du, dv
) -> VSOut {
  var o: VSOut;
  let local = (corner - 0.5) * 2.0;            // -1..1
  let half = rect.zw;
  let rot = misc.x;
  let c = cos(rot);
  let s = sin(rot);
  let off = vec2f(local.x * half.x * c - local.y * half.y * s,
                  local.x * half.x * s + local.y * half.y * c);
  let px = rect.xy + off;
  o.pos = vec4f(px.x / u.view.x * 2.0 - 1.0, 1.0 - px.y / u.view.y * 2.0, 0.0, 1.0);
  o.local = local;
  // 纹理 uv：uvrect.xy 是格心，角点 0..1 需按格宽展开（-0.5 回到格角）
  o.uv = uvrect.xy + (corner - 0.5) * uvrect.zw;
  o.kind = misc.y;
  o.tint = vec4f(tint.rgb, misc.z);
  o.param = param;
  o.half = half;
  return o;
}

/* 圆角矩形的有符号距离（局部 -1..1，圆角半径按像素给） */
fn sdRoundBox(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let kind = in.kind;

  // 纹理采样必须在统一控制流里：先无条件采样，再按图元类型选用。
  // （放在 if 分支内会被 WGSL 拒绝：textureSample 要求 uniform control flow）
  let texel = textureSample(atlas, samp, in.uv);

  var col = vec4f(0.0);
  if (kind < 0.5) {
    // 贴图精灵：emoji / 地形 / 装饰 / 文字
    col = vec4f(texel.rgb * in.tint.rgb, texel.a * in.tint.a);
  } else if (kind < 1.5) {
    // 圆角矩形底板（建筑地基）
    let p = in.local * in.half;
    let d = sdRoundBox(p, in.half, in.param.x);
    let a = in.tint.a * (1.0 - smoothstep(-1.0, 1.0, d));
    col = vec4f(in.tint.rgb, a);
  } else if (kind < 2.5) {
    // 圆角矩形描边（「现在还卷不动」的灰边）
    let p = in.local * in.half;
    let d = abs(sdRoundBox(p, in.half, in.param.x)) - in.param.y;
    let a = in.tint.a * (1.0 - smoothstep(-1.0, 1.0, d));
    col = vec4f(in.tint.rgb, a);
  } else if (kind < 3.5) {
    // 实心椭圆（粒子用圆：hw==hh；湖面/阴影用扁椭圆）
    // 局部坐标归一化后到边界距离恒为 1，天然支持任意宽高比
    let p = in.local;
    let d = length(p) - 1.0;
    let a = in.tint.a * (1.0 - smoothstep(-0.06, 0.06, d));
    col = vec4f(in.tint.rgb, a);
  } else if (kind < 4.5) {
    // 椭圆环（吞噬涟漪、湖岸线）；param.x = 线宽占半径的比例
    let p = in.local;
    let d = abs(length(p) - 1.0);
    let a = in.tint.a * (1.0 - smoothstep(in.param.x - 0.06, in.param.x + 0.06, d));
    col = vec4f(in.tint.rgb, a);
  } else if (kind < 5.5) {
    // 三角形（山峰）；param.x = 顶点相对高度 0..1（1 = 顶点抵包围盒顶边）
    // 局部坐标 x∈[-1,1]、y∈[-1,1]（y = -1 在顶）
    let p = in.local;
    let apexY = 1.0 - 2.0 * in.param.x;
    let t = clamp((p.y - apexY) / max(1.0 - apexY, 1e-4), 0.0, 1.0);
    let d = abs(p.x) - t;                 // 底边 (y=1) 张开到满宽
    var a = in.tint.a * (1.0 - smoothstep(-0.03, 0.03, d));
    a = a * step(apexY - 0.02, p.y);      // 裁掉顶点以上
    col = vec4f(in.tint.rgb, a);
  } else {
    // 细长条（道路等）：按局部 y 铺满、x 受 param.x 限制
    let p = in.local;
    let a = in.tint.a * (1.0 - smoothstep(in.param.x - 0.03, in.param.x + 0.03, abs(p.x)));
    col = vec4f(in.tint.rgb, a);
  }

  if (col.a <= 0.001) { discard; }
  return col;
}
`;

/**
 * 龙卷风：锥体（两段二次贝塞尔围成的曲面）+ 6 道旋转螺纹 + 5 块环绕碎屑。
 * 全部用解析距离场绘制，合成次序与 Canvas 的绘制次序一致。
 *
 * 这是全屏 effect（vgpu 自动生成顶点级），实际绘制范围由 pass 的 scissor
 * 限定在龙卷风包围盒内，所以不会为屏幕其余部分付片元开销。
 */
export const TORNADO_WGSL = /* wgsl */ `
struct TornadoU {
  center: vec2f,   // 风眼屏幕位置（设备像素），local.y < 0 即「向上」
  view: vec2f,     // 目标尺寸（设备像素）
  r: f32,          // 龙卷风半径（设备像素）
  h: f32,          // 锥体高度（设备像素）
  time: f32,
  alpha: f32,      // 整体不透明度（转场淡出用）
};
@group(0) @binding(0) var<uniform> u: TornadoU;

fn over(dst: vec4f, src: vec4f) -> vec4f {
  let a = src.a + dst.a * (1.0 - src.a);
  if (a <= 0.0) { return vec4f(0.0); }
  let rgb = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / a;
  return vec4f(rgb, a);
}

/* 二次贝塞尔上「给定 y 求 x」：y 随 t 单调，用牛顿迭代解出 t */
fn bezierX(y: f32, y0: f32, y1: f32, y2: f32, x0: f32, x1: f32, x2: f32) -> f32 {
  let A = y0 - 2.0 * y1 + y2;
  let B = 2.0 * (y1 - y0);
  let C = y0;
  var t = clamp((C - y) / max(C - y2, 0.0001), 0.0, 1.0);
  for (var i = 0; i < 5; i = i + 1) {
    let f = A * t * t + B * t + C - y;
    let df = 2.0 * A * t + B;
    if (abs(df) < 0.00001) { break; }
    t = clamp(t - f / df, 0.0, 1.0);
  }
  let mt = 1.0 - t;
  return mt * mt * x0 + 2.0 * mt * t * x1 + t * t * x2;
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(vec3f(c.x) + k.xyz) * 6.0 - vec3f(k.w));
  return c.z * mix(vec3f(k.x), clamp(p - vec3f(k.x), vec3f(0.0), vec3f(1.0)), c.y);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // 屏幕像素 → 以风眼为原点的局部坐标
  let local = uv * u.view - u.center;
  let r = max(3.0, u.r);
  let h = u.h;
  let aa = 1.2;

  var acc = vec4f(0.0);

  // ── ① 接触阴影 ──
  let ds = length(local / vec2f(r * 0.9, r * 0.24)) - 1.0;
  let asd = (1.0 - smoothstep(-aa / r, aa / r, ds)) * 0.18;
  acc = over(acc, vec4f(vec3f(28.0, 43.0, 51.0) / 255.0, asd));

  // ── ② 锥体：左右缘各一段贝塞尔，底边 y=-0.15r，顶边 y=-h ──
  let yTop = -h;
  let yBot = -r * 0.15;
  let xl = bezierX(local.y, yBot, -h * 0.5, yTop, -r * 0.85, -r * 0.2, -r * 0.52);
  let xr = bezierX(local.y, yBot, -h * 0.5, yTop,  r * 0.85,  r * 0.2,  r * 0.52);
  let dx = min(local.x - xl, xr - local.x);
  let dy = min(yBot - local.y, local.y - yTop);
  let coneCov = smoothstep(0.0, aa, dx) * smoothstep(0.0, aa, dy);
  acc = over(acc, vec4f(vec3f(96.0, 120.0, 138.0) / 255.0, coneCov * 0.28));

  // ── ③ 6 道旋转螺纹 ──
  for (var i = 0; i < 6; i = i + 1) {
    let t = f32(i) / 5.0;
    let yy = -r * 0.15 - (h - r * 0.3) * t;
    let w = r * (0.92 - 0.55 * t);
    let ph = u.time * 7.0 + f32(i) * 1.15;
    let cx = sin(ph) * w * 0.18;
    let sq = 0.30;
    let q = vec2f(local.x - cx, (local.y - yy) / sq);
    let d = abs(length(q / w) - 1.0) * w * sq;
    let lw = max(2.0, r * 0.13);
    let ringA = (1.0 - smoothstep(lw * 0.5 - aa, lw * 0.5 + aa, d)) * (0.55 - t * 0.22);
    acc = over(acc, vec4f(vec3f(52.0, 74.0, 90.0) / 255.0, ringA));
  }

  // ── ④ 5 块环绕碎屑 ──
  for (var i = 0; i < 5; i = i + 1) {
    let a = u.time * 5.2 + f32(i) * 1.26;
    let t = f32(i % 3) / 2.0;
    let yy = -r * 0.6 - (h - r * 0.3) * (0.25 + t * 0.6);
    let w = r * (0.95 - 0.5 * t);
    let p = vec2f(cos(a) * w, yy + sin(a * 1.7) * 4.0);
    let rad = max(2.0, r * 0.09);
    let d = length(local - p) - rad;
    let ca = 1.0 - smoothstep(-aa, aa, d);
    // hsla(30 + i*18, 30%, 40 + i*6%, .75)
    let rgb = hsv2rgb(vec3f((30.0 + f32(i) * 18.0) / 360.0, 0.30, (40.0 + f32(i) * 6.0) / 100.0));
    acc = over(acc, vec4f(rgb, ca * 0.75));
  }

  if (acc.a <= 0.002) { discard; }
  return vec4f(acc.rgb, acc.a * u.alpha);
}
`;

/** 合成：风眼擦除遮罩 + 暗角 + 整层不透明度 + 过场电影感，输出到画布（alphaMode = premultiplied） */
export const COMPOSITE_WGSL = /* wgsl */ `
struct CompU {
  view: vec2f,     // 0, 4
  wipeR: f32,      // 8  遮罩半径（设备像素）
  wipeInvert: f32, // 12 1 = 保留圆外；0 = 保留圆内
  wipeSoft: f32,   // 16 遮罩边缘柔和度（与 Canvas 径向渐变 0.72 停靠点对应）
  vignette: f32,   // 20 暗角强度
  layerAlpha: f32, // 24 整层不透明度（转场淡出）
  cine: f32,       // 28 过场动画强度 0..1
  wipeSpan: f32,   // 32 遮罩跨度：半径达到它即视为完全铺满，不做裁剪
  _pad0: f32,      // 36
  base: vec4f,     // 48 转场淡出目标底色（rgb 用，a 留空）—— vec4 需 16 字节对齐
};
// 结构体总大小 64 字节（16 个 float）。JS 侧必须分配同样大小，
// 否则 WebGPU 会以「binding size 小于 minBindingSize」拒绝整个 bind group。
@group(0) @binding(0) var<uniform> u: CompU;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSampleLevel(src, samp, uv, 0.0);
  let screen = uv * u.view;
  let d = length(screen - u.view * 0.5);

  // ── 风眼擦除：destination-out（保留圆外）或 destination-in（保留圆内）──
  // 半径不小于遮罩跨度时视为「完全铺满/完全未铺开」，不做裁剪——
  // 与 Canvas 路径 wipeMask 的提前返回同一语义，否则转场首帧会整屏被擦掉。
  var mask = 1.0;
  if (u.wipeR < u.wipeSpan) {
    let t = clamp(d / max(u.wipeR, 0.0001), 0.0, 1.0);
    let soft = smoothstep(u.wipeSoft, 1.0, t);     // 0..0.72 实心，向外渐隐
    mask = select(soft, 1.0 - soft, u.wipeInvert > 0.5);
    if (u.wipeR <= 0.0) { mask = select(0.0, 1.0, u.wipeInvert > 0.5); }
  }

  // ── 暗角：中心 0.42R 外逐渐压暗（过场时更重） ──
  var rgb = c.rgb;
  let vg = smoothstep(u.view.x * 0.42, u.view.x * 0.72, d) * (u.vignette + u.cine * 0.16);
  rgb = mix(rgb, vec3f(28.0, 43.0, 51.0) / 255.0, clamp(vg, 0.0, 1.0));

  // ── 过场调色：整体压一点饱和并偏冷，和 C 端演示画面区分开 ──
  if (u.cine > 0.001) {
    let lum = dot(rgb, vec3f(0.299, 0.587, 0.114));
    rgb = mix(vec3f(lum), rgb, 1.0 - 0.28 * u.cine);
    rgb = rgb * vec3f(0.94, 0.98, 1.06);
  }

  // 擦除/淡出的部分回到不透明底色——Canvas 路径先铺 TIERS[idx].ground[1] 再画世界，
  // 所以转场淡出看到的是底色，而不是画布外的页面白。
  let a = mask * u.layerAlpha;
  var outRgb = mix(u.base.rgb, rgb, a);

  // ── 过场：上下信箱边条压成宽银幕（纯黑，盖在底色之上）──
  if (u.cine > 0.001) {
    let barH = u.view.y * 0.13 * u.cine;
    if (screen.y < barH || screen.y > u.view.y - barH) {
      outRgb = vec3f(0.02, 0.027, 0.035);
    }
  }

  return vec4f(outRgb, 1.0);
}
`;
