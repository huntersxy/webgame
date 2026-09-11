/* ────────────────────────────────────────────────────────────
 *  othello/evaluate.ts — 静态评估 + 稳定子（供搜索与界面共用）
 * ──────────────────────────────────────────────────────────── */

import type { OthDisc, OthBoard } from '../types';
import { CELLS, fromCells, legalMoves, popcount, other } from './rules';
import type { OthPosition } from './rules';

/** 终局精确求解的剩余空格阈值：进入这个区间就不再依赖评估函数 */
export const ENDGAME_EMPTIES = 14;
/** 搜索分值上限（子数差口径，最多 64 子） */
export const WIN_BASE = 1000;

/* ── 位置权重表（黑白棋经典口径） ── */
const W_CORNER = 500;
const W_CORNER_ADJ = -120;
const W_EDGE = 40;
const W_CENTER = -18;
const W_OTHER = -8;

/** 位置权重表，index = y*8+x */
export const WEIGHT: Int16Array = (() => {
  const w = new Int16Array(CELLS);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = y * 8 + x;
      const isCorner = (x === 0 || x === 7) && (y === 0 || y === 7);
      const edge = x === 0 || x === 7 || y === 0 || y === 7;
      const inner = x === 1 || x === 6 || y === 1 || y === 6;
      const center = x >= 2 && x <= 5 && y >= 2 && y <= 5;
      if (isCorner) w[i] = W_CORNER;
      else if (edge) w[i] = W_EDGE;
      else if (inner) w[i] = W_CORNER_ADJ;   // 与角相邻的内侧格：先占最容易送角
      else if (center) w[i] = W_CENTER;
      else w[i] = W_OTHER;
    }
  }
  // 角旁对角格（b1/g1/a2/h2…）单独加重惩罚：送角最致命
  for (const i of [9, 14, 49, 54]) w[i] = W_CORNER_ADJ * 1.5;
  // 与角同边、隔一格的边格（c1/f1/a3/h3…）相对安全，给边权
  for (const i of [2, 5, 16, 24, 39, 46, 58, 61]) w[i] = W_EDGE;
  return w;
})();

export function weightAt(index: number): number {
  return WEIGHT[index];
}

/** 单格位表：避免热点循环里反复构造元组 */
export const CELL_BITS: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: CELLS },
  (_, i): readonly [number, number] => (i < 32 ? [(1 << i) >>> 0, 0] : [0, (1 << (i - 32)) >>> 0]),
);

function hasSet(set: readonly [number, number], bit: readonly [number, number]): boolean {
  return (((set[0] & bit[0]) | (set[1] & bit[1])) >>> 0) !== 0;
}

/** 双方棋子的位置权重差（当前行棋方视角） */
export function positionScore(pos: OthPosition, side: OthDisc): number {
  const mine = side === 1 ? pos.black : pos.white;
  const theirs = side === 1 ? pos.white : pos.black;
  let s = 0;
  for (let i = 0; i < CELLS; i++) {
    if (hasSet(mine, CELL_BITS[i])) s += WEIGHT[i];
    else if (hasSet(theirs, CELL_BITS[i])) s -= WEIGHT[i];
  }
  return s;
}

export function discDiff(pos: OthPosition, side: OthDisc): number {
  const black = popcount(pos.black[0]) + popcount(pos.black[1]);
  const white = popcount(pos.white[0]) + popcount(pos.white[1]);
  return (side === 1 ? black - white : white - black);
}

/** 相邻格掩码（稳定性传播用） */
const NEIGHBOR: number[][] = (() => {
  const out: number[][] = [];
  for (let i = 0; i < CELLS; i++) {
    const x = i & 7, y = i >> 3;
    const list: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx > 7 || ny < 0 || ny > 7) continue;
        list.push(ny * 8 + nx);
      }
    }
    out.push(list);
  }
  return out;
})();

/**
 * 稳定子计数（保守下界）：从四角出发，若某稳定子的全部相邻格都已被占用，
 * 则相邻格中属于该方的子也可视为稳定。
 * 宁可少算，也不会把可能被翻的子算成稳定——这是评估里唯一的安全方向。
 */
export function countStable(pos: OthPosition, side: OthDisc): number {
  const discs = side === 1 ? pos.black : pos.white;
  const occupied: [number, number] = [
    ((pos.black[0] | pos.white[0]) >>> 0),
    ((pos.black[1] | pos.white[1]) >>> 0),
  ];
  const stable = new Uint8Array(CELLS);
  for (const c of [0, 7, 56, 63]) {
    if (hasSet(discs, CELL_BITS[c])) stable[c] = 1;
  }
  for (let round = 0; round < 8; round++) {
    let added = 0;
    for (let i = 0; i < CELLS; i++) {
      if (!stable[i]) continue;
      const nb = NEIGHBOR[i];
      let allOccupied = true;
      for (const j of nb) {
        if (!hasSet(occupied, CELL_BITS[j])) { allOccupied = false; break; }
      }
      if (!allOccupied) continue;
      for (const j of nb) {
        if (!stable[j] && hasSet(discs, CELL_BITS[j])) { stable[j] = 1; added++; }
      }
    }
    if (!added) break;
  }
  let n = 0;
  for (let i = 0; i < CELLS; i++) n += stable[i];
  return n;
}

/**
 * 叶子评估，正数 = 当前行棋方好。
 * 中盘以「位置 + 行动力」为主（黑白棋中盘子数多通常是劣势，故只用极小权重）；
 * 进入终局区间后切换成「子数差 + 稳定子」口径，那个阶段多子才等于赢。
 */
export function evaluateState(
  pos: OthPosition,
  side: OthDisc,
  empties: number,
  mobility: (p: OthPosition, s: OthDisc) => number,
): number {
  const posScore = positionScore(pos, side);
  if (empties <= ENDGAME_EMPTIES) {
    const diff = discDiff(pos, side);
    const mine = countStable(pos, side);
    const theirs = countStable(pos, other(side));
    return posScore * 0.25 + diff * 60 + (mine - theirs) * 30;
  }
  return posScore + mobility(pos, side) * 45 + discDiff(pos, side) * 1.5;
}

/** 只做位置与行动力评估（不依赖搜索）：界面局势条 / 文本用 */
export function quickEval(pos: OthPosition): number {
  const empties = CELLS - (popcount(pos.black[0]) + popcount(pos.black[1]) + popcount(pos.white[0]) + popcount(pos.white[1]));
  return evaluateState(pos, pos.side, empties, mobilityOf);
}

function mobilityOf(p: OthPosition, side: OthDisc): number {
  return legalMoves({ ...p, side }).length;
}

/** 64 格数组 → 快速评估（当前行棋方视角） */
export function quickEvalCells(cells: OthBoard, side: OthDisc): number {
  return quickEval(fromCells(cells, side));
}

/** 清点双方子数（界面计分板） */
export function counts(cells: OthBoard): { black: number; white: number } {
  let black = 0, white = 0;
  for (let i = 0; i < CELLS; i++) {
    if (cells[i] === 1) black++;
    else if (cells[i] === 2) white++;
  }
  return { black, white };
}
