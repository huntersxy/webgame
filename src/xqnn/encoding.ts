/* ────────────────────────────────────────────────────────────
 *  xqnn/encoding.ts — 神经网络的局面编码与走法表（复刻上游）
 *
 *  上游 yingwang/chinese_chess 的 ChessNet（AlphaZero 风格）吃的是
 *  15×10×9 的 CHW 张量，吐出 2086 维策略 logits + 1 维价值。它的
 *  JS 侧编码写在 js/ml-ai.js 里，Python 侧写在 encoding.py（未开源），
 *  两者必须逐位一致——所以这里严格照 ml-ai.js 复刻：
 *
 *    · 通道 = 颜色偏移(RED 0 / BLACK 7) + 兵种序号(将0 士1 象2 马3 车4 炮5 兵6)
 *    · 通道 14 = 当前行棋方标记（红走 = 全 1）
 *    · 索引 = channel*90 + row*9 + col
 *    · row 0 = 黑方底线、col 0 = 屏幕左侧；与本项目 board[y][x] 完全同向
 *      （上游 js/model.js 里黑车在 row 0 col 0、红车在 row 9 col 0，
 *       再对比其 FEN 写出顺序即可确认，无需镜像）
 *
 *  走法表是「任意兵种在任意格子上的走法超集」（不判障碍、不判吃子），
 *  排序后按下标对应策略头输出——顺序必须与上游 generateMoveTable()
 *  完全一致，否则策略头指向的着法会整体错位。
 * ──────────────────────────────────────────────────────────── */

import type { XqBoard, XqSide } from '../types';
import { COLS, ROWS } from '../xiangqi/rules';

export const NUM_CHANNELS = 15;
export const NUM_ACTIONS = 2086;

/** 本项目棋子字符 → 上游通道序号（将0 士1 象2 马3 车4 炮5 兵6）。 */
const TYPE_INDEX: Record<string, number> = {
  k: 0, a: 1, b: 2, n: 3, r: 4, c: 5, p: 6,
};

/** 红方在通道 0..6，黑方在 7..13（与上游颜色偏移一致）。 */
const COLOR_OFFSET = 7;

/**
 * 把 2D 棋盘编码成 CHW 浮点张量（长度 15*10*9）。
 * @param board 棋盘，board[y][x]，y=0 为黑方底线
 * @param side  行棋方（大写为红：与 rules.ts 的 isRed 一致）
 */
export function encodeBoard(board: XqBoard, side: XqSide): Float32Array {
  const out = new Float32Array(NUM_CHANNELS * ROWS * COLS);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = board[y][x];
      if (!p) continue;
      const isRedPiece = p === p.toUpperCase();
      const type = TYPE_INDEX[p.toLowerCase()];
      if (type === undefined) continue;
      const ch = (isRedPiece ? 0 : COLOR_OFFSET) + type;
      out[ch * ROWS * COLS + y * COLS + x] = 1;
    }
  }
  if (side === 'r') {
    const base = 14 * ROWS * COLS;
    for (let i = 0; i < ROWS * COLS; i++) out[base + i] = 1;
  }
  return out;
}

/* ── 走法表（2086 项）──────────────────────────────────────────
 * 复刻上游 generateMoveTable()：
 *   ① 车/炮/兵的直线走法：四方向逐格外推（不判阻挡）
 *   ② 马的八向走法
 *   ③ 士的四向斜走：只从九宫内的士位出发，落点仍在九宫内
 *   ④ 象的四向田字：只从象位出发，落点仍在同一半场
 * 去重后按 (from, to) 升序排序。                                       */

const ADVISOR_SQUARES: Array<[number, number]> = [
  [0, 3], [0, 5], [1, 4], [2, 3], [2, 5],
  [7, 3], [7, 5], [8, 4], [9, 3], [9, 5],
];

const ELEPHANT_SQUARES: Array<[number, number]> = [
  [0, 2], [0, 6], [2, 0], [2, 4], [2, 8], [4, 2], [4, 6],
  [5, 2], [5, 6], [7, 0], [7, 4], [7, 8], [9, 2], [9, 6],
];

const ORTHO: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const KNIGHT: Array<[number, number]> = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1],
];
const DIAG: Array<[number, number]> = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

export interface XqMoveTable {
  /** 下标 = 策略头维度；值 = from*90+to（from/to 都是 row*9+col → 本项目的 y*9+x） */
  from: Int16Array;
  to: Int16Array;
  /** 反查：(from*90+to) → 策略下标，未登记为 -1。表长 90*90。 */
  index: Int32Array;
}

let cached: XqMoveTable | null = null;

/** 构建（并缓存）走法表。首次调用做 2086 项排序，之后零成本。 */
export function moveTable(): XqMoveTable {
  if (cached) return cached;

  const inBoard = (r: number, c: number) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
  const set = new Set<number>();
  /** 与上游一致：只用 f*100+t 当去重键（f、t 均为 row*9+col）。 */
  const add = (fr: number, fc: number, tr: number, tc: number) => {
    set.add((fr * COLS + fc) * 100 + (tr * COLS + tc));
  };

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of ORTHO) {
        for (let st = 1; st < Math.max(ROWS, COLS); st++) {
          const nr = r + dr * st;
          const nc = c + dc * st;
          if (inBoard(nr, nc)) add(r, c, nr, nc);
        }
      }
      for (const [dr, dc] of KNIGHT) {
        const nr = r + dr;
        const nc = c + dc;
        if (inBoard(nr, nc)) add(r, c, nr, nc);
      }
    }
  }

  for (const [r, c] of ADVISOR_SQUARES) {
    for (const [dr, dc] of DIAG) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBoard(nr, nc)) continue;
      const inPalace = (nr >= 0 && nr <= 2 && nc >= 3 && nc <= 5) || (nr >= 7 && nr <= 9 && nc >= 3 && nc <= 5);
      if (inPalace) add(r, c, nr, nc);
    }
  }

  for (const [r, c] of ELEPHANT_SQUARES) {
    for (const [dr, dc] of DIAG) {
      const nr = r + dr * 2;
      const nc = c + dc * 2;
      if (!inBoard(nr, nc)) continue;
      const sameHalf = (r <= 4 && nr <= 4) || (r >= 5 && nr >= 5);
      if (sameHalf) add(r, c, nr, nc);
    }
  }

  // 上游用 f*100+t 当 key，之后才转成 [f,t] 升序；这里同样按 (f,t) 升序排。
  const pairs: Array<[number, number]> = [];
  for (const key of set) {
    pairs.push([Math.floor(key / 100), key % 100]);
  }
  pairs.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));

  const from = new Int16Array(pairs.length);
  const to = new Int16Array(pairs.length);
  const index = new Int32Array(90 * 90).fill(-1);
  pairs.forEach(([f, t], i) => {
    from[i] = f;
    to[i] = t;
    index[f * 90 + t] = i;
  });

  cached = { from, to, index };
  return cached;
}

/** 某个 (from,to) 的策略下标；不存在返回 -1。坐标均为 y*9+x。 */
export function actionIndex(fromSq: number, toSq: number): number {
  const t = moveTable();
  if (fromSq < 0 || fromSq >= 90 || toSq < 0 || toSq >= 90) return -1;
  return t.index[fromSq * 90 + toSq];
}
