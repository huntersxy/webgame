/* ────────────────────────────────────────────────────────────
 *  go/tf-model.ts — 把解析出的 KataGo 权重搭成 TF.js 计算图并前向
 *
 *  结构与参考实现（web-katrain，MIT）一致：
 *   · 卷积核文件里就是 [kY,kX,inC,outC]，正好是 tf.conv2d 的 NHWC 核布局
 *   · 批归一化在解析阶段已折叠成 scale/bias，前向里只有一次乘加
 *   · gpool 块把「均值 / 均值×尺寸系数 / 最大值」拼接后经 1×1 卷积化
 *     成逐通道偏置，加到常规分支上
 *   · 价值头的池化用「均值 / 均值×f1 / 均值×f2」，f 由棋盘边长决定
 *
 *  推理后端由 evaluate.ts 负责选择（WebGPU → WebGL → WASM → CPU）。
 * ──────────────────────────────────────────────────────────── */

import * as tf from '@tensorflow/tfjs-core';
import type { ActivationKind, ParsedBatchNorm, ParsedConv, ParsedGoModel, ParsedMatBias, ParsedMatMul, ParsedTrunkBlock } from './model';

type TfBn = { scale: tf.Tensor4D; bias: tf.Tensor4D };
type TfConv = { filter: tf.Tensor4D; dilationY: number; dilationX: number };
type TfMatMul = { w: tf.Tensor2D };
type TfMatBias = { b: tf.Tensor2D };

type TfBlock =
  | { kind: 'ordinary'; preBN: TfBn; preActivation: ActivationKind; w1: TfConv; midBN: TfBn; midActivation: ActivationKind; w2: TfConv }
  | {
      kind: 'gpool';
      preBN: TfBn;
      preActivation: ActivationKind;
      w1a: TfConv;
      w1b: TfConv;
      gpoolBN: TfBn;
      gpoolActivation: ActivationKind;
      w1r: TfMatMul;
      midBN: TfBn;
      midActivation: ActivationKind;
      w2: TfConv;
    }
  | {
      kind: 'nested_bottleneck';
      preBN: TfBn;
      preActivation: ActivationKind;
      preConv: TfConv;
      blocks: TfBlock[];
      postBN: TfBn;
      postActivation: ActivationKind;
      postConv: TfConv;
    };

/** 一次前向的原始输出（都已是普通类型数组，可直接参与搜索） */
export interface GoNetRawOutput {
  modelName: string;
  modelVersion: number;
  /** 每样本 1 个平面：[n][h][w]（policyOutChannels 通常为 1） */
  policy: Float32Array;
  /** 每样本 policyOutChannels 个值 */
  policyPass: Float32Array;
  policyOutChannels: number;
  /** 每样本 3 个 logits：胜 / 负 / 无结果（轮走方视角） */
  valueLogits: Float32Array;
  /** 每样本 scoreValueChannels 个值 */
  scoreValue: Float32Array;
  scoreValueChannels: number;
  /** 每样本 h*w 个归属值（黑视角，+1 黑 / -1 白） */
  ownership: Float32Array;
  /** 空间边长 */
  size: number;
  /** 批大小 */
  batch: number;
}

function makeBn(bn: ParsedBatchNorm): TfBn {
  return {
    scale: tf.tensor4d(bn.scale, [1, 1, 1, bn.channels]),
    bias: tf.tensor4d(bn.bias, [1, 1, 1, bn.channels]),
  };
}

function makeConv(conv: ParsedConv): TfConv {
  return {
    filter: tf.tensor4d(conv.weights, [conv.kernelY, conv.kernelX, conv.inChannels, conv.outChannels]),
    dilationY: conv.dilationY,
    dilationX: conv.dilationX,
  };
}

function makeMatMul(mm: ParsedMatMul): TfMatMul {
  return { w: tf.tensor2d(mm.weights, [mm.inChannels, mm.outChannels]) };
}

function makeMatBias(b: ParsedMatBias): TfMatBias {
  return { b: tf.tensor2d(b.weights, [1, b.channels]) };
}

function activate(x: tf.Tensor4D | tf.Tensor2D, kind: ActivationKind): tf.Tensor4D | tf.Tensor2D {
  if (kind === 'identity') return x;
  if (kind === 'relu') return tf.relu(x);
  // mish(x) = x * tanh(softplus(x))
  return tf.mul(x, tf.tanh(tf.softplus(x)));
}

function bnAct4d(x: tf.Tensor4D, bn: TfBn, act: ActivationKind): tf.Tensor4D {
  const y = tf.add(tf.mul(x, bn.scale), bn.bias) as tf.Tensor4D;
  return activate(y, act) as tf.Tensor4D;
}

