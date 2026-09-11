/* ────────────────────────────────────────────────────────────
 *  xqnn/model.ts — 象棋神经网络（AlphaZero 风格 ResNet）的 TF.js 前向
 *
 *  网络来自 yingwang/chinese_chess 的 chess_model.onnx（8.7MB）：
 *    ResNet(128 滤波器 × 6 残差块)，双头——策略头 2086 维（走法表）、
 *    价值头 tanh 标量。用 4 万+ 大师棋谱预训练 + 20 轮自我对弈精炼。
 *
 *  ── 为什么不用 ONNX Runtime ──
 *  onnxruntime-web 最小的 wasm 运行时 13.3MB，比模型本身还大；而这个
 *  图里只有 Conv / Relu / Add / Gemm / Tanh（BatchNorm 已被导出器折进
 *  Conv 的偏置），用项目已有的 TF.js 复刻前向既更小也更快。
 *
 *  ── 权重识别方式 ──
 *  导出器给的张量名是 onnx::Conv_173 这类自动编号，换一版模型就变，
 *  所以这里**按形状**认权重（[128,15,3,3] 是输入卷积、12 个
 *  [128,128,3,3] 是残差块、[2,128,1,1] / [1,128,1,1] 是两个头），
 *  并在解析时逐条断言，模型换了会立刻报错而不是悄悄算错。
 * ──────────────────────────────────────────────────────────── */

import * as tf from '@tensorflow/tfjs-core';
import { parseOnnx, type OnnxGraph, type OnnxTensor } from './onnx';
import { COLS, ROWS } from '../xiangqi/rules';
import { NUM_ACTIONS, NUM_CHANNELS } from './encoding';

const TRUNK_CHANNELS = 128;
const RES_BLOCKS = 6;

export interface XqNetWeights {
  /** 输入卷积 [128,15,3,3] + 偏置 [128] */
  convIn: { w: Float32Array; b: Float32Array };
  /** 6 个残差块，每块两个 3×3 卷积 */
  blocks: Array<{ c1: { w: Float32Array; b: Float32Array }; c2: { w: Float32Array; b: Float32Array } }>;
  /** 策略头 1×1 卷积 [2,128,1,1] + 全连接 [2086,180] */
  policyConv: { w: Float32Array; b: Float32Array };
  policyFc: { w: Float32Array; b: Float32Array };
  /** 价值头 1×1 卷积 [1,128,1,1] + 两层全连接 */
  valueConv: { w: Float32Array; b: Float32Array };
  valueFc1: { w: Float32Array; b: Float32Array };
  valueFc2: { w: Float32Array; b: Float32Array };
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error('象棋神经网络模型不匹配：' + msg);
}

function take(t: OnnxTensor | undefined, what: string): Float32Array {
  expect(!!t, `缺少权重 ${what}`);
  expect(t!.dtype === 'float32', `${what} 应是 float32，实际 ${t!.dtype}`);
  return t!.data as Float32Array;
}

function sameShape(t: OnnxTensor, dims: number[]): boolean {
  return t.dims.length === dims.length && t.dims.every((d, i) => d === dims[i]);
}

/**
 * 解析 .onnx 字节 → 结构化权重。
 * 全部按形状识别 + 断言，不依赖导出器生成的张量名。
 */
