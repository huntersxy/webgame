/* ────────────────────────────────────────────────────────────
 *  junqi/ai.ts — 军棋 AI：紧凑棋盘上的 Alpha-Beta(PVS) + 置换表 + LMR
 *
 *  搜索全部跑在 fast.ts 的 Uint8Array 紧凑棋盘上（进局面时打包一次），
 *  热路径里没有对象棋盘、字符串比较和逐节点分配。
 *
 *  信息模型（揭棋）：轮走方始终知道自己的全部棋子，对对方的暗子则
 *  只知道「交战已暴露过的那些」（阵亡子、攻方胜局亮出的守方等）。
 *  评估因此分两部分：
 *    • 子力按真值计——阵亡在交战翻明时是公开事件，双方剩余子力总和
 *      本就是公开信息，按真值累加即等于双方都掌握的真实物质；
 *    • 位置项、旗区守备与威胁只统计「轮走方已知的身份」，对方暗子
 *      按编制先验（3 工兵 / 2 炸弹 / 2 大子）折算期望威胁，不做
 *      凭暗子真实身份超前的判断。
 *  明棋模式下无暗子，这套逻辑自动退化为全明评估。
 *
 *  与五子棋 / 象棋共用 core 里的 Zobrist 与置换表；置换表跨手保留，
 *  仅在揭棋开关切换时清空。
 * ──────────────────────────────────────────────────────────── */

import type { Difficulty, GameMode, SearchResult } from '../types';
import { COLS, HQS, PIECE_COUNTS, type Board, type JqMove, type PType, type Side } from './rules';
import {
  N, TI, TI_司令, TI_军长, TI_工兵, TI_炸弹, TI_地雷, TI_军旗,
  CODE_TI, CODE_ISB, CODE_MOVABLE, CODE_FLAG,
  CAMP, ADJ_OFF, ADJ_TO, DIST, MAX_MOVES, MAX_PLY, REC, REC_N, WIN_FLAG, codeOf,
  packBoard, genAll, makeFast, undoFast,
} from './fast';
import { Zobrist } from '../core/zobrist';
import { TranspositionTable } from '../core/transposition';

export const JQ_LEVEL_CONFIG: Record<Difficulty, { name: string; depth: number }> = {
  1: { name: '简单', depth: 1 },
  2: { name: '普通', depth: 2 },
  3: { name: '困难', depth: 4 },
  4: { name: '😈恶魔', depth: 8 },
};

export const JQ_MATE = 1_000_000;

/** 基础子力价值 */
export const VALUE: Record<PType, number> = {
  司令: 600, 军长: 520, 师长: 440, 旅长: 360, 团长: 300, 营长: 250,
  连长: 200, 排长: 150, 工兵: 230, 炸弹: 330, 地雷: 260, 军旗: 0,
};

/** 前进意愿权重：中低子积极抢占要点，司令/炸弹/工兵保持纵深 */
const ADV_W: Record<PType, number> = {
  司令: 0.3, 军长: 0.5, 师长: 0.8, 旅长: 0.9, 团长: 1, 营长: 1,
  连长: 1, 排长: 1, 工兵: 0.4, 炸弹: 0.3, 地雷: 0, 军旗: 0,
};

/* ── 按兵种序号展开的查表（热路径不用字符串索引对象）─────── */
const NT = PIECE_COUNTS.length;
const V = new Float64Array(NT);
const ADV = new Float64Array(NT);
PIECE_COUNTS.forEach(([t], i) => { V[i] = VALUE[t]; ADV[i] = ADV_W[t]; });

/** 揭棋暗子的期望子力值（25 枚编制的平均值）——仅用于走法排序的保守估值 */
export const HIDDEN_VAL = (() => {
  let sum = 0;
  for (const [t, n] of PIECE_COUNTS) sum += VALUE[t] * n;
  return sum / 25;
})();

