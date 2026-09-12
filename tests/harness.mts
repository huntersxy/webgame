/* ────────────────────────────────────────────────────────────
 *  tests/harness.mts — 断言与汇总（各 *test.mts 共用）
 *
 *  import { check, assert, section, finish } from './harness.mts';
 *
 *    check('名字', 条件, '失败时的补充信息')   记一笔，继续跑后面的用例
 *    assert(条件, '名字')                     同一件事，断言式写法
 *    section('分组标题')                      打印分组标题
 *    finish('engine')                         打印汇总并直接退出（失败退出码 1）
 *
 *  finish() 一律 process.exit：有的测试（控制器）会留下未清理的定时器，
 *  不退出的话 node 会一直挂着。
 * ──────────────────────────────────────────────────────────── */

let pass = 0;
let fail = 0;

export function section(title: string): void {
  console.log(`== ${title} ==`);
}

export function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
    return;
  }
  fail++;
  console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`);
}

/** 与 check 同义，参数顺序相反（断言式写法）。 */
export function assert(cond: boolean, name: string): void {
  check(name, cond);
}

export function finish(label: string): void {
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${label}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