export function parseXqNet(buf: ArrayBuffer): XqNetWeights {
  const g: OnnxGraph = parseOnnx(buf);
  const init = g.initializers;

  const convs: Array<{ w: OnnxTensor; b: OnnxTensor }> = [];
  const gemms: OnnxTensor[] = [];
  let gemmBiases: Array<OnnxTensor | undefined> = [];

  for (const node of g.nodes) {
    if (node.opType === 'Conv') {
      const w = init.get(node.input[1]);
      const b = init.get(node.input[2]);
      expect(!!w && !!b, `Conv 节点 ${node.name || node.output[0]} 缺少权重或偏置`);
      convs.push({ w: w!, b: b! });
    } else if (node.opType === 'Gemm') {
      const w = init.get(node.input[1]);
      expect(!!w, `Gemm 节点 ${node.name || node.output[0]} 缺少权重`);
      gemms.push(w!);
      gemmBiases.push(init.get(node.input[2]));
    } else if (node.opType === 'BatchNormalization') {
      // 导出器本应把 BN 折进 Conv；真出现说明换了导出方式，必须重写前向
      throw new Error('象棋神经网络模型不匹配：图里出现了未折叠的 BatchNormalization');
    }
  }

  const shape3x3 = (t: OnnxTensor, out: number, inp: number) => sameShape(t, [out, inp, 3, 3]);
  const shape1x1 = (t: OnnxTensor, out: number, inp: number) => sameShape(t, [out, inp, 1, 1]);

  const inConv = convs.find((c) => shape3x3(c.w, TRUNK_CHANNELS, NUM_CHANNELS));
  expect(!!inConv, `找不到 [${TRUNK_CHANNELS},${NUM_CHANNELS},3,3] 的输入卷积`);

  const resConvs = convs.filter((c) => shape3x3(c.w, TRUNK_CHANNELS, TRUNK_CHANNELS));
  expect(resConvs.length === RES_BLOCKS * 2, `残差卷积数量应为 ${RES_BLOCKS * 2}，实际 ${resConvs.length}`);

  const polConv = convs.find((c) => shape1x1(c.w, 2, TRUNK_CHANNELS));
  const valConv = convs.find((c) => shape1x1(c.w, 1, TRUNK_CHANNELS));
  expect(!!polConv, '找不到策略头 1×1 卷积');
  expect(!!valConv, '找不到价值头 1×1 卷积');

  const polFc = gemms.find((w) => sameShape(w, [NUM_ACTIONS, 2 * ROWS * COLS]));
  const valFc1 = gemms.find((w) => sameShape(w, [128, ROWS * COLS]));
  const valFc2 = gemms.find((w) => sameShape(w, [1, 128]));
  expect(!!polFc && !!valFc1 && !!valFc2, '全连接层形状不符（策略 [2086,180] / 价值 [128,90] 与 [1,128]）');

  const bias = (t: OnnxTensor | undefined, n: number, what: string): Float32Array => {
    expect(!!t && t.dims.length === 1 && t.dims[0] === n, `${what} 偏置形状应为 [${n}]`);
    return t!.data as Float32Array;
  };

  const wOf = (t: OnnxTensor, n: number): Float32Array => {
    expect(t.data.length === n, `权重元素数应为 ${n}，实际 ${t.data.length}`);
    return t.data as Float32Array;
  };

  return {
    convIn: { w: wOf(inConv!.w, TRUNK_CHANNELS * NUM_CHANNELS * 9), b: bias(inConv!.b, TRUNK_CHANNELS, '输入卷积') },
    blocks: Array.from({ length: RES_BLOCKS }, (_, i) => ({
      c1: {
        w: wOf(resConvs[i * 2].w, TRUNK_CHANNELS * TRUNK_CHANNELS * 9),
        b: bias(resConvs[i * 2].b, TRUNK_CHANNELS, `残差块${i}.c1`),
      },
      c2: {
        w: wOf(resConvs[i * 2 + 1].w, TRUNK_CHANNELS * TRUNK_CHANNELS * 9),
        b: bias(resConvs[i * 2 + 1].b, TRUNK_CHANNELS, `残差块${i}.c2`),
      },
    })),
    policyConv: { w: wOf(polConv!.w, 2 * TRUNK_CHANNELS), b: bias(polConv!.b, 2, '策略头卷积') },
    policyFc: {
      w: wOf(polFc!, NUM_ACTIONS * 2 * ROWS * COLS),
      b: bias(gemmBiases[gemms.indexOf(polFc!)] , NUM_ACTIONS, '策略全连接'),
    },
    valueConv: { w: wOf(valConv!.w, TRUNK_CHANNELS), b: bias(valConv!.b, 1, '价值头卷积') },
    valueFc1: {
      w: wOf(valFc1!, 128 * ROWS * COLS),
      b: bias(gemmBiases[gemms.indexOf(valFc1!)], 128, '价值全连接1'),
    },
    valueFc2: {
      w: wOf(valFc2!, 128),
      b: bias(gemmBiases[gemms.indexOf(valFc2!)], 1, '价值全连接2'),
    },
  };
}

