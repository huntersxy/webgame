/* ────────────────────────────────────────────────────────────
 *  gomoku/book.ts — Demon opening book (强硬应对必胜开局)
 *
 *  In freestyle Gomoku, classic black openings (花月/浦月…) favor black if
 *  white plays passively. To give the demon a fighting chance as the second
 *  player, we recognize black's first ~5 stones (normalized over the 8 board
 *  symmetries) and return a strong local reply. A reply is accepted only when
 *  the cell is empty and adjacent to existing stones.
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer } from '../types';
import { inBounds } from './rules';

/** A reply described as offsets from 黑1 (7,7) — but in, say, canonical-ish
 *  orientation; we try all 8 orientations and accept the first that lands on
 *  an empty near-stone cell. This avoids needing transform inversion. */
const REPLIES: Array<{ x: number; y: number }> = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

const ORIENT: Array<(dx: number, dy: number) => { x: number; y: number }> = [
  (dx, dy) => ({ x: dx, y: dy }),
  (dx, dy) => ({ x: -dx, y: dy }),
  (dx, dy) => ({ x: dx, y: -dy }),
  (dx, dy) => ({ x: -dx, y: -dy }),
  (dx, dy) => ({ x: dy, y: dx }),
  (dx, dy) => ({ x: -dy, y: dx }),
  (dx, dy) => ({ x: dy, y: -dx }),
  (dx, dy) => ({ x: -dy, y: -dx }),
];

/** Relative offsets of black's follow-up stones (黑3/黑5…) for each named
 *  opening, expressed in one canonical orientation. We match by checking
 *  whether, under SOME orientation, black's actual stones (besides 天元) equal
 *  a prefix of one of these patterns. */
const OPENING_PATTERNS: Array<{ name: string; offs: Array<{ x: number; y: number }> }> = [
  // 花月 (直指, up): 黑3 at (0,1), 黑5 at (1,-1)
  { name: '花月', offs: [{ x: 0, y: -1 }, { x: 1, y: 1 }] },
  // 浦月 (直指): 黑3 (0,-1), 黑5 (-1,0)
  { name: '浦月', offs: [{ x: 0, y: -1 }, { x: -1, y: 0 }] },
  // 溪月 (斜指): 黑3 (1,-1) 黑5 (-1,-1)
  { name: '溪月', offs: [{ x: 1, y: -1 }, { x: -1, y: -1 }] },
  // 寒星: 黑3 (1,-1) 黑5 (1,0)
  { name: '寒星', offs: [{ x: 1, y: -1 }, { x: 1, y: 0 }] },
  // 疏星 (斜): 黑3 (1,-1) 黑5 (1,1)
  { name: '疏星', offs: [{ x: 1, y: -1 }, { x: 1, y: 1 }] },
  // 明星 (斜): 黑3 (-1,-1) 黑5 (-1,1)
  { name: '明星', offs: [{ x: -1, y: -1 }, { x: -1, y: 1 }] },
  // 斜月 (斜): 黑3 (-1,-1) 黑5 (1,-1)
  { name: '斜月', offs: [{ x: -1, y: -1 }, { x: 1, y: -1 }] },
  // 丘月: 黑3 (0,-1) 黑5 (1,-1)
  { name: '丘月', offs: [{ x: 0, y: -1 }, { x: 1, y: -1 }] },
  // 云月: 黑3 (1,-1) 黑5 (-1,0)
  { name: '云月', offs: [{ x: 1, y: -1 }, { x: -1, y: 0 }] },
];

function blackOffsets(board: GomokuBoard): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      if (board[y][x] !== 1) continue;
      if (x === 7 && y === 7) continue; // 黑1 = 天元
      out.push({ x: x - 7, y: y - 7 });
    }
  }
  return out;
}

/** True if `actual` (as offsets) matches the first N of pattern under any orient. */
function matchesUnderOrient(actual: Array<{ x: number; y: number }>, offs: Array<{ x: number; y: number }>): boolean {
  if (actual.length === 0) return false;
  outer: for (const o of ORIENT) {
    // map actual stones; check they equal the first (actual.length) pattern cells
    const remapped = new Set(actual.map((s) => `${o(s.x, s.y).x},${o(s.x, s.y).y}`));
    for (let i = 0; i < actual.length; i++) {
      const want = offs[i];
      if (!remapped.has(`${want.x},${want.y}`)) continue outer;
    }
    return true;
  }
  return false;
}

function nearStone(board: GomokuBoard, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (inBounds(x + dx, y + dy) && board[y + dy][x + dx] !== 0) return true;
    }
  }
  return false;
}

/**
 * Strong reply for the second player against a recognized black opening.
 * Returns a move, or null when not applicable.
 */
export function probeOpening(
  board: GomokuBoard,
  player: GomokuPlayer,
  historyLength: number,
): { x: number; y: number } | null {
  if (player !== 2) return null;          // only as defender vs black
  if (historyLength < 2 || historyLength > 9) return null;
  const black = blackOffsets(board);
  if (black.length < 1 || black.length > 3) return null;

  // Recognize the opening by prefix match.
  let name: string | null = null;
  for (const p of OPENING_PATTERNS) {
    if (black.length <= p.offs.length && matchesUnderOrient(black, p.offs)) {
      name = p.name;
      break;
    }
  }
  if (!name) return null;

  // Reply: offset that attacks the most black stones / seizes initiative.
  // Base reply is the cell between/adjacent maximally; try each orientation's
  // "控制点" and pick an empty near cell.
  const baseReplies: Array<{ x: number; y: number }> = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  ];
  for (const o of ORIENT) {
    for (const base of baseReplies) {
      const r = o(base.x, base.y);
      const rx = 7 + r.x;
      const ry = 7 + r.y;
      if (inBounds(rx, ry) && board[ry][rx] === 0 && nearStone(board, rx, ry)) {
        return { x: rx, y: ry };
      }
    }
  }
  return null;
}

export type OpeningReply = ReturnType<typeof probeOpening>;