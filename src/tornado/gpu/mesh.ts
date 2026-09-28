/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/mesh.ts — 程序化单位网格
 *
 *  仓库承诺「不存第三方美术素材」，所以所有立体几何都在这里用代码生成：
 *  盒体、柱体、锥体、水平贴花面片。配合实例流里的位置/缩放/色调复用。
 *
 *  坐标约定与相机一致：**x / y 是地面平面，z 向上**。
 *  顶点格式统一为 position(float32x3) + normal(float32x3)，stride 24 字节，
 *  与 vgpu 几何配方暴露的布局一致，因此两者可以互换。
 * ──────────────────────────────────────────────────────────── */

/** 一个单位网格：非索引三角列表，位置与法线交错存放 */
export interface UnitMesh {
  /** 交错的 position(3) + normal(3)，共 6 个 float / 顶点 */
  data: Float32Array<ArrayBuffer>;
  /** 顶点数（非索引，直接作为 draw 的 vertexCount） */
  vertexCount: number;
}

/** 往交错缓冲里写一个顶点 */
function push(
  out: number[],
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
): void {
  out.push(px, py, pz, nx, ny, nz);
}

/** 三角形（按逆时针给出三个顶点 + 统一法线） */
function tri(
  out: number[],
  a: readonly number[], b: readonly number[], c: readonly number[],
  n: readonly number[],
): void {
  for (const v of [a, b, c]) push(out, v[0], v[1], v[2], n[0], n[1], n[2]);
}

/**
 * 单位盒体：中心在原点，x / y / z 边长均为 1（范围 -0.5..0.5）。
 * 每个面独立顶点（法线按面给），共 36 个顶点。
 */
export function unitBox(): UnitMesh {
  const out: number[] = [];
  const h = 0.5;
  // [法线, 面内两个切向]
  const faces: Array<[number[], number[], number[]]> = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],    // +Z 顶面
    [[0, 0, -1], [1, 0, 0], [0, -1, 0]],  // -Z 底面
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],    // +X
    [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],  // -X
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],   // +Y
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],   // -Y
  ];
  for (const [n, t, b] of faces) {
    const corner = (a: number, c: number): number[] => [
      n[0] * h + t[0] * a * h + b[0] * c * h,
      n[1] * h + t[1] * a * h + b[1] * c * h,
      n[2] * h + t[2] * a * h + b[2] * c * h,
    ];
    const v0 = corner(-1, -1); const v1 = corner(1, -1);
    const v2 = corner(1, 1); const v3 = corner(-1, 1);
    tri(out, v0, v1, v2, n);
    tri(out, v0, v2, v3, n);
  }
  return { data: new Float32Array(out), vertexCount: out.length / 6 };
}

/**
 * 单位柱体：底面半径 0.5，沿 z 轴高 1（z 从 -0.5 到 0.5），中心在原点。
 * `segments` 决定圆周细分，默认 12——低量级物体很小，12 段足够圆。
 */
export function unitCylinder(segments = 12): UnitMesh {
  const out: number[] = [];
  const r = 0.5;
  const h = 0.5;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0); const s0 = Math.sin(a0);
    const c1 = Math.cos(a1); const s1 = Math.sin(a1);
    const n0: number[] = [c0, s0, 0];
    const n1: number[] = [c1, s1, 0];
    const p00: number[] = [c0 * r, s0 * r, -h];
    const p01: number[] = [c0 * r, s0 * r, h];
    const p10: number[] = [c1 * r, s1 * r, -h];
    const p11: number[] = [c1 * r, s1 * r, h];
    // 侧面（法线按各顶点径向给）
    push(out, p00[0], p00[1], p00[2], n0[0], n0[1], 0);
    push(out, p10[0], p10[1], p10[2], n1[0], n1[1], 0);
    push(out, p11[0], p11[1], p11[2], n1[0], n1[1], 0);
    push(out, p00[0], p00[1], p00[2], n0[0], n0[1], 0);
    push(out, p11[0], p11[1], p11[2], n1[0], n1[1], 0);
    push(out, p01[0], p01[1], p01[2], n0[0], n0[1], 0);
    // 顶盖（z = +h）
    tri(out, [0, 0, h], [c0 * r, s0 * r, h], [c1 * r, s1 * r, h], [0, 0, 1]);
    // 底盖（z = -h）
    tri(out, [0, 0, -h], [c1 * r, s1 * r, -h], [c0 * r, s0 * r, -h], [0, 0, -1]);
  }
  return { data: new Float32Array(out), vertexCount: out.length / 6 };
}

/**
 * 单位锥体：底面半径 0.5 在 z = -0.5，顶点在 z = +0.5。山峰与树冠都用它。
 */
