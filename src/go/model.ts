/* ────────────────────────────────────────────────────────────
 *  go/model.ts — KataGo 神经网络权重解析（.bin.gz 解压后的 .bin）
 *
 *  文件格式（KataGo cpp/neuralnet/desc.cpp）是「文本头 + 二进制张量」
 *  的混合体：版本号、通道数等是 ASCII 十进制，权重块前面带 "@BIN@"
 *  标记，后面紧跟 count 个小端 float32。本文件实现 modelVersion
 *  8..16 的读取（我们随站点分发的是最小的 g170-b6c96，版本 8）。
 *
 *  批归一化在载入时折叠成 scale/bias（与 KataGo 推理端一致），
 *  这样前向里卷积后面只需要一次乘加。
 * ──────────────────────────────────────────────────────────── */

/** 激活函数类型 */
export type ActivationKind = 'identity' | 'relu' | 'mish';

export interface ParsedBatchNorm {
  channels: number;
  /** 折叠后的乘数 scale / sqrt(var + eps) */
  scale: Float32Array;
  /** 折叠后的偏置 bias - scale * mean */
  bias: Float32Array;
}

export interface ParsedConv {
  name: string;
  kernelY: number;
  kernelX: number;
  inChannels: number;
  outChannels: number;
  dilationY: number;
  dilationX: number;
  /** [kY, kX, inC, outC]（NHWC 卷积核布局） */
  weights: Float32Array;
}

export interface ParsedMatMul {
  name: string;
  inChannels: number;
  outChannels: number;
  /** [inC, outC] */
  weights: Float32Array;
}

export interface ParsedMatBias {
  name: string;
  channels: number;
  weights: Float32Array;
}

export type ParsedTrunkBlock =
  | {
      kind: 'ordinary';
      preBN: ParsedBatchNorm;
      preActivation: ActivationKind;
      w1: ParsedConv;
      midBN: ParsedBatchNorm;
      midActivation: ActivationKind;
      w2: ParsedConv;
    }
  | {
      kind: 'gpool';
      preBN: ParsedBatchNorm;
      preActivation: ActivationKind;
      w1a: ParsedConv;
      w1b: ParsedConv;
      gpoolBN: ParsedBatchNorm;
      gpoolActivation: ActivationKind;
      w1r: ParsedMatMul;
      midBN: ParsedBatchNorm;
      midActivation: ActivationKind;
      w2: ParsedConv;
    }
  | {
      kind: 'nested_bottleneck';
      numBlocks: number;
      preBN: ParsedBatchNorm;
      preActivation: ActivationKind;
      preConv: ParsedConv;
      blocks: ParsedTrunkBlock[];
      postBN: ParsedBatchNorm;
      postActivation: ActivationKind;
      postConv: ParsedConv;
    };

export interface ParsedGoModel {
  modelName: string;
  modelVersion: number;
  numInputChannels: number;
  numInputGlobalChannels: number;
  policyOutChannels: number;
  scoreValueChannels: number;
  trunk: {
    numBlocks: number;
    trunkNumChannels: number;
    midNumChannels: number;
    regularNumChannels: number;
    gpoolNumChannels: number;
    conv1: ParsedConv;
    ginput: ParsedMatMul;
    blocks: ParsedTrunkBlock[];
    tipBN: ParsedBatchNorm;
    tipActivation: ActivationKind;
  };
  policy: {
    p1: ParsedConv;
    g1: ParsedConv;
    g1BN: ParsedBatchNorm;
    g1Activation: ActivationKind;
    gpoolToBias: ParsedMatMul;
    p1BN: ParsedBatchNorm;
    p1Activation: ActivationKind;
    p2: ParsedConv;
    passMul: ParsedMatMul;
    passBias?: ParsedMatBias;
    passActivation?: ActivationKind;
    passMul2?: ParsedMatMul;
  };
  value: {
    v1: ParsedConv;
    v1BN: ParsedBatchNorm;
    v1Activation: ActivationKind;
    v2: ParsedMatMul;
    v2Bias: ParsedMatBias;
    v2Activation: ActivationKind;
    v3: ParsedMatMul;
    v3Bias: ParsedMatBias;
    sv3: ParsedMatMul;
    sv3Bias: ParsedMatBias;
    ownership: ParsedConv;
  };
}

