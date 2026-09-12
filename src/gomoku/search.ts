/* ────────────────────────────────────────────────────────────
 *  gomoku/search.ts — AI entry point (adapter over engine.ts)
 *
 *  Difficulty is expressed as a time-budgeted iterative deepening
 *  schedule rather than a fixed ply count: every level searches as
 *  deep as the clock allows and stops cleanly mid-tree. This is the
 *  "fastest & strongest" trade-off competitive engines use — easy
 *  answers instantly, demon burns seconds and reaches depth 10-16.
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer, Difficulty, GameMode, SearchResult, GomokuMove } from '../types';
import { GomokuEngine, MATE, xOf, yOf, cellOf, ttClear } from './engine';
import { probeOpening } from './book';
import { nowMs as now } from '../core/time';

export const LEVEL_CONFIG: Record<Difficulty, { name: string; depth: number; limit: number; timeMs: number }> = {
  1: { name: '简单', depth: 2, limit: 8, timeMs: 150 },
  2: { name: '普通', depth: 6, limit: 10, timeMs: 450 },
  3: { name: '困难', depth: 10, limit: 12, timeMs: 1400 },
  4: { name: '😈恶魔', depth: 30, limit: 16, timeMs: 2800 },
};

const engine = new GomokuEngine();

/** Kept for controller compatibility; state now resets per search. */
export function resetGomokuWarmDepth(): void {
  ttClear();
}

function toMove(cell: number, v = 0): GomokuMove {
  return { x: xOf(cell), y: yOf(cell), v };
}

/**
 * Find the best move for the current player.
 * @param board     Current board state (not mutated)
 * @param player    The player to move
 * @param difficulty AI difficulty level
 * @param mode      Game mode
 * @param historyLength Number of moves played so far
 */