export class GoTfModel {
  readonly modelName: string;
  readonly modelVersion: number;
  readonly policyOutChannels: number;
  readonly scoreValueChannels: number;
  readonly trunkChannels: number;

  private readonly conv1: TfConv;
  private readonly ginput: TfMatMul;
  private readonly blocks: TfBlock[];
  private readonly tipBN: TfBn;
  private readonly tipActivation: ActivationKind;

  private readonly p1: TfConv;
  private readonly g1: TfConv;
  private readonly g1BN: TfBn;
  private readonly g1Activation: ActivationKind;
  private readonly gpoolToBias: TfMatMul;
  private readonly p1BN: TfBn;
  private readonly p1Activation: ActivationKind;
  private readonly p2: TfConv;
  private readonly passMul: TfMatMul;
  private readonly passBias?: TfMatBias;
  private readonly passActivation?: ActivationKind;
  private readonly passMul2?: TfMatMul;

  private readonly v1: TfConv;
  private readonly v1BN: TfBn;
  private readonly v1Activation: ActivationKind;
  private readonly v2: TfMatMul;
  private readonly v2Bias: TfMatBias;
  private readonly v2Activation: ActivationKind;
  private readonly v3: TfMatMul;
  private readonly v3Bias: TfMatBias;
  private readonly sv3: TfMatMul;
  private readonly sv3Bias: TfMatBias;
  private readonly ownership: TfConv;

  private disposed = false;

  constructor(parsed: ParsedGoModel) {
    this.modelName = parsed.modelName;
    this.modelVersion = parsed.modelVersion;
    this.policyOutChannels = parsed.policyOutChannels;
    this.scoreValueChannels = parsed.scoreValueChannels;
    this.trunkChannels = parsed.trunk.trunkNumChannels;

    this.conv1 = makeConv(parsed.trunk.conv1);
    this.ginput = makeMatMul(parsed.trunk.ginput);
    const toTfBlock = (b: ParsedTrunkBlock): TfBlock => {
      if (b.kind === 'ordinary') {
        return {
          kind: 'ordinary',
          preBN: makeBn(b.preBN),
          preActivation: b.preActivation,
          w1: makeConv(b.w1),
          midBN: makeBn(b.midBN),
          midActivation: b.midActivation,
          w2: makeConv(b.w2),
        };
      }
      if (b.kind === 'gpool') {
        return {
          kind: 'gpool',
          preBN: makeBn(b.preBN),
          preActivation: b.preActivation,
          w1a: makeConv(b.w1a),
          w1b: makeConv(b.w1b),
          gpoolBN: makeBn(b.gpoolBN),
          gpoolActivation: b.gpoolActivation,
          w1r: makeMatMul(b.w1r),
          midBN: makeBn(b.midBN),
          midActivation: b.midActivation,
          w2: makeConv(b.w2),
        };
      }
      return {
        kind: 'nested_bottleneck',
        preBN: makeBn(b.preBN),
        preActivation: b.preActivation,
        preConv: makeConv(b.preConv),
        blocks: b.blocks.map(toTfBlock),
        postBN: makeBn(b.postBN),
        postActivation: b.postActivation,
        postConv: makeConv(b.postConv),
      };
    };
    this.blocks = parsed.trunk.blocks.map(toTfBlock);
    this.tipBN = makeBn(parsed.trunk.tipBN);
    this.tipActivation = parsed.trunk.tipActivation;

    this.p1 = makeConv(parsed.policy.p1);
    this.g1 = makeConv(parsed.policy.g1);
    this.g1BN = makeBn(parsed.policy.g1BN);
    this.g1Activation = parsed.policy.g1Activation;
    this.gpoolToBias = makeMatMul(parsed.policy.gpoolToBias);
    this.p1BN = makeBn(parsed.policy.p1BN);
    this.p1Activation = parsed.policy.p1Activation;
    this.p2 = makeConv(parsed.policy.p2);
    this.passMul = makeMatMul(parsed.policy.passMul);
    this.passBias = parsed.policy.passBias ? makeMatBias(parsed.policy.passBias) : undefined;
    this.passActivation = parsed.policy.passActivation;
    this.passMul2 = parsed.policy.passMul2 ? makeMatMul(parsed.policy.passMul2) : undefined;

    this.v1 = makeConv(parsed.value.v1);
    this.v1BN = makeBn(parsed.value.v1BN);
    this.v1Activation = parsed.value.v1Activation;
    this.v2 = makeMatMul(parsed.value.v2);
    this.v2Bias = makeMatBias(parsed.value.v2Bias);
    this.v2Activation = parsed.value.v2Activation;
    this.v3 = makeMatMul(parsed.value.v3);
    this.v3Bias = makeMatBias(parsed.value.v3Bias);
    this.sv3 = makeMatMul(parsed.value.sv3);
    this.sv3Bias = makeMatBias(parsed.value.sv3Bias);
    this.ownership = makeConv(parsed.value.ownership);
  }