/* ── 底层读取器：文本 token / "@BIN@" 浮点块 ── */
class BinReader {
  private idx = 0;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(private readonly data: Uint8Array) {}

  private skipSpace(): void {
    while (this.idx < this.data.length) {
      const b = this.data[this.idx];
      if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) {
        this.idx++;
        continue;
      }
      break;
    }
  }

  token(): string {
    this.skipSpace();
    const start = this.idx;
    while (this.idx < this.data.length) {
      const b = this.data[this.idx];
      if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) break;
      this.idx++;
    }
    if (this.idx <= start) throw new Error('模型文件在读取 token 时意外结束');
    return this.decoder.decode(this.data.subarray(start, this.idx));
  }

  int(): number {
    const tok = this.token();
    const v = Number.parseInt(tok, 10);
    if (!Number.isFinite(v)) throw new Error(`模型文件中的整数非法：${tok}`);
    return v;
  }

  floatAscii(): number {
    const tok = this.token();
    const v = Number.parseFloat(tok);
    if (!Number.isFinite(v)) throw new Error(`模型文件中的浮点非法：${tok}`);
    return v;
  }

  /** 读取 count 个 float32（前置 @BIN@ 标记） */
  floats(count: number): Float32Array {
    this.skipSpace();
    const marker = this.data.subarray(this.idx, this.idx + 5);
    if (
      marker.length !== 5 ||
      marker[0] !== 0x40 || // @
      marker[1] !== 0x42 || // B
      marker[2] !== 0x49 || // I
      marker[3] !== 0x4e || // N
      marker[4] !== 0x40 // @
    ) {
      throw new Error('模型文件缺少 @BIN@ 标记（权重不是二进制格式？）');
    }
    this.idx += 5;
    const byteLen = count * 4;
    const start = this.data.byteOffset + this.idx;
    if (start + byteLen > this.data.byteOffset + this.data.byteLength) {
      throw new Error('模型文件在读取权重时意外结束');
    }
    // 拷贝一份对齐的缓冲（subarray 可能不是 4 字节对齐）
    const out = new Float32Array(count);
    const view = new DataView(this.data.buffer, start, byteLen);
    for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
    this.idx += byteLen;
    this.skipSpace();
    return out;
  }
}

function readBN(p: BinReader): ParsedBatchNorm {
  p.token(); // 层名
  const channels = p.int();
  const epsilon = p.floatAscii();
  const hasScale = p.int() !== 0;
  const hasBias = p.int() !== 0;
  const mean = p.floats(channels);
  const variance = p.floats(channels);
  const scale = hasScale ? p.floats(channels) : new Float32Array(channels).fill(1);
  const bias = hasBias ? p.floats(channels) : new Float32Array(channels).fill(0);

  const mergedScale = new Float32Array(channels);
  const mergedBias = new Float32Array(channels);
  for (let i = 0; i < channels; i++) {
    const s = scale[i] / Math.sqrt(variance[i] + epsilon);
    mergedScale[i] = s;
    mergedBias[i] = bias[i] - s * mean[i];
  }
  return { channels, scale: mergedScale, bias: mergedBias };
}

function readActivation(p: BinReader, modelVersion: number): ActivationKind {
  p.token(); // 层名
  if (modelVersion < 11) return 'relu';
  const kind = p.token();
  if (kind === 'ACTIVATION_IDENTITY') return 'identity';
  if (kind === 'ACTIVATION_RELU') return 'relu';
  if (kind === 'ACTIVATION_MISH') return 'mish';
  throw new Error(`不支持的激活函数：${kind}`);
}

