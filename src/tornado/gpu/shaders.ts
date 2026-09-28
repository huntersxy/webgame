/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/shaders.ts — vgpu 渲染管线的 WGSL 源码
 *
 *  分工（与 Canvas 2D 路径的绘制步骤一一对应）：
 *    FLOOR   无限程序化地表：地貌拼块 + 细网格 + 接收阴影。原先每帧在
 *            CPU 上嵌套 fillRect 铺格子，现在改成逐像素计算——地貌种类与
 *            明暗都由世界坐标整数哈希决定，天生适合放进片元着色器。
 *    SPRITE  实例化四边形：粒子、涟漪环、转场文字、锁标。
 *            贴图来自离屏画布，所以美术与 Canvas 路径完全一致。
 *    BLOOM   亮部提取 + 可分离高斯模糊（半分辨率）。
 *    COMPOSITE_MAIN 合成：泛光叠加 + 移轴景深 + 暗角 + 调色 + 风眼擦除。
 *
 *  立体部分（网格、贴花、阴影、龙卷风漏斗、碎屑）在 mesh-shaders.ts。
 *
 *  坐标约定：vgpu 注入的 uv 原点在左上、v 向下，与 WebGPU 一致。
 * ──────────────────────────────────────────────────────────── */

/**
 * 全屏三角形的顶点阶段。
 *
 * 为什么不直接用 effect()：effect 会自己补一个顶点阶段，而它输出的 z 恒为 0，
 * 在「近平面 → 0、远平面 → 1」的深度约定下就是**最近**，会挡住所有立体网格。
 * 场景目标现在带深度附件，所以这两支全屏着色器必须改成显式 draw 并关掉深度
 * （depth: false），否则地表会把整座城市盖掉。
 */
export const FULLSCREEN_VS = /* wgsl */ `
struct FsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> FsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: FsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  // uv 原点在左上、v 向下（与 vgpu 注入的约定一致）
  o.uv = vec2f((p[vi].x + 1.0) * 0.5, 1.0 - (p[vi].y + 1.0) * 0.5);
  return o;
}
`;

