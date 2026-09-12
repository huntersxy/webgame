/* ────────────────────────────────────────────────────────────
 *  core/time.ts — 单调时钟（毫秒）
 *
 *  performance 在浏览器、Web Worker 与 Node 16+ 里都是全局可用的，
 *  搜索热路径上不需要每次判断「有没有 performance」。
 * ──────────────────────────────────────────────────────────── */

export function nowMs(): number {
  return performance.now();
}