function readConv(p: BinReader): ParsedConv {
  const name = p.token();
  const kernelY = p.int();
  const kernelX = p.int();
  const inChannels = p.int();
  const outChannels = p.int();
  const dilationY = p.int();
  const dilationX = p.int();
  const weights = p.floats(kernelY * kernelX * inChannels * outChannels);
  return { name, kernelY, kernelX, inChannels, outChannels, dilationY, dilationX, weights };
}

function readMatMul(p: BinReader): ParsedMatMul {
  const name = p.token();
  const inChannels = p.int();
  const outChannels = p.int();
  const weights = p.floats(inChannels * outChannels);
  return { name, inChannels, outChannels, weights };
}

function readMatBias(p: BinReader): ParsedMatBias {
  const name = p.token();
  const channels = p.int();
  const weights = p.floats(channels);
  return { name, channels, weights };
}

/**
 * 解析 KataGo 权重（已 gunzip 的 Uint8Array）。
 * 支持 modelVersion 8..16；带 SGF 元数据编码器的网络（human SL）本平台不使用。
 */
export function parseGoModel(data: Uint8Array): ParsedGoModel {
  const p = new BinReader(data);
  const modelName = p.token();
  const modelVersion = p.int();
  if (modelVersion < 8 || modelVersion > 16) {
    throw new Error(`不支持的模型版本 ${modelVersion}（支持 8..16）`);
  }
  const numInputChannels = p.int();
  const numInputGlobalChannels = p.int();

  if (modelVersion >= 13) {
    for (let i = 0; i < 7; i++) p.floatAscii(); // 后处理系数（本实现用 KataGo 默认值）
  }

  let metaEncoderVersion = 0;
  if (modelVersion >= 15) {
    metaEncoderVersion = p.int();
    for (let i = 0; i < 7; i++) p.int();
    if (metaEncoderVersion !== 0) {
      throw new Error('该网络需要 SGF 元数据输入（human SL 网络），本平台不支持');
    }
  }

  // trunk 头
  p.token();
  const numBlocks = p.int();
  const trunkNumChannels = p.int();
  const midNumChannels = p.int();
  const regularNumChannels = p.int();
  p.int();
  const gpoolNumChannels = p.int();
  if (modelVersion >= 15) {
    const normKind = p.int();
    if (normKind !== 0) throw new Error(`不支持的 trunk 归一化类型 ${normKind}`);
    for (let i = 0; i < 5; i++) p.int();
  }

  const conv1 = readConv(p);
  const ginput = readMatMul(p);

  const readBlock = (): ParsedTrunkBlock => {
    const kind = p.token();
    if (kind === 'ordinary_block') {
      p.token();
      const preBN = readBN(p);
      const preActivation = readActivation(p, modelVersion);
      const w1 = readConv(p);
      const midBN = readBN(p);
      const midActivation = readActivation(p, modelVersion);
      const w2 = readConv(p);
      return { kind: 'ordinary', preBN, preActivation, w1, midBN, midActivation, w2 };
    }
    if (kind === 'gpool_block') {
      p.token();
      const preBN = readBN(p);
      const preActivation = readActivation(p, modelVersion);
      const w1a = readConv(p);
      const w1b = readConv(p);
      const gpoolBN = readBN(p);
      const gpoolActivation = readActivation(p, modelVersion);
      const w1r = readMatMul(p);
      const midBN = readBN(p);
      const midActivation = readActivation(p, modelVersion);
      const w2 = readConv(p);
      return { kind: 'gpool', preBN, preActivation, w1a, w1b, gpoolBN, gpoolActivation, w1r, midBN, midActivation, w2 };
    }
    if (kind === 'nested_bottleneck_block') {
      p.token();
      const innerCount = p.int();
      const preBN = readBN(p);
      const preActivation = readActivation(p, modelVersion);
      const preConv = readConv(p);
      const blocks: ParsedTrunkBlock[] = [];
      for (let i = 0; i < innerCount; i++) blocks.push(readBlock());
      const postBN = readBN(p);
      const postActivation = readActivation(p, modelVersion);
      const postConv = readConv(p);
      return { kind: 'nested_bottleneck', numBlocks: innerCount, preBN, preActivation, preConv, blocks, postBN, postActivation, postConv };
    }
    throw new Error(`不支持的 trunk 块类型：${kind}`);
  };

  const blocks: ParsedTrunkBlock[] = [];
  for (let i = 0; i < numBlocks; i++) blocks.push(readBlock());

  const tipBN = readBN(p);
  const tipActivation = readActivation(p, modelVersion);

  // policy head
  p.token();
  const p1 = readConv(p);
  const g1 = readConv(p);
  const g1BN = readBN(p);
  const g1Activation = readActivation(p, modelVersion);
  const gpoolToBias = readMatMul(p);
  const p1BN = readBN(p);
  const p1Activation = readActivation(p, modelVersion);
  const p2 = readConv(p);
  const passMul = readMatMul(p);
  const passBias = modelVersion >= 15 ? readMatBias(p) : undefined;
  const passActivation = modelVersion >= 15 ? readActivation(p, modelVersion) : undefined;
  const passMul2 = modelVersion >= 15 ? readMatMul(p) : undefined;

  // value head
  p.token();
  const v1 = readConv(p);
  const v1BN = readBN(p);
  const v1Activation = readActivation(p, modelVersion);
  const v2 = readMatMul(p);
  const v2Bias = readMatBias(p);
  const v2Activation = readActivation(p, modelVersion);
  const v3 = readMatMul(p);
  const v3Bias = readMatBias(p);
  const sv3 = readMatMul(p);
  const sv3Bias = readMatBias(p);
  const ownership = readConv(p);

  return {
    modelName,
    modelVersion,
    numInputChannels,
    numInputGlobalChannels,
    policyOutChannels: p2.outChannels,
    scoreValueChannels: sv3.outChannels,
    trunk: {
      numBlocks,
      trunkNumChannels,
      midNumChannels,
      regularNumChannels,
      gpoolNumChannels,
      conv1,
      ginput,
      blocks,
      tipBN,
      tipActivation,
    },
    policy: { p1, g1, g1BN, g1Activation, gpoolToBias, p1BN, p1Activation, p2, passMul, passBias, passActivation, passMul2 },
    value: { v1, v1BN, v1Activation, v2, v2Bias, v2Activation, v3, v3Bias, sv3, sv3Bias, ownership },
  };
}