/** CHW（ONNX 布局）→ HWC（tf.conv2d 的 NHWC 布局） */
function toHwc(planes: Float32Array): Float32Array {
  const area = ROWS * COLS;
  const out = new Float32Array(area * NUM_CHANNELS);
  for (let ch = 0; ch < NUM_CHANNELS; ch++) {
    const base = ch * area;
    for (let i = 0; i < area; i++) out[i * NUM_CHANNELS + ch] = planes[base + i];
  }
  return out;
}

/** 一次前向的结果（都已是普通数组，可直接喂给搜索） */
export interface XqNetOutput {
  /** 2086 维策略 logits（未 softmax） */
  policy: Float32Array;
  /** tanh 价值：当前行棋方视角，+1 必胜 / -1 必败 */
  value: number;
}

type TfConv = { filter: tf.Tensor4D; bias: tf.Tensor4D };

function makeConv(w: Float32Array, b: Float32Array, kh: number, kw: number, inCh: number, outCh: number): TfConv {
  // ONNX 卷积核是 [out, in, kh, kw]，tf.conv2d 要 [kh, kw, in, out]
  const onnxShape = tf.tensor4d(w, [outCh, inCh, kh, kw]);
  const filter = tf.transpose(onnxShape, [2, 3, 1, 0]) as tf.Tensor4D;
  onnxShape.dispose();
  return { filter, bias: tf.tensor4d(b, [1, 1, 1, outCh]) };
}

/** 加载好的网络：持有 TF.js 张量，前向走 GPU 后端。 */
export class XqNet {
  private readonly convIn: TfConv;
  private readonly blocks: Array<{ c1: TfConv; c2: TfConv }>;
  private readonly polConv: TfConv;
  private readonly valConv: TfConv;
  private readonly polFc: { w: tf.Tensor2D; b: tf.Tensor1D };
  private readonly valFc1: { w: tf.Tensor2D; b: tf.Tensor1D };
  private readonly valFc2: { w: tf.Tensor2D; b: tf.Tensor1D };
  private disposed = false;

  constructor(weights: XqNetWeights) {
    const C = TRUNK_CHANNELS;
    this.convIn = makeConv(weights.convIn.w, weights.convIn.b, 3, 3, NUM_CHANNELS, C);
    this.blocks = weights.blocks.map((bl) => ({
      c1: makeConv(bl.c1.w, bl.c1.b, 3, 3, C, C),
      c2: makeConv(bl.c2.w, bl.c2.b, 3, 3, C, C),
    }));
    this.polConv = makeConv(weights.policyConv.w, weights.policyConv.b, 1, 1, C, 2);
    this.valConv = makeConv(weights.valueConv.w, weights.valueConv.b, 1, 1, C, 1);
    // Gemm transB=1 → y = x · Wᵀ + b，W 形状 [out, in]，转成 [in, out] 直接 matMul
    this.polFc = {
      w: tf.transpose(tf.tensor2d(weights.policyFc.w, [NUM_ACTIONS, 2 * ROWS * COLS]), [1, 0]) as tf.Tensor2D,
      b: tf.tensor1d(weights.policyFc.b),
    };
    this.valFc1 = {
      w: tf.transpose(tf.tensor2d(weights.valueFc1.w, [128, ROWS * COLS]), [1, 0]) as tf.Tensor2D,
      b: tf.tensor1d(weights.valueFc1.b),
    };
    this.valFc2 = {
      w: tf.transpose(tf.tensor2d(weights.valueFc2.w, [1, 128]), [1, 0]) as tf.Tensor2D,
      b: tf.tensor1d(weights.valueFc2.b),
    };
  }

