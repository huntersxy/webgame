/* ────────────────────────────────────────────────────────────
 *  gomoku/learn.ts — Demon "memory" system
 *
 *  The demon records games it loses to a human, extracts lessons
 *  (position → the move it played there and lost), and detects
 *  classic black-winning openings (花月/浦月/明星/斜月 …).
 *  Next time the same position shows up (humans replaying a
 *  winning opening produce identical prefixes), the demon avoids
 *  its previous losing move.
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer, GomokuCell } from '../types';

const KEY_LESSONS = 'gomoku.demonLessons.v1';
const KEY_LOSSES = 'gomoku.demonLosses.v1';
const MAX_LESSONS = 240;
const MAX_LOSSES = 30;

export interface LossRecord {
  ts: number;
  human: GomokuPlayer;
  level: number;
  moves: Array<{ x: number; y: number; c: number }>;
  opening: string | null;
}

interface Lesson {
  sig: string;          // board signature at the moment AI was to move
  avoid: { x: number; y: number }; // the move AI played there and lost
  at: number;           // move index (1-based) in the original game
  count: number;        // how many times this lesson fired
}

function load<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch { return fallback; }
}
function save(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* noop */ }
}

/** Compact but exact signature of a board: sorted "x,y:c;…" list. */
export function boardSig(board: GomokuBoard): string {
  const parts: string[] = [];
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const c = board[y][x];
      if (c) parts.push(`${x},${y}:${c}`);
    }
  }
  return parts.join(';');
}

function getLessons(): Lesson[] { return load<Lesson[]>(KEY_LESSONS, []); }
function setLessons(v: Lesson[]): void { save(KEY_LESSONS, v.slice(0, MAX_LESSONS)); }
export function getLosses(): LossRecord[] { return load<LossRecord[]>(KEY_LOSSES, []); }

/** Record a lost game, mine lessons from it, and return summary info. */
export function recordLoss(
  moves: Array<{ x: number; y: number; c: number }>,
  human: GomokuPlayer,
  level: number,
  opening: string | null,
): { losses: number; lessons: number } {
  const losses = getLosses();
  losses.unshift({ ts: Date.now(), human, level, moves, opening });
  save(KEY_LOSSES, losses.slice(0, MAX_LOSSES));

  // Replay the game; at every position where the AI was about to move,
  // record "this move lost this game" so we avoid it next time.
  const board = createEmpty();
  const ai: GomokuPlayer = human === 1 ? 2 : 1;
  const lessons = getLessons();
  let added = 0;
  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    if (mv.c === ai) {
      // Position BEFORE the AI move (i.e. after move i-1).
      const sig = boardSig(board);
      const prev = lessons.find((l) => l.sig === sig && l.avoid.x === mv.x && l.avoid.y === mv.y);
      if (prev) prev.count++;
      else { lessons.push({ sig, avoid: { x: mv.x, y: mv.y }, at: i + 1, count: 1 }); added++; }
    }
    board[mv.y][mv.x] = mv.c as GomokuCell;
  }
  setLessons(lessons);
  return { losses: losses.length, lessons: lessons.length };
}

/** Look up whether the demon has a lesson for this exact position. */
export function checkLesson(board: GomokuBoard): { x: number; y: number; count: number } | null {
  const sig = boardSig(board);
  let best: Lesson | null = null;
  for (const l of getLessons()) {
    if (l.sig === sig && (!best || l.count > best.count)) best = l;
  }
  return best ? { x: best.avoid.x, y: best.avoid.y, count: best.count } : null;
}

export function lessonCount(): number { return getLessons().length; }
export function clearLessons(): void { setLessons([]); }

// ── Winning-opening detection ────────────────────────────────
// Black's first three stones (黑1/黑3/黑5) relative to the first stone,
// normalized through the 8 symmetries of the square board.

type Pt2 = { x: number; y: number };