export function findBestMove(
  board: GomokuBoard,
  player: GomokuPlayer,
  difficulty: Difficulty,
  mode: GameMode,
  historyLength: number,
  persist = true,
): SearchResult<GomokuMove> {
  void persist;
  const t0 = now();
  const cfg = LEVEL_CONFIG[difficulty];
  const ci = player - 1;
  const oi = 1 - ci;

  engine.load2D(board);
  ttClear();

  const timeMs = mode === 'aivai' && difficulty === 4 ? Math.round(cfg.timeMs * 1.4) : cfg.timeMs;
  engine.startSearch(t0 + timeMs);

  // ── Opening ──
  if (historyLength === 0) {
    const mv = toMove(cellOf(7, 7));
    return { move: mv, depth: 1, nodes: 1, ms: 0, eval: 0, scores: [{ ...mv, v: 0 }], opening: true };
  }
  if (historyLength === 1) {
    // respond next to black's actual first stone (greedy local shape pick)
    const cell = pickNearFallback(board, player);
    const mv = toMove(cell);
    return { move: mv, depth: 1, nodes: 1, ms: 0, eval: 0, scores: [{ ...mv, v: 0 }], opening: true };
  }

  // ── Immediate tactics from maintained five-cell sets (O(1)) ──
  if (engine.winCellCount(ci) > 0) {
    const mv = toMove(engine.winCell(ci), MATE);
    return { move: mv, depth: 1, nodes: 0, ms: 0, eval: MATE, scores: [{ ...mv, v: MATE }], instant: true };
  }
  if (engine.winCellCount(oi) >= 1) {
    // Must block the (only) opponent five-cell — own win already checked.
    const mv = toMove(engine.winCell(oi), MATE - 1);
    return { move: mv, depth: 1, nodes: 0, ms: 0, eval: -MATE + 2, scores: [{ ...mv, v: -MATE + 2 }], instant: true };
  }

  // ── Opening book for hard/demon ──
  if (difficulty >= 3) {
    const book = probeOpening(board, player, historyLength);
    if (book) {
      const mv = { ...book, v: 0 };
      return { move: mv, depth: 0, nodes: 1, ms: 0, eval: 0, scores: [mv], opening: true, book: true };
    }
  }

  // ── VCF forced-win probe (sharp striking, beyond alpha-beta horizon) ──
  if (difficulty >= 3 && historyLength >= 6) {
    engine.deadlineForVcf(t0 + Math.min(900, timeMs * 0.35));
    const killCell = engine.vcfFind(ci, difficulty === 4 ? 60000 : 30000, difficulty === 4 ? 30 : 22);
    if (killCell >= 0) {
      const mv = toMove(killCell, MATE - 2);
      return { move: mv, depth: cfg.depth, nodes: engine.vcfNodes(), ms: Math.round(now() - t0), eval: MATE - 2, scores: [{ ...mv, v: MATE - 2 }], instant: true };
    }
    // restore full budget for the main search
    engine.startSearch(t0 + timeMs);
  }

  // ── Easy: shallow greedy + entertaining randomness ──
  if (difficulty === 1) {
    const r = engine.rootSearch(ci, 1, cfg.limit);
    const easyNodes = engine.nodes;
    const scored = r.scored.slice(0, 5).map((m) => toMove(m.cell, Math.round(m.s)) as GomokuMove & { v: number });
    const pool = scored.length > 3 && Math.random() < 0.35 ? scored.slice(1) : scored;
    const pick = pool[(Math.random() * pool.length) | 0] || toMove(r.best);
    return { move: pick, depth: 1, nodes: easyNodes, ms: Math.round(now() - t0), eval: Math.round(r.bestV), scores: scored };
  }

  // ── Iterative deepening within the wall-clock budget ──
  let bestDepth = 0;
  let bestCell = -1;
  let bestV = 0;
  let bestScores: Array<GomokuMove & { v: number }> = [];

  for (let d = 2; d <= cfg.depth; d++) {
    if (now() > t0 + timeMs) break;
    const r = engine.rootSearch(ci, d, Math.min(cfg.limit, 16));
    if (engine.aborted || r.best < 0) break;
    bestDepth = d;
    bestCell = r.best;
    bestV = r.bestV;
    bestScores = r.scored.slice(0, 6).map((m) => toMove(m.cell, Math.round(m.s)) as GomokuMove & { v: number });
    if (Math.abs(bestV) >= MATE - 64) break;            // proven forced win/loss
    if (now() - t0 > timeMs * 0.45) break;              // next iteration won't fit
  }

  if (bestCell < 0) {
    // Timed out before finishing even one iteration: fall back to greedy.
    const r = engine.rootSearch(ci, 1, cfg.limit);
    bestCell = r.best >= 0 ? r.best : engine.winCell(ci) >= 0 ? engine.winCell(ci) : -1;
    if (bestCell < 0) bestCell = pickNearFallback(board, player);
    bestScores = r.scored.slice(0, 6).map((m) => toMove(m.cell, Math.round(m.s)) as GomokuMove & { v: number });
  }

  const mv = toMove(bestCell, Math.round(bestV));
  return {
    move: mv,
    depth: bestDepth || 1,
    nodes: engine.nodes,
    ms: Math.round(now() - t0),
    eval: Math.round(bestV),
    scores: bestScores,
  };
}

function pickNearFallback(board: GomokuBoard, player: GomokuPlayer): number {
  const opp = player === 1 ? 2 : 1;
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      if (board[y][x] !== 0) { sumX += x; sumY += y; n++; }
    }
  }
  const cx = n ? Math.round(sumX / n) : 7;
  const cy = n ? Math.round(sumY / n) : 7;
  let best = -1;
  let bestS = -Infinity;
  for (let y = Math.max(0, cy - 2); y <= Math.min(14, cy + 2); y++) {
    for (let x = Math.max(0, cx - 2); x <= Math.min(14, cx + 2); x++) {
      if (board[y][x] !== 0) continue;
      const s = engine.attackGain(player - 1, cellOf(x, y)) + engine.attackGain(opp - 1, cellOf(x, y)) * 0.9 - Math.abs(x - cx) - Math.abs(y - cy);
      if (s > bestS) { bestS = s; best = cellOf(x, y); }
    }
  }
  return best >= 0 ? best : cellOf(7, 7);
}

/** Hint: always use demon-level search. */
export function findHintMove(
  board: GomokuBoard,
  player: GomokuPlayer,
  mode: GameMode,
  historyLength: number,
): SearchResult<GomokuMove> {
  return findBestMove(board, player, 4, mode, historyLength, false);
}
