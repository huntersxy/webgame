/* ────────────────────────────────────────────────────────────
 *  othello/egaroucid-assets.ts — Egaroucid 资源的版本号、URL 与预取
 *
 *  与 gomoku/rapfi-assets.ts 同样的纪律：只要改了 public/egaroucid/ 下任何
 *  文件，必须递增 EGAROUCID_ASSET_VERSION。线上该目录是长期缓存（immutable），
 *  不换版本号老访客会一直用旧引擎。
 *
 *  单独成一个模块，是为了让主线程（AI 桥 / 控制器）能构造 URL、做预取、
 *  映射难度档位，而不必把引擎客户端（只在 AI Worker 里用）拖进主包。
 * ──────────────────────────────────────────────────────────── */

/** 资源修订号：改了 public/egaroucid/ 才递增。 */
export const EGAROUCID_ASSET_VERSION = 'a1';

/** 引擎资源 URL（engine-worker.js 内部用相对路径取 egar.js / egar.wasm）。 */
export function egaroucidAssetUrl(file: string): string {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}egaroucid/${file}?v=${EGAROUCID_ASSET_VERSION}`;
}

/**
 * 引擎档位 → Egaroucid 搜索等级。
 *
 * Egaroucid 的 level 数值越大越强（官方网页版最高给到 60；其 level.hpp 中
 * ACCURATE_MAX_LEVEL=30、LIGHT_LEVEL=15）。这里的四档由弱到强。
 */
export const EGAROUCID_LEVELS: Record<1 | 2 | 3 | 4, number> = {
  1: 2,
  2: 6,
  3: 12,
  4: 24,
};

/** 「求一着 / 请神上身」用的档位（中上强度，兼顾等待时间）。 */
export const EGAROUCID_HINT_LEVEL = 12;

/** 资源大小（进度条在拿到响应头前先有个总数）。 */
export const EGAROUCID_WASM_BYTES = 1_427_921;
export const EGAROUCID_JS_BYTES = 56_574;

/**
 * 主线程预取引擎资源，触发一次真实下载并回报进度。
 *
 * Worker 里 Emscripten 会自己 fetch egar.wasm，这里先下同 URL 让它命中
 * HTTP 缓存，就能在界面上给出准确进度，也不用把 1.4MB 字节经 postMessage
 * 传递（与 Rapfi 的 dataBuffer 注入不同，wasm 由 Emscripten 自己加载）。
 */
export async function prefetchEgaroucid(
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const files: Array<[string, number]> = [
    ['egar.js', EGAROUCID_JS_BYTES],
    ['egar.wasm', EGAROUCID_WASM_BYTES],
  ];
  for (const [file, fallbackTotal] of files) {
    const res = await fetch(egaroucidAssetUrl(file));
    if (!res.ok) throw new Error(`${file} prefetch failed: ${res.status}`);
    const total = Number(res.headers.get('Content-Length')) || fallbackTotal;
    if (!res.body) {
      await res.arrayBuffer();
      onProgress?.(total, total);
      continue;
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
}
