/* ────────────────────────────────────────────────────────────
 *  gomoku/eval.ts — Static board evaluation
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer } from '../types';
import { BOARD_SIZE, WIN_LENGTH, DIRS, windowScore, other } from './rules';

/**
 * Full-board static evaluation from `ai` player's perspective.
 * Scans all 5-cell windows in 4 directions, weighting own offense
 * higher than opponent threat (asymmetric, aggressive eval).
 */
export function evaluateBoard(board: GomokuBoard, ai: GomokuPlayer): number {
  const hu = other(ai);
  let s = 0;
  const ATK = 1.2; // own offense weight
  const DEF = 0.92; // opponent threat weight
  const lead = ai === 1 ? 400 : 0; // black's first-move initiative

  // Horizontal
  for (let y = 0; y < BOARD_SIZE; y++) {
    const row = board[y];
    for (let x = 0; x <= BOARD_SIZE - WIN_LENGTH; x++) {
      let meN = 0;
      let opN = 0;
      for (let k = 0; k < WIN_LENGTH; k++) {
        const v = row[x + k];
        if (v === ai) meN++;
        else if (v === hu) opN++;
      }
      if (meN > 0 && opN > 0) continue;
      if (meN > 0) s += windowScore(meN, WIN_LENGTH - meN) * ATK;
      else if (opN > 0) s -= windowScore(opN, WIN_LENGTH - opN) * DEF;
    }
  }

  // Vertical
  for (let x = 0; x < BOARD_SIZE; x++) {
    for (let y = 0; y <= BOARD_SIZE - WIN_LENGTH; y++) {
      let meN = 0;
      let opN = 0;
      for (let k = 0; k < WIN_LENGTH; k++) {
        const v = board[y + k][x];
        if (v === ai) meN++;
        else if (v === hu) opN++;
      }
      if (meN > 0 && opN > 0) continue;
      if (meN > 0) s += windowScore(meN, WIN_LENGTH - meN) * ATK;
      else if (opN > 0) s -= windowScore(opN, WIN_LENGTH - opN) * DEF;
    }
  }

  // Diagonal ↘
  for (let y = 0; y <= BOARD_SIZE - WIN_LENGTH; y++) {
    for (let x = 0; x <= BOARD_SIZE - WIN_LENGTH; x++) {
      let meN = 0;
      let opN = 0;
      for (let k = 0; k < WIN_LENGTH; k++) {
        const v = board[y + k][x + k];
        if (v === ai) meN++;
        else if (v === hu) opN++;
      }
      if (meN > 0 && opN > 0) continue;
      if (meN > 0) s += windowScore(meN, WIN_LENGTH - meN) * ATK;
      else if (opN > 0) s -= windowScore(opN, WIN_LENGTH - opN) * DEF;
    }
  }

  // Diagonal ↗
  for (let y = WIN_LENGTH - 1; y < BOARD_SIZE; y++) {
    for (let x = 0; x <= BOARD_SIZE - WIN_LENGTH; x++) {
      let meN = 0;
      let opN = 0;
      for (let k = 0; k < WIN_LENGTH; k++) {
        const v = board[y - k][x + k];
        if (v === ai) meN++;
        else if (v === hu) opN++;
      }
      if (meN > 0 && opN > 0) continue;
      if (meN > 0) s += windowScore(meN, WIN_LENGTH - meN) * ATK;
      else if (opN > 0) s -= windowScore(opN, WIN_LENGTH - opN) * DEF;
    }
  }

  return s + lead;
}
