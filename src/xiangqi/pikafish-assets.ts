/* ────────────────────────────────────────────────────────────
 *  xiangqi/pikafish-assets.ts — Pikafish 资源的版本号与预取
 *
 *  与 gomoku/rapfi-assets.ts 同一套路：单独放一个模块，让主线程
 *  （AI 桥 / 控制器）能构造资源 URL 并在后台把数据包拉下来，而不必
 *  把整个 PikafishEngine 客户端拖进主包（它只在 AI Worker 里用）。
 *
 *  版本号纪律：只要动了 public/pikafish/ 下任何文件（含换了 NNUE 权重），
 *  必须把 PIKAFISH_ASSET_VERSION 加一版。因为 /pikafish/ 线上是
 *  `Cache-Control: immutable, max-age=31536000`，浏览器和 CDN 都会按
 *  URL 长期缓存——不换版本号，老访客永远拿不到新引擎。
 * ──────────────────────────────────────────────────────────── */

export const PIKAFISH_ASSET_VERSION = '20260911a';

/**
 * 权重包（pikafish.data，约 48MB）的托管基址。
 *
 * 引擎外壳（pikafish.js / pikafish.wasm，共约 670KB）很小，随仓库走；
 * 而权重包太大（GitHub 对 >50MB 文件会警告、且它压不动），所以默认
 * 允许把它放到外部 OSS/CDN 上：
 *
 *   .env.production:  VITE_PIKAFISH_DATA_BASE=https://your-bucket.oss-cn-xxx.aliyuncs.com/pikafish/
 *
 * 不配就走同源 public/pikafish/pikafish.data（本地开发用；该文件在
 * .gitignore 里，不入库）。
 *
 * 注意：跨域托管必须给 OSS 配 CORS（GET + 允许来源），否则浏览器
 * 读不到——引擎的 .data 加载与我们的预取都是 fetch，受同源策略约束。
 */
const RAW_DATA_BASE = (import.meta.env?.VITE_PIKAFISH_DATA_BASE as string | undefined)?.trim();

/** 归一化：确保以 / 结尾，便于直接拼文件名。 */
const DATA_BASE: string | null = RAW_DATA_BASE
  ? (RAW_DATA_BASE.endsWith('/') ? RAW_DATA_BASE : RAW_DATA_BASE + '/')
  : null;

/** 权重包是否托管在外部（真 = 跨域，需要 OSS 配 CORS）。 */
export const PIKAFISH_DATA_REMOTE = DATA_BASE !== null;

/** 引擎资源 URL。.data 走外部基址（若配了），其余（.js/.wasm）始终同源。 */
export function pikafishAssetUrl(file: string): string {
  if (DATA_BASE && /\.data$/.test(file)) {
    return `${DATA_BASE}${file}?v=${PIKAFISH_ASSET_VERSION}`;
  }
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}pikafish/${file}?v=${PIKAFISH_ASSET_VERSION}`;
}

/** 权重包的完整 URL。预取与引擎内部取包必须用同一个值，才能命中同一缓存条目。 */
export function pikafishDataUrl(): string {
  return pikafishAssetUrl('pikafish.data');
}

/** 权重包大小（约 48MB；仅用于响应头还没到时的进度条占位）。 */
export const PIKAFISH_DATA_BYTES = 50_706_378;

/**
 * 下载权重包并返回完整 ArrayBuffer。
 *
 * 跨域时 Worker 里 emscripten 的第二次 fetch 往往吃不到 HTTP 缓存，
 * 所以这里把字节拿在手里，经 postMessage 塞进引擎的 getPreloadedPackage，
 * 引擎不再对公网发第二次请求。
 */
export async function prefetchPikafishData(
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(pikafishDataUrl());
  if (!res.ok) throw new Error(`pikafish.data prefetch failed: ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || PIKAFISH_DATA_BYTES;
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
