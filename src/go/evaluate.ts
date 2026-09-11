/* ────────────────────────────────────────────────────────────
 *  go/evaluate.ts — 围棋神经网络评估器
 *
 *  职责：选后端 → 载入/解压权重 → 批量前向 → 后处理成搜索要用的量。
 *
 *  后端降级链：WebGPU → WebGL → WASM(SIMD) → CPU。
 *  为什么这么排：这个网络 9 路一次前向约 0.9 亿次乘加，纯 CPU/WASM
 *  跑一次要几百毫秒，只有 GPU 后端才谈得上「MCTS 每手几十上百次评估」。
 *  后两个后端仅作兜底（能在无 GPU 环境下出棋，但建议只用低访问量档）。
 *
 *  批处理：MCTS 每轮把若干叶子一起送来，一次前向算完再统一下发，
 *  这样 GPU 才不会被单样本小批次拖死。
 * ──────────────────────────────────────────────────────────── */

import * as tf from '@tensorflow/tfjs-core';
import { parseGoModel } from './model';
import { GoTfModel } from './tf-model';
import { NUM_GLOBAL_PLANES, NUM_SPATIAL_PLANES, createFeatureScratch, fillFeatures, type FeatureMove, type FeatureScratch } from './features';
import { goWasmPathPrefix } from './model-assets';
import type { GoColor } from './rules';

/** 可选后端 */
export type GoBackend = 'webgpu' | 'webgl' | 'wasm' | 'cpu';

/** 一次评估的输入（一个局面） */
export interface GoPositionInput {
  size: number;
  /** 棋子：0 空 1 黑 2 白 */
  stones: Uint8Array;
  /** 劫禁着点，-1 无 */
  koPoint: number;
  /** 轮走方 */
  toMove: GoColor;
  /** 最近若干手（时间顺序，最后一项是最近一手） */
  recentMoves: readonly FeatureMove[];
  komi: number;
  /** 上一手 / 上上手局面的征子掩码（KataGo v7 平面 15/16） */
  prevLaddered?: Uint8Array | null;
  prevPrevLaddered?: Uint8Array | null;
  /**
   * 可选：把本局面的征子掩码写到这里（搜索用它给子节点填平面 15）。
   * 只在同线程内使用，不参与结构化克隆。
   */
  ladderedOut?: Uint8Array | null;
}

/** 一次评估的输出 */
export interface GoNNResult {
  /** 原始策略 logits，长度 area+1（末位是虚手） */
  policyLogits: Float32Array;
  /** 黑方胜率 0..1 */
  blackWinProb: number;
  /** 黑方领先目数（≈ 盘面差 + 贴目） */
  blackScoreLead: number;
  blackScoreMean: number;
  blackScoreStdev: number;
  blackNoResultProb: number;
  /** 黑视角归属，长度 area（+1 黑 / -1 白） */
  ownership: Float32Array;
}

/** 单批最大样本数：太大反而会因为显存/纹理尺寸限制变慢 */
const MAX_BATCH = 8;

