/* ────────────────────────────────────────────────────────────
 *  xiangqi/search.ts — Alpha-Beta + Quiescence + TT + Killers
 * ──────────────────────────────────────────────────────────── */

import type { XqBoard, XqMove, XqSide, Difficulty, GameMode, SearchResult } from '../types';
import { COLS, ROWS, PIECE_VAL, typeOf, colorOf, findKing, pseudoMoves, legalMoves, makeMove, undoMoveOnBoard, inCheck, isAttacked } from './rules';
import { evaluate } from './eval';
import { Zobrist } from '../core/zobrist';
import { TranspositionTable } from '../core/transposition';
import { nowMs as now } from '../core/time';

export const LEVEL_CONFIG: Record<Difficulty, { name: string; depth: number; qd: number }> = {
  1: { name: '简单', depth: 1, qd: 1 },
  2: { name: '普通', depth: 2, qd: 2 },
  3: { name: '困难', depth: 3, qd: 2 },
  4: { name: '😈恶魔', depth: 5, qd: 3 },
};

export const MATE = 1_000_000;

/* ── 恶魔档的时间预算 ──
 * 硬上限 10s：任何一层跑不完就丢弃，绝不会用被截断的结果（见 findBestMove 里的说明）。
 * 软目标 6s：过了软目标就不再开新的一层 —— 大多数局面 2~6s 已经到位，
 * 没必要为了「跑满」而空烧 CPU；只有一直没算到杀、且下一层估得进硬上限时才继续加深。 */
export const DEMON_HARD_BUDGET_MS = 10_000;
export const DEMON_SOFT_BUDGET_MS = 6_000;
/** 「请神」提示走的也是恶魔档，但它要的是体验：给一个短预算，别让人等 10 秒 */
export const HINT_BUDGET_MS = 3_000;
/** 下一层预估开销 = 上一层耗时 × 这个系数（α-β + 置换表 + 杀手着下的经验值，留了余量） */
const NEXT_ITER_FACTOR = 3.2;

/** 软目标：恶魔档默认 6s；外部传了更小的硬上限（如提示的 3s）就按它来。 */
function difficultiesSoftBudget(difficulty: Difficulty, hardBudgetMs: number): number {
  if (difficulty !== 4 || !hardBudgetMs) return 0;
  return Math.min(DEMON_SOFT_BUDGET_MS, hardBudgetMs);
}

// Zobrist for Xiangqi: 9×10 board, 14 piece types
const PIECE_CHARS = ['r', 'n', 'b', 'a', 'k', 'c', 'p', 'R', 'N', 'B', 'A', 'K', 'C', 'P'];
const PIECE_IDX: Record<string, number> = {};
PIECE_CHARS.forEach((ch, i) => { PIECE_IDX[ch] = i; });

const zobrist = new Zobrist(COLS, ROWS, 14, 0x85ebca6b);
const tt = new TranspositionTable<XqMove>(300_000);
const killers: (XqMove | null)[] = new Array(256).fill(null);

// Warm-start adaptive depth for demon mode, persisted per side across moves:
// once a side deepens (e.g. to 8 while losing), it KEEPS that depth on the
// following moves until an advantage / balanced state triggers a reduction.
// 0 means "not warmed — start from base".
const warmDepth: Record<XqSide, number> = { r: 0, b: 0 };

/** Reset persisted warm-start depths (call on new game / difficulty change). */
export function resetXqWarmDepth(): void { warmDepth.r = 0; warmDepth.b = 0; }

export interface XqSearchContext {
  nodes: number;
  level: Difficulty;
  mode: GameMode;
  curQD: number;
  boost: boolean;
  /** Soft deadline (performance.now() ms). Search stops deepening past it. */
  deadline?: number;
  /** Set when a node bailed out of the remaining search due to the deadline. */
  hitDeadline?: boolean;
  /** Set when a node bailed out due to the node cap（同样意味着这一层不完整） */
  hitNodeCap?: boolean;
}

