/* ────────────────────────────────────────────────────────────
 *  xqnn/evaluate.ts — 象棋神经网络评估器
 *
 *  职责：选后端 → 载入并解析 .onnx → 批量前向 → 后处理成搜索要用的量。
 *
 *  后端降级链与围棋一致：WebGPU → WebGL → WASM(SIMD) → CPU。
 *  这个网络比 KataGo 小得多（一次前向约 1.6 亿次乘加），GPU 后端下
 *  单次前向通常个位数毫秒；只有 CPU 兜底时才会明显变慢——搜索侧有
 *  时间预算兜底，慢后端只会少搜几个访问，不会卡死界面。
 *
 *  评估结果的口径：
 *    · policy 是 2086 维原始 logits（未 softmax），对应 encoding.ts 的走法表
 *    · value 是 tanh 输出，**行棋方视角**（上游模型自带的语义）
 * ──────────────────────────────────────────────────────────── */

import * as tf from '@tensorflow/tfjs-core';
import { parseXqNet, XqNet, type XqNetOutput } from './model';
import { encodeBoard, type XqMoveTable, moveTable } from './encoding';
import { xqnnWasmPathPrefix } from './model-assets';
import type { XqBoard, XqSide } from '../types';

export type XqnnBackend = 'webgpu' | 'webgl' | 'wasm' | 'cpu';

async function tryBackend(name: XqnnBackend): Promise<boolean> {
  try {
    if (name === 'webgpu') {
      if (!(navigator as { gpu?: unknown }).gpu) return false;
      await import('@tensorflow/tfjs-backend-webgpu');
    } else if (name === 'webgl') {
      await import('@tensorflow/tfjs-backend-webgl');
    } else if (name === 'wasm') {
      const mod = await import('@tensorflow/tfjs-backend-wasm');
      mod.setWasmPaths(xqnnWasmPathPrefix());
    } else {
      await import('@tensorflow/tfjs-backend-cpu');
    }
    await tf.setBackend(name);
    await tf.ready();
    return tf.getBackend() === name;
  } catch (err) {
    console.warn(`[xqnn] ${name} 后端不可用：`, err);
    return false;
  }
}

/** 依次尝试后端，返回真正生效的那个 */
export async function selectXqnnBackend(preferred?: XqnnBackend): Promise<XqnnBackend> {
  const all: XqnnBackend[] = ['webgpu', 'webgl', 'wasm', 'cpu'];
  const order = preferred ? [preferred, ...all.filter((b) => b !== preferred)] : all;
  for (const name of order) {
    if (await tryBackend(name)) return name;
  }
  throw new Error('没有可用的 TF.js 后端');
}

/** 一个局面的评估结果 */
export interface XqEval {
  /** 2086 维原始 logits */
  policy: Float32Array;
  /** 行棋方视角的价值（-1..1） */
  value: number;
}

/**
 * 搜索侧只依赖这个最小接口（而不是整个评估器类）：
 * 测试可以注入 onnxruntime 之类的别的推理实现，用来跑对抗棋局。
 */
export interface XqEvaluatorLike {
  /** 走法表（策略下标 ↔ 坐标） */
  readonly moves: XqMoveTable;
  /** 批量评估：每个元素是一个局面的 CHW 平面 */
  evaluate(planes: Float32Array[]): Promise<XqEval[]>;
  /** 单局面评估 */
  evaluateBoard(board: XqBoard, side: XqSide): Promise<XqEval>;
  /** 推理后端名（展示/日志用） */
  backend: string | null;
}

export class XqnnEvaluator implements XqEvaluatorLike {
  private net: XqNet | null = null;
  private table: XqMoveTable;
  backend: XqnnBackend | null = null;
  /** 已评估的局数（自检/统计用） */
  evals = 0;

  constructor() {
    this.table = moveTable();
  }

  get ready(): boolean {
    return this.net !== null;
  }

  /** 走法表（策略下标 ↔ 坐标） */
  get moves(): XqMoveTable {
    return this.table;
  }

  /** 解析 .onnx 并建好推理图。bytes 可以是主线程预取好的权重。 */
  async load(bytes: ArrayBuffer, preferredBackend?: XqnnBackend): Promise<{ backend: XqnnBackend }> {
    if (!this.net) {
      const weights = parseXqNet(bytes);
      this.backend = await selectXqnnBackend(preferredBackend);
      this.net = new XqNet(weights);
      console.info(`[xqnn] 网络就绪（TF.js 后端 ${this.backend}）`);
    }
    return { backend: this.backend! };
  }

  /** 批量评估（每个元素是一个局面的 CHW 平面）。 */
  async evaluate(planes: Float32Array[]): Promise<XqEval[]> {
    if (!this.net) throw new Error('网络尚未载入');
    const outs: XqNetOutput[] = await this.net.forwardBatch(planes);
    this.evals += outs.length;
    return outs;
  }

  /** 单局面评估（便于测试与「请神」这类单次调用）。 */
  async evaluateBoard(board: XqBoard, side: XqSide): Promise<XqEval> {
    const [out] = await this.evaluate([encodeBoard(board, side)]);
    return out;
  }

  dispose(): void {
    this.net?.dispose();
    this.net = null;
  }
}
