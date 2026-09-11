/* ────────────────────────────────────────────────────────────
 *  xqnn/engine.ts — 象棋神经网络引擎（worker 侧门面）
 *
 *  与 go/engine.ts 同一角色：把「选后端 → 载模型 → 搜索」封成一个对象，
 *  供 AI Worker 调用。搜索失败/未就绪时由调用方决定回退（worker.ts 里
 *  回退到内置 JS 引擎），这里只负责如实抛出。
 * ──────────────────────────────────────────────────────────── */

import type { Difficulty, GameMode, SearchResult, XqBoard, XqMove, XqSide } from '../types';
import { XqnnEvaluator, type XqnnBackend } from './evaluate';
import { XqSearcher } from './search';
import { prefetchXqnnModel, XQNN_MODEL_LABEL } from './model-assets';

export interface XqnnWarmUpResult {
  ok: boolean;
  error?: string;
  backend?: XqnnBackend;
  modelName?: string;
}

export class XqnnEngine {
  private ev = new XqnnEvaluator();
  private searcher = new XqSearcher(this.ev);
  private loading: Promise<XqnnWarmUpResult> | null = null;

  /** 已生效的推理后端（webgpu/webgl/wasm/cpu） */
  backend: XqnnBackend | null = null;
  readonly modelLabel = XQNN_MODEL_LABEL;

  get ready(): boolean {
    return this.ev.ready;
  }

  /** 已评估的局面数（日志/自检用） */
  get evals(): number {
    return this.ev.evals;
  }

  /**
   * 载入网络。dataBuffer 是主线程预取好的 .onnx 字节；没有就自己下。
   */
  warmUp(dataBuffer?: ArrayBuffer, onProgress?: (loaded: number, total: number) => void): Promise<XqnnWarmUpResult> {
    if (this.ev.ready) return Promise.resolve({ ok: true, backend: this.backend ?? undefined, modelName: this.modelLabel });
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const bytes = dataBuffer ?? (await prefetchXqnnModel(onProgress));
        const { backend } = await this.ev.load(bytes);
        this.backend = backend;
        return { ok: true, backend, modelName: this.modelLabel };
      } catch (err) {
        console.error('[xqnn] 网络载入失败：', err);
        return { ok: false, error: String((err && (err as Error).message) || err) };
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** 求一着。未就绪会直接抛错，由 worker 决定是否回退内置引擎。 */
  async findMove(
    board: XqBoard,
    side: XqSide,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength = 0,
  ): Promise<SearchResult<XqMove>> {
    if (!this.ev.ready) throw new Error('象棋神经网络尚未就绪');
    const res = await this.searcher.search(board, side, difficulty, mode, historyLength);
    return { ...res, backend: this.backend ?? undefined };
  }

  dispose(): void {
    this.ev.dispose();
  }
}
