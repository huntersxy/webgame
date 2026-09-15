/* ───────────────────────────────────────────────────────────────
 *  src/ddz/encoder.ts — DouZero 特征编码器
 *
 *  移植自官方 kwai/DouZero douzero/env/env.py 的 get_obs 系列：
 *    · x：角色相关特征（地主 373 维，农民 484 维），每个候选走法一行
 *    · z：最近 15 手历史，重塑为 [5,162]（喂 LSTM），全体候选共享
 *  牌值编码 3..14,17,20,30；cards2array 为 4×13 列主序 + 双王 2 维 = 54。
 * ─────────────────────────────────────────────────────────────── */

import { type DdzState, rivalOfSeq } from './game';
import { type Move, getLegalMoves } from './rules';

/** 官方 Card2Column：3..14 → 0..11，2(17) → 12 */
const CARD2COLUMN = new Map<number, number>([
  [3, 0], [4, 1], [5, 2], [6, 3], [7, 4], [8, 5], [9, 6],
  [10, 7], [11, 8], [12, 9], [13, 10], [14, 11], [17, 12],
]);

/** 官方 NumOnes2Array：列内 1 的个数 → 4 维模式（如 2 → [1,1,0,0]） */
const NUM_ONES: number[][] = [
  [0, 0, 0, 0],
  [1, 0, 0, 0],
  [1, 1, 0, 0],
  [1, 1, 1, 0],
  [1, 1, 1, 1],
];

export const X_DIM_LANDLORD = 373;
export const X_DIM_FARMER = 484;

/** 官方 _cards2array：4×13 列主序展平 + 王 2 维 → 54 维 0/1 */
export function cards2array(cards: Move): Float32Array {
  const out = new Float32Array(54);
  if (cards.length === 0) return out;

  const counts = new Map<number, number>();
  for (const c of cards) counts.set(c, (counts.get(c) ?? 0) + 1);

  for (const [card, num] of counts) {
    if (card < 20) {
      const col = CARD2COLUMN.get(card);
      if (col === undefined) continue;
      const pattern = NUM_ONES[Math.min(num, 4)];
      // 列主序（flatten 'F'）：index = col * 4 + row
      for (let row = 0; row < 4; row++) out[col * 4 + row] = pattern[row];
    } else if (card === 20) {
      out[52] = 1;
    } else if (card === 30) {
      out[53] = 1;
    }
  }
  return out;
}

/** 官方 _get_one_hot_array：剩牌数 → 长 maxN 的 one-hot（下标 num-1） */
function oneHotNumLeft(num: number, maxN: number): Float32Array {
  const out = new Float32Array(maxN);
  if (num >= 1 && num <= maxN) out[num - 1] = 1;
  return out;
}

/** 官方 _get_one_hot_bomb：炸弹数 → 15 维 one-hot（下标 = bombNum） */
function oneHotBomb(bombNum: number): Float32Array {
  const out = new Float32Array(15);
  out[Math.min(Math.max(bombNum, 0), 14)] = 1;
  return out;
}

/** 官方 _process_action_seq：最近 15 手，左补空到 15 */
function processActionSeq(seq: Move[], length = 15): Move[] {
  const tail = seq.slice(-length);
  const pad: Move[] = Array.from({ length: length - tail.length }, () => []);
  return [...pad, ...tail];
}

/** 官方 _action_seq_list2array：15×54 → reshape(5,162) 行主序 */
function actionSeq2matrix(seq: Move[]): Float32Array {
  const out = new Float32Array(5 * 162);
  const processed = processActionSeq(seq);
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 162; col++) {
      // 第 row 行 = 第 3*row .. 3*row+2 手拼接
      const actionIdx = row * 3 + Math.floor(col / 54);
      const cardIdx = col % 54;
      out[row * 162 + col] = cards2array(processed[actionIdx])[cardIdx];
    }
  }
  return out;
}

