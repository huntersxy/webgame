/* ────────────────────────────────────────────────────────────
 *  gomoku/rapfi-assets.ts — Rapfi 资源的版本号与预取
 *
 *  单独放一个模块，是为了让主线程（AI 桥 / 控制器）也能构造引擎资源
 *  URL、并在后台把数据包拉下来，而**不必**把整个 RapfiEngine 客户端
 *  拖进主包（那个模块只在 AI Worker 里用）。
 *
 *  版本号纪律：只要动了 public/rapfi/ 下任何文件，必须把
 *  RAPFI_ASSET_VERSION 加一版。因为 /rapfi/ 线上是
 *  `Cache-Control: immutable, max-age=31536000`，浏览器和 CDN 都会
 *  按 URL 长期缓存——不换版本号，老访客永远拿不到新引擎。
 * ──────────────────────────────────────────────────────────── */

export const RAPFI_ASSET_VERSION = '20260911a';

/** 引擎资源 URL（与 engine-worker.js 内部的 locateFile 拼法保持一致）。 */
export function rapfiAssetUrl(file: string): string {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}rapfi/${file}?v=${RAPFI_ASSET_VERSION}`;
}

/** 数据包大小（用于进度条在还没拿到响应头时先显示一个总数）。 */
export const RAPFI_DATA_BYTES = 10_131_512;

/**
 * 下载引擎数据包并返回完整 ArrayBuffer。
 *
 * 跨域时 Worker 里 emscripten 的第二次 fetch 往往吃不到 HTTP 缓存，
 * 所以把字节经 postMessage 注入 getPreloadedPackage，避免重复下载。
 */
export async function prefetchRapfiData(
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(rapfiAssetUrl('rapfi.data'));
  if (!res.ok) throw new Error(`rapfi.data prefetch failed: ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || RAPFI_DATA_BYTES;
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
