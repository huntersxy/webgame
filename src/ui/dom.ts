/* ────────────────────────────────────────────────────────────
 *  ui/dom.ts — DOM 元素取用
 * ──────────────────────────────────────────────────────────── */

/**
 * 取 index.html 里的静态元素。页面是单文件外壳、所有 id 都在 index.html 里，
 * 取不到就是 id 写错了或外壳与脚本版本不匹配——直接抛错，比让界面静默不更新
 * 更容易发现。
 */
export function mustEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少 DOM 元素 #${id}`);
  return el as T;
}
