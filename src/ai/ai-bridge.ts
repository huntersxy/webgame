/* ────────────────────────────────────────────────────────────
 *  ai/ai-bridge.ts — Main-thread ↔ Worker bridge with promise API
 * ──────────────────────────────────────────────────────────── */

import type { WorkerRequest, WorkerResponse, Difficulty, GameMode, SearchResult, GomokuBoard, GomokuPlayer, GomokuHistoryMove, XqBoard, XqSide, XqEngineKind, GomokuMove, XqMove, JqMove, JqBoard, JqSide, GoMove, GoPositionPayload, GoLevel, OthBoard, OthDisc, OthMove } from '../types';
import { prefetchRapfiData } from '../gomoku/rapfi-assets';
import { prefetchXqnnModel } from '../xqnn/model-assets';
import { prefetchGoModel } from '../go/model-assets';
import { prefetchEgaroucid } from '../othello/egaroucid-assets';

/** 数据包下载进度来源：主线程预取，或引擎自己的那次请求 */
export type LoadPhase = 'prefetch' | 'engine';

/** 预热结果 */
export interface WarmUpResult {
  ok: boolean;
  variant?: 'multi' | 'single';
  error?: string;
  /** 围棋：实际生效的推理后端（webgpu/webgl/wasm/cpu） */
  backend?: string;
  /** 围棋：网络名 */
  modelName?: string;
}

/** 请求被取消/worker 崩溃时回给调用方的空结果 */
const EMPTY_RESULT: SearchResult<GomokuMove | XqMove | JqMove | GoMove> = { move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] };