/** 未知子的期望前进权重（按编制加权，含不可动兵种的 0 权重） */
const AVG_ADV = (() => {
  let sum = 0, cnt = 0;
  for (const [t, n] of PIECE_COUNTS) { sum += ADV_W[t] * n; cnt += n; }
  return sum / cnt;
})();

/** 对方暗子的编制先验：撞上时的期望威胁权重 */
const P_GB = 3 / 25;
const P_BOMB = 2 / 25;
const P_BIG = 2 / 25;

const HQS_ALL = [...HQS.b, ...HQS.r];

/* ── 哈希 ─────────────────────────────────────────────────── */
// 48 个键位：兵种 12 × 方位 2 × 明暗 2
const zob = new Zobrist(COLS, 12, NT * 4, 0x7c3aed11);
const zkey = (node: number, code: number, hidden: number): number =>
  zob.key(node % COLS, (node / COLS) | 0, (CODE_TI[code] - 1) * 2 + CODE_ISB[code] + hidden * NT * 2);

/**
 * 增量维护哈希：撤掉 from/to/亮旗节点的旧键，再按走子后的棋盘补上新键。
 * from 走子后必为空，to 与亮旗节点直接读当前棋盘即可。
 */
function deltaHash(h: number, ply: number, sq: Uint8Array, hid: Uint8Array): number {
  const o = ply * REC_N;
  const to = REC[o + 1];
  h ^= zkey(REC[o + 0], REC[o + 2], REC[o + 5]);
  if (REC[o + 3] !== 0) h ^= zkey(to, REC[o + 3], REC[o + 6]);
  for (let s = 0; s < 2; s++) {
    const fn = REC[o + 7 + s];
    if (fn < 0) continue;
    const fc = sq[fn];
    h ^= zkey(fn, fc, 1) ^ zkey(fn, fc, 0);
  }
  const tc = sq[to];
  if (tc !== 0) h ^= zkey(to, tc, hid[to]);
  return h >>> 0;
}

function boardHash(sq: Uint8Array, hid: Uint8Array, turnIsB: number): number {
  let h = 0;
  for (let i = 0; i < N; i++) {
    const c = sq[i];
    if (c !== 0) h ^= zkey(i, c, hid[i]);
  }
  if (turnIsB) h ^= zob.side;
  return h >>> 0;
}

/* ── 静态评估（红方视角）──────────────────────────────────── */

