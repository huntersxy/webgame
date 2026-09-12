/* ────────────────────────────────────────────────────────────
 *  othello/egaroucid.ts — Egaroucid（GPL-3.0）引擎客户端
 *
 *  真身在 public/egaroucid/engine-worker.js 的独立 **module** worker 里，
 *  这里只负责发请求与合法性校验；worker 生命周期与超时兜底见
 *  core/worker-engine.ts。未就绪或出错时一律回落到内置 JS 引擎（调用方传进来的
 *  fallback）。
 * ──────────────────────────────────────────────────────────── */

import type { OthBoard, OthDisc, Difficulty, GameMode, OthMove, SearchResult } from '../types';
import { legalMoves, place } from './rules';
import type { OthPosition } from './rules';
import { EGAROUCID_ASSET_VERSION, EGAROUCID_LEVELS } from './egaroucid-assets';
import { WorkerEngine, type EngineMessage } from '../core/worker-engine';

interface Reply {
  move: number | null;
  /** 引擎原始坐标（file 0..7，rank 1..8）；着法映射以此为准 */
  coord?: { file: number; rank: number };
  eval: number;
  ms: number;
  book: boolean;
  /** 诊断用：worker 侧收到的棋盘摘要 + 引擎自己打印的日志尾部 */
  debug?: string;
}

type EgarMsg = EngineMessage & {
  memMB?: number;
  move?: number;
  coord?: { file: number; rank: number };
  eval?: number;
  ms?: number;
  book?: boolean;
  debug?: string;
};

export class EgaroucidEngine extends WorkerEngine<Reply, EgarMsg> {
  protected readonly label = '[egaroucid]';
  /** 首次加载要下 1.4MB wasm + 初始化评估表/开局库，给足时间 */
  protected readonly readyTimeoutMs = 30_000;
  /** egar.js 是 ES module，必须按 module worker 起 */
  protected readonly workerType = 'module';

  /** 引擎实际声明/增长到的内存（MB），供界面展示 */
  memMB: number | null = null;

  protected workerUrl(): string {
    const base = import.meta.env.BASE_URL || '/';
    // 必须是 **module** worker：egar.js 内部用 import.meta.url 找同目录的
    // egar.wasm（见 engine-worker.js 顶部说明）。
    return new URL(base + 'egaroucid/engine-worker.js?v=' + EGAROUCID_ASSET_VERSION, self.location.href).href;
  }

  protected initMessage(): { message: unknown } {
    return { message: { type: 'init' } };
  }

  protected emptyReply(): Reply {
    return { move: null, eval: 0, ms: 0, book: false };
  }

  protected onReadyMessage(msg: EgarMsg): void {
    this.memMB = msg.memMB ?? null;
    console.info(`[egaroucid] 引擎就绪（wasm 内存 ${this.memMB ?? '?'}MB）`);
  }

  protected onEngineMessage(msg: EgarMsg): void {
    if (msg.type !== 'result') return;
    this.settle(msg.id, {
      move: msg.move ?? null,
      eval: msg.eval ?? 0,
      ms: msg.ms ?? 0,
      book: !!msg.book,
      debug: msg.debug,
    });
  }

  protected quitMessage(): unknown {
    return { type: 'quit' };
  }

  /** 起 worker 并等就绪。已就绪时返回同一个 promise。 */
  warmUp(): Promise<void> {
    return this.start();
  }

