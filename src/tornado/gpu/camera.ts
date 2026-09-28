/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/camera.ts — 倾斜正交相机与太阳投影矩阵
 *
 *  世界约定：x / y 是玩法平面（与模拟层一致），z 是高度（向上为正）。
 *  相机俯角 CAM_PITCH 从水平面算起：90° = 正俯视，越小越侧。
 *
 *  主相机矩阵是**直接构造**的，不是 lookAt 推出来的——因为必须与
 *  game.ts 里那条二维投影式逐项一致：
 *      screen_x = VIEW/2 + (x - camx) * s
 *      screen_y = VIEW/2 + (y - camy) * s·sinθ - z·s·cosθ
 *  两者一致，实例化精灵（二维）与网格（三维）才会落在同一个世界里。
 *
 *  深度：视线方向 dir = (0, cosθ, -sinθ)，所以
 *      view_z = (y - camy)·cosθ - z·sinθ
 *  z 越大（越高）view_z 越小＝越靠近相机，遮挡关系因此正确。
 * ──────────────────────────────────────────────────────────── */

/** 列主序 4x4 矩阵（与 WGSL mat4x4f / WebGPU 缓冲布局一致） */
export type Mat4 = Float32Array;

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

/** 列主序矩阵乘法：返回 a·b */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = sum;
    }
  }
  return o;
}

/**
 * 主相机：世界 (x, y, z) → 裁剪空间。
 *
 * 与二维投影式严格等价，只是补上了深度轴：
 *   clip.x =  (x - camx) · s / half
 *   clip.y = -[(y - camy) · s·sinθ - z · s·cosθ] / half      （裁剪空间 y 向上，屏幕 y 向下）
 *   clip.z =  (viewZ - depthNear) / (depthFar - depthNear)   ∈ [0, 1]
 * 其中视线方向深度 viewZ = (y - camy)·cosθ - z·sinθ，z 越大（越高）越靠近相机。
 *
 * **深度范围必须覆盖整个可见场景**：WebGPU 会把 clip.z 落在 [0, 1] 之外的
 * 片元直接裁掉。相机在场景内部，viewZ 天然有正有负，所以 depthNear 要取负值
 * （取正值会把相机附近的整个地面裁掉，画面只剩远处一条边）。
 */
export function tornadoViewProj(
  cam: { x: number; y: number },
  scale: number,
  viewSize: number,
  tiltSin: number,
  tiltCos: number,
  depthNear: number,
  depthFar: number,
): Mat4 {
  const half = viewSize / 2;
  const sx = scale / half;
  const sy = (scale * tiltSin) / half;
  const sz = (scale * tiltCos) / half;
  const range = Math.max(1e-4, depthFar - depthNear);

  const m = new Float32Array(16);
  // 第 0 列（x 的系数）
  m[0] = sx; m[1] = 0; m[2] = 0; m[3] = 0;
  // 第 1 列（y 的系数）
  m[4] = 0; m[5] = -sy; m[6] = tiltCos / range; m[7] = 0;
  // 第 2 列（z 的系数）
  m[8] = 0; m[9] = sz; m[10] = -tiltSin / range; m[11] = 0;
  // 第 3 列（平移）
  m[12] = -cam.x * sx;
  m[13] = sy * cam.y;
  m[14] = (-cam.y * tiltCos - depthNear) / range;
  m[15] = 1;
  return m;
}

/** 右手 lookAt（列主序） */
export function lookAt(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  up: readonly [number, number, number],
): Mat4 {
  const zx = eye[0] - target[0];
  const zy = eye[1] - target[1];
  const zz = eye[2] - target[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  const z = [zx / zl, zy / zl, zz / zl];
  // x = normalize(cross(up, z))
  let xx = up[1] * z[2] - up[2] * z[1];
  let xy = up[2] * z[0] - up[0] * z[2];
  let xz = up[0] * z[1] - up[1] * z[0];
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  // y = cross(z, x)
  const yx = z[1] * xz - z[2] * xy;
  const yy = z[2] * xx - z[0] * xz;
  const yz = z[0] * xy - z[1] * xx;

  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = z[0]; m[3] = 0;
  m[4] = xy; m[5] = yy; m[6] = z[1]; m[7] = 0;
  m[8] = xz; m[9] = yz; m[10] = z[2]; m[11] = 0;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  m[15] = 1;
  return m;
}

/** 正交投影（列主序），映射到 WebGPU 的 z ∈ [0, 1] */
export function ortho(
  left: number, right: number, bottom: number, top: number, near: number, far: number,
): Mat4 {
  const m = new Float32Array(16);
  const rl = right - left || 1e-4;
  const tb = top - bottom || 1e-4;
  const fn = far - near || 1e-4;
  m[0] = 2 / rl;
  m[5] = 2 / tb;
  m[10] = -1 / fn;
  m[12] = -(right + left) / rl;
  m[13] = -(top + bottom) / tb;
  m[14] = -near / fn;
  m[15] = 1;
  return m;
}

/**
 * 太阳朝向：单位向量，指向太阳（阴影落在反方向）。
 *
 * 方向必须与相机同侧：倾斜相机是从 +y 一侧往下看的，所以画面里能看到的
 * 竖直面是物体的 +y 面。太阳若朝 -y，可见的那一面恰好背光，整座城市会
 * 变成一片黑块。这里取「偏 +y、偏 +x、偏上」，让可见面受光、阴影朝左上投。
 */
export const SUN_DIR: readonly [number, number, number] = (() => {
  const v: [number, number, number] = [0.34, 0.46, 0.82];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

/**
 * 太阳的正交投影：把可见世界范围（含高度）罩进一个正交盒。
 *
 * 阴影贴图只需要覆盖当前屏幕能看到的地面区域；范围取得越紧，
 * 同样的贴图分辨率下阴影越锐利。世界高度上限用 maxHeight 兜住。
 */
export function sunViewProj(
  center: { x: number; y: number },
  halfW: number,
  halfH: number,
  maxHeight: number,
): Mat4 {
  const radius = Math.hypot(halfW, halfH) + maxHeight;
  const dist = radius * 2 + 10;
  const eye: [number, number, number] = [
    center.x + SUN_DIR[0] * dist,
    center.y + SUN_DIR[1] * dist,
    SUN_DIR[2] * dist,
  ];
  const view = lookAt(eye, [center.x, center.y, 0], [0, 0, 1]);
  // 正交盒按半径给：太阳斜射，投影到视线平面上的范围不会超过半径
  const proj = ortho(-radius, radius, -radius, radius, 1, dist * 2 + radius);
  return mat4Multiply(proj, view);
}