  /** 单局面便捷入口（内部就是 batch=1）。 */
  async forward(planes: Float32Array): Promise<XqNetOutput> {
    const [out] = await this.forwardBatch([planes]);
    return out;
  }

  /**
   * 批量前向。planes 为 encodeBoard() 的输出列表（每个长度 15*90，CHW）。
   *
   * 为什么要批量：这个网络很小（约 1.6 亿次乘加），单样本前向时
   * TF.js 的逐算子调度开销会占掉大头；一次算 8 个局面后，摊到每个
   * 局面的时间通常只有 1/3~1/5。搜索侧因此按批取叶子。
   */
  async forwardBatch(planesList: Float32Array[]): Promise<XqNetOutput[]> {
    if (this.disposed) throw new Error('网络已释放');
    const n = planesList.length;
    if (!n) return [];

    // ONNX 输入是 NCHW（通道在前），tf.conv2d 要 NHWC —— 先转置成 HWC。
    const hwc = new Float32Array(n * ROWS * COLS * NUM_CHANNELS);
    for (let i = 0; i < n; i++) hwc.set(toHwc(planesList[i]), i * ROWS * COLS * NUM_CHANNELS);

    const outs = tf.tidy(() => {
      const x0 = tf.tensor4d(hwc, [n, ROWS, COLS, NUM_CHANNELS]);

      let x = tf.relu(this.conv(x0, this.convIn));
      for (const bl of this.blocks) {
        const h = tf.relu(this.conv(x, bl.c1));
        const h2 = this.conv(h, bl.c2);
        x = tf.relu(tf.add(h2, x)) as tf.Tensor4D;
      }

      // 两个头都是一次展平后接全连接。ONNX 的展平是 NCHW 顺序（通道在前），
      // 而 tf 张量是 NHWC —— 必须显式转置回去，否则通道与格子会整体错位。
      const p = tf.relu(this.conv(x, this.polConv));
      const pFlat = tf.reshape(tf.transpose(p, [0, 3, 1, 2]), [n, 2 * ROWS * COLS]);
      const logits = tf.add(tf.matMul(pFlat, this.polFc.w), this.polFc.b);

      const v = tf.relu(this.conv(x, this.valConv));
      const vFlat = tf.reshape(tf.transpose(v, [0, 3, 1, 2]), [n, ROWS * COLS]);
      const v1 = tf.relu(tf.add(tf.matMul(vFlat, this.valFc1.w), this.valFc1.b));
      const v2 = tf.tanh(tf.add(tf.matMul(v1, this.valFc2.w), this.valFc2.b));

      return { logits, v2 };
    });

    const [policy, value] = await Promise.all([outs.logits.data(), outs.v2.data()]);
    tf.dispose(outs);

    const policyAll = policy as Float32Array;
    const valueAll = value as Float32Array;
    const out: XqNetOutput[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        policy: policyAll.subarray(i * NUM_ACTIONS, (i + 1) * NUM_ACTIONS),
        value: valueAll[i],
      });
    }
    return out;
  }

  private conv(x: tf.Tensor4D, c: TfConv): tf.Tensor4D {
    const y = tf.conv2d(x, c.filter, 1, 'same', 'NHWC') as tf.Tensor4D;
    return tf.add(y, c.bias) as tf.Tensor4D;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const list: tf.Tensor[] = [this.convIn.filter, this.convIn.bias, this.polConv.filter, this.polConv.bias, this.valConv.filter, this.valConv.bias, this.polFc.w, this.polFc.b, this.valFc1.w, this.valFc1.b, this.valFc2.w, this.valFc2.b];
    for (const bl of this.blocks) list.push(bl.c1.filter, bl.c1.bias, bl.c2.filter, bl.c2.bias);
    tf.dispose(list);
  }
}
