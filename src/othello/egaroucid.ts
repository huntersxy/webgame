/* ────────────────────────────────────────────────────────────
 *  othello/egaroucid.ts — Egaroucid（GPL-3.0）引擎客户端
 *
 *  与 xiangqi/xqwlight.ts 同一套路：真身在 public/egaroucid/engine-worker.js
 *  的独立 worker 里，这里只负责起 worker、发请求、超时兜底与合法性校验。
 *  未就绪或出错时一律回落到内置 JS 引擎（调用方传进来的 fallback）。
 * ──────────────────────────────────────────────────────────── */

import type { OthBoard, OthDisc, Difficulty, GameMode, OthMove, SearchResult } from '../types';
import { legalMoves, place } from './rules';
import type { OthPosition } from './rules';
import { EGAROUCID_ASSET_VERSION, EGAROUCID_HINT_LEVEL, EGAROUCID_LEVELS } from './egaroucid-assets';

type EngineMsg =
  | { type: 'ready'; memMB?: number }
  | { type: 'result'; id?: number; move: number; coord?: { file: number; rank: number }; eval: number; ms: number; book: boolean }
  | { type: 'error'; id?: number; data: string };

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

export class EgaroucidEngine {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly pending = new Map<number, (r: Reply) => void>();
  private nextId = 0;
  private failures = 0;
  /** 连续失败后不再重试，直接走内置引擎 */
  private disabled = false;
  ready = false;
  /** 引擎实际声明/增长到的内存（MB），供界面展示 */
  memMB: number | null = null;

  static isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  /** 起 worker 并等就绪。已就绪时返回同一个 promise。 */
  warmUp(): Promise<void> {
    if (this.disabled) return Promise.reject(new Error('Egaroucid 已停用'));
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let w: Worker;
      try {
        const base = import.meta.env.BASE_URL || '/';
        // 必须是 **module** worker：egar.js 是 ES module，内部用 import.meta.url
        // 找同目录的 egar.wasm（见 engine-worker.js 顶部说明）。
        w = new Worker(
          new URL(base + 'egaroucid/engine-worker.js?v=' + EGAROUCID_ASSET_VERSION, self.location.href).href,
          { type: 'module' },
        );
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // 首次加载要下 1.4MB wasm + 初始化评估表/开局库，给足时间
      const timer = setTimeout(() => fail(new Error('Egaroucid 初始化超时')), 30_000);
      const fail = (err: Error): void => {
        clearTimeout(timer);
        this.readyPromise = null;
        this.worker?.terminate();
        this.worker = null;
        reject(err);
      };
      w.onmessage = (e: MessageEvent<EngineMsg>) => {
        if (this.worker !== w) return;
        const msg = e.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          this.ready = true;
          this.memMB = msg.memMB ?? null;
          console.info(`[egaroucid] 引擎就绪（wasm 内存 ${this.memMB ?? '?'}MB）`);
          resolve();
          return;
        }
        if (msg.type === 'result') {
          const cb = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
          if (cb && msg.id !== undefined) {
            this.pending.delete(msg.id);
            cb({ move: msg.move, eval: msg.eval, ms: msg.ms, book: msg.book, debug: (msg as unknown as { debug?: string }).debug });
          }
          return;
        }
        if (msg.type === 'error') {
          console.error('[egaroucid] 引擎报错：', msg.data);
          if (!this.ready) fail(new Error(String(msg.data)));
          else this.markDead(String(msg.data));
        }
      };
      w.onerror = (e) => {
        if (this.worker !== w) return;
        const err = new Error('egaroucid worker error: ' + (e.message || 'unknown'));
        if (!this.ready) fail(err);
        else this.markDead(err.message);
      };
      this.worker = w;
      w.postMessage({ type: 'init' });
    });
    return this.readyPromise;
  }

  private markDead(why: string): void {
    console.warn(`[egaroucid] 引擎停止：${why}`);
    this.readyPromise = null;
    this.ready = false;
    this.worker?.terminate();
    this.worker = null;
    for (const cb of this.pending.values()) cb({ move: null, eval: 0, ms: 0, book: false });
    this.pending.clear();
  }

  private go(cells: OthBoard, side: OthDisc, level: number, timeoutMs: number): Promise<Reply> {
    return new Promise<Reply>((resolve) => {
      if (!this.worker) {
        resolve({ move: null, eval: 0, ms: 0, book: false });
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ move: null, eval: 0, ms: 0, book: false });
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.worker.postMessage({ type: 'go', id, board: cells, aiPlayer: side, level });
    });
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
    if (this.disabled) return fallback();
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

    try {
      const reply = await this.go(cells, side, useLevel, 60_000);
      if (reply.move == null) return fallback();
      // 引擎坐标 → 我们的索引：恒等映射（「真相矩阵」实验：16/16 命中）。
      // 若上游坐标缺省，退回已算好的 move 字段。
      const raw = reply.coord
        ? (((8 - reply.coord.rank) * 8 + reply.coord.file) | 0)
        : reply.move;
      const idx = raw;
      const mapped = legal.includes(idx) ? idx : mapBySymmetry(idx, legal);
      if (mapped == null) {
        console.warn('[egaroucid] 引擎着法经对称映射后仍不合法，回退内置引擎：', idx);
        this.failures++;
        if (this.failures >= 2) this.disabled = true;
        return fallback();
      }
      this.failures = 0;
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
    } catch (err) {
      console.warn('[egaroucid] 搜索异常，回退内置引擎：', err);
      this.failures++;
      if (this.failures >= 2) this.disabled = true;
      return fallback();
    }
  }

  /** 提示：固定用中上档位 */
  hintLevel(): number {
    return EGAROUCID_HINT_LEVEL;
  }

  dispose(): void {
    this.worker?.postMessage({ type: 'quit' });
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.readyPromise = null;
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
