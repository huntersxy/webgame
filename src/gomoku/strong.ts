/* ────────────────────────────────────────────────────────────
 *  gomoku/strong.ts — Precise pattern eval & VCF (连冲必杀) win search
 *
 *  Conventional alpha-beta in Gomoku is weak at spotting forced wins, and a
 *  simplistic window-count evaluator can't tell 活三 from 眠三. This module:
 *    1. precise per-line point-pattern evaluation (活四/冲四/活三/眠三/跳三)
 *    2. a fast VCF probe (连续冲四必杀) that finds forced wins at ANY depth,
 *       consulted BEFORE the main alpha-beta — so the engine "sees" kill lines.
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer } from '../types';
import { BOARD_SIZE, DIRS, other, inBounds } from './rules';

// ────────────────────────────────────────────────────────────
// 1) Precise point evaluation
// ────────────────────────────────────────────────────────────

/**
 * Score of placing `color` at (x,y), from that color's perspective, summing
 * the strongest pattern on each of the 4 rays.
 */
export function evaluatePoint(
  board: GomokuBoard,
  x: number,
  y: number,
  color: GomokuPlayer,
): number {
  let score = 0;
  for (const [dx, dy] of DIRS) {
    score += evaluateRay(board, x, y, dx, dy, color);
  }
  return score;
}

function evaluateRay(
  board: GomokuBoard,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: GomokuPlayer,
): number {
  // continuous run of `color` through (x,y)
  let left = 0;
  for (let i = 1; i <= 4; i++) {
    if (inBounds(x - dx * i, y - dy * i) && board[y - dy * i][x - dx * i] === color) left++;
    else break;
  }
  let right = 0;
  for (let i = 1; i <= 4; i++) {
    if (inBounds(x + dx * i, y + dy * i) && board[y + dy * i][x + dx * i] === color) right++;
    else break;
  }
  const run = 1 + left + right;
  // open ends: beyond the run is either empty (=1) or opponent/edge (=0). Edge
  // still allows the run to touch it, so treat edge as open.
  const lx = x - dx * (left + 1);
  const ly = y - dy * (left + 1);
  const rx = x + dx * (right + 1);
  const ry = y + dy * (right + 1);
  const leftOpen = !inBounds(lx, ly) || board[ly][lx] === 0;
  const rightOpen = !inBounds(rx, ry) || board[ry][rx] === 0;
  const open = (leftOpen ? 1 : 0) + (rightOpen ? 1 : 0);

  // 5-in-a-row
  if (run >= 5) return 5_000_000;

  let s = 0;
  if (run === 4) {
    if (open === 2) return 4_000_000; // 活四
    if (open === 1) return 400_000;   // 冲四 — adding the run gives 5 next
    return 40_000;                    // 眠四
  }
  if (run === 3) {
    if (open === 2) s += 40_000;      // 活三
    else if (open === 1) s += 10_000; // 眠三
    else s += 400;
  } else if (run === 2) {
    s += open === 2 ? 1_800 : open === 1 ? 300 : 24;
  } else {
    s += open === 2 ? 140 : open === 1 ? 36 : 5;
  }

  // jump threats: X _ X X, X X _ X, X _ X _ X …
  s = addJumpThreat(board, x, y, dx, dy, color, s);
  return Math.max(s, run === 4 && open === 1 ? 400_000 : s);
}

/** Find big jump patterns on the ray window centered at (x,y). */
function addJumpThreat(
  board: GomokuBoard,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: GomokuPlayer,
  base: number,
): number {
  const opp = other(color);
  const w: Array<0 | 1 | 2> = [];
  for (let k = -4; k <= 4; k++) {
    const nx = x + dx * k;
    const ny = y + dy * k;
    if (!inBounds(nx, ny)) w.push(0);
    else w.push(board[ny][nx] === color ? 1 : board[ny][nx] === opp ? 2 : 0);
  }
  const c = 4;
  let bestGap = 0;
  for (let start = c - 3; start <= c; start++) {
    let own = 0;
    let op = 0;
    const gaps: number[] = [];
    for (let i = start; i < start + 5; i++) {
      if (i < 0 || i >= w.length) continue;
      if (w[i] === 1) own++;
      else if (w[i] === 2) op++;
      else gaps.push(i);
    }
    if (op > 0 || own < 3) continue;
    if (gaps.length === 1) {
      const g = gaps[0];
      const joined = (g > 0 && w[g - 1] === 1) || (g < 8 && w[g + 1] === 1);
      if (own === 4) bestGap = Math.max(bestGap, joined ? 400_000 : 380_000);
      else if (own === 3) bestGap = Math.max(bestGap, joined ? 120_000 : 60_000);
    } else if (gaps.length === 2 && own === 3) {
      bestGap = Math.max(bestGap, 28_000);
    }
  }
  return base + bestGap;
}

// ────────────────────────────────────────────────────────────
// 2) VCF (连续冲四必杀) — forced-win probe
// ────────────────────────────────────────────────────────────

function nearStone(board: GomokuBoard, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (inBounds(x + dx, y + dy) && board[y + dy][x + dx] !== 0) return true;
    }
  }
  return false;
}

function countRun(board: GomokuBoard, x: number, y: number, dx: number, dy: number, color: GomokuPlayer): number {
  let n = 1;
  for (let i = 1; i <= 4; i++) {
    if (inBounds(x + dx * i, y + dy * i) && board[y + dy * i][x + dx * i] === color) n++;
    else break;
  }
  for (let i = 1; i <= 4; i++) {
    if (inBounds(x - dx * i, y - dy * i) && board[y - dy * i][x - dx * i] === color) n++;
    else break;
  }
  return n;
}

