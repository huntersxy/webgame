/* ────────────────────────────────────────────────────────────
 *  junqi/ai.ts — 军棋 AI：动态评估 + Alpha-Beta(PVS) + 置换表 + 杀手着
 *
 *  与五子棋 / 象棋共用 core 里的 Zobrist 与置换表。
 *  揭棋（暗棋）近似：hidden = 对对方暗置。走法按真实兵种生成
 *  （保证合法），评估对所有暗子统一使用期望子力值——AI 不依赖
 *  暗子身份做决策（对称近似，保证 negamax 一致性）；交战翻明
 *  与司令亮旗在 make/undo 中统一处理，搜索树信息状态与真实
 *  对局完全一致，翻明后的子力摆动自然进入评估。
 *  各档位均迭代加深（复用置换表），带节点/时间预算。
 * ──────────────────────────────────────────────────────────── */

import type { Difficulty, GameMode, SearchResult } from '../types';
import {
  COLS, ROWS, PIECE_COUNTS, canMoveType, allJqMoves, makeJqMove, undoJqMove,
  rowOf, colOf, other, isCamp, ADJ, type Board, type Side, type PType, type JqMove, type JqMoveRec,
} from './rules';
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

/** 走子后增量维护哈希：hidden 位按 make/undo 的翻明记录同步 */
function deltaHash(h: number, rec: JqMoveRec): number {
  let nh = h;
  nh ^= zkey(rec.from, rec.att.type, rec.attHidden0);
  if (!rec.attOut) nh ^= zkey(rec.to, rec.att.type, rec.attHidden1);
  if (rec.def) {
    nh ^= zkey(rec.to, rec.def.type, rec.defHidden0);
    if (!rec.defOut) nh ^= zkey(rec.to, rec.def.type, rec.defHidden1);
  }
  if (rec.revealedFlag && rec.flagNode >= 0) {
    nh ^= zkey(rec.flagNode, rec.revealedFlag.type, true);
    nh ^= zkey(rec.flagNode, rec.revealedFlag.type, false);
  }
  return nh >>> 0;
}

function dist(a: number, b: number): number {
  return Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b));
}

/** 静态评估（红方视角）。flip=揭棋：双方暗子统一按期望值计 */
export function evaluate(board: Board, flip: boolean): number {
  let score = 0;
  let rFlag = -1, bFlag = -1;
  let rMines = 0, bMines = 0;
  let rBomb = 0, bBomb = 0;      // 明置炸弹存活数
  let rCmd = -1, bCmd = -1;      // 明置司令位置
  let rBigDead = true, bBigDead = true; // 敌方司令/军长是否全灭（红视角下 bBigDead）

  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p) continue;
    let v = p.hidden ? HIDDEN_VAL : VALUE[p.type];
    if (!p.hidden && canMoveType(p.type)) {
      const adv = p.side === 'r' ? rowOf(i) - 6 : 5 - rowOf(i);
      v += adv * 3 * ADV_W[p.type];
      if (isCamp(i)) v += p.type === '司令' ? 10 : 6;
    }
    score += p.side === 'r' ? v : -v;
    if (p.type === '军旗') { if (p.side === 'r') rFlag = i; else bFlag = i; }
    if (p.hidden) continue;
    if (p.type === '地雷') { if (p.side === 'r') rMines++; else bMines++; }
    else if (p.type === '炸弹') { if (p.side === 'r') rBomb++; else bBomb++; }
    else if (p.type === '司令') { if (p.side === 'r') rCmd = i; else bCmd = i; }
    if (p.type === '司令' || p.type === '军长') {
      if (p.side === 'r') rBigDead = false; else bBigDead = false;
    }
  }

  // 动态权重：敌方明雷越多，己方工兵越值钱；敌方大子尽墨则炸弹贬值
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p || p.hidden) continue;
    const red = p.side === 'r';
    if (p.type === '工兵') {
      const mines = red ? bMines : rMines;
      if (mines) score += (red ? 1 : -1) * mines * 30;
    } else if (p.type === '炸弹') {
      const bigAlive = red ? !bBigDead : !rBigDead;
      score += (red ? 1 : -1) * (bigAlive ? 40 : -40);
    }
  }
  // 司令暴露惩罚：敌方仍有明置炸弹而己方司令孤军深入
  if (rCmd >= 0 && bBomb > 0 && rowOf(rCmd) <= 5) score -= (6 - rowOf(rCmd)) * 5;
  if (bCmd >= 0 && rBomb > 0 && rowOf(bCmd) >= 6) score += (rowOf(bCmd) - 5) * 5;

  // 旗区：守备加成（己方可动子护旗）与威胁（敌子逼近己旗）
  const guard = (flag: number, own: Side): number => {
    if (flag < 0) return 0;
    let g = 0;
    for (const e of ADJ[flag]) {
      const q = board[e.to];
      if (!q || q.side !== own || q.hidden || !canMoveType(q.type)) continue;
      g += 9;
    }
    return Math.min(g, 27);
  };
  const threat = (flag: number, enemy: Side): number => {
    if (flag < 0) return 0;
    let t = 0;
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (!p || p.side !== enemy || p.hidden) continue;
      const d = dist(i, flag);
      if (p.type === '工兵') t += Math.max(0, 50 - d * 9);
      else if (p.type === '炸弹') t += Math.max(0, 28 - d * 6);
      else if (p.type === '司令' || p.type === '军长') t += Math.max(0, 18 - d * 3);
    }
    return t;
  };
  score += guard(rFlag, 'r') - guard(bFlag, 'b');
  score -= threat(rFlag, 'b');
  score += threat(bFlag, 'r');
  return score;
}