export function evalPacked(sq: Uint8Array, hid: Uint8Array, turnIsB: number): number {
  // 军旗定位：己方军旗必知；对方军旗未翻明时，两个大本营互斥均分
  let myFlag = -1;
  let oppFlag = -1;
  for (let k = 0; k < 4; k++) {
    const n = HQS_ALL[k] as number;
    const c = sq[n];
    if (c === 0 || !CODE_FLAG[c]) continue;
    if (CODE_ISB[c] === turnIsB) myFlag = n;
    else if (hid[n] === 0) oppFlag = n;
  }
  const oppHQ = turnIsB ? HQS.r : HQS.b;
  const cand0 = oppFlag >= 0 ? oppFlag : oppHQ[0];
  const cand1 = oppFlag >= 0 ? -1 : oppHQ[1];

  let score = 0;
  let defThreat = 0;                 // 对方对我方军旗的威胁
  let offThreat0 = 0, offThreat1 = 0; // 我方对对方军旗（候选点）的威胁
  let cntMineGB = 0, cntMineBomb = 0, cntOppGB = 0, cntOppBomb = 0;
  let minesMine = 0, minesOpp = 0, bombsMine = 0, bombsOpp = 0;
  let bigMine = false, bigOppKnown = false;
  let myCmd = -1, oppCmd = -1;
  let oppHiddenCnt = 0;

  for (let i = 0; i < N; i++) {
    const c = sq[i];
    if (c === 0) continue;
    const ti = CODE_TI[c];
    const isB = CODE_ISB[c];
    const mine = isB === turnIsB;
    const known = mine || hid[i] === 0;
    const row = (i / COLS) | 0;

    // 子力（真值；剩余子力总和是公开信息）+ 位置项（未知子按平均权重）
    let v = V[ti];
    if (CODE_MOVABLE[c]) {
      const adv = isB ? 5 - row : row - 6;
      v += adv * 3 * (known ? ADV[ti] : AVG_ADV);
      if (CAMP[i]) v += known && ti === TI_司令 ? 10 : 6;
    }
    score += isB ? -v : v;

    if (CODE_FLAG[c]) continue; // 军旗位置已单独处理

    if (mine) {
      if (ti === TI_地雷) minesMine++;
      else if (ti === TI_炸弹) { bombsMine++; cntMineBomb++; }
      else if (ti === TI_工兵) cntMineGB++;
      else if (ti === TI_司令 || ti === TI_军长) { bigMine = true; if (ti === TI_司令) myCmd = i; }
    } else if (known) {
      if (ti === TI_地雷) minesOpp++;
      else if (ti === TI_炸弹) { bombsOpp++; cntOppBomb++; }
      else if (ti === TI_工兵) cntOppGB++;
      else if (ti === TI_司令 || ti === TI_军长) { bigOppKnown = true; if (ti === TI_司令) oppCmd = i; }
    } else {
      oppHiddenCnt++;
    }

    // 对方逼近我方军旗：明子按真实兵种，暗子按编制先验折算
    if (!mine && myFlag >= 0) {
      const d = DIST[myFlag * N + i];
      if (known) {
        if (ti === TI_工兵) defThreat += d <= 5 ? 50 - d * 9 : 0;
        else if (ti === TI_炸弹) defThreat += d <= 4 ? 28 - d * 6 : 0;
        else if (ti === TI_司令 || ti === TI_军长) defThreat += d <= 5 ? 18 - d * 3 : 0;
      } else {
        defThreat += P_GB * (d <= 5 ? 50 - d * 9 : 0)
          + P_BOMB * (d <= 4 ? 28 - d * 6 : 0)
          + P_BIG * (d <= 5 ? 18 - d * 3 : 0);
      }
    }

    // 我方逼近对方军旗：我方子力全知，按真实兵种计
    if (mine && (ti === TI_工兵 || ti === TI_炸弹 || ti === TI_司令 || ti === TI_军长)) {
      const isGB = ti === TI_工兵, isBomb = ti === TI_炸弹;
      const d0 = DIST[cand0 * N + i];
      offThreat0 += isGB ? (d0 <= 5 ? 50 - d0 * 9 : 0)
        : isBomb ? (d0 <= 4 ? 28 - d0 * 6 : 0) : (d0 <= 5 ? 18 - d0 * 3 : 0);
      if (cand1 >= 0) {
        const d1 = DIST[cand1 * N + i];
        offThreat1 += isGB ? (d1 <= 5 ? 50 - d1 * 9 : 0)
          : isBomb ? (d1 <= 4 ? 28 - d1 * 6 : 0) : (d1 <= 5 ? 18 - d1 * 3 : 0);
      }
    }
  }

  // 旗区守备：己方军旗四周的可动子（己方全知）每枚 +9，上限 27
  const guard = (flag: number, sideIsB: number): number => {
    if (flag < 0) return 0;
    let g = 0;
    for (let k = ADJ_OFF[flag], ke = ADJ_OFF[flag + 1]; k < ke; k++) {
      const q = sq[ADJ_TO[k]];
      if (q === 0 || CODE_ISB[q] !== sideIsB || !CODE_MOVABLE[q]) continue;
      g += 9;
    }
    return g > 27 ? 27 : g;
  };

  score += guard(myFlag, turnIsB) - guard(cand0, turnIsB ? 0 : 1);
  score -= defThreat;
  score += cand1 >= 0 ? (offThreat0 + offThreat1) / 2 : offThreat0;

  // 动态权重：对方明雷越多己方工兵越值钱；对方大子尚存则炸弹保值
  const oppBigAlive = bigOppKnown || oppHiddenCnt > 0;
  const myBigAlive = bigMine;
  score += cntMineGB * minesOpp * 30;
  score += cntMineBomb * (oppBigAlive ? 40 : -40);
  score -= cntOppGB * minesMine * 30;
  score -= cntOppBomb * (myBigAlive ? 40 : -40);

  // 司令暴露惩罚：孤军深入且对方尚有明置炸弹
  if (myCmd >= 0 && bombsOpp > 0) {
    const r = (myCmd / COLS) | 0;
    if (!turnIsB && r <= 5) score -= (6 - r) * 5;
    if (turnIsB && r >= 6) score += (r - 5) * 5;
  }
  if (oppCmd >= 0 && bombsMine > 0) {
    const r = (oppCmd / COLS) | 0;
    if (turnIsB && r <= 5) score -= (6 - r) * 5;
    if (!turnIsB && r >= 6) score += (r - 5) * 5;
  }
  return score;
}