export class AIBridge {
  private worker: Worker | null = null;
  /** 在途请求：id → resolver。必须按 id 一一对应，不能只留「最后一个」——
   *  「请神上身」会与 AI 落子、求一着并发，单槽 resolver 会让先发的那个
   *  promise 永不 settle，后发的那个冒领前者的结果。 */
  private pending = new Map<number, (r: SearchResult<GomokuMove | XqMove | JqMove | GoMove>) => void>();
  private nextId = 0;
  /** 预热结果按项目分开挂起：三个引擎（Rapfi / 象棋神经网络 / 围棋网络）各自预热，互不冒领。 */
  private warmupResolvers = new Map<'gomoku' | 'xq' | 'go' | 'oth', (r: WarmUpResult) => void>();
  private loadProgressCb: ((loaded: number, total: number, src: LoadPhase) => void) | null = null;
  private searchProgressCb: ((id: number, nodes: number) => void) | null = null;

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'search-result') {
          // 只认回带的 id：拿不到对应在途请求的结果直接丢弃，
          // 绝不「顺延」给别的调用方。
          const resolve = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
          if (resolve && msg.id !== undefined) {
            this.pending.delete(msg.id);
            resolve(msg.result);
          }
        } else if (msg.type === 'warmup-done') {
          const key = msg.game ?? 'gomoku';
          const settle = this.warmupResolvers.get(key);
          if (settle) {
            this.warmupResolvers.delete(key);
            settle({ ok: msg.ok, variant: msg.variant, error: msg.error, backend: msg.backend, modelName: msg.modelName });
          }
        } else if (msg.type === 'load-progress') {
          this.loadProgressCb?.(msg.loaded, msg.total, 'engine');
        } else if (msg.type === 'search-progress') {
          if (msg.id !== undefined) this.searchProgressCb?.(msg.id, msg.nodes);
        }
      };
      this.worker.onerror = (e) => {
        console.error('AI Worker error:', e);
        this.failAllPending();
      };
    } catch (err) {
      console.error('Failed to create AI worker:', err);
    }
  }

  /**
   * 预热统一入口：主线程预取权重 → **完整结束**后再启动引擎。
   * @param game     'gomoku' | 'xq'，用于把结果配回对应的调用方
   * @param prefetch 主线程预取函数（URL 与引擎内部取包一致，完成后引擎应命中 HTTP 缓存）
   *
   * 不再「预取与引擎并行」：并行时浏览器常不合并同 URL 的 in-flight 请求，
   * 会变成真下两遍（象棋约 63MB），且两条进度流抢写进度条。
   * 预取失败也照常启引擎——让引擎自己再下，并改由 engine 侧 progress 驱动。
   */
  private warmUp(
    game: 'gomoku' | 'xq' | 'go' | 'oth',
    req: WorkerRequest,
    prefetch: ((cb: (loaded: number, total: number) => void) => Promise<ArrayBuffer | void>) | null,
    onProgress?: (loaded: number, total: number, src: LoadPhase) => void,
  ): Promise<WarmUpResult> {
    let shownLoaded = 0;
    let shownTotal = 0;
    const emit = (loaded: number, total: number, src: LoadPhase): void => {
      if (!total) return;
      const nextTotal = Math.max(total, shownTotal);
      const nextLoaded = Math.max(shownLoaded, Math.min(loaded, nextTotal));
      if (nextLoaded === shownLoaded && nextTotal === shownTotal) return;
      shownLoaded = nextLoaded;
      shownTotal = nextTotal;
      onProgress?.(shownLoaded, shownTotal, src);
    };
    this.loadProgressCb = onProgress ? emit : null;

    const startEngine = (dataBuffer?: ArrayBuffer): Promise<WarmUpResult> =>
      new Promise((resolve) => {
        if (!this.worker) {
          resolve({ ok: false, error: 'AI worker 未创建' });
          return;
        }
        this.warmupResolvers.set(game, resolve);
        if (dataBuffer) {
          // transfer 避免再拷一份 10~63MB；worker 再 transfer 给 classic engine-worker
          this.worker.postMessage({ ...req, dataBuffer }, [dataBuffer]);
        } else {
          this.worker.postMessage(req);
        }
      });

    if (!prefetch) return startEngine();
    return prefetch((loaded, total) => this.loadProgressCb?.(loaded, total, 'prefetch')).then(
      // Egaroucid 返回空（wasm 由 Emscripten 自己 fetch，只借预取刷缓存与进度）
      (dataBuffer) => startEngine(dataBuffer instanceof ArrayBuffer ? dataBuffer : undefined),
      () => startEngine(),
    );
  }

  /**
   * 提前唤醒 Rapfi 引擎（加载 wasm + mix9svq 权重，约 10MB）。
   * 返回 ok=false 表示会走内置 JS 引擎兜底。
   */
  warmUpGomoku(
    onProgress?: (loaded: number, total: number, src: LoadPhase) => void,
  ): Promise<WarmUpResult> {
    return this.warmUp('gomoku', { type: 'gomoku-warmup' }, prefetchRapfiData, onProgress);
  }

  /**
   * 提前唤醒象棋神经网络引擎（下载 .onnx 8.7MB + TF.js 后端初始化）。
   * 返回 ok=false 表示会走内置 JS 引擎兜底。
   */
  warmUpXq(
    onProgress?: (loaded: number, total: number, src: LoadPhase) => void,
  ): Promise<WarmUpResult> {
    return this.warmUp('xq', { type: 'xq-warmup' }, prefetchXqnnModel, onProgress);
  }

  /**
   * 提前唤醒黑白棋的 Egaroucid 引擎（约 1.4MB wasm，自包含评估表 + 开局库）。
   * 与 Rapfi 不同：wasm 由 Emscripten 自己 fetch，这里只负责「先下同 URL 刷缓存 + 进度」。
   */
  warmUpOth(
    onProgress?: (loaded: number, total: number, src: LoadPhase) => void,
  ): Promise<WarmUpResult> {
    return this.warmUp('oth', { type: 'oth-warmup' }, prefetchEgaroucid, onProgress);
  }

  /**
   * 提前唤醒围棋神经网络（约 3.8MB 权重 + TF.js 后端初始化）。
   * 返回 ok=false 表示会落到常识棋兜底引擎。
   */
  warmUpGo(
    onProgress?: (loaded: number, total: number, src: LoadPhase) => void,
  ): Promise<WarmUpResult> {
    return this.warmUp('go', { type: 'go-warmup' }, prefetchGoModel, onProgress);
  }

  private send(req: WorkerRequest): Promise<SearchResult<GomokuMove | XqMove | JqMove | GoMove>> {
    return new Promise((resolve) => {
      if (!this.worker) {
        // No worker — resolve immediately with null
        resolve(EMPTY_RESULT);
        return;
      }
      const id = ++this.nextId;
      this.pending.set(id, resolve);
      this.worker.postMessage({ ...req, id });
    });
  }

  /** 把全部在途请求以空结果落地，避免 worker 崩溃后调用方永久 await。 */
  private failAllPending(): void {
    for (const resolve of this.pending.values()) resolve(EMPTY_RESULT);
    this.pending.clear();
    for (const settle of this.warmupResolvers.values()) settle({ ok: false, error: 'AI worker 崩溃或取消' });
    this.warmupResolvers.clear();
  }

  searchGomoku(
    board: GomokuBoard,
    player: GomokuPlayer,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
    moves: GomokuHistoryMove[],
    forceJs = false,
  ): Promise<SearchResult<GomokuMove>> {
    return this.send({
      type: 'gomoku-search',
      board,
      player,
      difficulty,
      mode,
      historyLength,
      moves,
      forceJs,
    }) as Promise<SearchResult<GomokuMove>>;
  }

  hintGomoku(
    board: GomokuBoard,
    player: GomokuPlayer,
    mode: GameMode,
    historyLength: number,
    moves: GomokuHistoryMove[],
    forceJs = false,
  ): Promise<SearchResult<GomokuMove>> {
    return this.send({
      type: 'gomoku-hint',
      board,
      player,
      mode,
      historyLength,
      moves,
      forceJs,
    }) as Promise<SearchResult<GomokuMove>>;
  }

  /** 黑白棋：AI 落子（四档难度） */
  searchOth(
    board: OthBoard,
    side: OthDisc,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
    engineKind: 'builtin' | 'egar' = 'builtin',
  ): Promise<SearchResult<OthMove>> {
    return this.send({
      type: 'oth-search', board, side, difficulty, mode, historyLength, engineKind,
    }) as Promise<SearchResult<OthMove>>;
  }

  /** 黑白棋：求一着 / 请神上身（固定恶魔档配置、预算收短） */
  hintOth(
    board: OthBoard,
    side: OthDisc,
    mode: GameMode,
    historyLength: number,
    engineKind: 'builtin' | 'egar' = 'builtin',
  ): Promise<SearchResult<OthMove>> {
    return this.send({ type: 'oth-hint', board, side, mode, historyLength, engineKind }) as Promise<SearchResult<OthMove>>;
  }

  searchXq(
    board: XqBoard,
    side: XqSide,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
    engineKind: XqEngineKind = 'nn',
  ): Promise<SearchResult<XqMove>> {
    return this.send({
      type: 'xq-search',
      board,
      side,
      difficulty,
      mode,
      historyLength,
      engineKind,
    }) as Promise<SearchResult<XqMove>>;
  }

  hintXq(
    board: XqBoard,
    side: XqSide,
    mode: GameMode,
    historyLength: number,
    engineKind: XqEngineKind = 'nn',
  ): Promise<SearchResult<XqMove>> {
    return this.send({
      type: 'xq-hint',
      board,
      side,
      mode,
      historyLength,
      engineKind,
    }) as Promise<SearchResult<XqMove>>;
  }

  searchJq(
    board: JqBoard,
    side: JqSide,
    difficulty: Difficulty,
    mode: GameMode,
    flip: boolean,
    historyLength: number,
  ): Promise<SearchResult<JqMove>> {
    return this.send({
      type: 'junqi-search',
      board,
      side,
      difficulty,
      mode,
      flip,
      historyLength,
    }) as Promise<SearchResult<JqMove>>;
  }

  hintJq(
    board: JqBoard,
    side: JqSide,
    mode: GameMode,
    flip: boolean,
    historyLength: number,
  ): Promise<SearchResult<JqMove>> {
    return this.send({
      type: 'junqi-hint',
      board,
      side,
      mode,
      flip,
      historyLength,
    }) as Promise<SearchResult<JqMove>>;
  }

  /**
   * 围棋求一着。forceHeuristic = 玩家选了「内置简单」；visitsOverride /
   * timeMsOverride 用于「请神上身」这类满配搜索。
   */
  searchGo(
    position: GoPositionPayload,
    level: GoLevel,
    opts: { forceHeuristic?: boolean; visitsOverride?: number; timeMsOverride?: number; onProgress?: (visits: number) => void } = {},
  ): Promise<SearchResult<GoMove>> {
    // 交互式搜索只有一条在途：进度回调也只需要认「当前那次」
    this.searchProgressCb = opts.onProgress ? (_id, nodes) => opts.onProgress?.(nodes) : null;
    const p = this.send({
      type: 'go-search',
      position,
      level,
      forceHeuristic: opts.forceHeuristic,
      visitsOverride: opts.visitsOverride,
      timeMsOverride: opts.timeMsOverride,
    }) as Promise<SearchResult<GoMove>>;
    return p.finally(() => {
      this.searchProgressCb = null;
    });
  }

  /** 围棋形势判断（不搜索）：返回 winProb / scoreLead / ownership */
  estimateGo(position: GoPositionPayload): Promise<SearchResult<GoMove>> {
    return this.send({ type: 'go-estimate', position }) as Promise<SearchResult<GoMove>>;
  }

  cancel(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'cancel' } as WorkerRequest);
    }
    this.failAllPending();
  }

  get isBusy(): boolean {
    return this.pending.size > 0;
  }
}