/** 走法排序分：吃大子优先，避撞明雷，入营与弱子推进加分（确定性） */
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
  let s = adv * 8 * ADV_W[att.type];
  if (isCamp(m.to)) s += 30; // 入行营受保护
  if (att.type === '工兵') s += 6; // 工兵沿铁路机动（去挖雷）
  return s;
}

function orderMoves(board: Board, moves: JqMove[], jitter = false): JqMove[] {
  for (const m of moves) {
    (m as JqMove & { ord?: number }).ord = orderScore(board, m) + (jitter ? Math.random() : 0);
  }
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
  const nodeCap = ctx.level === 4 ? 1_200_000 : ctx.level === 3 ? 500_000 : 150_000;
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
  const nodeCap = ctx.level === 4 ? 1_500_000 : ctx.level === 3 ? 500_000 : 150_000;
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
  let first = true;

  for (const m of list) {
    const rec = makeJqMove(board, m.from, m.to);
    const childPV: JqMove[] = [];
    let v: number;
    if (rec.flag) v = JQ_MATE - ply;
    else if (first) {
      v = -alphaBeta(board, depth - 1, -beta, -alpha, other(turn), ply + 1, childPV, ctx, deltaHash(hash, rec));
    } else {
      // PVS：零窗试探，fail-high 再全窗重搜
      v = -alphaBeta(board, depth - 1, -alpha - 1, -alpha, other(turn), ply + 1, [], ctx, deltaHash(hash, rec));
      if (v > alpha && v < beta) {
        v = -alphaBeta(board, depth - 1, -beta, -alpha, other(turn), ply + 1, childPV, ctx, deltaHash(hash, rec));
      }
    }
    undoJqMove(board, rec);
    first = false;

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

/** 主搜索入口：全难度迭代加深，按档位给节点/时间预算 */
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

  const TIME_BUDGET_MS = demon ? (mode === 'aivai' ? 2200 : 2600) : 0;
  const ctx: Ctx = {
    nodes: 0, level: difficulty, mode, flip,
    deadline: TIME_BUDGET_MS ? (typeof performance !== 'undefined' ? performance.now() + TIME_BUDGET_MS : 0) : undefined,
  };

  const allMoves = orderMoves(board, allJqMoves(board, side), true); // 根节点加微量抖动增多样性
  if (allMoves.length === 0) {
    return { move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] };
  }

  const rootHash = boardHash(board, side);

  /**
   * 定深全根搜索（复用 TT）。
   * pvs=true 时根着用零窗试探 + fail-high 全窗重搜（深度大时省节点），
   * 此时未过线的候选分值是上界（仅影响展示排序，不影响选着）。
   */
  const runAtDepth = (depth: number, pvs: boolean) => {
    let best = allMoves[0];
    let bestV = -Infinity;
    let rootAlpha = -Infinity;
    const bestPV: JqMove[] = [];
    const scored: Array<JqMove & { v: number }> = [];
    for (const m of allMoves) {
      const rec = makeJqMove(board, m.from, m.to);
      const pv: JqMove[] = [];
      let v: number;
      if (rec.flag) v = JQ_MATE;
      else if (!pvs || rootAlpha === -Infinity) {
        v = -alphaBeta(board, depth - 1, -Infinity, Infinity, other(side), 1, pv, ctx, deltaHash(rootHash, rec));
      } else {
        v = -alphaBeta(board, depth - 1, -rootAlpha - 1, -rootAlpha, other(side), 1, [], ctx, deltaHash(rootHash, rec));
        if (v > rootAlpha) {
          const pv2: JqMove[] = [];
          v = -alphaBeta(board, depth - 1, -Infinity, Infinity, other(side), 1, pv2, ctx, deltaHash(rootHash, rec));
          pv.push(...pv2);
        }
      }
      undoJqMove(board, rec);
      if (!demon) v += Math.random() * (difficulty === 1 ? 140 : difficulty === 2 ? 40 : 10);
      scored.push({ ...m, v });
      if (v > bestV) { bestV = v; best = m; bestPV.length = 0; bestPV.push(m, ...pv); }
      if (v > rootAlpha) rootAlpha = v;
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
  let searchDepth = 1;

  // 迭代加深：预算内能到多深就到多深；超时的残局结果不采纳。
  // 恶魔档开启根节点 PVS 省节点；低档全窗保证候选分值精确
  res = runAtDepth(searchDepth, false);
  for (let d = 2; d <= cfg.depth; d++) {
    if (pastDeadline()) break;
    ctx.hitDeadline = false;
    const r = runAtDepth(d, demon);
    if (ctx.hitDeadline) break;
    res = r;
    searchDepth = d;
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
