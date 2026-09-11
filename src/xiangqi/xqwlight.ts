/* ────────────────────────────────────────────────────────────
 *  xiangqi/xqwlight.ts — XQWLight（象棋小巫师）引擎客户端
 *
 *  与象棋神经网络引擎（src/xqnn/）的角色相同（把「一个外部引擎」接成本项目的
 *  SearchResult），但内部完全不同：
 *
 *   · XQWLight 是**纯 JS**，由 public/xqwlight/engine-worker.js 这个
 *     classic worker 用 importScripts 加载（GPL 代码不进主包）。
 *   · 它不需要阻塞式 stdin，也不需要 SharedArrayBuffer/COOP-COEP：
 *     一问一答（fromFen → searchMain）就能拿到着法。
 *   · 它自带 96KB 开局库，开局瞬间出着法。
 *
 *  任何环节不可用（worker 起不来 / 引擎报错 / 给不出合法着法）都会
 *  回退到内置 JS 引擎，绝不把非法着法交给控制器。
 * ──────────────────────────────────────────────────────────── */

import type { Difficulty, GameMode, SearchResult, XqBoard, XqMove, XqSide } from '../types';
import { boardToFen, uciToXqMove } from './fen';
import { legalMoves } from './rules';

/** 资源修订号：改了 public/xqwlight/ 下任何文件才递增 */
export const XQWLIGHT_ASSET_VERSION = 'a1';

/** 难度档：depth 是迭代加深的上限，millis 是真正的时限（引擎自己控时） */
export const XQWLIGHT_LEVELS: Record<Difficulty, { depth: number; millis: number }> = {
  1: { depth: 4, millis: 150 },
  2: { depth: 8, millis: 450 },
  3: { depth: 14, millis: 1200 },
  4: { depth: 64, millis: 2800 },
};

interface BestMoveReply {
  iccs: string | null;
  nodes: number;
  ms: number;
  book: boolean;
}

type EngineMsg =
  | { type: 'ready' }
  | ({ type: 'bestmove'; id?: number } & BestMoveReply)
  | { type: 'error'; id?: number; data: string };

export class XqWLightEngine {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly pending = new Map<number, (r: BestMoveReply) => void>();
  private nextId = 0;
  private failures = 0;
  /** 连续失败后不再重试，直接走内置引擎 */
  private disabled = false;
  ready = false;

  static isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  /** 起 worker 并等就绪。已就绪时直接返回同一个 promise。 */
  warmUp(): Promise<void> {
    if (this.disabled) return Promise.reject(new Error('XQWLight 已停用'));
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let w: Worker;
      try {
        const base = import.meta.env.BASE_URL || '/';
        w = new Worker(new URL(base + 'xqwlight/engine-worker.js?v=' + XQWLIGHT_ASSET_VERSION, self.location.href).href);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const timer = setTimeout(() => {
        fail(new Error('XQWLight 初始化超时'));
      }, 20_000);
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
          resolve();
          return;
        }
        if (msg.type === 'bestmove') {
          const cb = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
          if (cb && msg.id !== undefined) {
            this.pending.delete(msg.id);
            cb({ iccs: msg.iccs, nodes: msg.nodes, ms: msg.ms, book: !!msg.book });
          }
          return;
        }
        if (msg.type === 'error') {
          console.error('[xqwlight] 引擎报错：', msg.data);
          if (!this.ready) fail(new Error(String(msg.data)));
          else this.markDead(String(msg.data));
        }
      };
      w.onerror = (e) => {
        if (this.worker !== w) return;
        const err = new Error('xqwlight worker error: ' + (e.message || 'unknown'));
        if (!this.ready) fail(err);
        else this.markDead(err.message);
      };
      this.worker = w;
      w.postMessage({ type: 'init' });
    });
    return this.readyPromise;
  }

  private markDead(why: string): void {
    console.warn(`[xqwlight] 引擎停止：${why}`);
    this.readyPromise = null;
    this.ready = false;
    this.worker?.terminate();
    this.worker = null;
    for (const cb of this.pending.values()) cb({ iccs: null, nodes: 0, ms: 0, book: false });
    this.pending.clear();
  }

  private go(fen: string, depth: number, millis: number, timeoutMs: number): Promise<BestMoveReply> {
    return new Promise<BestMoveReply>((resolve) => {
      if (!this.worker) {
        resolve({ iccs: null, nodes: 0, ms: 0, book: false });
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ iccs: null, nodes: 0, ms: 0, book: false });
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.worker.postMessage({ type: 'go', id, fen, depth, millis });
    });
  }

  /**
   * 求一着。fallback 用于未就绪/失败时的兜底（内置 JS 引擎）。
   */
  async findMove(
    board: XqBoard,
    side: XqSide,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
    fallback: () => SearchResult<XqMove>,
  ): Promise<SearchResult<XqMove>> {
    void historyLength;
    if (this.disabled) return fallback();
    if (!this.ready) {
      // 加载中不要卡住这一手：先让兜底引擎立刻应手，加载在后台继续
      void this.warmUp().catch(() => undefined);
      return fallback();
    }

    const cfg = XQWLIGHT_LEVELS[difficulty];
    // AI 互搏时抖一点思考时间，避免每局一模一样
    const jitter = mode === 'aivai' ? 0.85 + Math.random() * 0.3 : 1;
    const millis = Math.round(cfg.millis * jitter);
    const legal = legalMoves(board, side);

    try {
      const reply = await this.go(boardToFen(board, side), cfg.depth, millis, millis + 6000);
      if (!reply.iccs) {
        // 引擎没给出着法（长将判负局面等）：用兜底引擎，不计入失败
        return fallback();
      }
      const mv = uciToXqMove(reply.iccs.replace('-', '').toLowerCase(), board);
      const ok = mv && legal.some((m) => m.fx === mv.fx && m.fy === mv.fy && m.tx === mv.tx && m.ty === mv.ty);
      if (!ok) {
        console.warn('[xqwlight] 引擎给了不合法的着法：', reply.iccs);
        this.failures++;
        if (this.failures >= 2) this.disabled = true;
        return fallback();
      }
      this.failures = 0;
      return {
        move: mv,
        depth: cfg.depth,
        nodes: reply.nodes,
        ms: reply.ms,
        eval: 0,
        scores: [{ ...mv, v: 0 }],
        pv: [mv],
        engine: 'xqwlight',
        book: reply.book,
      };
    } catch (err) {
      console.warn('[xqwlight] 搜索失败，回退内置引擎：', err);
      this.failures++;
      if (this.failures >= 2) {
        this.disabled = true;
        console.warn('[xqwlight] 连续失败，本局改用内置 JS 引擎（刷新页面可重试）');
      }
      return fallback();
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.readyPromise = null;
  }
}