/** 地貌调色板：每个量级 5 种地貌，共 6 档 */
export const FLOOR_WGSL = /* wgsl */ `
${FULLSCREEN_VS}

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
  tiltSin: f32,
  shadowStrength: f32,
  // 太阳的正交矩阵：地面是阴影的主要接收面，
  // 少了这一项，立体物体会「浮」在地表上，投不出影子。
  sunViewProj: mat4x4f,
  sunDir: vec4f,   // xyz = 指向太阳的方向，w = 环境光强度
  relief: vec4f,   // x = 起伏强度, y = 边界过渡宽度, z = 水面高光, w = 备用
};
@group(0) @binding(0) var<uniform> u: FloorU;
@group(0) @binding(1) var decor: texture_2d<f32>;
@group(0) @binding(2) var decorSamp: sampler;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowSamp: sampler_comparison;

/* 地面在 z = 0 平面上，直接对世界点求阴影。
   与 mesh-shaders 的 shadowFactor 同一套逻辑（2x2 PCF，越界视为全亮）。 */
fn groundShadow(world: vec2f) -> f32 {
  let lightClip = u.sunViewProj * vec4f(world, 0.0, 1.0);
  let ndc = lightClip.xyz / lightClip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let depth = ndc.z;
  let t = 1.0 / 1024.0;
  var sum = 0.0;
  for (var i = 0; i < 2; i = i + 1) {
    for (var j = 0; j < 2; j = j + 1) {
      let o = (vec2f(f32(i), f32(j)) - vec2f(0.5)) * t;
      sum = sum + textureSampleCompare(shadowMap, shadowSamp, uv + o, depth - 0.0018);
    }
  }
  let avg = sum * 0.25;
  let inBounds = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  return select(1.0, avg, inBounds);
}

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

/* 平滑值噪声：给地面加起伏与斑驳，打破「一块格一个纯色」的读感。
   与 hashInt 不同，这里只需要视觉上的连续性，不必与 JS 侧一致。 */
fn h2(p: vec2f) -> f32 {
  return f32(hashInt(i32(floor(p.x)), i32(floor(p.y)), 777)) / 4294967296.0;
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = h2(i);
  let b = h2(i + vec2f(1.0, 0.0));
  let c = h2(i + vec2f(0.0, 1.0));
  let d = h2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm2(p0: vec2f) -> f32 {
  var p = p0;
  var v = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 4; i = i + 1) {
    v = v + amp * vnoise(p);
    p = p * 2.03;
    amp = amp * 0.5;
  }
  return v;
}

/* 在 3x3 邻域里取「最近的其他地貌」和它的距离：
   用于把硬边的色块改成有过渡的地貌拼布（硬边正是「像色板」的直接原因）。 */
fn biomeBlend(cell: vec2f, lvl: i32, own: i32, width: f32) -> vec2f {
  // 返回 (混合权重, 邻居地貌索引)
  var best = 1e9;
  var bestKind = own;
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      if (i == 0 && j == 0) { continue; }
      let nc = cell + vec2f(f32(i), f32(j));
      let nk = biomeIndex(i32(nc.x), i32(nc.y), lvl);
      if (nk == own) { continue; }
      // 到该格中心区域的近似距离（格内坐标以中心为原点）
      let d = length(fract(cell) - vec2f(0.5) - vec2f(f32(i), f32(j)));
      if (d < best) { best = d; bestKind = nk; }
    }
  }
  // 只在离边界很近时才混合，避免整片糊掉
  let w = 1.0 - smoothstep(0.0, width, best);
  return vec2f(w, f32(bestKind));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // 屏幕像素 → 世界坐标（倾斜正交的逆：纵向要除以 sinθ 还原被压扁的地面）
  let screen = uv * u.view;
  let world = u.cam + vec2f((screen.x - u.view.x * 0.5) / u.scale,
                            (screen.y - u.view.y * 0.5) / (u.scale * u.tiltSin));

  // ① 地貌拼块：格子边长随镜头缩放（贴近「每屏约 4 个地貌格」的 LOD）
  let cell = world / u.tile;
  let cx = i32(floor(cell.x));
  let cy = i32(floor(cell.y));
  let lvl = i32(u.tier);
  let kind = biomeIndex(cx, cy, lvl);

  // 格内位置哈希 → 明暗抖动，让地表读起来像地图而不是色板
  let jitter = f32(hashInt(cx, cy, lvl + 5)) / 4294967296.0;
  // 数组下标必须是整数：先算整型槽位再索引
  let slot = lvl * 5 + kind;
  let base = u.cols[slot].rgb / 255.0;
  var col = shade(base * 255.0, (jitter - 0.5) * 0.1) / 255.0;

  // ①b 地貌过渡：把硬边色块改成有过渡的拼布。
  //     相邻地貌不同时，在边界附近按距离把两种色混起来——
  //     这是消除「一块格一个纯色」观感的关键一笔。
  let bl = biomeBlend(cell, lvl, kind, u.relief.y);
  if (bl.x > 0.001) {
    let nb = u.cols[lvl * 5 + i32(bl.y)].rgb / 255.0;
    col = mix(col, shade(nb * 255.0, (jitter - 0.5) * 0.1) / 255.0, bl.x * 0.85);
  }

  // ② 地表装饰：路网 / 田块 / 海浪，按世界坐标平铺（repeat 采样）
  let duv = world / u.decorWorld;
  let dec = textureSample(decor, decorSamp, duv);
  col = mix(col, dec.rgb, dec.a * u.decorMix);

  // ②b 起伏：用 fbm 造一层高度场并求法线，按太阳方向做明暗。
  //     没有这一层，地面永远是一张平贴图，加多少颜色都还是平的。
  //
  //     频率与法线强度都必须克制：求法线的差分对噪声极其敏感，
  //     采样步长偏小或强度偏大时，法线会在相邻像素间乱翻，
  //     地面就从「有起伏的地形」退化成「电视雪花」。
  //     这里用低频（每屏约 6 个起伏）+ 小步长 + 小强度。
  let rel = u.relief.x;
  if (rel > 0.001) {
    let freq = 1.4;
    let e = u.tile * 0.25;                     // 求法线的采样步长（世界单位）
    let hC = fbm2(world / u.tile * freq);
    let hX = fbm2((world + vec2f(e, 0.0)) / u.tile * freq);
    let hY = fbm2((world + vec2f(0.0, e)) / u.tile * freq);
    // 高度差 → 法线（z 分量为 1 的近似）
    let nrm = normalize(vec3f(-(hX - hC) * rel * 2.2, -(hY - hC) * rel * 2.2, 1.0));
    let l = max(dot(nrm, normalize(u.sunDir.xyz)), 0.0);
    // 只调制亮度、不改变色相，避免把调色板搞乱；均值保持在 1.0 附近，
    // 否则整体会一起变亮、把粉彩地表冲成灰白。
    let lift = 0.90 + 0.22 * l;
    col = col * lift;
    // 高处再补一点暖色，低处压暗，强化体积感
    col = col + vec3f(0.030, 0.026, 0.018) * (hC - 0.5) * rel * 2.0;
    // 细颗粒：再加一层高频噪声做「土质」，否则大片色块显得像塑料。
    // 幅度很小（±4%），只是打散纯色，不改变地貌读法。
    let grain = fbm2(world / u.tile * 26.0);
    col = col * (0.96 + 0.08 * grain);
  }

  // ③ 细网格：线宽固定为屏幕像素，任何镜头下都读作 1.4px 的路网
  let g0 = 64.0;
  let halfW = (u.gridPx * 0.5) / u.scale;          // 世界单位下的半线宽
  let aa = 0.75 / u.scale;                          // 抗锯齿过渡带
  let dw = abs(world / g0 - round(world / g0)) * g0;
  let gd = min(dw.x, dw.y);
  let cov = 1.0 - smoothstep(halfW - aa, halfW + aa, gd);
  col = mix(col, u.gridCol.rgb / 255.0, cov * u.gridCol.a);

  // ③b 水面：单独处理高光与波纹。
  //     水的关键不是颜色而是「会反光的平面」——没有高光，湖面只是一块蓝补丁。
  //
  //     高光必须用低频法线 + 宽高光：噪声法线配高次幂会产生孤立亮点，
  //     读起来像撒了一地白色碎屑，而不是水面反光。
  if (kind == 4 && u.relief.z > 0.001) {
    // 频率必须远高于地貌格：早先用 0.9（波长约 167 世界单位 ≈ 一格），
    // 结果反光成片、读起来是「天上的白云」而不是水面。4.0 让波长降到约 37 单位。
    let wp = world / u.tile * 4.0;
    let ph = vec2f(u.relief.w * 0.9, u.relief.w * 0.55);
    let w1 = fbm2(wp + ph);
    let w2 = fbm2(wp * 1.7 - ph);
    let wave = (w1 + w2) * 0.5;
    let e = 0.5;
    let wX = fbm2((wp + vec2f(e, 0.0)) + ph);
    let wY = fbm2((wp + vec2f(0.0, e)) + ph);
    let wnrm = normalize(vec3f(-(wX - w1) * 3.0, -(wY - w1) * 3.0, 1.0));
    let sd = normalize(u.sunDir.xyz);
    // 俯视：视线近似垂直向下，半程向量取太阳与视线之间
    let halfV = normalize(sd + vec3f(0.0, 0.0, 1.0));
    // 宽高光（指数 12）配一个窄包络，让反光成「闪点」而不是「云斑」
    let spec = pow(max(dot(wnrm, halfV), 0.0), 12.0);
    let env = smoothstep(0.62, 0.88, wave);
    col = col * (0.96 + 0.08 * wave);
    col = col + vec3f(1.0, 0.99, 0.95) * spec * env * u.relief.z;
  }

  // ④ 地面接收阴影：立体物体的投影落在这里，
  //    这是「物体站在地上」而不是「浮在地表上」的关键一笔。
  let sh = groundShadow(world);
  let shadowMul = mix(1.0, 0.62, (1.0 - sh) * u.shadowStrength);
  col = col * shadowMul;
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

/** 泛光：亮部提取（阈值 + 软膝）与可分离高斯模糊，输出半分辨率纹理 */
export const BLOOM_WGSL = /* wgsl */ `
${FULLSCREEN_VS}

