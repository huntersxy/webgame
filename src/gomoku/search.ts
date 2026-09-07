/* ────────────────────────────────────────────────────────────
 *  gomoku/search.ts — Negamax Alpha-Beta search with TT + killers
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer, Difficulty, GameMode, SearchResult, GomokuMove } from '../types';
import { BOARD_SIZE, DIRS, checkWin, generateCandidates, quickScore, findImmediate, other, windowScore } from './rules';
import { evaluateBoard } from './eval';
import { Zobrist } from '../core/zobrist';
import { TranspositionTable } from '../core/transposition';
import { vcfProbe, evaluatePoint } from './strong';
import { probeOpening } from './book';

export const LEVEL_CONFIG: Record<Difficulty, { name: string; depth: number; limit: number }> = {
  1: { name: '简单', depth: 1, limit: 10 },
  2: { name: '普通', depth: 2, limit: 8 },
  3: { name: '困难', depth: 3, limit: 10 },
  4: { name: '😈恶魔', depth: 5, limit: 14 },
};

const zobrist = new Zobrist(BOARD_SIZE, BOARD_SIZE, 2, 0x9e3779b9);
const tt = new TranspositionTable<GomokuMove>(300_000);
const killers: (GomokuMove | null)[] = new Array(256).fill(null);

// Warm-start adaptive depth for demon mode, persisted per player across moves:
// once a side deepens (e.g. to 8 while losing), it KEEPS that depth on the
// following moves until an advantage / balanced state triggers a reduction.
// 0 means "not warmed — start from base".
const warmDepth: Record<number, number> = { 1: 0, 2: 0 };

/** Reset persisted warm-start depths (call on new game / difficulty change). */
export function resetGomokuWarmDepth(): void { warmDepth[1] = 0; warmDepth[2] = 0; }

export interface SearchContext {
  nodes: number;
  level: Difficulty;
  mode: GameMode;
  curLimit: number;
  underPressure: boolean;
}

function boardHash(board: GomokuBoard): number {
  let h = 0;
  for (let y = 0; y < BOARD_SIZE; y++) {
    const row = board[y];
    for (let x = 0; x < BOARD_SIZE; x++) {
      const v = row[x];
      if (v === 1) h ^= zobrist.key(x, y, 0);
      else if (v === 2) h ^= zobrist.key(x, y, 1);
    }
  }
  return h >>> 0;
}

/**
 * Negamax search with alpha-beta pruning, transposition table, and killer moves.
 */
function negamax(
  board: GomokuBoard,
  depth: number,
  alpha: number,
  beta: number,
  side: GomokuPlayer,
  hash: number,
  ply: number,
  ctx: SearchContext,
): number {
  ctx.nodes++;

  const key = (hash ^ (side === 1 ? 0 : 0x80000000)) >>> 0;
  const ttScore = tt.probe(key, depth, alpha, beta);
  if (ttScore !== null) return ttScore;
  const tte = tt.get(key);

  if (depth === 0) return evaluateBoard(board, side);

  let width = ctx.curLimit || 10;
  if (ctx.level !== 4) {
    width = depth >= 2 ? Math.min(width, 8) : Math.min(width, 10);
  }

  let moves = generateCandidates(board, 2, width, side);
  if (moves.length === 0) return evaluateBoard(board, side);

  // Move ordering: TT best move + killers first
  const priority: GomokuMove[] = [];
  if (tte?.move) priority.push(tte.move);
  if (killers[ply * 2]) priority.push(killers[ply * 2]!);
  if (killers[ply * 2 + 1]) priority.push(killers[ply * 2 + 1]!);

  if (priority.length > 0) {
    const front: typeof moves = [];
    for (const p of priority) {
      const i = moves.findIndex((m) => m.x === p.x && m.y === p.y);
      if (i >= 0) front.push(moves.splice(i, 1)[0]);
    }
    moves = front.concat(moves);
  }

  const origAlpha = alpha;
  let best = -Infinity;
  let bestMove: GomokuMove | null = null;

  for (const m of moves) {
    board[m.y][m.x] = side;
    const nh = hash ^ (side === 1 ? zobrist.key(m.x, m.y, 0) : zobrist.key(m.x, m.y, 1));

    let v: number;
    if (checkWin(board, m.x, m.y)) {
      v = 10_000_000;
    } else {
      v = -negamax(board, depth - 1, -beta, -alpha, other(side), nh, ply + 1, ctx);
    }

    board[m.y][m.x] = 0;

    if (v > best) {
      best = v;
      bestMove = m;
    }
    if (v > alpha) alpha = v;
    if (alpha >= beta) {
      killers[ply * 2 + 1] = killers[ply * 2];
      killers[ply * 2] = m;
      break;
    }
  }

  tt.store(key, depth, best, origAlpha, beta, bestMove);
  return best;
}