  /**
   * 批量前向。spatial 为 [n, size, size, 22]（NHWC 扁平），global 为 [n, 19]。
   * 走 GPU 后端时 `.data()` 是异步的，故本方法返回 Promise。
   */
  async forwardBatch(spatial: Float32Array, global: Float32Array, n: number, size: number): Promise<GoNetRawOutput> {
    if (this.disposed) throw new Error('模型已释放');
    const inputChannels = spatial.length / (n * size * size);

    const outputs = tf.tidy(() => {
      const spatialT = tf.tensor4d(spatial, [n, size, size, inputChannels]);
      const globalT = tf.tensor2d(global, [n, this.ginput.w.shape[0]]);
      const trunk = this.forwardTrunk(spatialT, globalT, size);

      // ── policy head ──
      let p1Out = this.conv2d(trunk, this.p1);
      const g1Out = this.conv2d(trunk, this.g1);
      const g1Out2 = bnAct4d(g1Out, this.g1BN, this.g1Activation);
      const g1Concat = this.poolRowsGPool(g1Out2, size); // [n, 3*g1C]
      const g1Bias = tf.matMul(g1Concat, this.gpoolToBias.w) as tf.Tensor2D;
      p1Out = tf.add(p1Out, tf.reshape(g1Bias, [n, 1, 1, g1Bias.shape[1]])) as tf.Tensor4D;
      const p1Out2 = bnAct4d(p1Out, this.p1BN, this.p1Activation);
      const policy = this.conv2d(p1Out2, this.p2);

      let policyPass = tf.matMul(g1Concat, this.passMul.w) as tf.Tensor2D;
      if (this.passBias && this.passActivation && this.passMul2) {
        policyPass = tf.add(policyPass, this.passBias.b) as tf.Tensor2D;
        policyPass = activate(policyPass, this.passActivation) as tf.Tensor2D;
        policyPass = tf.matMul(policyPass, this.passMul2.w) as tf.Tensor2D;
      }

      // ── value head ──
      const v1Out = this.conv2d(trunk, this.v1);
      const v1Out2 = bnAct4d(v1Out, this.v1BN, this.v1Activation);
      const v1Mean = this.poolRowsValueHead(v1Out2, size);
      let v2Out = tf.add(tf.matMul(v1Mean, this.v2.w) as tf.Tensor2D, this.v2Bias.b) as tf.Tensor2D;
      v2Out = activate(v2Out, this.v2Activation) as tf.Tensor2D;
      const value = tf.add(tf.matMul(v2Out, this.v3.w) as tf.Tensor2D, this.v3Bias.b) as tf.Tensor2D;
      const scoreValue = tf.add(tf.matMul(v2Out, this.sv3.w) as tf.Tensor2D, this.sv3Bias.b) as tf.Tensor2D;
      const ownership = this.conv2d(v1Out2, this.ownership);

      return { policy, policyPass, value, scoreValue, ownership };
    });

    const [policyData, passData, valueData, scoreData, ownData] = await Promise.all([
      outputs.policy.data(),
      outputs.policyPass.data(),
      outputs.value.data(),
      outputs.scoreValue.data(),
      outputs.ownership.data(),
    ]);
    tf.dispose(outputs);

    return {
      modelName: this.modelName,
      modelVersion: this.modelVersion,
      policy: policyData as Float32Array,
      policyPass: passData as Float32Array,
      policyOutChannels: this.policyOutChannels,
      valueLogits: valueData as Float32Array,
      scoreValue: scoreData as Float32Array,
      scoreValueChannels: this.scoreValueChannels,
      ownership: ownData as Float32Array,
      size,
      batch: n,
    };
  }

  private forwardTrunk(spatial: tf.Tensor4D, global: tf.Tensor2D, size: number): tf.Tensor4D {
    let trunk = this.conv2d(spatial, this.conv1);
    const ginput = tf.matMul(global, this.ginput.w) as tf.Tensor2D;
    trunk = tf.add(trunk, tf.reshape(ginput, [global.shape[0], 1, 1, ginput.shape[1]])) as tf.Tensor4D;
    trunk = this.applyBlocks(trunk, this.blocks, size);
    return bnAct4d(trunk, this.tipBN, this.tipActivation);
  }

  private conv2d(x: tf.Tensor4D, conv: TfConv): tf.Tensor4D {
    return tf.conv2d(x, conv.filter, 1, 'same', 'NHWC', [conv.dilationY, conv.dilationX]) as tf.Tensor4D;
  }