/* 泛光：亮部提取（阈值 + 软膝）与可分离高斯模糊。
   两者共用同一支着色器，靠 u.mode 分流——省一次管线编译。
   mode 0 = 提取亮部，1 = 横向模糊，2 = 纵向模糊。 */
struct BloomU {
  texel: vec2f,      // 源纹理纹素尺寸
  threshold: f32,    // 亮部阈值
  knee: f32,         // 软膝
  dir: vec2f,        // 模糊方向（纹素为单位）
  radius: f32,       // 模糊半径倍数
  mode: f32,
};
@group(0) @binding(0) var<uniform> b: BloomU;
@group(0) @binding(1) var bsrc: texture_2d<f32>;
@group(0) @binding(2) var bsamp: sampler;

@fragment fn fs_bloom(@location(0) uv: vec2f) -> @location(0) vec4f {
  if (b.mode < 0.5) {
    // ── 提取亮部：只有明显高于地面平均亮度的像素才参与 ──
    // 地表是明亮的粉彩（亮度常在 0.7 以上），阈值若按「接近 1」去设，
    // 整片地面都会被算进亮部，泛光就变成给全屏加白。
    // 所以阈值必须显著高于地面亮度，只留下高光、碎屑与龙卷风边缘。
    let c = textureSampleLevel(bsrc, bsamp, uv, 0.0).rgb;
    let lum = dot(c, vec3f(0.299, 0.587, 0.114));
    let soft = clamp((lum - b.threshold) / max(b.knee, 1e-4), 0.0, 1.0);
    let w = max(lum - b.threshold, 0.0) / max(lum, 1e-4);
    return vec4f(c * w * soft, 1.0);
  }
  // ── 9 抽头高斯：横向与纵向共用 ──
  let w = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  var sum = textureSampleLevel(bsrc, bsamp, uv, 0.0).rgb * w[0];
  for (var i = 1; i < 5; i = i + 1) {
    let o = b.dir * f32(i) * b.radius;
    sum = sum + textureSampleLevel(bsrc, bsamp, uv + o, 0.0).rgb * w[i];
    sum = sum + textureSampleLevel(bsrc, bsamp, uv - o, 0.0).rgb * w[i];
  }
  return vec4f(sum, 1.0);
}
`;

/** 合成：泛光 + 移轴景深 + 暗角 + 调色 + 风眼擦除 + 过场演出 */
export const COMPOSITE_MAIN_WGSL = /* wgsl */ `
${FULLSCREEN_VS}

