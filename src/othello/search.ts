/* ────────────────────────────────────────────────────────────
 *  othello/search.ts — 黑白棋 AI：迭代加深 α-β + 终局精确求解
 *
 *  难度档不是「固定深度」，而是「时间预算内的迭代加深」，与五子棋同一套
 *  取舍：简单档几乎秒答，恶魔档把预算烧满、能深就深；剩余空格进入终局区间
 *  后切换为完全搜索（精确求解），不再依赖评估函数。
 *
 *  为什么中盘不以子数为主要指标：黑白棋中盘多子通常是劣势（对方行动力更
 *  差、更容易被逼送角）。评估以位置权重与行动力为主，子数只作微小调节。
 *
 *  停一手（pass）的处理是这类实现最容易写出死递归的地方：连续两次 pass
 *  时剩余空格不变、深度也不变，必须显式判定「上一手也是 pass → 终局」。
 * ──────────────────────────────────────────────────────────── */

import type { OthBoard, OthDisc, Difficulty, GameMode, SearchResult, OthMove } from '../types';
import {
  CELLS, PASS_MOVE, bitOfIndex, legalMoves, other, place, popcount, result, toCells,
} from './rules';
import type { OthPosition } from './rules';
import { evaluateState, ENDGAME_EMPTIES, WIN_BASE, weightAt } from './evaluate';

/**
 * 单次搜索的节点硬上限。
 * 残局精确求解在「剩 14 空」附近需要几十万节点，上限给小了会在预算没用完时
 * 就被掐断（表现为恶魔档的精确求解反而不如困难档的深搜）。这里按恶魔档
 * 5.2s 预算的量级放宽，主线程有 worker 隔离，卡不到界面。
 */
const NODE_CAP = 900_000;

export const LEVEL_CONFIG: Record<Difficulty, { name: string; depth: number; limit: number; timeMs: number }> = {
  1: { name: '简单', depth: 1, limit: 8, timeMs: 60 },
  2: { name: '普通', depth: 4, limit: 12, timeMs: 400 },
  3: { name: '困难', depth: 9, limit: 14, timeMs: 1600 },
  4: { name: '😈恶魔', depth: 13, limit: 16, timeMs: 5200 },
};

type Word = [number, number];

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isEmpty(a: Word): boolean {
  return a[0] === 0 && a[1] === 0;
}

/** 当前视角的终局分：正 = 赢 */
function terminalScore(pos: OthPosition, side: OthDisc): number {
  const black = popcount(pos.black[0]) + popcount(pos.black[1]);
  const white = popcount(pos.white[0]) + popcount(pos.white[1]);
  const diff = side === 1 ? black - white : white - black;
  return diff > 0 ? WIN_BASE + diff : diff < 0 ? -WIN_BASE + diff : 0;
}

/** 某方合法落点数量（行动力） */
function mobility(pos: OthPosition, side: OthDisc): number {
  return legalMoves({ ...pos, side }).length;
}

interface Scored {
  i: number;
  s: number;
  flipped: number;
  /** 根节点搜索出的分值（仅根节点的 scored 会被赋值） */
  v?: number;
}

/** 列出全部着法及其翻子数（翻子数为 0 表示非法），按静态分降序 */
function listMoves(pos: OthPosition, limit: number): Scored[] {
  const out: Scored[] = [];
  for (let i = 0; i < CELLS; i++) {
    const bit = bitOfIndex(i);
    if ((((pos.black[0] | pos.white[0]) & bit[0]) | ((pos.black[1] | pos.white[1]) & bit[1])) >>> 0) continue;
    const pl = place(pos, i);
    if (!pl) continue;
    // 静态分：翻掉棋子的位置权重（含符号）+ 落点权重 + 少量翻子数
    let gain = weightAt(i);
    for (const j of maskIndices(pl.flippedMask)) gain += weightAt(j);
    out.push({ i, s: gain + pl.flipped * 0.5, flipped: pl.flipped });
  }
  out.sort((a, b) => b.s - a.s);
  return limit > 0 ? out.slice(0, limit) : out;
}

function maskIndices(mask: Word): number[] {
  const out: number[] = [];
  let lo = mask[0], hi = mask[1];
  while (lo) {
    const b = lo & -lo;
    out.push(31 - Math.clz32(b));
    lo = (lo ^ b) >>> 0;
  }
  while (hi) {
    const b = hi & -hi;
    out.push(32 + 31 - Math.clz32(b));
    hi = (hi ^ b) >>> 0;
  }
  return out;
}