/* ── gzip 解压 ── */
export async function maybeGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return bytes;
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!Ctor) throw new Error('当前浏览器不支持 DecompressionStream，无法解压围棋权重');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Ctor('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/* ── 后端选择 ── */
async function tryBackend(name: GoBackend): Promise<boolean> {
  try {
    if (name === 'webgpu') {
      if (!(navigator as { gpu?: unknown }).gpu) return false;
      await import('@tensorflow/tfjs-backend-webgpu');
    } else if (name === 'webgl') {
      await import('@tensorflow/tfjs-backend-webgl');
    } else if (name === 'wasm') {
      const mod = await import('@tensorflow/tfjs-backend-wasm');
      mod.setWasmPaths(goWasmPathPrefix());
    } else {
      await import('@tensorflow/tfjs-backend-cpu');
    }
    await tf.setBackend(name);
    await tf.ready();
    return tf.getBackend() === name;
  } catch (err) {
    console.warn(`[go] ${name} 后端不可用：`, err);
    return false;
  }
}

/** 依次尝试后端，返回真正生效的后端名 */
export async function selectGoBackend(preferred?: GoBackend): Promise<GoBackend> {
  const order: GoBackend[] = preferred
    ? [preferred, ...(['webgpu', 'webgl', 'wasm', 'cpu'] as GoBackend[]).filter((b) => b !== preferred)]
    : ['webgpu', 'webgl', 'wasm', 'cpu'];
  for (const name of order) {
    if (await tryBackend(name)) return name;
  }
  throw new Error('没有可用的 TF.js 后端');
}

/* ── 价值头后处理（KataGo nneval 口径：默认系数 20 / 40） ── */
const softplus = (x: number): number => {
  if (x > 20) return x;
  if (x < -20) return Math.exp(x);
  return Math.log1p(Math.exp(x));
};

export interface ValuePostProcess {
  blackWinProb: number;
  blackScoreLead: number;
  blackScoreMean: number;
  blackScoreStdev: number;
  blackNoResultProb: number;
}

/** 把网络输出（轮走方视角）换算成黑方视角的胜率与目差 */
export function postprocessValue(toMove: GoColor, valueLogits: ArrayLike<number>, scoreValue: ArrayLike<number>): ValuePostProcess {
  const winLogit = valueLogits[0];
  const lossLogit = valueLogits[1];
  const noResultLogit = valueLogits[2];
  const maxLogit = Math.max(winLogit, lossLogit, noResultLogit);
  let winProb = Math.exp(winLogit - maxLogit);
  let lossProb = Math.exp(lossLogit - maxLogit);
  const noResultProb = Math.exp(noResultLogit - maxLogit);
  const sum = winProb + lossProb + noResultProb;
  winProb /= sum;
  lossProb /= sum;
  const nr = noResultProb / sum;

  const scoreMeanMultiplier = 20;
  const scoreStdevMultiplier = 20;
  const leadMultiplier = 20;

  let scoreMean = scoreValue[0] * scoreMeanMultiplier;
  const scoreStdev = softplus(scoreValue[1]) * scoreStdevMultiplier;
  const scoreMeanSq = scoreMean * scoreMean + scoreStdev * scoreStdev;
  let lead = scoreValue[2] * leadMultiplier;

  // 与「无结果」解耦
  scoreMean *= 1 - nr;
  lead *= 1 - nr;

  const blackWinProb = toMove === 1 ? winProb : lossProb;
  const blackScoreLead = toMove === 1 ? lead : -lead;
  const blackScoreMean = toMove === 1 ? scoreMean : -scoreMean;
  const stdev = Math.sqrt(Math.max(0, scoreMeanSq * (1 - nr) - scoreMean * scoreMean));

  return {
    blackWinProb,
    blackScoreLead,
    blackScoreMean,
    blackScoreStdev: stdev,
    blackNoResultProb: nr,
  };
}

/**
 * 策略 logits → 概率（只保留合法着法 + 虚手，其余置 0）。
 * @param legal 长度 area 的合法掩码（1 合法），null 表示不掩码
 */
export function policyFromLogits(logits: Float32Array, area: number, legal?: Uint8Array | null): Float32Array {
  const out = new Float32Array(area + 1);
  let max = -Infinity;
  for (let i = 0; i < area; i++) {
    if (legal && !legal[i]) continue;
    if (logits[i] > max) max = logits[i];
  }
  if (logits[area] > max) max = logits[area];
  if (!Number.isFinite(max)) {
    // 没有合法点（理论上只剩虚手）→ 全部给虚手
    out[area] = 1;
    return out;
  }
  let sum = 0;
  for (let i = 0; i < area; i++) {
    if (legal && !legal[i]) continue;
    const v = Math.exp(logits[i] - max);
    out[i] = v;
    sum += v;
  }
  const passV = Math.exp(logits[area] - max);
  out[area] = passV;
  sum += passV;
  if (sum > 0) for (let i = 0; i <= area; i++) out[i] /= sum;
  return out;
}

/** 评估器：持有 TF.js 模型与特征缓冲，供 Worker 常驻复用 */
export class GoEvaluator {
  private net: GoTfModel | null = null;
  private backendName: string | null = null;
  private modelName: string | null = null;
  private scratch: FeatureScratch | null = null;
  private spatial: Float32Array | null = null;
  private global: Float32Array | null = null;
  private bufferedSize = 0;

  get ready(): boolean {
    return this.net !== null;
  }

  get backend(): string | null {
    return this.backendName;
  }

  get loadedModelName(): string | null {
    return this.modelName;
  }

  /** 载入权重（已 gunzip 的字节）并预热一次前向 */
  async load(bytes: Uint8Array, preferredBackend?: GoBackend): Promise<{ backend: string; modelName: string }> {
    this.backendName = await selectGoBackend(preferredBackend);
    const parsed = parseGoModel(bytes);
    this.net = new GoTfModel(parsed);
    this.modelName = parsed.modelName;
    // 预热：让小后端把着色器/内核先编好，第一手棋不至于卡住
    const warm = new Uint8Array(81);
    await this.evaluate([{ size: 9, stones: warm, koPoint: -1, toMove: 1, recentMoves: [], komi: 7 }]);
    return { backend: this.backendName, modelName: parsed.modelName };
  }

  /** 载入权重（网络字节，自动按需解压） */
  async loadBytes(bytes: Uint8Array, preferredBackend?: GoBackend): Promise<{ backend: string; modelName: string }> {
    return this.load(await maybeGunzip(bytes), preferredBackend);
  }

  private ensureBuffers(size: number, batch: number): void {
    const area = size * size;
    if (!this.scratch || this.scratch.size !== size) this.scratch = createFeatureScratch(size);
    const spatialLen = batch * area * NUM_SPATIAL_PLANES;
    const globalLen = batch * NUM_GLOBAL_PLANES;
    if (!this.spatial || this.spatial.length < spatialLen) this.spatial = new Float32Array(spatialLen);
    if (!this.global || this.global.length < globalLen) this.global = new Float32Array(globalLen);
    this.bufferedSize = size;
  }

  /**
   * 批量评估。要求同一批局面棋盘尺寸一致（MCTS 天然满足）。
   */
  async evaluate(positions: GoPositionInput[]): Promise<GoNNResult[]> {
    const net = this.net;
    if (!net) throw new Error('围棋模型尚未加载');
    if (positions.length === 0) return [];
    const size = positions[0].size;
    const area = size * size;
    const results: GoNNResult[] = [];

    for (let start = 0; start < positions.length; start += MAX_BATCH) {
      const batch = positions.slice(start, start + MAX_BATCH);
      this.ensureBuffers(size, batch.length);
      const spatial = this.spatial!;
      const global = this.global!;
      for (let i = 0; i < batch.length; i++) {
        const p = batch[i];
        // 特征直接写进大缓冲的第 i 段
        const spatialOffset = i * area * NUM_SPATIAL_PLANES;
        const globalOffset = i * NUM_GLOBAL_PLANES;
        fillFeatures({
          size: p.size,
          stones: p.stones,
          koPoint: p.koPoint,
          toMove: p.toMove,
          recentMoves: p.recentMoves,
          komi: p.komi,
          prevLaddered: p.prevLaddered,
          prevPrevLaddered: p.prevPrevLaddered,
          ladderedOut: p.ladderedOut,
          outSpatial: spatial.subarray(spatialOffset, spatialOffset + area * NUM_SPATIAL_PLANES),
          outGlobal: global.subarray(globalOffset, globalOffset + NUM_GLOBAL_PLANES),
          scratch: this.scratch ?? undefined,
        });
      }

      const raw = await net.forwardBatch(
        spatial.subarray(0, batch.length * area * NUM_SPATIAL_PLANES),
        global.subarray(0, batch.length * NUM_GLOBAL_PLANES),
        batch.length,
        size,
      );

      const channels = raw.policyOutChannels;
      for (let i = 0; i < batch.length; i++) {
        const logits = new Float32Array(area + 1);
        for (let p = 0; p < area; p++) logits[p] = raw.policy[(i * area + p) * channels];
        logits[area] = raw.policyPass[i * channels];

        const value = new Float32Array(3);
        value[0] = raw.valueLogits[i * 3];
        value[1] = raw.valueLogits[i * 3 + 1];
        value[2] = raw.valueLogits[i * 3 + 2];
        const sv = raw.scoreValue.subarray(i * raw.scoreValueChannels, (i + 1) * raw.scoreValueChannels);
        const post = postprocessValue(batch[i].toMove, value, sv);

        results.push({
          policyLogits: logits,
          blackWinProb: post.blackWinProb,
          blackScoreLead: post.blackScoreLead,
          blackScoreMean: post.blackScoreMean,
          blackScoreStdev: post.blackScoreStdev,
          blackNoResultProb: post.blackNoResultProb,
          ownership: raw.ownership.slice(i * area, (i + 1) * area),
        });
      }
    }

    return results;
  }

  /** 单个局面评估（内部仍走批处理通道） */
  async evaluateOne(position: GoPositionInput): Promise<GoNNResult> {
    const [r] = await this.evaluate([position]);
    return r;
  }

  dispose(): void {
    this.net?.dispose();
    this.net = null;
    this.spatial = null;
    this.global = null;
    this.scratch = null;
    this.bufferedSize = 0;
  }
}