struct CompU {
  view: vec2f,     // 0, 4
  wipeR: f32,      // 8  遮罩半径（设备像素）
  wipeInvert: f32, // 12 1 = 保留圆外；0 = 保留圆内
  wipeSoft: f32,   // 16 遮罩边缘柔和度（与 Canvas 径向渐变 0.72 停靠点对应）
  vignette: f32,   // 20 暗角强度
  layerAlpha: f32, // 24 整层不透明度（转场淡出）
  cine: f32,       // 28 过场动画强度 0..1
  wipeSpan: f32,   // 32 遮罩跨度：半径达到它即视为完全铺满，不做裁剪
  bloom: f32,      // 36 泛光强度
  dofAmount: f32,  // 40 移轴景深强度（0 = 关闭）
  _pad0: f32,      // 44
  base: vec4f,     // 48 转场淡出目标底色（rgb 用，a 留空）—— vec4 需 16 字节对齐
  dof: vec4f,      // 64 移轴参数：x = 聚焦带半高（0..1），y = 过渡带宽度，zw 备用
};
// 结构体总大小 80 字节（20 个 float）。JS 侧必须分配同样大小，
// 否则 WebGPU 会以「binding size 小于 minBindingSize」拒绝整个 bind group。
@group(0) @binding(0) var<uniform> u: CompU;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;
@group(0) @binding(4) var bloomSamp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let screen = uv * u.view;
  let d = length(screen - u.view * 0.5);

  // ── 移轴景深：屏幕上下缘按距离虚化，中间保持锐利 ──
  // 这是俯视游戏性价比最高的一招：它把画面读成「微缩模型」，
  // 而不需要真正的景深缓冲。
  var c = textureSampleLevel(src, samp, uv, 0.0);
  if (u.dofAmount > 0.001) {
    let band = u.dof.x;
    let falloff = max(u.dof.y, 1e-4);
    // 距屏幕竖直中心的归一化距离，超出聚焦带即开始虚化
    let dv = abs(uv.y - 0.5) * 2.0;
    let blur = clamp((dv - band) / falloff, 0.0, 1.0) * u.dofAmount;
    if (blur > 0.001) {
      // 9 抽头圆盘采样近似散景
      var acc = vec3f(0.0);
      var wsum = 0.0;
      for (var i = 0; i < 9; i = i + 1) {
        let a = f32(i) * 0.6981317;      // 2π/9
        let rr = select(0.6, 1.0, i % 2 == 0);
        let o = vec2f(cos(a), sin(a)) * rr * blur * 6.0 / u.view;
        acc = acc + textureSampleLevel(src, samp, uv + o, 0.0).rgb;
        wsum = wsum + 1.0;
      }
      let blurred = acc / wsum;
      c = vec4f(mix(c.rgb, blurred, blur), c.a);
    }
  }

  // ── 泛光：把亮部叠加回来，让高光与碎屑发光 ──
  var rgb = c.rgb;
  if (u.bloom > 0.001) {
    rgb = rgb + textureSampleLevel(bloomTex, bloomSamp, uv, 0.0).rgb * u.bloom;
  }

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
