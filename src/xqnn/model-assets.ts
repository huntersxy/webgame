/* ────────────────────────────────────────────────────────────
 *  xqnn/model-assets.ts — 象棋神经网络权重的位置、版本与预取
 *
 *  与 go/model-assets.ts 同一套路：主线程拿这个模块构造 URL 并在后台
 *  把权重拉下来，不必把 TF.js 推理代码拖进主包。
 *
 *  版本号纪律：换了 public/xqnn/ 下的 .onnx 必须把 XQNN_ASSET_VERSION
 *  加一版——线上是 immutable 长缓存，不换号老访客永远拿不到新网络。
 * ──────────────────────────────────────────────────────────── */

/** 资源修订号：改了 public/xqnn/ 下任何文件才递增 */
export const XQNN_ASSET_VERSION = 'a1';

/** 权重文件：yingwang/chinese_chess 的 AlphaZero 风格 ResNet（8.7MB） */
export const XQNN_MODEL_FILE = 'chess_model.onnx';

/** 权重字节数（响应头没到时的进度条占位） */
export const XQNN_MODEL_BYTES = 8_719_980;

/** 界面展示名 */
export const XQNN_MODEL_LABEL = '象棋神经网络 ResNet128×6';

/** TF.js WASM 后端所需文件由 scripts/copy-tfjs-wasm.mjs 统一放到 public/go/tfjs/（与围棋共用一份）。 */
export function xqnnWasmPathPrefix(): string {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}go/tfjs/`;
}

/** 权重 URL（带版本号，可长缓存） */
export function xqnnModelUrl(): string {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}xqnn/${XQNN_MODEL_FILE}?v=${XQNN_ASSET_VERSION}`;
}

/** 下载权重（返回原始 .onnx 字节） */
export async function prefetchXqnnModel(
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(xqnnModelUrl());
  if (!res.ok) throw new Error(`象棋神经网络权重下载失败：${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || XQNN_MODEL_BYTES;
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress?.(total, total);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}