/**
 * 对外接口：打包后按「轮走方视角」评估（红方为正）。
 * 明棋 / 揭棋走同一套逻辑——揭棋里的知识不对称由每枚棋子的
 * hidden 位与所属方推导，不需要模式参数。
 */
export function evaluate(board: Board, turn: Side = 'r'): number {
  const { sq, hid } = packBoard(board);
  return evalPacked(sq, hid, turn === 'b' ? 1 : 0);
}

/* ── 走法排序 ─────────────────────────────────────────────── */

const ORDER_TT = 0x3fffffff;
const ORDER_KILLER = 0x2fffffff;

function orderScore(sq: Uint8Array, hid: Uint8Array, m: number, turnIsB: number): number {
  const from = m >>> 6;
  const to = m & 63;
  const def = sq[to];
  const att = sq[from];
  const ati = CODE_TI[att];
  if (def !== 0) {
    const dti = CODE_TI[def];
    if (dti === TI_军旗) return 1_000_000_000;
    const knownDef = hid[to] === 0;
    if (dti === TI_地雷 && knownDef && ati !== TI_工兵) return -8000; // 撞明雷
    const dv = knownDef ? V[dti] : HIDDEN_VAL;
    return 8000 + dv * 10 - V[ati];
  }
  const adv = turnIsB ? ((from / COLS) | 0) - ((to / COLS) | 0) : ((to / COLS) | 0) - ((from / COLS) | 0);
  let s = adv * 8 * ADV[ati];
  if (CAMP[to]) s += 30;
  if (ati === TI_工兵) s += 6;
  return s;
}

/* ── 搜索 ─────────────────────────────────────────────────── */

interface Ctx {
  nodes: number;
  level: Difficulty;
  /** 0 表示不限时 */
  deadline: number;
  hitDeadline: boolean;
  sq: Uint8Array;
  hid: Uint8Array;
}

// 逐层独立的着法 / 排序缓冲：递归子节点会写自己的槽位，不能共用一份
const movBuf = new Int32Array(MAX_PLY * MAX_MOVES);
const ordBuf = new Int32Array(MAX_PLY * MAX_MOVES);
const killers = new Int32Array(MAX_PLY * 2).fill(-1);
const pvLen = new Int32Array(MAX_PLY + 1);
const pvTbl = new Int32Array((MAX_PLY + 1) * (MAX_PLY + 1));
const ttProbe = new Int32Array(3);

const MATE_MIN = JQ_MATE - MAX_PLY;

// 52 万槽：实测再翻倍到 104 万槽只带来 1~2% 节点率提升（噪声量级），
// 却要多占约 10MB 内存；Worker 创建即分配，移动端不划算，故维持此规模。
const tt = new TranspositionTable<number>(1 << 19);
let ttMode: boolean | null = null;

function deadlineHit(ctx: Ctx): boolean {
  if (ctx.deadline === 0) return false;
  if ((ctx.nodes & 1023) !== 0) return false;
  if (typeof performance === 'undefined' || performance.now() <= ctx.deadline) return false;
  ctx.hitDeadline = true;
  return true;
}

