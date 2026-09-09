/* ────────────────────────────────────────────────────────────
 *  junqi/ai.ts — 军棋 AI：评估 + Alpha-Beta + 置换表 + 杀手着
 *
 *  与五子棋 / 象棋共用 core 里的 Zobrist 与置换表。
 *  揭棋（暗棋）近似：hidden = 对对方暗置。走法按真实兵种生成
 *  （保证合法），评估对所有暗子使用期望子力值 —— AI 不依赖暗子
 *  的具体身份做决策（对称近似，不利用己方暗子信息）。
 * ──────────────────────────────────────────────────────────── */

import type { Difficulty, GameMode, SearchResult } from '../types';
import {
  COLS, ROWS, PIECE_COUNTS, canMoveType, allJqMoves, makeJqMove, undoJqMove,
  rowOf, colOf, other, isCamp, type Board, type Side, type PType, type JqMove,
} from './rules';
import { Zobrist } from '../core/zobrist';
import { TranspositionTable } from '../core/transposition';

export const JQ_LEVEL_CONFIG: Record<Difficulty, { name: string; depth: number }> = {
  1: { name: '简单', depth: 1 },
  2: { name: '普通', depth: 2 },
  3: { name: '困难', depth: 3 },
  4: { name: '😈恶魔', depth: 6 },
};

export const JQ_MATE = 1_000_000;

/** 子力价值 */
export const VALUE: Record<PType, number> = {
  司令: 600, 军长: 520, 师长: 440, 旅长: 360, 团长: 300, 营长: 250,
  连长: 200, 排长: 150, 工兵: 230, 炸弹: 330, 地雷: 260, 军旗: 0,
};

/** 揭棋暗子的期望子力值（25 枚编制的平均值）——对双方未知的子统一按期望计 */
export const HIDDEN_VAL = (() => {
  let sum = 0;
  for (const [t, n] of PIECE_COUNTS) sum += VALUE[t] * n;
  return sum / 25;
})();

const PTYPES: PType[] = PIECE_COUNTS.map(([t]) => t);
const TYPE_IDX: Record<string, number> = {};
PTYPES.forEach((t, i) => { TYPE_IDX[t] = i; });

const zobrist = new Zobrist(COLS, ROWS, 24, 0x7c3aed11);
const tt = new TranspositionTable<JqMove>(300_000);
const killers: (JqMove | null)[] = new Array(256).fill(null);

interface Ctx {
  nodes: number;
  level: Difficulty;
  mode: GameMode;
  flip: boolean;
  deadline?: number;
  hitDeadline?: boolean;
}

function zkey(i: number, type: PType, hidden: boolean): number {
  return zobrist.key(colOf(i), rowOf(i), TYPE_IDX[type] + (hidden ? 12 : 0));
}

function boardHash(board: Board, turn: Side): number {
  let h = 0;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p) h ^= zkey(i, p.type, !!p.hidden);
  }
  if (turn === 'r') h ^= zobrist.side;
  return h >>> 0;
}

/** 走子后增量维护哈希（att/def 的 hidden 位按翻明规则更新） */
function deltaHash(h: number, rec: ReturnType<typeof makeJqMove>): number {
  let nh = h;
  nh ^= zkey(rec.from, rec.att.type, !!rec.att.hidden);
  if (!rec.attOut) nh ^= zkey(rec.to, rec.att.type, false); // 走子即翻明
  if (rec.def) {
    const dOld = zkey(rec.to, rec.def.type, !!rec.def.hidden);
    nh ^= dOld;
    if (!rec.defOut) nh ^= zkey(rec.to, rec.def.type, false); // 交战守方翻明
  }
  return nh >>> 0;
}

function dist(a: number, b: number): number {
  return Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b));
}

/** 静态评估（红方视角）。flip=揭棋：暗子按期望值计 */
export function evaluate(board: Board, flip: boolean): number {
  let score = 0;
  let rFlag = -1;
  let bFlag = -1;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p) continue;
    let v = p.hidden ? HIDDEN_VAL : VALUE[p.type];
    if (!p.hidden && canMoveType(p.type)) {
      const adv = p.side === 'r' ? rowOf(i) - 6 : 5 - rowOf(i);
      v += adv * 3;
      if (isCamp(i)) v += 6;
    }
    score += p.side === 'r' ? v : -v;
    if (p.type === '军旗') { if (p.side === 'r') rFlag = i; else bFlag = i; }
  }
  // 挖旗威胁：敌方已翻明的工兵/炸弹逼近己方军旗 → 压力
  const threat = (flag: number, enemy: Side): number => {
    if (flag < 0) return 0;
    let t = 0;
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (!p || p.side !== enemy || p.hidden) continue;
      const d = dist(i, flag);
      if (p.type === '工兵') t += Math.max(0, 42 - d * 7);
      else if (p.type === '炸弹') t += Math.max(0, 24 - d * 5);
    }
    return t;
  };
  score -= threat(rFlag, 'b');
  score += threat(bFlag, 'r');
  return score;
}