/* ── 置换表 ── */
const TT_BITS = 16;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttLo = new Uint32Array(TT_SIZE);
const ttHi = new Uint32Array(TT_SIZE);
const ttLo2 = new Uint32Array(TT_SIZE);
const ttHi2 = new Uint32Array(TT_SIZE);
const ttUsed = new Uint8Array(TT_SIZE);
const ttMove = new Uint8Array(TT_SIZE); // index+1
const ttScore = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Uint8Array(TT_SIZE); // 0 精确 / 1 下界 / 2 上界

export function ttClear(): void {
  ttUsed.fill(0);
  ttMove.fill(0);
}

function hashKey(pos: OthPosition): number {
  let h = (pos.black[0] ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = (h ^ (pos.black[1] + 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (pos.white[0] * 0x27d4eb2d)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x165667b1) >>> 0;
  h = (h ^ pos.white[1] ^ (pos.side === 1 ? 0x27d4eb2d : 0x85ebca6b)) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

interface Ctx {
  nodes: number;
  deadline: number;
  aborted: boolean;
  /** 节点硬上限：迭代加深 + 终局求解都不会超过它，防止未收敛的搜索吃满内存 */
  nodeCap: number;
}

/**
 * 负极大值 α-β。
 * @param passedPrev 上一手是否为停一手：若本方也无着法，则双方连续停手 → 终局。
 */
/** 单条搜索路径的手数上限：黑白棋最多 60 手 + 停手余量，超出必定是状态机异常 */
const MAX_PLY = 80;

function negamax(
  ctx: Ctx,
  pos: OthPosition,
  depth: number,
  alpha: number,
  beta: number,
  passedPrev: boolean,
  ply: number,
): number {
  ctx.nodes++;
  if ((ctx.nodes & 255) === 0 && now() > ctx.deadline) ctx.aborted = true;
  if (ctx.nodes >= ctx.nodeCap) ctx.aborted = true;
  if (ctx.aborted) return 0;

  const empties = CELLS - (popcount(pos.black[0]) + popcount(pos.black[1]) + popcount(pos.white[0]) + popcount(pos.white[1]));
  if (empties === 0 || ply >= MAX_PLY) return terminalScore(pos, pos.side);

  // 终局精确求解：深度由剩余空格天然封闭（每手 empties 减一，最终归零）。
  // 关键点：这里绝不能再把 depth 夹到 empties —— 每层都重新夹取会让 depth
  // 永不衰减，递归直接爆栈（本项目踩过两次）。
  const endgame = empties <= ENDGAME_EMPTIES;
  if (!endgame && depth <= 0) {
    return evaluateState(pos, pos.side, empties, mobility);
  }

  const moves = listMoves(pos, 0);
  if (!moves.length) {
    // 本方无着法：自己停一手（停手不落子，深度必须减 1，否则原地打转）
    if (passedPrev) return terminalScore(pos, pos.side);
    const next = { ...pos, side: other(pos.side) };
    if (!legalMoves(next).length) return terminalScore(pos, pos.side);
    return -negamax(ctx, next, depth - 1, -beta, -alpha, true, ply + 1);
  }

  const key = hashKey(pos);
  const slot = key & TT_MASK;
  let ttBest = -1;
  if (ttUsed[slot] && ttLo[slot] === pos.black[0] && ttHi[slot] === pos.black[1]
    && ttLo2[slot] === pos.white[0] && ttHi2[slot] === pos.white[1]) {
    ttBest = ttMove[slot] - 1;
    if (ttDepth[slot] >= depth) {
      const sc = ttScore[slot];
      const fl = ttFlag[slot];
      if (fl === 0) return sc;
      if (fl === 1 && sc >= beta) return sc;
      if (fl === 2 && sc <= alpha) return sc;
    }
  }

  if (ttBest >= 0) {
    const k = moves.findIndex((m) => m.i === ttBest);
    if (k > 0) {
      const [m] = moves.splice(k, 1);
      moves.unshift(m);
    }
  }

  const alpha0 = alpha;
  let best = -Infinity;
  let bestMove = moves[0].i;
  // 终局阶段不按层递减：剩余空格每手都减一，天然收敛；非终局阶段正常递减
  const nextDepth = endgame ? depth : depth - 1;

  for (let k = 0; k < moves.length; k++) {
    const mv = place(pos, moves[k].i);
    if (!mv) continue;
    let v: number;
    if (k === 0) {
      v = -negamax(ctx, mv.pos, nextDepth, -beta, -alpha, false, ply + 1);
    } else {
      v = -negamax(ctx, mv.pos, nextDepth, -alpha - 1, -alpha, false, ply + 1);
      if (!ctx.aborted && v > alpha && v < beta) {
        v = -negamax(ctx, mv.pos, nextDepth, -beta, -alpha, false, ply + 1);
      }
    }
    if (ctx.aborted) return 0;
    if (v > best) {
      best = v;
      bestMove = moves[k].i;
    }
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }

  if (!ctx.aborted) {
    ttUsed[slot] = 1;
    ttLo[slot] = pos.black[0];
    ttHi[slot] = pos.black[1];
    ttLo2[slot] = pos.white[0];
    ttHi2[slot] = pos.white[1];
    ttMove[slot] = bestMove + 1;
    ttScore[slot] = Math.round(best);
    ttDepth[slot] = Math.min(120, Math.max(-120, depth));
    ttFlag[slot] = best <= alpha0 ? 2 : best >= beta ? 1 : 0;
  }
  return best;
}

interface RootResult {
  best: number;
  bestV: number;
  scored: Scored[];
  complete: boolean;
}

function rootSearch(ctx: Ctx, pos: OthPosition, depth: number): RootResult {
  const empties = CELLS - (popcount(pos.black[0]) + popcount(pos.black[1]) + popcount(pos.white[0]) + popcount(pos.white[1]));
  const endgame = empties <= ENDGAME_EMPTIES;
  const d = depth;
  const scored = listMoves(pos, 0);
  let alpha = -Infinity;
  let bestV = -Infinity;
  let best = scored.length ? scored[0].i : -1;
  const nextDepth = endgame ? d : d - 1;

  for (const m of scored) {
    const mv = place(pos, m.i);
    if (!mv) continue;
    const v = -negamax(ctx, mv.pos, nextDepth, -Infinity, alpha === -Infinity ? Infinity : -alpha, false, 1);
    if (ctx.aborted) break;
    m.v = Math.round(v);
    if (v > bestV) {
      bestV = v;
      best = m.i;
    }
    if (v > alpha) alpha = v;
  }
  return { best, bestV, scored, complete: !ctx.aborted };
}

/** 迭代加深公共主体 */
function iterativeSearch(pos: OthPosition, budgetMs: number, maxDepth: number): SearchResult<OthMove> {
  const t0 = now();
  const r0 = result(pos);
  if (r0.over) return { move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] };

  const myMoves = legalMoves(pos);
  if (!myMoves.length) {
    // 本方无着法：如实返回停一手（界面据此自动跳过）
    return {
      move: { ...PASS_MOVE, pass: true, v: 0 },
      depth: 0, nodes: 0, ms: Math.round(now() - t0), eval: 0,
      scores: [{ ...PASS_MOVE, pass: true, v: 0 }], instant: true,
    };
  }

  const empties = CELLS - (popcount(pos.black[0]) + popcount(pos.black[1]) + popcount(pos.white[0]) + popcount(pos.white[1]));
  const ctx: Ctx = { nodes: 0, deadline: t0 + budgetMs, aborted: false, nodeCap: NODE_CAP };
  let bestIdx = -1;
  let bestV = 0;
  let bestDepth = 0;
  let last: Scored[] = [];

  for (let d = 2; d <= Math.min(maxDepth, empties); d++) {
    if (now() > ctx.deadline) break;
    const r = rootSearch(ctx, pos, d);
    if (ctx.aborted) break;
    if (r.best >= 0) {
      bestIdx = r.best;
      bestV = r.bestV;
      bestDepth = d;
      last = r.scored;
    }
    // 剩下的时间不够再深一层就收手（下一层通常贵 1.5~3 倍）
    if (now() - t0 > budgetMs * 0.55) break;
  }
  if (bestIdx < 0) {
    const r = rootSearch(ctx, pos, 1);
    bestIdx = r.best;
    bestV = r.bestV;
    bestDepth = 1;
    last = r.scored;
  }

  return {
    move: bestIdx >= 0 ? toOthMove(bestIdx, bestV, pos) : null,
    depth: bestDepth,
    nodes: ctx.nodes,
    ms: Math.round(now() - t0),
    eval: Math.round(bestV),
    scores: last.slice(0, 6).map((m) => toOthMove(m.i, m.v ?? 0, pos)) as Array<OthMove & { v: number }>,
  };
}

/**
 * 内部格索引 → 界面坐标。
 * 约定：索引 i = y*8 + x，其中 y=0 是渲染的第 1 行、x=0 是 a 列；
 * 转换到棋谱记谱时行号是 y+1、列号是 x+1（a1 在左下角 y=7、x=0）。
 */
function toOthMove(index: number, v: number, pos: OthPosition): OthMove & { v: number } {
  const pl = place(pos, index);
  const pt = ptOfIndex(index);
  return { ...pt, v: Math.round(v), f: pl ? pl.flipped : 0 };
}

/**
 * 格索引 → 逻辑坐标 Pt。
 *
 * 全局唯一口径：index = row*8 + x，row = 0 对应**棋谱第 1 行**（画布最下面一行），
 * 于是棋谱记谱就是 `${files[x]}${row + 1}`，d4 = index 27、e4 = 28、d5 = 35、e5 = 36。
 * 画布把 row 0 画在最上面还是最下面是渲染问题（本项目渲染器把 rank 8 放顶部，
 * 即 canvasRow = 7 - row），不要在逻辑坐标里再翻一次——翻两次就会镜像。
 */
export function ptOfIndex(index: number): { x: number; y: number } {
  return { x: index & 7, y: index >> 3 };
}

/** 逻辑坐标 → 格索引 */
export function indexOfPt(p: { x: number; y: number }): number {
  return p.y * 8 + p.x;
}

/** 格索引 → 棋谱记谱（a1 在左下）。行号走 ptOfIndex 的同一套换算，别再手推。 */
export function notationOf(index: number): string {
  const p = ptOfIndex(index);
  return `${'abcdefgh'[p.x]}${p.y + 1}`;
}


/** AI 落子：按难度档预算迭代加深 */
export function findBestMove(
  cells: OthBoard,
  side: OthDisc,
  difficulty: Difficulty,
  mode: GameMode,
  historyLength: number,
  /** 覆盖时间预算（毫秒）。基准脚本用它在固定预算下比较不同档位，不传则用档位默认值 */
  budgetOverride?: number,
): SearchResult<OthMove> {
  void historyLength;
  ttClear();
  const pos = fromCellsFast(cells, side);
  const cfg = LEVEL_CONFIG[difficulty];
  const budget = budgetOverride ?? (mode === 'aivai' && difficulty === 4 ? Math.round(cfg.timeMs * 1.3) : cfg.timeMs);

  // 简单档：只算一层，并偶尔在候选中挑次优，保证新手也有胜机
  if (difficulty === 1) {
    const r = iterativeSearch(pos, budget, 1);
    if (!r.move || r.move.pass || r.scores.length < 2) return r;
    const pool = r.scores.slice(0, 4);
    const pick = pool.length > 1 && Math.random() < 0.35
      ? pool[1 + ((Math.random() * (pool.length - 1)) | 0)]
      : pool[0];
    return { ...r, move: pick };
  }

  return iterativeSearch(pos, budget, cfg.depth);
}

/** 求一着 / 请神上身的预算（毫秒）：恶魔档配置 + 收短预算，兼顾棋力与等待感 */
export const HINT_BUDGET_MS = 1800;

/** 提示：固定恶魔档配置，预算收短 */
export function findHintMove(
  cells: OthBoard,
  side: OthDisc,
  mode: GameMode,
  historyLength: number,
): SearchResult<OthMove> {
  void mode;
  void historyLength;
  ttClear();
  return iterativeSearch(fromCellsFast(cells, side), HINT_BUDGET_MS, LEVEL_CONFIG[4].depth);
}

/** 64 格数组 → 位棋盘 */
export function fromCellsFast(cells: OthBoard, side: OthDisc): OthPosition {
  let bl = 0, bh = 0, wl = 0, wh = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (!v) continue;
    const sh = i < 32 ? i : i - 32;
    if (i < 32) {
      if (v === 1) bl = (bl | (1 << sh)) >>> 0;
      else wl = (wl | (1 << sh)) >>> 0;
    } else {
      if (v === 1) bh = (bh | (1 << sh)) >>> 0;
      else wh = (wh | (1 << sh)) >>> 0;
    }
  }
  return { black: [bl >>> 0, bh >>> 0], white: [wl >>> 0, wh >>> 0], side };
}

/** 局面 → 64 格数组（导出给 worker / 控制器复用） */
export function cellsOf(pos: OthPosition): OthBoard {
  return toCells(pos);
}

/** 供界面显示：当前局面双方子数 */
export function countsOf(pos: OthPosition): { black: number; white: number } {
  return {
    black: popcount(pos.black[0]) + popcount(pos.black[1]),
    white: popcount(pos.white[0]) + popcount(pos.white[1]),
  };
}

export { isEmpty };