/** All near-stone empty cells. */
function allNear(board: GomokuBoard): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board[y][x] !== 0) continue;
      if (nearStone(board, x, y)) out.push({ x, y });
    }
  }
  return out;
}

/** Does placing `color` at (x,y) create >=4 in a row (a four)? */
function isFour(board: GomokuBoard, x: number, y: number, color: GomokuPlayer): boolean {
  for (const [dx, dy] of DIRS) {
    if (countRun(board, x, y, dx, dy, color) >= 4) return true;
  }
  return false;
}

function findFive(board: GomokuBoard, color: GomokuPlayer): { x: number; y: number } | null {
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board[y][x] !== 0) continue;
      if (!nearStone(board, x, y)) continue;
      board[y][x] = color;
      let win = false;
      for (const [dx, dy] of DIRS) {
        if (countRun(board, x, y, dx, dy, color) >= 5) { win = true; break; }
      }
      board[y][x] = 0;
      if (win) return { x, y };
    }
  }
  return null;
}

/**
 * VCF probe: can `attacker` force a win with a sequence of fours (and blocks)?
 * Returns the winning first move, or null if none found within maxPlies.
 * Defender answers every attacker four (or wins first); if the attacker can
 * always re-create a four and eventually reach five, it's a forced win.
 */
export function vcfProbe(
  board: GomokuBoard,
  attacker: GomokuPlayer,
  maxPlies = 16,
): { x: number; y: number } | null {
  // Budget: cap total nodes so the probe never stalls a turn.
  const budget = { n: 0 };
  const LIMIT = 6000;
  // Root: attacker plays any near move that is a four.
  const root = allNear(board)
    .filter((m) => isFour(board, m.x, m.y, attacker))
    .sort((a, b) => evaluatePoint(board, b.x, b.y, attacker) - evaluatePoint(board, a.x, a.y, attacker));

  for (const m of root) {
    if (budget.n > LIMIT) break;
    board[m.y][m.x] = attacker;
    // If attacker just made five, it's a win.
    const dWin = findFive(board, other(attacker));
    const attackerWin = hasFiveOnBoard(board, attacker);
    board[m.y][m.x] = 0;
    if (attackerWin) return m;
    if (dWin) continue;

    board[m.y][m.x] = attacker;
    if (!defenderHolds(board, attacker, 1, maxPlies, budget, LIMIT)) {
      board[m.y][m.x] = 0;
      return m;
    }
    board[m.y][m.x] = 0;
  }
  return null;
}

function hasFiveOnBoard(board: GomokuBoard, color: GomokuPlayer): boolean {
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board[y][x] !== color) continue;
      for (const [dx, dy] of DIRS) {
        // count forward from this stone
        let n = 1;
        for (let i = 1; i < 5; i++) {
          if (inBounds(x + dx * i, y + dy * i) && board[y + dy * i][x + dx * i] === color) n++;
          else break;
        }
        if (n >= 5) return true;
      }
    }
  }
  return false;
}

/**
 * Defender-to-move: returns TRUE if the defender can survive (prevent attacker
 * win) within horizon — i.e. the attacker line FAILS.
 */
function defenderHolds(
  board: GomokuBoard,
  attacker: GomokuPlayer,
  ply: number,
  maxPlies: number,
  budget: { n: number },
  limit: number,
): boolean {
  if ((budget.n += 1) > limit) return true; // out of budget → treat as survives
  if (ply > maxPlies) return true; // horizon: attacker hasn't proven a win
  const defender = other(attacker);

  // Defender's immediate five beats everything.
  if (findFive(board, defender)) return true;

  // Defender only needs to try replies in the threat neighbourhood (any other
  // reply leaves an attacker four unanswered and therefore loses). Order them
  // by defensive value and cap the branch width for speed.
  const near = allNear(board)
    .map((m) => ({ ...m, s: evaluatePoint(board, m.x, m.y, defender) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 8);

  for (const dm of near) {
    if (budget.n > limit) return true;
    board[dm.y][dm.x] = defender;
    const dWin = hasFiveOnBoard(board, defender);
    board[dm.y][dm.x] = 0;
    if (dWin) return true;

    // After the defender move, attacker must be able to make another four that
    // continues the force. If the attacker has NO four, defender is safe.
    board[dm.y][dm.x] = defender;
    const aFours = allNear(board)
      .filter((m) => isFour(board, m.x, m.y, attacker))
      .map((m) => ({ ...m, s: evaluatePoint(board, m.x, m.y, attacker) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 6);
    if (aFours.length === 0) {
      board[dm.y][dm.x] = 0;
      return true; // defender safe
    }
    // Attacker picks some four continuation; for the defender move to be
    // "hold", EVERY attacker continuation must fail.
    let anyAttackerWin = false;
    for (const am of aFours) {
      if (budget.n > limit) break;
      board[am.y][am.x] = attacker;
      const aWin = hasFiveOnBoard(board, attacker);
      board[am.y][am.x] = 0;
      if (aWin) { anyAttackerWin = true; break; }
      board[am.y][am.x] = attacker;
      const survives = defenderHolds(board, attacker, ply + 1, maxPlies, budget, limit);
      board[am.y][am.x] = 0;
      if (!survives) { anyAttackerWin = true; break; } // this continuation kills
    }
    board[dm.y][dm.x] = 0;
    if (!anyAttackerWin) return true; // this defender move survives all attacks
  }
  return false; // no defender move survives → attacker forces the win
}