/** hstack 若干定长段 */
function hstack(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 该座出牌序列里「上一次动作」（含 pass 的空数组语义与官方 last_move_dict 一致） */
function lastMoveOf(state: DdzState, seatPos: 'landlord' | 'landlord_down' | 'landlord_up'): Move {
  const seat = seatOfPos(state.landlordSeat, seatPos);
  return state.lastMoveBySeat[seat];
}

function seatOfPos(landlordSeat: number, pos: 'landlord' | 'landlord_down' | 'landlord_up'): number {
  if (pos === 'landlord') return landlordSeat;
  const step = pos === 'landlord_down' ? 1 : 2;
  return (landlordSeat + step) % 3;
}

function concatHands(state: DdzState, mySeat: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < 3; s++) {
    if (s !== mySeat) out.push(...state.hands[s]);
  }
  return out.sort((a, b) => a - b);
}

export interface DdzObs {
  /** 候选走法列表（与 xBatch 行一一对应），最后一个为 []（不出）时已含在内 */
  legalActions: Move[];
  /** [n, xDim]，xDim = 373（地主）或 484（农民） */
  xBatch: Float32Array;
  xDim: number;
  /** [n, 5, 162] */
  zBatch: Float32Array;
}

/**
 * 生成某座位视角的观测：x 每行 = 固定特征 + 候选动作编码；z 各行相同。
 * 对齐官方 _get_obs_landlord / _get_obs_landlord_up / _get_obs_landlord_down。
 */
export function getObs(state: DdzState, mySeat: number): DdzObs {
  const legalActions = getLegalMoves(state.hands[mySeat], state.actionSeq);
  const n = legalActions.length;

  const myHand = cards2array(state.hands[mySeat]);
  const otherHand = cards2array(concatHands(state, mySeat));
  const lastAction = cards2array(rivalOfSeq(state.actionSeq));
  const bombFeat = oneHotBomb(state.bombNum);
  const left = (s: number): number => state.hands[s].length;

  const isLandlord = mySeat === state.landlordSeat;
  let fixed: Float32Array;
  let xDim: number;

  if (isLandlord) {
    // 地主视角：54*5 + 17 + 17 + 15 = 319 固定 + 54 动作 = 373
    const llUp = seatOfPos(state.landlordSeat, 'landlord_up');
    const llDown = seatOfPos(state.landlordSeat, 'landlord_down');
    fixed = hstack([
      myHand,
      otherHand,
      lastAction,
      cards2array(state.playedBySeat[llUp]),
      cards2array(state.playedBySeat[llDown]),
      oneHotNumLeft(left(llUp), 17),
      oneHotNumLeft(left(llDown), 17),
      bombFeat,
    ]);
    xDim = X_DIM_LANDLORD;
  } else {
    // 农民视角：54*7 + 20 + 17 + 15 = 430 固定 + 54 动作 = 484
    const ll = state.landlordSeat;
    const teammate = 3 - mySeat - ll;
    fixed = hstack([
      myHand,
      otherHand,
      cards2array(state.playedBySeat[ll]),
      cards2array(state.playedBySeat[teammate]),
      lastAction,
      cards2array(lastMoveOf(state, 'landlord')),
      cards2array(state.lastMoveBySeat[teammate]),
      oneHotNumLeft(left(ll), 20),
      oneHotNumLeft(left(teammate), 17),
      bombFeat,
    ]);
    xDim = X_DIM_FARMER;
  }

  const xBatch = new Float32Array(n * xDim);
  for (let i = 0; i < n; i++) {
    xBatch.set(fixed, i * xDim);
    xBatch.set(cards2array(legalActions[i]), (i + 1) * xDim - 54);
  }

  const zOne = actionSeq2matrix(state.actionSeq);
  const zBatch = new Float32Array(n * 5 * 162);
  for (let i = 0; i < n; i++) zBatch.set(zOne, i * 5 * 162);

  return { legalActions, xBatch, xDim, zBatch };
}