function boardHash(board: XqBoard, turn: XqSide): number {
  let h = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = board[y][x];
      if (p) h ^= zobrist.key(x, y, PIECE_IDX[p]);
    }
  }
  if (turn === 'r') h ^= zobrist.side;
  return h >>> 0;
}

/** Incrementally apply a move to a Zobrist hash (must undo-symmetrically). */
function applyHash(h: number, m: XqMove): number {
  // Remove moving piece from origin, add at destination.
  const moving = m.piece ? PIECE_IDX[m.piece] : 0;
  let nh = h ^ zobrist.key(m.fx, m.fy, moving) ^ zobrist.key(m.tx, m.ty, moving);
  // Remove captured piece at destination (if any).
  if (m.cap) nh ^= zobrist.key(m.tx, m.ty, PIECE_IDX[m.cap]);
  return nh >>> 0;
}

/** MVV-LVA + positional move ordering */
export function orderMoves(moves: XqMove[], demon = false): XqMove[] {
  for (const m of moves) {
    let s = 0;
    const pv = m.cap ? PIECE_VAL[typeOf(m.cap) ?? ''] || 0 : 0;
    const av = PIECE_VAL[typeOf(m.piece) ?? ''] || 1;
    if (m.cap) s = 10 * pv - av / 10 + 1000; // MVV-LVA
    if (typeOf(m.piece) === 'p') s += 12;     // pawn advance
    if (typeOf(m.piece) === 'c' && m.cap) s += 60; // cannon capture
    if (!m.cap) {
      const cx = Math.abs(m.tx - 4);
      s += (4 - cx) * 2;
      if (colorOf(m.piece) === 'r' && m.ty < m.fy) s += 4;
      if (colorOf(m.piece) === 'b' && m.ty > m.fy) s += 4;
    }
    m.ord = s + (!demon ? Math.random() * 2 : ((m.fx * 31 + m.fy * 17 + m.tx * 13 + m.ty * 7) % 5) * 0.01);
  }
  moves.sort((a, b) => b.ord! - a.ord!);
  return moves;
}