export function unitCone(segments = 12): UnitMesh {
  const out: number[] = [];
  const r = 0.5;
  const h = 0.5;
  // 斜面法线：径向分量 0.5（半径），轴向分量 1（高）——按斜高归一化
  const axial = r;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const am = (a0 + a1) * 0.5;
    const mx = Math.cos(am); const my = Math.sin(am);
    const nl = Math.hypot(axial, 1) || 1;
    const n: number[] = [(mx * axial) / nl, (my * axial) / nl, 1 / nl];
    tri(out, [0, 0, h], [Math.cos(a0) * r, Math.sin(a0) * r, -h], [Math.cos(a1) * r, Math.sin(a1) * r, -h], n);
    // 底盖
    tri(out, [0, 0, -h], [Math.cos(a1) * r, Math.sin(a1) * r, -h], [Math.cos(a0) * r, Math.sin(a0) * r, -h], [0, 0, -1]);
  }
  return { data: new Float32Array(out), vertexCount: out.length / 6 };
}

/**
 * 水平贴花面片：x / y 平面上的单位正方形（-0.5..0.5），法线朝 +z。
 * emoji 贴花贴在底座顶面时用它；额外带一套 uv（顶点格式为 pos + uv）。
 */
export interface UnitDecal {
  data: Float32Array<ArrayBuffer>;
  vertexCount: number;
}

/**
 * 龙卷风漏斗：沿 z 轴堆叠的渐缩环，带轻微外扩的喇叭口。
 *
 * 单位尺寸约定：高度 1（z 从 0 到 1，底面贴地），底面半径 1。
 * 剖面半径 profile(t)：t=0 是触地端（窄），t=1 是顶端（宽）——
 * 与真实的漏斗一致，也让「越往上越粗」的剪影一眼可读。
 * 顶点只带 position + normal；旋转螺纹在片元着色器里按世界坐标现算。
 */
export interface UnitFunnel {
  data: Float32Array<ArrayBuffer>;
  vertexCount: number;
}

export function unitFunnel(segments = 24, rings = 14): UnitFunnel {
  const out: number[] = [];
  // 剖面：触地端极窄、向上加速外扩成喇叭口。
  //
  // 指数与底径都是量出来的，不是拍的：早先用 `0.16 + 0.84·t^0.75`，
  // 实测屏幕剪影只有 1.8:1（高:宽），最宽处落在离顶 21% 处、顶缘反而收窄，
  // 于是整根糊成一个竖椭圆——玩家看到的正是「一块深色污渍」。
  // 改成 `0.09 + 0.91·t^1.35` 后触地端只剩 9% 顶宽，锥度才读得出来。
  const radiusAt = (t: number): number => 0.09 + 0.91 * t ** 1.35;
  // 沿高度轻微 S 形弯曲，避免变成一个呆板的直筒
  const bendAt = (t: number): [number, number] => [
    Math.sin(t * Math.PI * 1.15) * 0.10,
    Math.cos(t * Math.PI * 0.85) * 0.06 - 0.06,
  ];

  for (let j = 0; j < rings; j++) {
    const t0 = j / rings;
    const t1 = (j + 1) / rings;
    const r0 = radiusAt(t0); const r1 = radiusAt(t1);
    const [b0x, b0y] = bendAt(t0);
    const [b1x, b1y] = bendAt(t1);
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const c0 = Math.cos(a0); const s0 = Math.sin(a0);
      const c1 = Math.cos(a1); const s1 = Math.sin(a1);
      // 四个角：下环两点 + 上环两点
      const p00: number[] = [c0 * r0 + b0x, s0 * r0 + b0y, t0];
      const p10: number[] = [c1 * r0 + b0x, s1 * r0 + b0y, t0];
      const p01: number[] = [c0 * r1 + b1x, s0 * r1 + b1y, t1];
      const p11: number[] = [c1 * r1 + b1x, s1 * r1 + b1y, t1];
      // 法线取径向（漏斗很薄，径向足够读出体积）
      const n0: number[] = [c0, s0, 0];
      const n1: number[] = [c1, s1, 0];
      // 两个三角形；uv.x = 角度归一化、uv.y = 高度
      const u0 = i / segments; const u1 = (i + 1) / segments;
      push(out, p00[0], p00[1], p00[2], n0[0], n0[1], n0[2]);
      push(out, p10[0], p10[1], p10[2], n1[0], n1[1], n1[2]);
      push(out, p11[0], p11[1], p11[2], n1[0], n1[1], n1[2]);
      push(out, p00[0], p00[1], p00[2], n0[0], n0[1], n0[2]);
      push(out, p11[0], p11[1], p11[2], n1[0], n1[1], n1[2]);
      push(out, p01[0], p01[1], p01[2], n0[0], n0[1], n0[2]);
      void u0; void u1;
    }
  }
  return { data: new Float32Array(out), vertexCount: out.length / 6 };
}

export function unitDecalQuad(): UnitDecal {
  const out: number[] = [];
  // 位置(x,y,z) + uv(u,v)
  const v = [
    [-0.5, -0.5, 0, 0, 1],
    [0.5, -0.5, 0, 1, 1],
    [0.5, 0.5, 0, 1, 0],
    [-0.5, -0.5, 0, 0, 1],
    [0.5, 0.5, 0, 1, 0],
    [-0.5, 0.5, 0, 0, 0],
  ];
  for (const p of v) out.push(p[0], p[1], p[2], p[3], p[4]);
  return { data: new Float32Array(out), vertexCount: 6 };
}
