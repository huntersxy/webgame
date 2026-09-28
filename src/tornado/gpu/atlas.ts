/* ────────────────────────────────────────────────────────────
 *  tornado/gpu/atlas.ts — 精灵图集
 *
 *  物体贴图仍是 emoji（美术与 Canvas 2D 路径完全一致），但不再逐字
 *  fillText：把本局用到的 emoji 一次性栅格化进一张离屏画布，再上传成
 *  一张 GPU 贴图，渲染时只画实例化四边形。
 *
 *  为什么这么做：Canvas 路径的注释里记着实测数据——DPR2 下 300 个 emoji
 *  fillText 要 1.68ms，而填充圆只要 0.16ms，逐字栅格化是主要开销。
 *  图集把这份开销从「每帧每物体」降到「每局每字形一次」。
 * ──────────────────────────────────────────────────────────── */

/** 单格边长（px）。要容得下最大的 emoji 且留出抗锯齿余量 */
const CELL = 96;
/** 图集每行格数 */
const COLS = 8;

export interface AtlasSlot {
  /** 格中心在图集中的 uv */
  u: number;
  v: number;
  /** 单格 uv 尺寸 */
  du: number;
  dv: number;
}

export interface Atlas {
  canvas: HTMLCanvasElement;
  data: Uint8Array;
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** 字形 → 槽位 */
  slots: Map<string, AtlasSlot>;
}

/**
 * 把一组字形栅格化成图集。`glyphs` 的顺序决定槽位分配，
 * 同一批字形每次得到同一张图集（便于快照比对）。
 */
export function buildAtlas(glyphs: string[], fontStack: string): Atlas {
  const rows = Math.max(1, Math.ceil(glyphs.length / COLS));
  const cols = Math.min(COLS, Math.max(1, glyphs.length));
  const canvas = document.createElement('canvas');
  canvas.width = cols * CELL;
  canvas.height = rows * CELL;
  const ctx = canvas.getContext('2d');
  const slots = new Map<string, AtlasSlot>();

  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 字号取格子的七成：emoji 字形的墨迹通常小于 em 框，留出余量避免相邻格串色
    ctx.font = `${Math.round(CELL * 0.72)}px ${fontStack}`;
    glyphs.forEach((g, i) => {
      const cx = (i % COLS) * CELL + CELL / 2;
      const cy = Math.floor(i / COLS) * CELL + CELL / 2;
      ctx.fillText(g, cx, cy);
      slots.set(g, {
        u: ((i % COLS) + 0.5) / cols,
        v: (Math.floor(i / COLS) + 0.5) / rows,
        du: 1 / cols,
        dv: 1 / rows,
      });
    });
  }

  const img = ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
  return {
    canvas,
    // ImageData 的底层缓冲直接复用，避免再拷一份
    data: img ? new Uint8Array(img.data.buffer.slice(0)) : new Uint8Array(canvas.width * canvas.height * 4),
    width: canvas.width,
    height: canvas.height,
    cols,
    rows,
    slots,
  };
}

/** 本局需要栅格化的全部字形：物体 emoji + 锁标 */
export function glyphsFor(pools: Array<Array<{ e: string }>>): string[] {
  const set = new Set<string>(['🔒']);
  for (const pool of pools) for (const p of pool) set.add(p.e);
  return [...set];
}