const OPENING_TABLE: Array<[string, Pt2, Pt2]> = [
  // 直指 (黑3 直连) — canonical 黑3 = (0,1)
  ['花月', { x: 0, y: 1 }, { x: 1, y: -1 }],
  ['浦月', { x: 0, y: 1 }, { x: -1, y: 0 }],
  ['丘月', { x: 0, y: 1 }, { x: -1, y: 1 }],
  ['寒星', { x: 0, y: 1 }, { x: 1, y: 0 }],
  ['溪月', { x: 0, y: 1 }, { x: 0, y: 2 }],
  ['疏星', { x: 0, y: 1 }, { x: 2, y: 1 }],
  // 斜指 (黑3 斜连) — canonical 黑3 = (1,1)
  ['明星', { x: 1, y: 1 }, { x: 1, y: -1 }],
  ['斜月', { x: 1, y: 1 }, { x: -1, y: 1 }],
  ['岚月', { x: 1, y: 1 }, { x: 2, y: 0 }],
  ['银月', { x: 1, y: 1 }, { x: 0, y: 2 }],
  ['金星', { x: 1, y: 1 }, { x: 0, y: -1 }],
];

/** All 8 symmetries as (x,y) → (x',y') transforms. */
const SYMS: Array<(p: Pt2) => Pt2> = [
  (p) => ({ x: p.x, y: p.y }),
  (p) => ({ x: -p.x, y: p.y }),
  (p) => ({ x: p.x, y: -p.y }),
  (p) => ({ x: -p.x, y: -p.y }),
  (p) => ({ x: p.y, y: p.x }),
  (p) => ({ x: -p.y, y: p.x }),
  (p) => ({ x: p.y, y: -p.x }),
  (p) => ({ x: -p.y, y: -p.x }),
];

const keyOf = (p: Pt2): string => `${p.x},${p.y}`;

/**
 * Detect a classic black winning opening from the move history.
 * Returns the opening name, or a generic "起手式" label, or null.
 * Only meaningful when a human plays black (mode ai, human === 1).
 */
export function detectWinningOpening(
  moves: Array<{ x: number; y: number; c: number }>,
  human: GomokuPlayer,
): { name: string; exact: boolean } | null {
  if (human !== 1) return null;               // black winning openings require human black
  const blacks = moves.filter((m) => m.c === 1).slice(0, 3); // 黑1 黑3 黑5
  if (blacks.length < 2) return null;
  const b1 = blacks[0];
  const p3 = { x: blacks[1].x - b1.x, y: blacks[1].y - b1.y };
  const straight = (p3.x === 0 && Math.abs(p3.y) === 1) || (p3.y === 0 && Math.abs(p3.x) === 1);
  const diag = Math.abs(p3.x) === 1 && Math.abs(p3.y) === 1;
  if (!straight && !diag) return null;

  // Generic read on the first three stones: a 直指/斜指 start is itself a
  // known "black winning" skeleton.
  const base: { name: string; exact: boolean } = {
    name: straight ? '直指型黑棋必胜开局' : '斜指型黑棋必胜开局',
    exact: false,
  };
  if (blacks.length < 3) return base;

  const p5 = { x: blacks[2].x - b1.x, y: blacks[2].y - b1.y };
  const target3: Pt2 = straight ? { x: 0, y: 1 } : { x: 1, y: 1 };
  let best: { name: string; exact: boolean } | null = null;
  for (const sym of SYMS) {
    const q3 = sym(p3);
    if (q3.x !== target3.x || q3.y !== target3.y) continue;
    const q5 = sym(p5);
    for (const [name, t3, t5] of OPENING_TABLE) {
      if (t3.x === target3.x && t3.y === target3.y && keyOf(t5) === keyOf(q5)) {
        best = { name, exact: true };
        break;
      }
    }
    if (best) break;
  }
  return best ?? base;
}

function createEmpty(): GomokuBoard {
  const b: GomokuBoard = [];
  for (let y = 0; y < 15; y++) {
    const row: GomokuCell[] = [];
    for (let x = 0; x < 15; x++) row.push(0);
    b.push(row);
  }
  return b;
}