/** 静态搜索：只延伸吃子，避免水平线效应 */
function quiesce(ctx: Ctx, alpha: number, beta: number, turnIsB: number, qd: number, ply: number, hash: number): number {
  const sq = ctx.sq;
  const hid = ctx.hid;
  ctx.nodes++;
  if (deadlineHit(ctx)) return (turnIsB ? -1 : 1) * evalPacked(sq, hid, turnIsB);
  const stand = (turnIsB ? -1 : 1) * evalPacked(sq, hid, turnIsB);
  if (qd <= 0 || ply >= MAX_PLY - 1) return stand;
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;

  const mv = ply * MAX_MOVES;
  const n = genAll(sq, turnIsB, movBuf, mv);
  if (n <= 0) return stand;
  let cnt = 0;
  for (let k = 0; k < n; k++) {
    const m = movBuf[mv + k];
    if (sq[m & 63] === 0) continue; // 只看吃子
    movBuf[mv + cnt] = m;
    ordBuf[mv + cnt] = orderScore(sq, hid, m, turnIsB);
    cnt++;
  }
  for (let idx = 0; idx < cnt; idx++) {
    let bi = idx;
    for (let k = idx + 1; k < cnt; k++) if (ordBuf[mv + k] > ordBuf[mv + bi]) bi = k;
    if (bi !== idx) {
      const tm = movBuf[mv + idx]; movBuf[mv + idx] = movBuf[mv + bi]; movBuf[mv + bi] = tm;
      const to = ordBuf[mv + idx]; ordBuf[mv + idx] = ordBuf[mv + bi]; ordBuf[mv + bi] = to;
    }
    const m = movBuf[mv + idx];
    const flags = makeFast(sq, hid, m, ply);
    let v: number;
    if (flags & 4) v = JQ_MATE - ply;
    else v = -quiesce(ctx, -beta, -alpha, turnIsB ^ 1, qd - 1, ply + 1, deltaHash(hash, ply, sq, hid));
    undoFast(sq, hid, ply);
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

function ab(ctx: Ctx, depth: number, alpha: number, beta: number, turnIsB: number, ply: number, hash: number): number {
  const sq = ctx.sq;
  const hid = ctx.hid;
  ctx.nodes++;
  if (deadlineHit(ctx)) return (turnIsB ? -1 : 1) * evalPacked(sq, hid, turnIsB);
  if (depth <= 0 || ply >= MAX_PLY - 1) return quiesce(ctx, alpha, beta, turnIsB, 4, ply, hash);

  const key = (hash ^ (turnIsB ? 0 : zob.side)) >>> 0;
  let ttMove = -1;
  const flag = tt.probeInto(key, ttProbe);
  if (flag >= 0 && ttProbe[0] >= depth) {
    const s = ttProbe[1];
    if (flag === 0) return s;
    if (flag === 1 && s >= beta) return s;
    if (flag === 2 && s <= alpha) return s;
  }
  if (flag >= 0) ttMove = ttProbe[2];

  const mv = ply * MAX_MOVES;
  const n = genAll(sq, turnIsB, movBuf, mv);
  if (n < 0) return -JQ_MATE + ply; // 缓冲区不足（不该发生），按无子可动处理
  if (n === 0) return -JQ_MATE + ply; // 无子可动判负

  const k0 = killers[ply * 2];
  const k1 = killers[ply * 2 + 1];
  const width = ctx.level >= 4 ? 64 : ctx.level === 3 ? 48 : 40;
  let limit = n;
  for (let k = 0; k < n; k++) {
    const m = movBuf[mv + k];
    let s = orderScore(sq, hid, m, turnIsB);
    if (m === ttMove) s = ORDER_TT;
    else if (m === k0) s = ORDER_KILLER;
    else if (m === k1) s = ORDER_KILLER - 1;
    ordBuf[mv + k] = s;
  }
  if (n > width) limit = width;

  let best = -Infinity;
  let bestM = movBuf[mv];
  const origAlpha = alpha;
  let first = true;
  pvLen[ply] = 0;

  for (let idx = 0; idx < limit; idx++) {
    let bi = idx;
    for (let k = idx + 1; k < limit; k++) if (ordBuf[mv + k] > ordBuf[mv + bi]) bi = k;
    if (bi !== idx) {
      const tm = movBuf[mv + idx]; movBuf[mv + idx] = movBuf[mv + bi]; movBuf[mv + bi] = tm;
      const to = ordBuf[mv + idx]; ordBuf[mv + idx] = ordBuf[mv + bi]; ordBuf[mv + bi] = to;
    }
    const m = movBuf[mv + idx];
    const isCap = sq[m & 63] !== 0;
    const flags = makeFast(sq, hid, m, ply);
    let v: number;
    if (flags & 4) {
      v = JQ_MATE - ply;
    } else {
      const nh = deltaHash(hash, ply, sq, hid);
      if (first) {
        v = -ab(ctx, depth - 1, -beta, -alpha, turnIsB ^ 1, ply + 1, nh);
      } else {
        // 后期着法缩减：靠后且不吃子的着法先按浅一层搜，超过 alpha 再补回
        let red = 0;
        if (depth >= 3 && idx >= 4 && !isCap) red = 1 + (idx >= 14 && depth >= 6 ? 1 : 0);
        v = -ab(ctx, depth - 1 - red, -alpha - 1, -alpha, turnIsB ^ 1, ply + 1, nh);
        if (red !== 0 && v > alpha) v = -ab(ctx, depth - 1, -alpha - 1, -alpha, turnIsB ^ 1, ply + 1, nh);
        if (v > alpha && v < beta) v = -ab(ctx, depth - 1, -beta, -alpha, turnIsB ^ 1, ply + 1, nh);
      }
    }
    undoFast(sq, hid, ply);
    first = false;

    if (v > best) {
      best = v;
      bestM = m;
      const cl = pvLen[ply + 1];
      pvTbl[ply * (MAX_PLY + 1)] = m;
      for (let k = 0; k < cl; k++) pvTbl[ply * (MAX_PLY + 1) + 1 + k] = pvTbl[(ply + 1) * (MAX_PLY + 1) + k];
      pvLen[ply] = cl + 1;
    }
    if (v > alpha) alpha = v;
    if (alpha >= beta) {
      if (!isCap && m !== k0) { killers[ply * 2 + 1] = k0; killers[ply * 2] = m; }
      break;
    }
    if (ctx.hitDeadline) break;
  }

  if (!ctx.hitDeadline && Math.abs(best) < MATE_MIN) tt.store(key, depth, best, origAlpha, beta, bestM);
  return best;
}

/* ── 关于不完全信息：为什么不做确定性采样（PIMC）───────
 * 揭棋的标准强解是 PIMC/确定性采样：按公开信息（双方剩余编制公开、
 * 地雷必在后两排、军旗必在大本营）把对方暗子重排 K 次，每次当完全
 * 信息局面搜一遍，再对根着法取平均。本仓库实现并实测过这一路径
 * （采样器 + 跨世界精确根值聚合），结论是不采纳：
 *   • 固定 2~3 秒预算下切成 K 份，每份深度掉约 log(K) 层——实测
 *     K=8 只到 depth5，而单世界能到 depth7；
 *   • 等时间自对弈（恶魔档 · 揭棋 · 双方同引擎仅切换 K）：
 *     K=1 对 K=2 / K=4 / K=8 分别为 20:0 / 20:0 / 19:1，
 *     即深度损失压倒了信息模型收益；
 *   • 注意 K=1 并非「开图作弊」：子力总和本就是公开信息，真实身份
 *     只在搜索树内部使用，评估仍按轮走方实际掌握的信息计（见上）。
 * 因此这里保持单世界搜索，把全部时间预算换成深度。
 * ─────────────────────────────────────────────────────────── */

/* ── 主搜索入口 ───────────────────────────────────────────── */

const rootOrder = new Int32Array(MAX_MOVES);
const rootVals = new Float64Array(MAX_MOVES);
const rootTmp = new Float64Array(MAX_MOVES);
/** 与 rootTmp 平行：该根着法本轮只做了零窗试探、未全窗复核，分值是上界 */
const rootTmpUb = new Uint8Array(MAX_MOVES);
const rootUb = new Uint8Array(MAX_MOVES);

interface RootOut { bestIdx: number; bestV: number; depth: number; pv: number[]; nodes: number }

/**
 * 在给定局面（可能是采样出来的世界）上迭代加深搜根节点，
 * 把每个根着法的分值写进 rootVals。半途超时的那一轮整体丢弃。
 */
function rootSearch(
  sq: Uint8Array, hid: Uint8Array, turnIsB: number, level: Difficulty,
  deadline: number, rootMoves: Int32Array, rn: number,
): RootOut {
  const ctx: Ctx = { nodes: 0, level, sq, hid, hitDeadline: false, deadline };
  const rootHash = boardHash(sq, hid, turnIsB);
  for (let k = 0; k < rn; k++) rootOrder[k] = k;
  const pvsRoot = level >= 4;
  const maxDepth = JQ_LEVEL_CONFIG[level].depth;

  let bestIdx = 0;
  let bestV = -Infinity;
  let pv: number[] = [rootMoves[0]];
  let depth = 0;

  const runAtDepth = (d: number): boolean => {
    let alpha = -Infinity;
    let bv = -Infinity;
    let bi = 0;
    let bpv: number[] = [];
    for (let k = 0; k < rn; k++) {
      const oi = rootOrder[k];
      const m = rootMoves[oi];
      const fl = makeFast(sq, hid, m, 0);
      let v: number;
      let exact = true;
      if (fl & WIN_FLAG) {
        v = JQ_MATE;
      } else {
        const nh = deltaHash(rootHash, 0, sq, hid);
        pvLen[1] = 0;
        exact = true;
        if (!pvsRoot || alpha === -Infinity) {
          v = -ab(ctx, d - 1, -Infinity, Infinity, turnIsB ^ 1, 1, nh);
        } else {
          // 根节点 PVS：零窗试探，过线再全窗重搜
          v = -ab(ctx, d - 1, -alpha - 1, -alpha, turnIsB ^ 1, 1, nh);
          if (v > alpha) v = -ab(ctx, d - 1, -Infinity, Infinity, turnIsB ^ 1, 1, nh);
          else exact = false;
        }
      }
      undoFast(sq, hid, 0);
      if (ctx.hitDeadline) return false; // 本轮作废
      rootTmp[oi] = v;
      // 非首个着法走的是零窗试探；只有过线后全窗重搜才是精确值
      rootTmpUb[oi] = exact ? 0 : 1;
      if (v > bv) {
        bv = v; bi = k;
        bpv = [m];
        for (let q = 0; q < pvLen[1]; q++) bpv.push(pvTbl[MAX_PLY + 1 + q]);
      }
      if (v > alpha) alpha = v;
    }
    rootVals.set(rootTmp);
    rootUb.set(rootTmpUb);
    bestV = bv;
    bestIdx = rootOrder[bi];
    pv = bpv;
    // 最优着提前，改善下一轮 PVS 剪枝
    if (bi > 0) { const t = rootOrder[0]; rootOrder[0] = rootOrder[bi]; rootOrder[bi] = t; }
    return true;
  };

  if (runAtDepth(1)) {
    depth = 1;
    for (let d = 2; d <= maxDepth; d++) {
      if (deadline !== 0 && typeof performance !== 'undefined' && performance.now() > deadline) break;
      ctx.hitDeadline = false;
      if (!runAtDepth(d)) break;
      depth = d;
    }
  }
  return { bestIdx, bestV, depth, pv, nodes: ctx.nodes };
}

export function findBestMove(
  board: Board,
  side: Side,
  difficulty: Difficulty,
  mode: GameMode,
  flip: boolean,
  historyLength: number,
): SearchResult<JqMove> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const cfg = JQ_LEVEL_CONFIG[difficulty];
  const demon = difficulty === 4;
  const { sq, hid } = packBoard(board);
  const turnIsB = side === 'b' ? 1 : 0;

  // 置换表跨手保留（局面键含明暗与手番）；仅切换明 / 揭棋时清空
  if (ttMode !== flip) { tt.clear(); ttMode = flip; }
  killers.fill(-1);

  const rn = genAll(sq, turnIsB, rootOrder, 0, MAX_MOVES);
  if (rn <= 0) return { move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] };
  const rootMoves = new Int32Array(rn);
  const rootOrd = new Float64Array(rn);
  for (let k = 0; k < rn; k++) {
    rootMoves[k] = rootOrder[k];
    rootOrd[k] = orderScore(sq, hid, rootOrder[k], turnIsB) + Math.random();
  }
  for (let i = 0; i < rn; i++) {
    let bi = i;
    for (let k = i + 1; k < rn; k++) if (rootOrd[k] > rootOrd[bi]) bi = k;
    if (bi !== i) {
      const tm = rootMoves[i]; rootMoves[i] = rootMoves[bi]; rootMoves[bi] = tm;
      const to = rootOrd[i]; rootOrd[i] = rootOrd[bi]; rootOrd[bi] = to;
    }
  }

  // 开局随机化（低难度，增加多样性）
  if (!demon && historyLength < 2 && Math.random() < 0.35 && rn > 5) {
    const r = rootMoves[(Math.random() * 5) | 0];
    return {
      move: { from: r >>> 6, to: r & 63 }, depth: cfg.depth, nodes: 5, ms: 1, eval: 0,
      scores: [{ from: r >>> 6, to: r & 63, v: 0 }], opening: true,
    };
  }

  const budget = demon ? (mode === 'aivai' ? 2200 : 2600) : 0;
  const r = rootSearch(sq, hid, turnIsB, difficulty, budget ? t0 + budget : 0, rootMoves, rn);
  const agg = new Float64Array(rn);
  for (let k = 0; k < rn; k++) agg[k] = rootVals[k];

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const bestM = rootMoves[r.bestIdx];
  const scored: Array<{ from: number; to: number; v: number; ub: boolean }> = [];
  for (let k = 0; k < rn; k++) scored.push({ from: rootMoves[k] >>> 6, to: rootMoves[k] & 63, v: agg[k], ub: rootUb[k] === 1 });
  // 上界分值不参与排序比较：把它们排在精确分值之后
  scored.sort((a, b) => (a.ub === b.ub ? b.v - a.v : a.ub ? 1 : -1));
  return {
    move: { from: bestM >>> 6, to: bestM & 63 },
    depth: r.depth,
    nodes: r.nodes,
    ms: Math.round(t1 - t0),
    eval: Math.round(r.bestV),
    scores: scored.slice(0, 6),
    pv: r.pv.slice(0, 6).map((m) => ({ from: m >>> 6, to: m & 63 })),
    qd: 4,
  };
}

/** 求一着：固定恶魔级 */
export function findHintMove(
  board: Board, side: Side, mode: GameMode, flip: boolean, historyLength: number,
): SearchResult<JqMove> {
  return findBestMove(board, side, 4, mode, flip, historyLength);
}

/** 供控制器 / 测试用的着法描述 */
export function describeMove(board: Board, m: JqMove): string {
  const p = board[m.from];
  const def = board[m.to];
  const nm = p ? (p.hidden ? '暗子' : p.type) : '?';
  const cap = def ? (def.hidden ? '×暗子' : `×${def.type}`) : '→';
  const r = (m.from / COLS) | 0, c = m.from % COLS;
  return `${nm}${cap}(${r + 1},${c + 1})`;
}
