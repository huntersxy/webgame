/* ────────────────────────────────────────────────────────────
 *  go/engine.ts — 围棋引擎门面：难度档、权重装载、搜索调度、兜底
 *
 *  调用链：worker → GoEngine →（GoSearcher → GoEvaluator → TF.js 模型）
 *                          └→ 失败时落到 heuristic.ts 的常识棋
 *
 *  难度档按「时间预算 + 访问上限 + 先验噪声/温度」组合：
 *  低档不是单纯少算，而是主动加大根节点探索噪声与选点温度，让
 *  简单档真的会走软手，而不是把同一手棋下得更慢。
 * ──────────────────────────────────────────────────────────── */

import { GoBoard, type GoColor } from './rules';
import { errText } from '../core/errors';
import { GoEvaluator, type GoPositionInput } from './evaluate';
import { computeLadderFeatures } from './life';
import { GoSearcher, defaultSearchOptions, type GoCandidateInfo, type GoSearchOptions } from './mcts';
import { heuristicMove, mulberry32 } from './heuristic';
import { prefetchGoModel } from './model-assets';
import type { FeatureMove } from './features';

/** 难度档：1 简单 / 2 普通 / 3 困难 / 4 恶魔 */
export type GoLevel = 1 | 2 | 3 | 4;

export interface GoLevelConfig {
  name: string;
  /** 访问次数上限 */
  visits: number;
  /** 时间预算（毫秒） */
  timeMs: number;
  /** 根节点先验噪声比例 */
  rootNoise: number;
  /** 根节点策略温度 */
  policyTemp: number;
  /** 最终选点温度 */
  moveTemp: number;
  /** 批量评估大小 */
  batch: number;
}

export const GO_LEVELS: Record<GoLevel, GoLevelConfig> = {
  1: { name: '简单', visits: 24, timeMs: 600, rootNoise: 0.30, policyTemp: 1.5, moveTemp: 1.2, batch: 4 },
  2: { name: '普通', visits: 96, timeMs: 1400, rootNoise: 0.10, policyTemp: 1.15, moveTemp: 0.6, batch: 8 },
  3: { name: '困难', visits: 320, timeMs: 3000, rootNoise: 0, policyTemp: 1, moveTemp: 0, batch: 8 },
  4: { name: '恶魔', visits: 1200, timeMs: 6000, rootNoise: 0, policyTemp: 1, moveTemp: 0, batch: 8 },
};

/** 后端能力系数：WASM/CPU 上一帧前向要几百毫秒，访问量必须大幅缩水 */
function backendScale(backend: string | null): number {
  if (backend === 'webgpu') return 1;
  if (backend === 'webgl') return 1;
  if (backend === 'wasm') return 0.35;
  if (backend === 'cpu') return 0.18;
  return 1;
}

/** 把外部传入的棋子数组统一成 Uint8Array */
function toStones(input: Uint8Array | number[]): Uint8Array {
  return input instanceof Uint8Array ? input : Uint8Array.from(input);
}

export interface GoMoveRequest {
  size: number;
  stones: Uint8Array | number[];
  koPoint: number;
  toMove: GoColor;
  komi: number;
  /** 最近若干手（时间顺序，最后一项是最近一手；move = -1 为虚手） */
  moveHistory: readonly FeatureMove[];
  level: GoLevel;
  /** 上一手 / 上上手局面（用于征子平面 15/16）；缺省则留 0 */
  prevStones?: Uint8Array | number[] | null;
  prevKoPoint?: number;
  prevPrevStones?: Uint8Array | number[] | null;
  prevPrevKoPoint?: number;
  /** 强制走兜底 AI（玩家在面板里选了「内置简单」） */
  forceHeuristic?: boolean;
  /** 覆盖访问量/时间（「请神上身」用满配） */
  visitsOverride?: number;
  timeMsOverride?: number;
  /** 随机种子（自对弈/测试可固定） */
  seed?: number;
}

export interface GoMoveResult {
  /** 落子索引；-1 = 虚手 */
  move: number;
  visits: number;
  ms: number;
  /** 轮走方胜率 0~1 */
  winProb: number;
  /** 黑方视角目差 */
  scoreLead: number;
  candidates: GoCandidateInfo[];
  /** 黑视角归属（长度 area） */
  ownership: Float32Array;
  pv: number[];
  engine: 'nn' | 'heuristic';
  backend?: string;
  modelName?: string;
}

export interface GoEstimate {
  /** 黑方胜率 */
  blackWinProb: number;
  /** 黑方视角目差 */
  blackScoreLead: number;
  blackScoreMean: number;
  /** 黑视角归属 */
  ownership: Float32Array;
}

export interface GoWarmUpResult {
  ok: boolean;
  backend?: string;
  modelName?: string;
  error?: string;
}

export interface GoEngineHooks {
  onProgress?: (visits: number) => void;
  shouldStop?: () => boolean;
}

/** 围棋引擎：常驻（在 AI Worker 里），权重只装一次 */
export class GoEngine {
  private evaluator = new GoEvaluator();
  private loadPromise: Promise<GoWarmUpResult> | null = null;
  /**
   * 搜索串行队列。评估器内部复用同一组特征缓冲（spatial / global / scratch），
   * 两次搜索并发会互相踩内存、算出垃圾着法。请神上身、求一着、AI 落子
   * 三路请求都可能叠在一起，所以在这一层统一排队。
   */
  private queue: Promise<unknown> = Promise.resolve();