/**
 * Find the best move for the current player.
 * @param board     Current board state (will not be modified)
 * @param player    The player to move
 * @param difficulty AI difficulty level
 * @param mode      Game mode
 * @param historyLength  Number of moves played so far
 */
export function findBestMove(
  board: GomokuBoard,
  player: GomokuPlayer,
  difficulty: Difficulty,
  mode: GameMode,
  historyLength: number,
  persist = true,
): SearchResult<GomokuMove> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const cfg = LEVEL_CONFIG[difficulty];
  let depth = cfg.depth;
  let limit = cfg.limit;

  const ctx: SearchContext = {
    nodes: 0,
    level: difficulty,
    mode,
    curLimit: limit,
    underPressure: false,
  };

  // Demon mode in AI-vs-AI: deeper search
  if (difficulty === 4 && mode === 'aivai') {
    depth = Math.max(depth, 6);
    ctx.curLimit = Math.min(limit, 12);
  }

  // Base (floor) depth that the adaptive demon search may never drop below.
  const base = depth;

  tt.clear();

  // Immediate win/block
  const imm = findImmediate(board, player);
  if (imm) {
    return {
      move: imm,
      depth,
      nodes: 0,
      ms: 0,
      eval: 9_999_999,
      scores: [{ ...imm, v: 9_999_999 }],
      instant: true,
    };
  }

  // Demon & hard: opening book (black-winning shapes → strongest reply)
  if (difficulty >= 3) {
    const book = probeOpening(board, player, historyLength);
    if (book) {
      return { move: book, depth: 0, nodes: 1, ms: 0, eval: 0, scores: [{ ...book, v: 0 }], opening: true, book: true };
    }
  }

  // Demon & hard: VCF forced-win probe (see far-away kill lines the fixed
  // alpha-beta depth misses). This is what makes demon "sharp" at striking.
  // Skipped in the opening (few pieces → no forced lines) to save time.
  if (difficulty >= 3 && historyLength >= 6) {
    const kill = vcfProbe(board, player, difficulty === 4 ? 16 : 12);
    if (kill) {
      return {
        move: kill,
        depth,
        nodes: 0,
        ms: 0,
        eval: 9_999_998,
        scores: [{ ...kill, v: 9_999_998 }],
        instant: true,
      };
    }
  }

  // Easy mode: mostly take best, sometimes random for entertainment
  if (difficulty === 1) {
    const moves = generateCandidates(board, 2, limit, player);
    const scored = moves.slice(0, 6).map((m) => ({ ...m, v: Math.round(m.s) }));
    if (Math.random() < 0.3 && moves.length > 3) {
      const pick = moves[(Math.random() * Math.min(5, moves.length)) | 0];
      return { move: pick, depth, nodes: moves.length, ms: 1, eval: Math.round(pick.s), scores: scored, opening: false };
    }
    return { move: moves[0], depth, nodes: moves.length, ms: 1, eval: Math.round(moves[0]?.s || 0), scores: scored };
  }

  // Opening moves
  if (historyLength === 0) {
    const mv = { x: 7, y: 7, v: 0 };
    return { move: mv, depth, nodes: 1, ms: 0, eval: 0, scores: [mv], opening: true };
  }
  if (historyLength === 1 && difficulty !== 4) {
    const h0 = { x: 7, y: 7 }; // approximate — caller passes real history
    const mv = {
      x: Math.min(14, Math.max(0, 7 + (Math.random() < 0.5 ? 1 : -1))),
      y: Math.min(14, Math.max(0, 8)),
      v: 0,
    };
    void h0;
    return { move: mv, depth, nodes: 1, ms: 0, eval: 0, scores: [mv], opening: true };
  }

  // Full search
  const moves = generateCandidates(board, 2, ctx.curLimit, player);
  const baseHash = boardHash(board);

  /** Run the full root search at a given depth; reuses TT between iterations. */
  const runAtDepth = (depth: number) => {
    let best: GomokuMove = moves[0];
    let bestV = -Infinity;
    const scored: Array<GomokuMove & { v: number }> = [];
    for (const m of moves) {
      board[m.y][m.x] = player;
      let v: number;
      if (checkWin(board, m.x, m.y)) {
        v = 10_000_000;
      } else {
        v = -negamax(board, depth - 1, -Infinity, Infinity, other(player), baseHash ^ (player === 1 ? zobrist.key(m.x, m.y, 0) : zobrist.key(m.x, m.y, 1)), 1, ctx);
      }
      board[m.y][m.x] = 0;
      // Non-demon: small randomness to avoid repetition; demon keeps v pure.
      v += difficulty !== 4 ? Math.random() * 20 : 0;
      scored.push({ ...m, v });
      if (v > bestV) { bestV = v; best = m; }
    }
    scored.sort((a, b) => b.v - a.v);
    return { best, bestV, scored };
  };

  // ── Demon adaptive depth (stateful across moves) ──────────────────────
  // Warm-start: if this player previously deepened (e.g. to 8 while losing),
  // keep that depth for this move too, instead of re-deepening from base.
  // While the rank-1 result still favors the opponent, deepen (up to base+3 /
  // hardCap) and re-roll. Once advantage / balanced is reached, settle on a
  // reduced depth (advantage −2, balanced −1). The settled depth persists into
  // the next move and is never allowed below the base depth.
  const hardCap = 8;
  const disAdv = (v: number) => v < -8000;   // clearly losing for the side to move
  const adv = (v: number) => v > 12000;      // clearly winning for the side to move

  if (difficulty === 4) {
    // Resume from the persisted warm-start depth (if still >= base).
    depth = Math.max(base, Math.min(warmDepth[player] || base, hardCap));

    for (let iter = 0; iter < 3; iter++) {
      const r = runAtDepth(depth);
      if (!disAdv(r.bestV) || depth >= Math.min(base + 3, hardCap)) break;
      ctx.underPressure = true;
      depth++;
    }
  }

  let res: ReturnType<typeof runAtDepth>;
  if (difficulty === 4 && depth > base) {
    const preSettleDepth = depth;
    const probe = runAtDepth(depth);
    if (adv(probe.bestV)) depth = Math.max(base, depth - 2);
    else if (!disAdv(probe.bestV)) depth = Math.max(base, depth - 1); // balanced
    res = depth === preSettleDepth ? probe : runAtDepth(depth);
  } else {
    res = runAtDepth(depth);
  }

  // Persist the settled depth for the next move (only for live demon play).
  if (difficulty === 4 && persist) warmDepth[player] = depth;
  else if (difficulty !== 4) { warmDepth[1] = 0; warmDepth[2] = 0; }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    move: res.best,
    depth,
    nodes: ctx.nodes,
    ms: Math.round(t1 - t0),
    eval: Math.round(res.bestV),
    scores: res.scored.slice(0, 6),
    boosted: ctx.underPressure,
  };
}

/** Hint: always use demon-level search (does not mutate persisted adaptive depth). */
export function findHintMove(
  board: GomokuBoard,
  player: GomokuPlayer,
  mode: GameMode,
  historyLength: number,
): SearchResult<GomokuMove> {
  return findBestMove(board, player, 4, mode, historyLength, false);
}
