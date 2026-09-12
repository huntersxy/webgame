/* 象棋 α-β 引擎回归测试：重点盯「恶魔档时间预算被撞线」这一类
   会让结果不自洽的路径（曾实测把「炮2进7吃马」这种亏子交换算成大优）。 */
import { createInitialBoard, legalMoves, makeMove } from '../src/xiangqi/rules';
import { findBestMove, resetXqWarmDepth } from '../src/xiangqi/search';
import type { GameMode, XqBoard, XqMove } from '../src/types';
import { check, finish } from './harness.mts';

const PVP: GameMode = 'pvp';


/** 红先 炮二平五（(7,7)→(4,7)）之后轮到黑方；此时黑炮 (1,2) 可用红炮 (1,7) 当炮架吃 (1,9) 的红马，
 *  但红车 a0 能吃回 —— 交换下来黑方亏（炮 300 换 马 270）。 */
function centerCannonPosition(): XqBoard {
  const b = createInitialBoard();
  const first = legalMoves(b, 'r').find((m) => m.fx === 7 && m.fy === 7 && m.tx === 4 && m.ty === 7)!;
  makeMove(b, first);
  return b;
}

const isCannonGrab = (m: XqMove | null | undefined) => !!m && m.fx === 1 && m.fy === 2 && m.tx === 1 && m.ty === 9;

/** 把 performance.now 换成每次调用前进 stepMs 的假时钟：模拟慢机器撞时间预算 */
function withFakeClock<T>(stepMs: number, fn: () => T): T {
  const real = (globalThis as { performance?: { now(): number } }).performance;
  let t = 0;
  (globalThis as { performance?: { now(): number } }).performance = { now: () => (t += stepMs) };
  try { return fn(); } finally {
    (globalThis as { performance?: { now(): number } }).performance = real;
  }
}

/* ── ① 局面本身：该吃子合法，但红方能吃回 ── */
{
  const b = centerCannonPosition();
  const grab = legalMoves(b, 'b').find((m) => m.fx === 1 && m.fy === 2 && m.tx === 1 && m.ty === 9);
  check('炮(1,2)吃马(1,9) 合法（红炮 (1,7) 当炮架）', !!grab);
  const after = b.map((r) => [...r]) as XqBoard;
  makeMove(after, grab!);
  check('红方能用 a0 车吃回这枚炮', legalMoves(after, 'r').some((m) => m.tx === 1 && m.ty === 9));
}

/* ── ② 完整搜索：不选亏子交换，且该着法评分为负 ── */
{
  const b = centerCannonPosition();
  resetXqWarmDepth();
  const rootOut: Array<XqMove & { v: number }> = [];
  const res = findBestMove(b, 'b', 3, PVP, 1, true, rootOut, true);
  const grabScore = rootOut.find((m) => m.fx === 1 && m.fy === 2 && m.tx === 1 && m.ty === 9);
  check('困难档不选炮吃马', !isCannonGrab(res.move), `${res.move?.fx},${res.move?.fy}→${res.move?.tx},${res.move?.ty}`);
  check('炮吃马的根评分是负的（引擎知道会被吃回）', !!grabScore && (grabScore.v ?? 0) < 0, String(grabScore?.v));
}

/* ── ③ 恶魔档 + 时间预算被截断：仍必须给出自洽结果（本轮回归点） ── */
{
  resetXqWarmDepth();
  const rootOut: Array<XqMove & { v: number }> = [];
  const res = withFakeClock(50, () => findBestMove(centerCannonPosition(), 'b', 4, PVP, 1, true, rootOut, true));
  const grabScore = rootOut.find((m) => m.fx === 1 && m.fy === 2 && m.tx === 1 && m.ty === 9);
  check('恶魔档即使第一轮迭代就被掐断，也不选炮吃马', !isCannonGrab(res.move), `${res.move?.fx},${res.move?.fy}→${res.move?.tx},${res.move?.ty}`);
  check('截断时退回完整浅层结果（评分自洽，不为大优）', !grabScore || (grabScore.v ?? 0) < 0, String(grabScore?.v));
  check('截断时报告的是完整跑完的深度', res.depth <= 3, String(res.depth));
}

/* ── ④ 一步杀在恶魔档也必须算准（回归杀棋不被预算吃掉） ── */
{
  const mate = createInitialBoard();
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) mate[y][x] = null;
  mate[0][4] = 'k';
  mate[9][3] = 'K';
  mate[1][0] = 'R';
  mate[3][8] = 'R';
  resetXqWarmDepth();
  const res = withFakeClock(50, () => findBestMove(mate, 'r', 4, PVP, 1, true, undefined, true));
  check('恶魔档在预算被掐断时仍走出一步杀 i6-i9', !!res.move && res.move.fx === 8 && res.move.fy === 3 && res.move.tx === 8 && res.move.ty === 0);
}

finish('xqsearch');