  /** 把任务接到队列尾部；前一个失败也不影响后续 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  get ready(): boolean {
    return this.evaluator.ready;
  }

  get backend(): string | null {
    return this.evaluator.backend;
  }

  get modelName(): string | null {
    return this.evaluator.loadedModelName;
  }

  /**
   * 预热：优先用主线程已经下好的字节（省一次下载），否则自己取。
   * 重复调用共用同一个 Promise。
   */
  warmUp(dataBuffer?: ArrayBuffer, onProgress?: (loaded: number, total: number) => void): Promise<GoWarmUpResult> {
    if (this.evaluator.ready) {
      return Promise.resolve({ ok: true, backend: this.evaluator.backend ?? undefined, modelName: this.evaluator.loadedModelName ?? undefined });
    }
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async (): Promise<GoWarmUpResult> => {
      try {
        const bytes = dataBuffer ? new Uint8Array(dataBuffer) : new Uint8Array(await prefetchGoModel(onProgress));
        const info = await this.evaluator.loadBytes(bytes);
        return { ok: true, backend: info.backend, modelName: info.modelName };
      } catch (err) {
        const message = errText(err);
        console.error('[go] 神经网络装载失败：', err);
        // 允许下次重试
        this.loadPromise = null;
        return { ok: false, error: message };
      }
    })();
    return this.loadPromise;
  }

  /** 只做形势判断（不搜索）：给「形势判断」按钮用 */
  estimate(req: GoMoveRequest): Promise<GoEstimate | null> {
    return this.enqueue(() => this.estimateNow(req));
  }

  private async estimateNow(req: GoMoveRequest): Promise<GoEstimate | null> {
    if (!this.evaluator.ready) return null;
    const r = await this.evaluator.evaluateOne(this.buildPosition(req));
    return {
      blackWinProb: r.blackWinProb,
      blackScoreLead: r.blackScoreLead,
      blackScoreMean: r.blackScoreMean,
      ownership: r.ownership,
    };
  }

  /** 求一着 */
  findMove(req: GoMoveRequest, hooks: GoEngineHooks = {}): Promise<GoMoveResult> {
    return this.enqueue(() => this.findMoveNow(req, hooks));
  }

  private async findMoveNow(req: GoMoveRequest, hooks: GoEngineHooks = {}): Promise<GoMoveResult> {
    const started = Date.now();
    const config = GO_LEVELS[req.level] ?? GO_LEVELS[2];
    const size = req.size;

    // 兜底 AI：权重没就绪、玩家强制、或模型出错时
    const fallback = (): GoMoveResult => {
      const board = GoBoard.from(size, toStones(req.stones), req.toMove);
      board.koPoint = req.koPoint;
      const rng = mulberry32(req.seed ?? (Date.now() & 0xffff) ^ (board.stoneCount() * 2654435761));
      const move = heuristicMove(board, rng);
      return {
        move,
        visits: 0,
        ms: Date.now() - started,
        winProb: 0.5,
        scoreLead: 0,
        candidates: [],
        ownership: new Float32Array(size * size),
        pv: move >= 0 ? [move] : [],
        engine: 'heuristic',
      };
    };

    if (req.forceHeuristic || !this.evaluator.ready) return fallback();

    try {
      const scale = backendScale(this.evaluator.backend);
      const visits = Math.max(4, Math.round((req.visitsOverride ?? config.visits) * scale));
      const timeMs = req.timeMsOverride ?? Math.round(config.timeMs / (scale < 1 ? 2.2 : 1));
      const options: GoSearchOptions = {
        ...defaultSearchOptions(),
        maxVisits: visits,
        maxTimeMs: timeMs,
        batchSize: config.batch,
        rootNoise: config.rootNoise,
        rootPolicyTemperature: config.policyTemp,
        moveTemperature: config.moveTemp,
      };
      const searcher = new GoSearcher(this.evaluator, options);
      const result = await searcher.run(this.buildPosition(req), hooks);
      return {
        move: result.move,
        visits: result.visits,
        ms: result.ms,
        winProb: result.winProb,
        scoreLead: result.scoreLead,
        candidates: result.candidates,
        ownership: result.ownership,
        pv: result.pv.map((m) => (m >= size * size ? -1 : m)),
        engine: 'nn',
        backend: this.evaluator.backend ?? undefined,
        modelName: this.evaluator.loadedModelName ?? undefined,
      };
    } catch (err) {
      console.error('[go] 搜索失败，改用兜底 AI：', err);
      return fallback();
    }
  }

  /** 组装神经网络需要的局面输入（含上一手/上上手的征子掩码） */
  private buildPosition(req: GoMoveRequest): GoPositionInput {
    const size = req.size;
    const stones = req.stones instanceof Uint8Array ? req.stones : Uint8Array.from(req.stones as ArrayLike<number>);
    const recentMoves = req.moveHistory.slice(-5);

    let prevLaddered: Uint8Array | null = null;
    let prevPrevLaddered: Uint8Array | null = null;
    if (req.prevStones) {
      const prev = req.prevStones instanceof Uint8Array ? req.prevStones : Uint8Array.from(req.prevStones as ArrayLike<number>);
      // 上一手局面的轮走方是当前轮走方的对方
      const prevToMove: GoColor = req.toMove === 1 ? 2 : 1;
      prevLaddered = computeLadderFeatures(prev, size, req.prevKoPoint ?? -1, prevToMove).laddered;
      if (req.prevPrevStones) {
        const prevPrev = req.prevPrevStones instanceof Uint8Array ? req.prevPrevStones : Uint8Array.from(req.prevPrevStones as ArrayLike<number>);
        prevPrevLaddered = computeLadderFeatures(prevPrev, size, req.prevPrevKoPoint ?? -1, req.toMove).laddered;
      }
    }

    return {
      size,
      stones,
      koPoint: req.koPoint,
      toMove: req.toMove,
      recentMoves,
      komi: req.komi,
      prevLaddered,
      prevPrevLaddered,
    };
  }

  dispose(): void {
    this.evaluator.dispose();
    this.loadPromise = null;
  }
}
