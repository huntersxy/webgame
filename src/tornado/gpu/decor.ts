/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/decor.ts — 地表装饰贴图
 *
 *  Canvas 路径把每个量级的地面装饰（低量级的路网、中量级的田野、
 *  高量级的海浪）画进一张离屏画布，平铺时只做 drawImage。这里做同一件事，
 *  只是把那张画布上传成 GPU 贴图，由地表着色器按世界坐标采样平铺。
 *
 *  装饰画法必须与 game.ts 的 drawGroundDecor 保持一致，否则两个后端的
 *  地表质感会明显不同。
 * ──────────────────────────────────────────────────────────── */

/** 装饰贴图分辨率（与 Canvas 路径的 DECOR_PX 对齐） */
export const DECOR_PX = 512;
/** 装饰覆盖的世界尺寸：与 game.ts 的 VIEW * WORLD_K 一致 */
export const DECOR_WORLD = 640 * 1.75;

/** 确定性伪随机（与 game.ts 的 mulberry32 同实现） */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成某个量级的装饰贴图。
 * 与 game.ts 的 drawGroundDecor 逐条对应：低量级画道路街区、中量级画田块林斑、
 * 高量级画海浪。世界坐标 → 贴图像素的比例是 DECOR_PX / DECOR_WORLD。
 */
export function buildDecorCanvas(index: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = DECOR_PX;
  canvas.height = DECOR_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const W = DECOR_WORLD;
  const rng = mulberry32(((index + 1) * 9973 + 7) | 0);
  ctx.save();
  ctx.scale(DECOR_PX / W, DECOR_PX / W);

  if (index <= 2) {
    // 道路：横竖各 3 条沥青带 + 白色虚线中心线
    const roads: Array<{ v: boolean; p: number }> = [];
    for (let i = 0; i < 3; i++) roads.push({ v: false, p: W * (0.16 + 0.32 * i) + (rng() - 0.5) * 90 });
    for (let i = 0; i < 3; i++) roads.push({ v: true, p: W * (0.2 + 0.3 * i) + (rng() - 0.5) * 90 });
    const rw = 34 * (index <= 1 ? 1 : 1.4);
    ctx.fillStyle = 'rgba(62,72,84,.16)';
    for (const rd of roads) {
      if (rd.v) ctx.fillRect(rd.p - rw / 2, 0, rw, W);
      else ctx.fillRect(0, rd.p - rw / 2, W, rw);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.5)';
    ctx.lineWidth = 2.5 * (index <= 1 ? 1 : 1.4);
    ctx.setLineDash([16 * (index <= 1 ? 1 : 1.5), 22 * (index <= 1 ? 1 : 1.5)]);
    ctx.beginPath();
    for (const rd of roads) {
      if (rd.v) { ctx.moveTo(rd.p, 0); ctx.lineTo(rd.p, W); }
      else { ctx.moveTo(0, rd.p); ctx.lineTo(W, rd.p); }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // 街区角落的小绿地
    for (let i = 0; i < 7; i++) {
      const x = rng() * W; const y = rng() * W; const rr = 26 + rng() * 40;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(88,140,90,.09)'; ctx.fill();
    }
  } else if (index <= 4) {
    // 田野拼布：柔和色块
    for (let i = 0; i < 30; i++) {
      const x = rng() * W; const y = rng() * W;
      const w = 90 + rng() * 190; const h = 70 + rng() * 150;
      ctx.fillStyle = i % 2 ? 'rgba(120,140,70,.10)' : 'rgba(190,170,110,.13)';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 10);
      ctx.fill();
    }
    // 蜿蜒小路
    ctx.strokeStyle = 'rgba(140,120,80,.20)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    let px = 0; let py = W * (0.3 + rng() * 0.4);
    ctx.moveTo(px, py);
    while (px < W) { px += 130; py += (rng() - 0.5) * 170; ctx.lineTo(px, py); }
    ctx.stroke();
  } else {
    // 海洋：波纹弧线
    ctx.strokeStyle = 'rgba(255,255,255,.4)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = 0; i < 60; i++) {
      const x = rng() * W; const y = rng() * W; const rr = 12 + rng() * 16;
      ctx.beginPath();
      ctx.arc(x, y, rr, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
    // 远处暗流
    ctx.strokeStyle = 'rgba(40,90,130,.12)';
    ctx.lineWidth = 26;
    for (let i = 0; i < 4; i++) {
      const y = W * (0.15 + 0.22 * i) + (rng() - 0.5) * 80;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= W; x += 160) ctx.lineTo(x, y + Math.sin(x / 150 + i * 2) * 36);
      ctx.stroke();
    }
  }

  ctx.restore();
  return canvas;
}
