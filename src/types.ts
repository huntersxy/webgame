/* ────────────────────────────────────────────────────────────
 *  types.ts — Shared type definitions across all game engines
 * ──────────────────────────────────────────────────────────── */

import type { Board as JqBoard, Side as JqSide } from './junqi/rules';
export type { JqBoard, JqSide };
import type { GoColor } from './go/rules';
export type { GoColor };

/** Player color for Gomoku: 1 = Black, 2 = White */
export type GomokuPlayer = 1 | 2;
/** 15×15 board cell: 0 empty, 1 black, 2 white */
export type GomokuCell = 0 | 1 | 2;
export type GomokuBoard = GomokuCell[][];

/** Othello (黑白棋) disc colour: 1 = black, 2 = white */
export type OthDisc = 1 | 2;
/** Othello board as a flat 64-cell array, index = y*8+x; 0 empty, 1 black, 2 white */
export type OthBoard = Uint8Array;

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

/** 黑白棋一手棋。pass = true 表示该方无合法点、被迫停一手（x/y 无意义）。 */
export interface OthMove extends Pt {
  /** 该手翻掉的棋子数（界面播报用） */
  f?: number;
  /** Heuristic score for ordering */
  s?: number;
  /** Search value（搜索分值，界面评估栏用） */
  v?: number;
  /** 停一手（pass） */
  pass?: boolean;
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

/* ── 围棋 ── */

/** 围棋一手棋：i = 棋盘索引（y*size+x），-1 = 虚手 */
export interface GoMove {
  i: number;
  /** 搜索值（访问次数），界面排序用 */
  v?: number;
}

/** 围棋候选点（界面「候选点显示」与思考日志用） */
export interface GoCandidate {
  /** 棋盘索引，size*size 表示虚手 */
  move: number;
  visits: number;
  /** 该手之后轮走方的胜率 0~1 */
  winProb: number;
  /** 黑方视角目差 */
  scoreLead: number;
  prior: number;
}

/** 围棋 AI 难度档 */
export type GoLevel = 1 | 2 | 3 | 4;

/**
 * 围棋局面负载（主线程 → Worker，必须可结构化克隆）。
 * stones 用 Uint8Array（0 空 / 1 黑 / 2 白），长度 size*size。
 */
export interface GoPositionPayload {
  size: number;
  stones: Uint8Array;
  /** 劫禁着点，-1 无 */
  koPoint: number;
  toMove: GoColor;
  komi: number;
  /** 最近若干手（时间顺序，最后一项是最近一手；move = -1 为虚手） */
  moveHistory: Array<{ move: number; color: GoColor }>;
  /** 上一手 / 上上手局面（供网络输入的历史与征子平面） */
  prevStones?: Uint8Array | null;
  prevKoPoint?: number;
  prevPrevStones?: Uint8Array | null;
  prevPrevKoPoint?: number;
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
  /** Which engine produced this result: rapfi WASM variant, 象棋神经网络, XQWLight, or the bundled JS engine */
  engine?: 'rapfi-multi' | 'rapfi-single' | 'xqnn' | 'xqwlight' | 'js' | 'go-nn' | 'go-heuristic';
  /** 围棋：访问次数 */
  visits?: number;
  /** 围棋：轮走方胜率 0~1 */
  winProb?: number;
  /** 围棋：黑方视角目差 */
  scoreLead?: number;
  /** 围棋：候选点（按访问次数排序） */
  goCandidates?: GoCandidate[];
  /** 围棋：黑视角归属（+1 黑 / -1 白，长度 size*size） */
  ownership?: Float32Array;
  /** 围棋：推理后端与网络名（界面展示） */
  backend?: string;
  modelName?: string;
}

/** Difficulty levels */
export type Difficulty = 1 | 2 | 3 | 4;

/** 象棋引擎选择：'nn' = 神经网络（默认），'classic' = XQWLight 小巫师 */
export type XqEngineKind = 'nn' | 'classic';

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

/** Worker request messages.
 *  `id` 由 AIBridge 分配并原样回带，用于把响应精确配回发起它的那次请求——
 *  否则并发请求（如「请神上身」与 AI 落子同时进行）会互相冒领结果。 */
export type WorkerRequest = (
  | { type: 'gomoku-search'; board: GomokuBoard; player: GomokuPlayer; difficulty: Difficulty; mode: GameMode; historyLength: number; moves: GomokuHistoryMove[]; forceJs?: boolean }
  | { type: 'gomoku-hint'; board: GomokuBoard; player: GomokuPlayer; mode: GameMode; historyLength: number; moves: GomokuHistoryMove[]; forceJs?: boolean }
  | { type: 'xq-search'; board: XqBoard; side: XqSide; difficulty: Difficulty; mode: GameMode; historyLength: number; engineKind?: XqEngineKind }
  | { type: 'xq-hint'; board: XqBoard; side: XqSide; mode: GameMode; historyLength: number; engineKind?: XqEngineKind }
  | { type: 'junqi-search'; board: JqBoard; side: JqSide; difficulty: Difficulty; mode: GameMode; flip: boolean; historyLength: number }
  | { type: 'junqi-hint'; board: JqBoard; side: JqSide; mode: GameMode; flip: boolean; historyLength: number }
  /** 黑白棋：board 为 64 格 Uint8Array（0 空 / 1 黑 / 2 白），side 为轮走方 */
  | { type: 'oth-search'; board: OthBoard; side: OthDisc; difficulty: Difficulty; mode: GameMode; historyLength: number }
  | { type: 'oth-hint'; board: OthBoard; side: OthDisc; mode: GameMode; historyLength: number }
  /** 围棋：求一着（level 决定访问量/时间预算；visitsOverride/timeMsOverride 给「请神上身」满配用） */
  | {
      type: 'go-search';
      position: GoPositionPayload;
      level: GoLevel;
      forceHeuristic?: boolean;
      visitsOverride?: number;
      timeMsOverride?: number;
    }
  /** 围棋：形势判断（不搜索，只要网络的胜率/目差/归属） */
  | { type: 'go-estimate'; position: GoPositionPayload }
  /** 提前唤醒 Rapfi 引擎。dataBuffer：主线程已下完的权重包，经 getPreloadedPackage 注入 */
  | { type: 'gomoku-warmup'; dataBuffer?: ArrayBuffer }
  /** 提前唤醒象棋神经网络引擎。dataBuffer：主线程已下完的 .onnx 权重 */
  | { type: 'xq-warmup'; dataBuffer?: ArrayBuffer }
  /** 提前唤醒围棋神经网络。dataBuffer：主线程已下完的权重（gzip 流） */
  | { type: 'go-warmup'; dataBuffer?: ArrayBuffer }
  | { type: 'cancel' }
) & { id?: number };

/** Worker response messages */
export type WorkerResponse =
  | { type: 'search-result'; id?: number; result: SearchResult<GomokuMove | XqMove | JqMove | GoMove | OthMove> }
  | { type: 'progress'; nodes: number }
  /** 搜索进度（围棋：已访问次数） */
  | { type: 'search-progress'; id?: number; nodes: number }
  /** 预热结果。game 用于区分是哪个项目的引擎（两个引擎各自预热）。 */
  | {
      type: 'warmup-done';
      ok: boolean;
      variant?: 'multi' | 'single';
      game?: 'gomoku' | 'xq' | 'go';
      error?: string;
      backend?: string;
      modelName?: string;
    }
  /** 引擎数据包下载进度（worker 侧上报，主线程预取时通常一闪而过） */
  | { type: 'load-progress'; loaded: number; total: number };
