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
 *  回退到内置 JS 引擎，绝不把非法着法交给控制器。worker 生命周期与超时
 *  兜底见 core/worker-engine.ts。
 * ──────────────────────────────────────────────────────────── */

import type { Difficulty, GameMode, SearchResult, XqBoard, XqMove, XqSide } from '../types';
import { boardToFen, uciToXqMove } from './fen';
import { legalMoves } from './rules';
import { WorkerEngine, type EngineMessage } from '../core/worker-engine';

/** 资源修订号：改了 public/xqwlight/ 下任何文件才递增 */
export const XQWLIGHT_ASSET_VERSION = 'a1';

/** 难度档：depth 是迭代加深的上限，millis 是真正的时限（引擎自己控时）。
 *  恶魔档给足预算（6s）；「求一着」提示用 millisOverride 压到短预算。 */
export const XQWLIGHT_LEVELS: Record<Difficulty, { depth: number; millis: number }> = {
  1: { depth: 4, millis: 150 },
  2: { depth: 8, millis: 450 },
  3: { depth: 14, millis: 1200 },
  4: { depth: 64, millis: 6000 },
};

interface BestMoveReply {
  iccs: string | null;
  nodes: number;
  ms: number;
  book: boolean;
}

type XqEngineMsg = EngineMessage & { iccs?: string | null; nodes?: number; ms?: number; book?: boolean };

export class XqWLightEngine extends WorkerEngine<BestMoveReply, XqEngineMsg> {
  protected readonly label = '[xqwlight]';
  protected readonly readyTimeoutMs = 20_000;

  protected workerUrl(): string {
    const base = import.meta.env.BASE_URL || '/';
    return new URL(base + 'xqwlight/engine-worker.js?v=' + XQWLIGHT_ASSET_VERSION, self.location.href).href;
  }

  protected initMessage(): { message: unknown } {
    return { message: { type: 'init' } };
  }

  protected emptyReply(): BestMoveReply {
    return { iccs: null, nodes: 0, ms: 0, book: false };
  }

  protected onEngineMessage(msg: XqEngineMsg): void {
    if (msg.type !== 'bestmove') return;
    this.settle(msg.id, { iccs: msg.iccs ?? null, nodes: msg.nodes ?? 0, ms: msg.ms ?? 0, book: !!msg.book });
  }

  /** 起 worker 并等就绪。已就绪时返回同一个 promise。 */
  warmUp(): Promise<void> {
    return this.start();
  }

  /**
   * 求一着。fallback 用于未就绪/失败时的兜底（内置 JS 引擎）。
   * millisOverride 覆盖该档位的思考时限（「求一着」提示走短预算）。
   */
  async findMove(
    board: XqBoard,
    side: XqSide,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
    fallback: () => SearchResult<XqMove>,
    millisOverride?: number,
  ): Promise<SearchResult<XqMove>> {
    void historyLength;
    if (this.isDisabled) return fallback();
    if (!this.ready) {
      // 加载中不要卡住这一手：先让兜底引擎立刻应手，加载在后台继续
      void this.warmUp().catch(() => undefined);
      return fallback();
    }

    const cfg = XQWLIGHT_LEVELS[difficulty];
    // AI 互搏时抖一点思考时间，避免每局一模一样
    const jitter = mode === 'aivai' ? 0.85 + Math.random() * 0.3 : 1;
    const millis = Math.round((millisOverride ?? cfg.millis) * jitter);
    const legal = legalMoves(board, side);

    const reply = await this.request(
      { type: 'go', fen: boardToFen(board, side), depth: cfg.depth, millis },
      millis + 6000,
    );
    if (!reply.iccs) {
      // 引擎没给出着法（长将判负局面等）：用兜底引擎，不计入失败
      return fallback();
    }

    const mv = uciToXqMove(reply.iccs.replace('-', '').toLowerCase(), board);
    const ok = mv && legal.some((m) => m.fx === mv.fx && m.fy === mv.fy && m.tx === mv.tx && m.ty === mv.ty);
    if (!ok) {
      console.warn('[xqwlight] 引擎给了不合法的着法：', reply.iccs);
      this.noteFailure();
      return fallback();
    }

    this.noteSuccess();
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
  }
}
