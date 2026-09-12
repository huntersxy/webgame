/* ────────────────────────────────────────────────────────────
 *  ui/format.ts — Shared formatting helpers for the think panel
 * ──────────────────────────────────────────────────────────── */

export function fmtTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function fmtEval(v: number, mate: number): string {
  if (v >= mate - 1000) return '必胜';
  if (v <= -mate + 1000) return '必败';
  if (v > 50000) return '大优';
  if (v > 0) return `+${v}`;
  return `${v}`;
}

export function appendLog(element: HTMLElement, html: string, max = 40): void {
  const empty = element.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'tline';
  div.innerHTML = `<span class="tt">${fmtTime()}</span> ${html}`;
  element.prepend(div);
  while (element.children.length > max) element.lastChild?.remove();
}

export function setStats(element: HTMLElement, html: string): void {
  element.innerHTML = html;
}

export function toggleProgress(element: HTMLElement, on: boolean): void {
  element.classList.toggle('hidden', !on);
}