/** Quiescence search: only explore captures (and checks) to avoid horizon effect */
function quiesce(board: XqBoard, alpha: number, beta: number, turn: XqSide, qd: number, ctx: XqSearchContext): number {
  ctx.nodes++;
  const nodeCap = ctx.level === 4 ? (ctx.mode === 'aivai' ? 3_500_000 : 2_500_000) : 120_000;
  if (ctx.nodes > nodeCap) {
    ctx.hitNodeCap = true;
    return (turn === 'r' ? 1 : -1) * evaluate(board);
  }
  if (ctx.deadline && now() > ctx.deadline) {
    ctx.hitDeadline = true;
    return (turn === 'r' ? 1 : -1) * evaluate(board);
  }

  const stand = (turn === 'r' ? 1 : -1) * evaluate(board);
  if (qd <= 0) return stand;
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;

  const opp: XqSide = turn === 'r' ? 'b' : 'r';
  const inChk = inCheck(board, turn);
  let moves: XqMove[];

  if (inChk) {
    moves = orderMoves(legalMoves(board, turn), ctx.level === 4);
  } else {
    // Only capture moves
    moves = [];
    const kpos = findKing(board, turn);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const p = board[y][x];
        if (!p || colorOf(p) !== turn) continue;
        for (const m of pseudoMoves(board, x, y)) {
          if (!m.cap) continue;
          const cap = makeMove(board, m);
          const k = typeOf(p) === 'k' ? { x: m.tx, y: m.ty } : kpos;
          if (k && !isAttacked(board, k.x, k.y, opp)) moves.push({ ...m, cap, piece: p });
          undoMoveOnBoard(board, m, cap);
        }
      }
    }
    moves = orderMoves(moves, ctx.level === 4);
  }

  if (moves.length === 0) return inChk ? -MATE + 10 : stand;

  for (const m of moves) {
    const cap = makeMove(board, m);
    const v = -quiesce(board, -beta, -alpha, opp, qd - 1, ctx);
    undoMoveOnBoard(board, m, cap);
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

/** Full alpha-beta search with check extension, TT, and killer moves */
function alphaBeta(
  board: XqBoard,
  depth: number,
  alpha: number,
  beta: number,
  turn: XqSide,
  ply: number,
  pv: XqMove[],
  ctx: XqSearchContext,
  hash: number,
): number {
  ctx.nodes++;
  const demon = ctx.level === 4;
  const nodeCap = demon && ctx.mode === 'aivai' ? 4_000_000 : demon ? 2_500_000 : 120_000;
  if (ctx.nodes > nodeCap) {
    ctx.hitNodeCap = true;
    return (turn === 'r' ? 1 : -1) * evaluate(board);
  }
  if (ctx.deadline && now() > ctx.deadline) {
    ctx.hitDeadline = true;
    return (turn === 'r' ? 1 : -1) * evaluate(board);
  }

  const inChk = inCheck(board, turn);

  // Check extension: extend depth when in check
  if (inChk && depth <= 0 && ply < 8) return quiesce(board, alpha, beta, turn, ctx.curQD + 1, ctx);
  if (depth <= 0) return quiesce(board, alpha, beta, turn, ctx.curQD, ctx);

  const key = (hash ^ (turn === 'r' ? zobrist.side : 0)) >>> 0;
  const ttScore = tt.probe(key, depth, alpha, beta);
  if (ttScore !== null) return ttScore;
  const tte = tt.get(key);

  let moves = orderMoves(legalMoves(board, turn), demon);

  // TT best move + killers to front
  if (tte?.move) {
    const i = moves.findIndex((m) => m.fx === tte.move!.fx && m.fy === tte.move!.fy && m.tx === tte.move!.tx && m.ty === tte.move!.ty);
    if (i > 0) moves.unshift(moves.splice(i, 1)[0]);
  }
  for (const k of [killers[ply * 2], killers[ply * 2 + 1]]) {
    if (!k) continue;
    const i = moves.findIndex((m) => m.fx === k.fx && m.fy === k.fy && m.tx === k.tx && m.ty === k.ty);
    if (i > 0) moves.unshift(moves.splice(i, 1)[0]);
  }

  const next: XqSide = turn === 'r' ? 'b' : 'r';
  if (moves.length === 0) {
    return inChk ? -MATE + ply : -MATE + ply + 100; // checkmate or stalemate
  }

  // Width control
  let list = moves;
  if (demon) {
    if (depth >= 3 && moves.length > 20) list = moves.slice(0, 20);
    else if (depth === 2 && moves.length > 24) list = moves.slice(0, 24);
  } else {
    if (depth >= 2 && moves.length > (ctx.level < 3 ? 22 : 30)) list = moves.slice(0, ctx.level < 3 ? 22 : 30);
  }

  let best = -Infinity;
  let bestM = list[0];
  const origAlpha = alpha;

  for (const m of list) {
    const cap = makeMove(board, m);
    const childPV: XqMove[] = [];
    let v: number;
    const oppKing = findKing(board, next);
    const childHash = applyHash(hash, m);
    if (!oppKing) v = MATE;
    else v = -alphaBeta(board, depth - 1, -beta, -alpha, next, ply + 1, childPV, ctx, childHash);
    undoMoveOnBoard(board, m, cap);

    if (v > best) {
      best = v;
      bestM = m;
      if (pv) { pv.length = 0; pv.push(m, ...childPV); }
    }
    if (v > alpha) alpha = v;
    if (alpha >= beta) {
      killers[ply * 2 + 1] = killers[ply * 2];
      killers[ply * 2] = m;
      break;
    }
  }

  tt.store(key, depth, best, origAlpha, beta, bestM);
  return best;
}

/** Find best move for the current side
 *
 *  @param rootOut 可选：把**全部**根着法及其 α-β 分数写回这里（神经网络
 *                 引擎要把网络先验融合进根着法评分，光靠返回的 top6 不够）。
 *  @param skipOpeningRandom 跳过「开局随机挑一手」的捷径。神经网络引擎要传 true：
 *                 开局的多样性应当由网络先验 + 温度采样给出，而不是随机数——
 *                 而且那条捷径不走 rootOut，会让调用方拿到空的根着法表。
 *  @param timeBudgetMs 覆盖恶魔档的硬时间上限（默认 10s）。「请神」提示走短预算。
 */
export function findBestMove(
  board: XqBoard,
  side: XqSide,
  difficulty: Difficulty,
  mode: GameMode,
  historyLength: number,
  persist = true,
  rootOut?: Array<XqMove & { v: number }>,
  skipOpeningRandom = false,
  timeBudgetMs?: number,
): SearchResult<XqMove> {
  const t0 = now();
  const cfg = LEVEL_CONFIG[difficulty];
  let base = cfg.depth;

  // 恶魔档的时间预算：硬上限管死（跑不完的层一律丢弃），软目标决定「够强就收手」。
  // 非恶魔档没有时间预算（按固定深度搜完）。
  const hardBudgetMs = difficulty === 4 ? (timeBudgetMs ?? DEMON_HARD_BUDGET_MS) : 0;
  const softBudgetMs = difficultiesSoftBudget(difficulty, hardBudgetMs);

  const ctx: XqSearchContext = {
    nodes: 0,
    level: difficulty,
    mode,
    curQD: cfg.qd,
    boost: false,
    deadline: hardBudgetMs ? now() + hardBudgetMs : 0,
  };

  // Demon AI-vs-AI: deeper
  if (difficulty === 4 && mode === 'aivai') base = Math.max(base, 6);

  tt.clear();
  const demon = difficulty === 4;
  const next: XqSide = side === 'r' ? 'b' : 'r';
  const rootHash = boardHash(board, side);

  const allMoves = orderMoves(legalMoves(board, side), demon);
  if (allMoves.length === 0) {
    return { move: null, depth: base, nodes: 0, ms: 0, eval: 0, scores: [] };
  }

  // Non-demon opening randomness（神经网络引擎会跳过这条捷径，见上面的参数说明）
  if (!skipOpeningRandom && !demon && historyLength < 2 && Math.random() < 0.35 && allMoves.length > 5) {
    const r = allMoves[(Math.random() * 5) | 0];
    if (rootOut) {
      rootOut.length = 0;
      rootOut.push({ ...r, v: 0 });
    }
    return { move: r, depth: base, nodes: 5, ms: 1, eval: 0, scores: [{ ...r, v: 0 }], opening: true };
  }

  /** Run the full root search at a given depth; reuses TT between iterations. */
  const runAtDepth = (depth: number) => {
    let best = allMoves[0];
    let bestV = -Infinity;
    const bestPV: XqMove[] = [];
    const scored: Array<XqMove & { v: number }> = [];
    for (const m of allMoves) {
      const cap = makeMove(board, m);
      let v: number;
      const pv: XqMove[] = [];
      const childHash = applyHash(rootHash, m);
      const oppKing = findKing(board, next);
      if (!oppKing) v = MATE;
      else v = -alphaBeta(board, depth - 1, -Infinity, Infinity, next, 1, pv, ctx, childHash);
      undoMoveOnBoard(board, m, cap);
      if (!demon) v += Math.random() * (difficulty === 1 ? 120 : 8);
      scored.push({ ...m, v });
      if (v > bestV) { bestV = v; best = m; bestPV.length = 0; bestPV.push(m, ...pv); }
    }
    scored.sort((a, b) => b.v - a.v);
    return { best, bestV, bestPV, scored };
  };

  // ── Demon adaptive depth (stateful across moves) ──────────────────────
  // Warm-start: if this side previously deepened (e.g. to 8 while losing),
  // keep that depth for this move too, instead of re-deepening from base.
  // While the rank-1 result still favors the opponent, deepen the search
  // (up to base+3 / hardCap) and re-roll. Once an advantage / balanced state
  // is reached, settle on a reduced depth (advantage −2, balanced −1).
  // The settled depth is persisted so it carries into the next move, and is
  // never allowed below the base depth.
  const hardCap = 8;

  let searchDepth = base;
  // Keeps the last COMPLETE (budget-safe) depth result so a time-out deepens
  // fall back to a solid shallower search instead of a garbled partial one.
  let lastGood: ReturnType<typeof runAtDepth> | null = null;
  let lastGoodDepth = base;
  /** 迭代里跑出绝杀分就收手：再深也不会更好 */
  let solvedMate = false;

  if (demon) {
    // ── 迭代加深 + 时间管理 ──
    // ① 先垫一个「一定能跑完」的浅层完整结果：一个完整迭代都没有时，
    //    只能用被截断的那次结果，而被截断的子树直接返回静态评估，
    //    于是「刚吃完一个马」的节点会被算成大优（实测把亏子交换算成 +236）。
    //    depth3 通常几十毫秒，换来结果永远自洽。
    // ② 再一层层加深，每层都做「还值不值得再开一层」的估算：
    //    软目标（默认 6s）之内、且预估下一层能在硬上限（默认 10s）内跑完才继续。
    //    这样大多数局面 2~6s 就收手，只有真需要深算的局面才用满硬上限。
    const savedDeadline = ctx.deadline;
    ctx.deadline = undefined;
    ctx.hitDeadline = false;
    ctx.hitNodeCap = false;
    lastGood = runAtDepth(Math.min(base, 3));
    lastGoodDepth = Math.min(base, 3);
    ctx.deadline = savedDeadline;

    let lastIterMs = 0;
    for (let d = lastGoodDepth + 1; d <= hardCap; d++) {
      const nowMs = now();
      const elapsed = nowMs - t0;
      const remain = (ctx.deadline ?? nowMs) - nowMs;
      // 已经过了软目标就收手；估算下一层跑不完也不开（EBF 取 3.2 留余量）
      if (elapsed >= softBudgetMs) break;
      if (remain <= 0) break;
      if (lastIterMs > 0 && lastIterMs * NEXT_ITER_FACTOR > remain * 0.85) break;

      ctx.hitDeadline = false;
      ctx.hitNodeCap = false;
      const iterStart = now();
      const r = runAtDepth(d);
      lastIterMs = now() - iterStart;
      // 被硬上限/节点上限掐断的这一层不算数，保留上一层完整结果
      if (ctx.hitDeadline || ctx.hitNodeCap) break;
      lastGood = r;
      lastGoodDepth = d;
      if (Math.abs(r.bestV) >= MATE - 1000) { solvedMate = true; break; }
    }

    searchDepth = lastGoodDepth;
    void solvedMate;
  }

  let res: ReturnType<typeof runAtDepth>;
  if (demon) {
    res = lastGood ?? runAtDepth(searchDepth);
  } else {
    res = runAtDepth(searchDepth);
  }

  // Persist the settled depth for the next move (only for live demon play).
  if (demon && persist) warmDepth[side] = searchDepth;
  else if (!demon) { warmDepth.r = 0; warmDepth.b = 0; }

  const t1 = now();
  if (rootOut) {
    rootOut.length = 0;
    for (const s of res.scored) rootOut.push(s);
  }
  return {
    move: res.best,
    depth: searchDepth,
    nodes: ctx.nodes,
    ms: Math.round(t1 - t0),
    eval: Math.round(res.bestV),
    scores: res.scored.slice(0, 6),
    pv: res.bestPV.slice(0, 6),
    boosted: ctx.boost,
    qd: cfg.qd,
  };
}

/** Hint: 走恶魔档配置，但用短预算（HINT_BUDGET_MS）——「请神」要的是体验，不是榨干 CPU。 */
export function findHintMove(
  board: XqBoard,
  side: XqSide,
  mode: GameMode,
  historyLength: number,
  timeBudgetMs: number = HINT_BUDGET_MS,
): SearchResult<XqMove> {
  return findBestMove(board, side, 4, mode, historyLength, false, undefined, true, timeBudgetMs);
}
