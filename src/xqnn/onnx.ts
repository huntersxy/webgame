/* ────────────────────────────────────────────────────────────
 *  xqnn/onnx.ts — 极简 ONNX 解析器（只取推理需要的部分）
 *
 *  为什么不直接用 onnxruntime-web：它最小的 wasm 运行时就要 13.3MB，
 *  比我们的模型（8.7MB）还大；而这个网络只有 Conv/BatchNorm/Relu/
 *  Add/Gemm/Tanh 六种算子，用项目已经装好的 TF.js 复刻前向反而更小更快。
 *
 *  所以这里只做一件事：把 .onnx 里的 initializer（权重）与 node 列表
 *  读出来，交给 model.ts 按已知结构搭建 TF.js 模型。
 *
 *  ONNX 是 protobuf 编码（ModelProto → GraphProto → NodeProto/TensorProto），
 *  这里手写一个够用的 protobuf 读取器，不引任何依赖。
 * ──────────────────────────────────────────────────────────── */

/** 只保留推理用得到的张量类型：float32 / int64 / int32 / float16。 */
export type OnnxDtype = 'float32' | 'int64' | 'int32' | 'float16';

export interface OnnxTensor {
  name: string;
  dims: number[];
  dtype: OnnxDtype;
  /** float32 张量：定长 Float32Array；整型：Float64Array（只用来读 shape/常量） */
  data: Float32Array | Float64Array;
}

export interface OnnxNode {
  opType: string;
  name: string;
  input: string[];
  output: string[];
  attrs: Record<string, number | string | number[]>;
}

export interface OnnxGraph {
  nodes: OnnxNode[];
  initializers: Map<string, OnnxTensor>;
  inputs: string[];
  outputs: string[];
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }

  varint(): number {
    // 用 BigInt 累加：ONNX 里 int64 既可能是大正数，也可能是负数的补码
    // （10 字节 varint），浮点累加会丢精度且不会还原符号。
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.bytes[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
      if (shift > 70n) throw new Error('onnx: varint 过长');
    }
    if (result >= 1n << 63n) result -= 1n << 64n; // 补码还原为负数
    return Number(result);
  }

  /** 返回 [fieldNumber, wireType]；到末尾返回 null。 */
  tag(): [number, number] | null {
    if (this.eof) return null;
    const key = this.varint();
    return [key >>> 3, key & 7];
  }

  lenBytes(): Uint8Array {
    const len = this.varint();
    const out = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(): string {
    return new TextDecoder().decode(this.lenBytes());
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT: this.varint(); break;
      case WIRE_FIXED64: this.pos += 8; break;
      case WIRE_LEN: this.lenBytes(); break;
      case WIRE_FIXED32: this.pos += 4; break;
      default: throw new Error('onnx: 未知 wire type ' + wire);
    }
  }

  /** 跳过整个 length-delimited 子消息之外的所有字段，返回子读取器。 */
  message(): Reader {
    return new Reader(this.lenBytes());
  }
}

function dtypeOf(t: number): OnnxDtype {
  switch (t) {
    case 1: return 'float32';
    case 6: return 'int32';
    case 7: return 'int64';
    case 10: return 'float16';
    default: throw new Error(`onnx: 暂不支持的张量类型 ${t}`);
  }
}

function float16ToNumber(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

function parseTensor(r: Reader): OnnxTensor {
  const dims: number[] = [];
  let dtype: OnnxDtype = 'float32';
  let name = '';
  let raw: Uint8Array | null = null;
  const floatData: number[] = [];
  const intData: number[] = [];

  for (;;) {
    const t = r.tag();
    if (!t) break;
    const [field, wire] = t;
    switch (field) {
      case 1: readVarints(r, wire, dims); break;                  // dims（可能 packed）
      case 2: dtype = dtypeOf(r.varint()); break;                 // data_type
      case 4: readFloats(r, wire, floatData); break;              // float_data
      case 5: readVarints(r, wire, intData); break;               // int32_data
      case 7: readVarints(r, wire, intData); break;               // int64_data
      case 8: name = r.string(); break;                           // name
      case 9: raw = new Uint8Array(r.lenBytes()); break;          // raw_data
      default: r.skip(wire);
    }
  }

  const count = dims.reduce((a, b) => a * b, 1) || 1;
  if (raw) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (dtype === 'float32') {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, true);
      return { name, dims, dtype, data: out };
    }
    if (dtype === 'float16') {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = float16ToNumber(dv.getUint16(i * 2, true));
      return { name, dims, dtype, data: out };
    }
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = dtype === 'int32' ? dv.getInt32(i * 4, true) : Number(dv.getBigInt64(i * 8, true));
    }
    return { name, dims, dtype, data: out };
  }

  const data = dtype === 'float32'
    ? Float32Array.from(floatData)
    : Float64Array.from(intData.length ? intData : floatData);
  return { name, dims, dtype, data };
}

