/* ────────────────────────────────────────────────────────────
 *  types.ts — Shared type definitions across all game engines
 * ──────────────────────────────────────────────────────────── */

import type { Board as JqBoard, Side as JqSide } from './junqi/rules';
export type { JqBoard, JqSide };

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

/** 按真实落子顺序记录的一手。Rapfi 引擎要求按行棋序重摆棋盘（见 rapfi.ts），
 *  只传 2D 棋盘无法还原顺序。 */
export interface GomokuHistoryMove extends Pt {
  c: GomokuPlayer;
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

/** A Junqi (陆战棋) move: board node indices */
export interface JqMove {
  from: number;
  to: number;
  /** Search value */
  v?: number;
  /** 根节点 PVS 未过线时该分值只是上界，不能与精确分值等同展示 */
  ub?: boolean;
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
  /** Which engine produced this result: rapfi WASM variant or the bundled JS engine */
  engine?: 'rapfi-multi' | 'rapfi-single' | 'js';
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
  | { type: 'gomoku-search'; board: GomokuBoard; player: GomokuPlayer; difficulty: Difficulty; mode: GameMode; historyLength: number; moves: GomokuHistoryMove[] }
  | { type: 'gomoku-hint'; board: GomokuBoard; player: GomokuPlayer; mode: GameMode; historyLength: number; moves: GomokuHistoryMove[] }
  | { type: 'xq-search'; board: XqBoard; side: XqSide; difficulty: Difficulty; mode: GameMode; historyLength: number }
  | { type: 'xq-hint'; board: XqBoard; side: XqSide; mode: GameMode; historyLength: number }
  | { type: 'junqi-search'; board: JqBoard; side: JqSide; difficulty: Difficulty; mode: GameMode; flip: boolean; historyLength: number }
  | { type: 'junqi-hint'; board: JqBoard; side: JqSide; mode: GameMode; flip: boolean; historyLength: number }
  /** 提前唤醒 Rapfi 引擎，把首次 ~11MB 加载挪到玩家思考首手的时间里 */
  | { type: 'gomoku-warmup' }
  | { type: 'cancel' };

/** Worker response messages */
export type WorkerResponse =
  | { type: 'search-result'; result: SearchResult<GomokuMove | XqMove | JqMove> }
  | { type: 'progress'; nodes: number }
  | { type: 'warmup-done'; ok: boolean; variant?: 'multi' | 'single' }
  /** 引擎数据包下载进度（worker 侧上报，主线程预取时通常一闪而过） */
  | { type: 'load-progress'; loaded: number; total: number };
