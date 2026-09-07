/* ────────────────────────────────────────────────────────────
 *  xiangqi/eval.ts — Static evaluation with piece-square bonuses
 * ──────────────────────────────────────────────────────────── */

import type { XqBoard } from '../types';
import { PIECE_VAL, isRed, typeOf, COLS, ROWS } from './rules';

/** Pawn position bonus: advancing + center file after crossing river */
function pawnBonus(p: string, x: number, y: number): number {
  const red = isRed(p);
  let v = PIECE_VAL.p;
  if (red) {
    v += (9 - y) * 8;
    if (y <= 4) {
      v += 130;
      v += (4 - Math.abs(x - 4)) * 8;
      if (x === 4) v += 12;
    }
  } else {
    v += y * 8;
    if (y >= 5) {
      v += 130;
      v += (4 - Math.abs(x - 4)) * 8;
      if (x === 4) v += 12;
    }
  }
  return v;
}

/**
 * Static evaluation: positive = good for Red, negative = good for Black.
 * Combines material values with position-based bonuses (center horse,
 * cannon files, advancing pawns, king safety).
 */
export function evaluate(board: XqBoard): number {
  let s = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = board[y][x];
      if (!p) continue;
      const t = typeOf(p)!;
      const red = isRed(p);
      let v = 0;

      switch (t) {
        case 'p':
          v = pawnBonus(p, x, y);
          break;
        case 'n':
          v = PIECE_VAL.n;
          if (x >= 2 && x <= 6 && y >= 1 && y <= 8) v += 16; // central horse
          if (x >= 3 && x <= 5 && y >= 2 && y <= 7) v += 10;  // high horse
          if (x === 0 || x === 8) v -= 22;                    // edge penalty
          if (y === 0 || y === 9) v -= 12;
          break;
        case 'r':
          v = PIECE_VAL.r;
          if (y >= 3 && y <= 6) v += 8;
          if (x === 4) v += 6;
          if (y === 0 || y === 9) v -= 6;
          break;
        case 'c':
          v = PIECE_VAL.c;
          if (x >= 2 && x <= 6) v += 8;
          if (x === 4) v += 8; // center/rib cannon
          if ((red && y >= 5 && y <= 7) || (!red && y >= 2 && y <= 4)) v += 6;
          break;
        case 'b':
        case 'a':
          v = PIECE_VAL[t];
          if (x === 4) v += 6; // center advisor/elephant slightly better
          break;
        case 'k':
          v = PIECE_VAL.k;
          if (x === 4) v += 12; // centered king
          break;
        default:
          v = PIECE_VAL[t] || 0;
      }
      s += red ? v : -v;
    }
  }
  return s;
}
