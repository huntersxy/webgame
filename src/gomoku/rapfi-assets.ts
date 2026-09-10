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

export const RAPFI_ASSET_VERSION = '20260910e';

/** 引擎资源 URL（与 engine-worker.js 内部的 locateFile 拼法保持一致）。 */
export function rapfiAssetUrl(file: string): string {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}rapfi/${file}?v=${RAPFI_ASSET_VERSION}`;
}

/** 数据包大小（用于进度条在还没拿到响应头时先显示一个总数）。 */
export const RAPFI_DATA_BYTES = 10_131_512;

/**
 * 提前把引擎数据包（约 10MB）拉下来，只做两件事：预热 HTTP 缓存、上报进度。
 *
 *   1. URL 与请求参数必须和 emscripten 内部那句 `fetch(h)` 完全一致
 *      （同 URL、都用默认参数），这样引擎稍后自己去取时会直接命中同一
 *      缓存条目，不会重复下载 10MB。
 *   2. 逐块读取并立即丢弃，不在主线程留驻这 10MB。
 */
export async function prefetchRapfiData(
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const res = await fetch(rapfiAssetUrl('rapfi.data'));
  if (!res.ok) throw new Error(`rapfi.data prefetch failed: ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || RAPFI_DATA_BYTES;
  if (!res.body) {
    // 极老的浏览器没有流式 body：退化成整体读取，只报一次完成
    await res.arrayBuffer();
    onProgress?.(total, total);
    return;
  }
  const reader = res.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.length;
    onProgress?.(loaded, total);
  }
}