/** 走法排序分：吃大子优先，避撞明雷；空步向前 */
function orderScore(board: Board, m: JqMove): number {
  const def = board[m.to];
  const att = board[m.from]!;
  if (def) {
    if (def.type === '军旗') return 1_000_000;
    const dv = def.hidden ? HIDDEN_VAL : VALUE[def.type];
    if (def.type === '地雷' && !def.hidden && att.type !== '工兵') return -8000; // 撞明雷
    return 8000 + dv * 10 - VALUE[att.type];
  }
  const adv = att.side === 'r' ? rowOf(m.to) - rowOf(m.from) : rowOf(m.from) - rowOf(m.to);
  let s = adv * 8;
  // 工兵沿铁路机动（去挖雷）加一点分
  if (att.type === '工兵') s += 6;
  return s;
}

function orderMoves(board: Board, moves: JqMove[]): JqMove[] {
  for (const m of moves) (m as JqMove & { ord?: number }).ord = orderScore(board, m) + Math.random();
  moves.sort((a, b) => (b as JqMove & { ord: number }).ord - (a as JqMove & { ord: number }).ord);
  return moves;
}

function sameMove(a: JqMove, b: JqMove): boolean {
  return a.from === b.from && a.to === b.to;
}

/** 静态搜索：只延伸吃子，避免水平线效应 */
function quiesce(
  board: Board, alpha: number, beta: number, turn: Side, qd: number, ply: number, ctx: Ctx, hash: number,
): number {
  ctx.nodes++;
  const nodeCap = ctx.level === 4 ? 1_200_000 : 150_000;
  if (ctx.nodes > nodeCap) return (turn === 'r' ? 1 : -1) * evaluate(board, ctx.flip);
  if (ctx.deadline && typeof performance !== 'undefined' && performance.now() > ctx.deadline) {
    ctx.hitDeadline = true;
    return (turn === 'r' ? 1 : -1) * evaluate(board, ctx.flip);
  }
  const stand = (turn === 'r' ? 1 : -1) * evaluate(board, ctx.flip);
  if (qd <= 0 || ply >= 96) return stand;
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;

  const caps = orderMoves(board, allJqMoves(board, turn).filter((m) => !!board[m.to]));
  for (const m of caps) {
    const rec = makeJqMove(board, m.from, m.to);
    let v: number;
    if (rec.flag) v = JQ_MATE - ply;
    else v = -quiesce(board, -beta, -alpha, other(turn), qd - 1, ply + 1, ctx, deltaHash(hash, rec));
    undoJqMove(board, rec);
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

function alphaBeta(
  board: Board, depth: number, alpha: number, beta: number, turn: Side, ply: number,
  pv: JqMove[], ctx: Ctx, hash: number,
): number {
  ctx.nodes++;
  const nodeCap = ctx.level === 4 ? 1_400_000 : 150_000;
  if (ctx.nodes > nodeCap) return (turn === 'r' ? 1 : -1) * evaluate(board, ctx.flip);
  if (ctx.deadline && typeof performance !== 'undefined' && performance.now() > ctx.deadline) {
    ctx.hitDeadline = true;
    return (turn === 'r' ? 1 : -1) * evaluate(board, ctx.flip);
  }
  if (depth <= 0 || ply >= 96) return quiesce(board, alpha, beta, turn, 4, ply, ctx, hash);

  const key = (hash ^ (turn === 'r' ? zobrist.side : 0)) >>> 0;
  const ttScore = tt.probe(key, depth, alpha, beta);
  if (ttScore !== null) return ttScore;
  const tte = tt.get(key);

  const moves = orderMoves(board, allJqMoves(board, turn));
  if (moves.length === 0) return -JQ_MATE + ply; // 无子可动判负

  // TT 最佳着 + 杀手着提前
  if (tte?.move) {
    const i = moves.findIndex((m) => sameMove(m, tte.move!));
    if (i > 0) moves.unshift(moves.splice(i, 1)[0]);
  }
  for (const k of [killers[ply * 2], killers[ply * 2 + 1]]) {
    if (!k) continue;
    const i = moves.findIndex((m) => sameMove(m, k));
    if (i > 0) moves.unshift(moves.splice(i, 1)[0]);
  }

  // 宽度控制
  let list = moves;
  const width = ctx.level === 4 ? 44 : 34;
  if (depth >= 2 && moves.length > width) list = moves.slice(0, width);

  let best = -Infinity;
  let bestM = list[0];
  const origAlpha = alpha;

  for (const m of list) {
    const rec = makeJqMove(board, m.from, m.to);
    const childPV: JqMove[] = [];
    let v: number;
    if (rec.flag) v = JQ_MATE - ply;
    else v = -alphaBeta(board, depth - 1, -beta, -alpha, other(turn), ply + 1, childPV, ctx, deltaHash(hash, rec));
    undoJqMove(board, rec);

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

function moveText(board: Board, m: JqMove): string {
  const p = board[m.from];
  const def = board[m.to];
  const nm = p ? (p.hidden ? '暗子' : p.type) : '?';
  const cap = def ? (def.hidden ? '×暗子' : `×${def.type}`) : '→';
  return `${nm}${cap}(${rowOf(m.from) + 1},${colOf(m.from) + 1})`;
}

/** 主搜索入口 */
export function findBestMove(
  board: Board,
  side: Side,
  difficulty: Difficulty,
  mode: GameMode,
  flip: boolean,
  historyLength: number,
  persist = true,
): SearchResult<JqMove> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const cfg = JQ_LEVEL_CONFIG[difficulty];
  const demon = difficulty === 4;
  tt.clear();
  killers.fill(null);

  const TIME_BUDGET_MS = demon ? (mode === 'aivai' ? 2400 : 2800) : 0;
  const ctx: Ctx = {
    nodes: 0, level: difficulty, mode, flip,
    deadline: TIME_BUDGET_MS ? (typeof performance !== 'undefined' ? performance.now() + TIME_BUDGET_MS : 0) : undefined,
  };

  const allMoves = orderMoves(board, allJqMoves(board, side));
  if (allMoves.length === 0) {
    return { move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] };
  }

  const rootHash = boardHash(board, side);

  /** 定深全根搜索（复用 TT） */
  const runAtDepth = (depth: number) => {
    let best = allMoves[0];
    let bestV = -Infinity;
    const bestPV: JqMove[] = [];
    const scored: Array<JqMove & { v: number }> = [];
    for (const m of allMoves) {
      const rec = makeJqMove(board, m.from, m.to);
      const pv: JqMove[] = [];
      let v: number;
      if (rec.flag) v = JQ_MATE;
      else v = -alphaBeta(board, depth - 1, -Infinity, Infinity, other(side), 1, pv, ctx, deltaHash(rootHash, rec));
      undoJqMove(board, rec);
      if (!demon) v += Math.random() * (difficulty === 1 ? 140 : difficulty === 2 ? 40 : 10);
      scored.push({ ...m, v });
      if (v > bestV) { bestV = v; best = m; bestPV.length = 0; bestPV.push(m, ...pv); }
    }
    scored.sort((a, b) => b.v - a.v);
    return { best, bestV, bestPV, scored };
  };

  const pastDeadline = () => !!ctx.deadline && typeof performance !== 'undefined' && performance.now() > ctx.deadline;

  // 开局随机化（低难度，增加多样性）
  if (!demon && historyLength < 2 && Math.random() < 0.35 && allMoves.length > 5) {
    const r = allMoves[(Math.random() * 5) | 0];
    return { move: r, depth: cfg.depth, nodes: 5, ms: 1, eval: 0, scores: [{ ...r, v: 0 }], opening: true };
  }

  let res: ReturnType<typeof runAtDepth>;
  let searchDepth = cfg.depth;

  if (demon) {
    // 迭代加深：预算内能到多深就到多深；超时的残局结果不采纳
    res = runAtDepth(2);
    searchDepth = 2;
    for (let d = 3; d <= cfg.depth; d++) {
      if (pastDeadline()) break;
      ctx.hitDeadline = false;
      const r = runAtDepth(d);
      if (ctx.hitDeadline) break;
      res = r;
      searchDepth = d;
    }
  } else {
    res = runAtDepth(searchDepth);
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    move: res.best,
    depth: searchDepth,
    nodes: ctx.nodes,
    ms: Math.round(t1 - t0),
    eval: Math.round(res.bestV),
    scores: res.scored.slice(0, 6),
    pv: res.bestPV.slice(0, 6),
    qd: 4,
  };
}

/** 求一着：固定恶魔级 */
export function findHintMove(
  board: Board, side: Side, mode: GameMode, flip: boolean, historyLength: number,
): SearchResult<JqMove> {
  return findBestMove(board, side, 4, mode, flip, historyLength, false);
}

/** 供控制器 / 测试用的着法描述 */
export function describeMove(board: Board, m: JqMove): string {
  return moveText(board, m);
}