/** 模型参数总量（用于日志/体积展示） */
export function countModelParams(m: ParsedGoModel): number {
  const conv = (c: ParsedConv): number => c.weights.length + c.outChannels;
  const bn = (b: ParsedBatchNorm): number => b.channels * 2;
  const mm = (m2: ParsedMatMul): number => m2.weights.length;
  let n = 0;
  n += conv(m.trunk.conv1) + mm(m.trunk.ginput);
  for (const b of m.trunk.blocks) {
    n += bn(b.preBN);
    if (b.kind === 'ordinary') n += conv(b.w1) + bn(b.midBN) + conv(b.w2);
    else if (b.kind === 'gpool') n += conv(b.w1a) + conv(b.w1b) + bn(b.gpoolBN) + mm(b.w1r) + bn(b.midBN) + conv(b.w2);
    else {
      n += conv(b.preConv) + bn(b.postBN) + conv(b.postConv);
      for (const inner of b.blocks) {
        n += bn(inner.preBN);
        if (inner.kind === 'ordinary') n += conv(inner.w1) + bn(inner.midBN) + conv(inner.w2);
      }
    }
  }
  n += bn(m.trunk.tipBN);
  n += conv(m.policy.p1) + conv(m.policy.g1) + bn(m.policy.g1BN) + mm(m.policy.gpoolToBias) + bn(m.policy.p1BN) + conv(m.policy.p2) + mm(m.policy.passMul);
  n += conv(m.value.v1) + bn(m.value.v1BN) + mm(m.value.v2) + mm(m.value.v3) + mm(m.value.sv3) + conv(m.value.ownership);
  return n;
}