  private applyBlocks(trunk: tf.Tensor4D, blocks: TfBlock[], size: number): tf.Tensor4D {
    for (const block of blocks) {
      if (block.kind === 'ordinary') {
        const a = bnAct4d(trunk, block.preBN, block.preActivation);
        const b = this.conv2d(a, block.w1);
        const c = bnAct4d(b, block.midBN, block.midActivation);
        const d = this.conv2d(c, block.w2);
        trunk = tf.add(trunk, d) as tf.Tensor4D;
        continue;
      }
      if (block.kind === 'gpool') {
        const a = bnAct4d(trunk, block.preBN, block.preActivation);
        let regular = this.conv2d(a, block.w1a);
        const gpoolOut = this.conv2d(a, block.w1b);
        const gpoolOut2 = bnAct4d(gpoolOut, block.gpoolBN, block.gpoolActivation);
        const gpoolConcat = this.poolRowsGPool(gpoolOut2, size);
        const gpoolBias = tf.matMul(gpoolConcat, block.w1r.w) as tf.Tensor2D;
        regular = tf.add(regular, tf.reshape(gpoolBias, [gpoolBias.shape[0], 1, 1, gpoolBias.shape[1]])) as tf.Tensor4D;
        const c = bnAct4d(regular, block.midBN, block.midActivation);
        const d = this.conv2d(c, block.w2);
        trunk = tf.add(trunk, d) as tf.Tensor4D;
        continue;
      }
      const a = bnAct4d(trunk, block.preBN, block.preActivation);
      let mid = this.conv2d(a, block.preConv);
      mid = this.applyBlocks(mid, block.blocks, size);
      const c = bnAct4d(mid, block.postBN, block.postActivation);
      const d = this.conv2d(c, block.postConv);
      trunk = tf.add(trunk, d) as tf.Tensor4D;
    }
    return trunk;
  }

  /** gpool：拼接 均值 / 均值×尺寸系数 / 最大值（KataGo 的棋盘尺寸补偿） */
  private poolRowsGPool(x: tf.Tensor4D, size: number): tf.Tensor2D {
    const factor = (size - 14) * 0.1;
    const mean = tf.mean(x, [1, 2]) as tf.Tensor2D;
    const max = tf.max(x, [1, 2]) as tf.Tensor2D;
    return tf.concat([mean, tf.mul(mean, factor), max], 1) as tf.Tensor2D;
  }

  /** 价值头池化：拼接 均值 / 均值×f1 / 均值×f2 */
  private poolRowsValueHead(x: tf.Tensor4D, size: number): tf.Tensor2D {
    const base = size - 14;
    const f1 = base * 0.1;
    const f2 = base * base * 0.01 - 0.1;
    const mean = tf.mean(x, [1, 2]) as tf.Tensor2D;
    return tf.concat([mean, tf.mul(mean, f1), tf.mul(mean, f2)], 1) as tf.Tensor2D;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const tensors: tf.Tensor[] = [
      this.conv1.filter,
      this.ginput.w,
      this.tipBN.scale,
      this.tipBN.bias,
      this.p1.filter,
      this.g1.filter,
      this.g1BN.scale,
      this.g1BN.bias,
      this.gpoolToBias.w,
      this.p1BN.scale,
      this.p1BN.bias,
      this.p2.filter,
      this.passMul.w,
      this.v1.filter,
      this.v1BN.scale,
      this.v1BN.bias,
      this.v2.w,
      this.v2Bias.b,
      this.v3.w,
      this.v3Bias.b,
      this.sv3.w,
      this.sv3Bias.b,
      this.ownership.filter,
    ];
    if (this.passBias) tensors.push(this.passBias.b);
    if (this.passMul2) tensors.push(this.passMul2.w);

    const pushBlock = (b: TfBlock): void => {
      tensors.push(b.preBN.scale, b.preBN.bias);
      if (b.kind === 'ordinary') {
        tensors.push(b.w1.filter, b.midBN.scale, b.midBN.bias, b.w2.filter);
        return;
      }
      if (b.kind === 'gpool') {
        tensors.push(b.w1a.filter, b.w1b.filter, b.gpoolBN.scale, b.gpoolBN.bias, b.w1r.w, b.midBN.scale, b.midBN.bias, b.w2.filter);
        return;
      }
      tensors.push(b.preConv.filter);
      for (const inner of b.blocks) pushBlock(inner);
      tensors.push(b.postBN.scale, b.postBN.bias, b.postConv.filter);
    };
    for (const b of this.blocks) pushBlock(b);
    tf.dispose(tensors);
  }
}
