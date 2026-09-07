/* ────────────────────────────────────────────────────────────
 *  types.ts — Shared type definitions across all game engines
 * ──────────────────────────────────────────────────────────── */

/** Player color for Gomoku: 1 = Black, 2 = White */
export type GomokuPlayer = 1 | 2;
/** 15×15 board cell: 0 empty, 1 black, 2 white */
export type GomokuCell = 0 | 1 | 2;
export type GomokuBoard = GomokuCell[][];

/** Xiangqi side: 'r' = Red, 'b' = Black */
export type XqSide = 'r' | 'b';
/** A piece is an uppercase (Red) or lowercase (Black) letter, or null */
export type XqPiece = string | null;
export type XqBoard = XqPiece[][];

/** A coordinate on the board */
export interface Pt {
  x: number;
  y: number;
}

/** A Gomoku move */
export interface GomokuMove extends Pt {
  /** Heuristic score for ordering */
  s?: number;
  /** Search value */
  v?: number;
}

/** A Xiangqi move */
export interface XqMove {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  cap: XqPiece;
  piece: XqPiece;
  /** Ordering score (internal, not serialized) */
  ord?: number;
}

/** Search result returned by the AI */
export interface SearchResult<M> {
  move: M | null;
  depth: number;
  nodes: number;
  ms: number;
  eval: number;
  scores: Array<M & { v: number }>;
  pv?: M[];
  instant?: boolean;
  boosted?: boolean;
  opening?: boolean;
  book?: boolean;
  qd?: number;
}

/** Difficulty levels */
export type Difficulty = 1 | 2 | 3 | 4;

export interface DifficultyConfig {
  name: string;
  depth: number;
  limit: number;
  qd?: number; // quiescence depth (xiangqi)
}

/** Game mode */
export type GameMode = 'ai' | 'pvp' | 'aivai';

/** Game-over outcome */
export interface GameOver {
  winner: GomokuPlayer | XqSide | 0 | 'draw';
  winLine?: Pt[];
}

/** Thinking info for the UI panel */
export interface ThinkInfo {
  depth: number;
  limit: number;
  nodes: number;
  ms: number;
  eval: number;
  scores: Array<{ x: number; y: number; v: number; rank?: number }>;
  pv?: XqMove[];
  instant?: boolean;
  boosted?: boolean;
  opening?: boolean;
  qd?: number;
}

/** Worker request messages */
export type WorkerRequest =
  | { type: 'gomoku-search'; board: GomokuBoard; player: GomokuPlayer; difficulty: Difficulty; mode: GameMode; historyLength: number }
  | { type: 'gomoku-hint'; board: GomokuBoard; player: GomokuPlayer; mode: GameMode; historyLength: number }
  | { type: 'xq-search'; board: XqBoard; side: XqSide; difficulty: Difficulty; mode: GameMode; historyLength: number }
  | { type: 'xq-hint'; board: XqBoard; side: XqSide; mode: GameMode; historyLength: number }
  | { type: 'cancel' };

/** Worker response messages */
export type WorkerResponse =
  | { type: 'search-result'; result: SearchResult<GomokuMove | XqMove> }
  | { type: 'progress'; nodes: number };
