/* ────────────────────────────────────────────────────────────
 *  gomoku/rules.ts — Board logic, win detection, move generation
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer, Pt } from '../types';

export const BOARD_SIZE = 15;
export const WIN_LENGTH = 5;

/** Four line directions: horizontal, vertical, diagonal ↘, diagonal ↗ */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

export function createBoard(): GomokuBoard {
  return Array.from({ length: BOARD_SIZE }, () =>
    new Array<GomokuBoard[number][number]>(BOARD_SIZE).fill(0),
  );
}

export function cloneBoard(b: GomokuBoard): GomokuBoard {
  return b.map((row) => [...row]) as GomokuBoard;
}

export function other(player: GomokuPlayer): GomokuPlayer {
  return player === 1 ? 2 : 1;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

export function isBoardFull(b: GomokuBoard): boolean {
  for (const row of b) {
    for (const v of row) {
      if (v === 0) return false;
    }
  }
  return true;
}

/**
 * Check if placing at (x, y) creates a winning line.
 * Returns the winning line points or null.
 */
export function checkWin(b: GomokuBoard, x: number, y: number): Pt[] | null {
  const color = b[y][x];
  if (color === 0) return null;

  for (const [dx, dy] of DIRS) {
    const line: Pt[] = [{ x, y }];

    // Extend forward
    for (let k = 1; k < WIN_LENGTH; k++) {
      const nx = x + dx * k;
      const ny = y + dy * k;
      if (!inBounds(nx, ny) || b[ny][nx] !== color) break;
      line.push({ x: nx, y: ny });
    }

    // Extend backward
    for (let k = 1; k < WIN_LENGTH; k++) {
      const nx = x - dx * k;
      const ny = y - dy * k;
      if (!inBounds(nx, ny) || b[ny][nx] !== color) break;
      line.unshift({ x: nx, y: ny });
    }

    if (line.length >= WIN_LENGTH) {
      return line.slice(0, WIN_LENGTH);
    }
  }
  return null;
}

export interface MoveCandidate {
  x: number;
  y: number;
  s: number;
}

/**
 * Generate candidate moves near existing stones, sorted by heuristic score.
 * @param board    Current board state
 * @param range    Search radius around existing stones
 * @param limit    Max candidates to return
 * @param forColor The color to evaluate for (attacker)
 */
export function generateCandidates(
  board: GomokuBoard,
  range = 2,
  limit = 12,
  forColor: GomokuPlayer = 1,
): MoveCandidate[] {
  const hasStone = board.some((row) => row.some((v) => v !== 0));
  if (!hasStone) {
    return [{ x: 7, y: 7, s: 0 }];
  }

  const set = new Set<number>();
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board[y][x] !== 0) continue;
      let near = false;
      for (let dy = -range; dy <= range && !near; dy++) {
        for (let dx = -range; dx <= range; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (inBounds(nx, ny) && board[ny][nx] !== 0) {
            near = true;
            break;
          }
        }
      }
      if (near) set.add(y * BOARD_SIZE + x);
    }
  }

  const opp = other(forColor);
  const arr: MoveCandidate[] = [];
  for (const k of set) {
    const x = k % BOARD_SIZE;
    const y = (k / BOARD_SIZE) | 0;

    // Attacker score
    board[y][x] = forColor;
    const atk = quickScore(board, x, y, forColor);
    board[y][x] = 0;

    // Defender score (blocking opponent)
    board[y][x] = opp;
    const def = quickScore(board, x, y, opp);
    board[y][x] = 0;

    const centerBonus = (7 - Math.abs(7 - x) + 7 - Math.abs(7 - y)) * 0.5;
    arr.push({ x, y, s: atk + def * 0.92 + centerBonus });
  }

  arr.sort((a, b) => b.s - a.s);
  return arr.slice(0, limit);
}

/** Quick localized score around a single stone (for move ordering) */
export function quickScore(
  board: GomokuBoard,
  x: number,
  y: number,
  color: GomokuPlayer,
): number {
  const me = color;
  const op = other(color);
  let s = 0;

  for (const [dx, dy] of DIRS) {
    for (let o = -4; o <= 0; o++) {
      let meN = 0;
      let opN = 0;
      let ok = true;

      for (let k = 0; k < WIN_LENGTH; k++) {
        const nx = x + dx * (o + k);
        const ny = y + dy * (o + k);
        if (!inBounds(nx, ny)) {
          ok = false;
          break;
        }
        if (nx === x && ny === y) {
          meN++;
          continue;
        }
        const v = board[ny][nx];
        if (v === me) meN++;
        else if (v === op) opN++;
      }

      if (!ok || (meN > 0 && opN > 0)) continue;
      if (meN > 0) s += windowScore(meN, WIN_LENGTH - meN - opN);
    }
  }
  return s;
}

/** Score for a window of `own` stones and `empty` empty cells */
export function windowScore(own: number, empty: number): number {
  if (own === 5) return 1_000_000;
  if (own === 4) return empty === 1 ? 120_000 : 0;
  if (own === 3) return empty === 2 ? 12_000 : empty === 1 ? 800 : 0;
  if (own === 2) return empty === 3 ? 800 : empty === 2 ? 120 : 0;
  if (own === 1) return empty === 4 ? 15 : 0;
  return 0;
}

