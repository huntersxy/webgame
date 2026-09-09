/* ────────────────────────────────────────────────────────────
 *  gomoku/eval.ts — Full-board static evaluation (UI view)
 *
 *  Mirrors the engine's incremental window table: every 5-cell
 *  window contributes a shape value for whichever side has a
 *  monopoly on it. Used for the score bar / candidate shading in
 *  the UI; the engine itself maintains the same totals in O(1)
 *  incrementally (see engine.ts).
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer } from '../types';
import { other } from './rules';

/** Per-window shape values indexed by own-stone count (k=0..5). */
export const WINDOW_TABLE = [0, 30, 420, 6200, 125_000, 5_000_000];
export const DEFENCE_WEIGHT = 1.16;

/** Window start ranges per direction: [dx, dy, xLo, xHi, yLo, yHi] */
const RANGES: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [1, 0, 0, 10, 0, 14],
  [0, 1, 0, 14, 0, 10],
  [1, 1, 0, 10, 0, 10],
  [1, -1, 0, 10, 4, 14],
];

export function evaluateBoard(board: GomokuBoard, ai: GomokuPlayer): number {
  const hu = other(ai);
  let sAi = 0;
  let sHu = 0;

  for (const [dx, dy, xLo, xHi, yLo, yHi] of RANGES) {
    for (let y = yLo; y <= yHi; y++) {
      for (let x = xLo; x <= xHi; x++) {
        let a = 0;
        let h = 0;
        for (let k = 0; k < 5; k++) {
          const v = board[y + dy * k][x + dx * k];
          if (v === ai) a++;
          else if (v === hu) h++;
        }
        if (a > 0 && h === 0) sAi += WINDOW_TABLE[a];
        else if (h > 0 && a === 0) sHu += WINDOW_TABLE[h];
      }
    }
  }

  const lead = ai === 1 ? 900 : 0; // small first-move initiative bonus
  return sAi - DEFENCE_WEIGHT * sHu + lead;
}