  /**
   * 求一着。fallback：未就绪/失败时的兜底（内置 JS 引擎）。
   * levelOverride 用于「求一着 / 请神上身」走中上强度档位。
   */
  async findMove(
    cells: OthBoard,
    side: OthDisc,
    difficulty: Difficulty,
    mode: GameMode,
    fallback: () => SearchResult<OthMove>,
    levelOverride?: number,
  ): Promise<SearchResult<OthMove>> {
    if (this.isDisabled) return fallback();
    if (!this.ready) {
      // 加载中不要卡住这一手：先让内置引擎立刻应手，加载在后台继续
      void this.warmUp().catch(() => undefined);
      return fallback();
    }

    const level = levelOverride ?? EGAROUCID_LEVELS[difficulty];
    const legal = legalMoves({ ...cellsToPos(cells, side) });
    if (!legal.length) return fallback();

    // AI 互搏时抖一点档位，避免每局一模一样
    const jitter = mode === 'aivai' ? (Math.random() < 0.5 ? 0 : 1) : 0;
    const useLevel = Math.min(60, level + jitter);

    const reply = await this.request({ type: 'go', board: cells, aiPlayer: side, level: useLevel }, 60_000);
    if (reply.move == null) return fallback();

    // 引擎坐标 → 我们的索引：恒等映射（「真相矩阵」实验：16/16 命中）。
    // 若上游坐标缺省，退回已算好的 move 字段。
    const idx = reply.coord ? (((8 - reply.coord.rank) * 8 + reply.coord.file) | 0) : reply.move;
    const mapped = legal.includes(idx) ? idx : mapBySymmetry(idx, legal);
    if (mapped == null) {
      console.warn('[egaroucid] 引擎着法经对称映射后仍不合法，回退内置引擎：', idx);
      this.noteFailure();
      return fallback();
    }
    this.noteSuccess();

    const pt = ptFromIndex(idx);
    return {
      move: { ...pt, v: reply.eval, f: flipCount(cells, side, idx) },
      depth: useLevel,
      nodes: 0,
      ms: reply.ms,
      eval: reply.eval,
      scores: [{ ...pt, v: reply.eval }],
      book: reply.book,
      engine: 'egaroucid',
    };
  }
}

/** 64 格数组 → 位棋盘（本模块自用的小工具，避免依赖 search.ts） */
function cellsToPos(cells: OthBoard, side: OthDisc): OthPosition {
  let bl = 0, bh = 0, wl = 0, wh = 0;
  for (let i = 0; i < 64; i++) {
    const v = cells[i];
    if (!v) continue;
    const sh = i < 32 ? i : i - 32;
    if (i < 32) {
      if (v === 1) bl = (bl | (1 << sh)) >>> 0;
      else wl = (wl | (1 << sh)) >>> 0;
    } else {
      if (v === 1) bh = (bh | (1 << sh)) >>> 0;
      else wh = (wh | (1 << sh)) >>> 0;
    }
  }
  return { black: [bl >>> 0, bh >>> 0], white: [wl >>> 0, wh >>> 0], side };
}

/**
 * 把引擎的索引按八种正交对称变换映射回我们的坐标，返回第一个落在合法点集合中的结果。
 *
 * 为什么需要它：实测定标显示引擎的坐标与我们的棋盘相差一个固定对称变换，
 * 但不同局面下光照条件一致、变换也一致；用「映射后是否合法」来选定变换，
 * 既避免把变换写死，也能在上下文中自愈（非法即试下一个）。
 */
function mapBySymmetry(index: number, legal: number[]): number | null {
  const r = index >> 3;
  const f = index & 7;
  const cands = [
    [r, f], [r, 7 - f], [7 - r, f], [7 - r, 7 - f],
    [f, r], [f, 7 - r], [7 - f, r], [7 - f, 7 - r],
  ];
  for (const [rr, ff] of cands) {
    const i = rr * 8 + ff;
    if (legal.includes(i)) return i;
  }
  return null;
}

/** 格索引 → 界面坐标（y=0 是棋谱第 1 行） */
function ptFromIndex(index: number): { x: number; y: number } {
  return { x: index & 7, y: 7 - (index >> 3) };
}

/** 这一手翻掉多少子（界面播报用） */
function flipCount(cells: OthBoard, side: OthDisc, index: number): number {
  const pl = place(cellsToPos(cells, side), index);
  return pl ? pl.flipped : 0;
}
