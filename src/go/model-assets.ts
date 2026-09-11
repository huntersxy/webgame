/* ────────────────────────────────────────────────────────────
 *  go/model-assets.ts — 围棋神经网络权重的位置、版本与预取
 *
 *  与 gomoku/rapfi-assets.ts、xqnn/model-assets.ts 同一套路：
 *  单独一个模块，让主线程能构造 URL 并在后台把权重拉下来，而不必把
 *  TF.js / 推理代码拖进主包。
 *
 *  版本号纪律：只要换了 public/go/ 下的权重文件，必须把
 *  GO_ASSET_VERSION 加一版——线上 /go/ 是 immutable 长缓存，不换版本号
 *  老访客永远拿不到新网络。
 * ──────────────────────────────────────────────────────────── */

/** 资源修订号：改了 public/go/ 下任何文件才递增 */
export const GO_ASSET_VERSION = 'a1';

/** 随站点分发的权重：KataGo 官方最小网络 g170-b6c96（约 3.8MB，远小于 10MB 预算） */
export const GO_MODEL_FILE = 'g170-b6c96-s175395328-d26788732.bin.gz';

/** 权重包字节数（用于响应头未到时的进度条占位） */
export const GO_MODEL_BYTES = 3_827_339;

/** 人类可读的网络名（界面展示用） */
export const GO_MODEL_LABEL = 'KataGo b6c96';

/** TF.js WASM 后端所需文件所在目录（同源） */
export function goWasmPathPrefix(): string {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}go/tfjs/`;
}

/** 权重 URL（带版本号，可长缓存） */
export function goModelUrl(): string {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}go/${GO_MODEL_FILE}?v=${GO_ASSET_VERSION}`;
}

/** 下载权重包（返回原始字节，仍是 gzip 流；解压由 evaluate.ts 负责） */
export async function prefetchGoModel(
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(goModelUrl());
  if (!res.ok) throw new Error(`围棋权重下载失败：${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || GO_MODEL_BYTES;
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
