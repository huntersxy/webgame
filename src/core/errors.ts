/* ────────────────────────────────────────────────────────────
 *  core/errors.ts — 错误对象转可读文本
 * ──────────────────────────────────────────────────────────── */

/** 把 catch 到的任意值转成一句话，用于日志与界面提示。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把 catch 到的任意值转成 Error（原样返回已经是 Error 的）。 */
export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