function readFloat(r: Reader): number {
  const v = new DataView(r.bytes.buffer, r.bytes.byteOffset + r.pos, 4).getFloat32(0, true);
  r.pos += 4;
  return v;
}

/** repeated 标量字段可能是 packed（wire=2）或逐个（wire=0）。 */
function readVarints(r: Reader, wire: number, out: number[]): void {
  if (wire === WIRE_LEN) {
    const sub = r.message();
    while (!sub.eof) out.push(sub.varint());
    return;
  }
  out.push(r.varint());
}

/** repeated float 字段同样可能 packed。 */
function readFloats(r: Reader, wire: number, out: number[]): void {
  if (wire === WIRE_LEN) {
    const sub = r.message();
    while (!sub.eof) out.push(readFloat(sub));
    return;
  }
  out.push(readFloat(r));
}

function parseAttribute(r: Reader): { name: string; value: number | string | number[] } {
  let name = '';
  let value: number | string | number[] = 0;
  const out7: number[] = [];
  for (;;) {
    const t = r.tag();
    if (!t) break;
    const [field, wire] = t;
    switch (field) {
      case 1: name = r.string(); break;
      case 2: value = readFloat(r); break;
      case 3: value = r.varint(); break;
      case 4: value = new TextDecoder().decode(r.lenBytes()); break;
      case 7: readFloats(r, wire, out7); value = out7; break;
      case 8: {
        const out: number[] = [];
        readVarints(r, wire, out);
        value = out;
        break;
      }
      default: r.skip(wire);
    }
  }
  return { name, value };
}

function parseNode(r: Reader): OnnxNode {
  const node: OnnxNode = { opType: '', name: '', input: [], output: [], attrs: {} };
  for (;;) {
    const t = r.tag();
    if (!t) break;
    const [field, wire] = t;
    switch (field) {
      case 1: node.input.push(r.string()); break;
      case 2: node.output.push(r.string()); break;
      case 3: node.name = r.string(); break;
      case 4: node.opType = r.string(); break;
      case 5: {
        const a = parseAttribute(r.message());
        node.attrs[a.name] = a.value;
        break;
      }
      default: r.skip(wire);
    }
  }
  return node;
}

function parseValueInfo(r: Reader): string {
  let name = '';
  for (;;) {
    const t = r.tag();
    if (!t) break;
    const [field, wire] = t;
    if (field === 1) name = r.string();
    else r.skip(wire);
  }
  return name;
}

function parseGraph(r: Reader): OnnxGraph {
  const graph: OnnxGraph = { nodes: [], initializers: new Map(), inputs: [], outputs: [] };
  for (;;) {
    const t = r.tag();
    if (!t) break;
    const [field, wire] = t;
    switch (field) {
      case 1: graph.nodes.push(parseNode(r.message())); break;
      case 5: {
        const ten = parseTensor(r.message());
        graph.initializers.set(ten.name, ten);
        break;
      }
      case 11: graph.inputs.push(parseValueInfo(r.message())); break;
      case 12: graph.outputs.push(parseValueInfo(r.message())); break;
      default: r.skip(wire);
    }
  }
  return graph;
}

/** 解析 .onnx 字节，返回图结构。 */
export function parseOnnx(buf: ArrayBuffer): OnnxGraph {
  const r = new Reader(new Uint8Array(buf));
  let graph: OnnxGraph | null = null;
  for (;;) {
    const t = r.tag();
    if (!t) break;
    const [field, wire] = t;
    if (field === 7) graph = parseGraph(r.message());
    else r.skip(wire);
  }
  if (!graph) throw new Error('onnx: 文件里没有 graph');
  return graph;
}
