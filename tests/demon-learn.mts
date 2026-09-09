/* 定向验证恶魔复盘：人类(引擎困难档,带随机)反复挑战执黑，
 * 直到击败恶魔 → recordLoss 提取教训 → 用同一棋谱重放，
 * 观察恶魔记忆是否触发、改走后结果是否改善。 */

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

import { findBestMove, LEVEL_CONFIG } from '../src/gomoku/search';
import { checkWin, isBoardFull, other } from '../src/gomoku/rules';
import { checkLesson, recordLoss, detectWinningOpening, getLosses, lessonCount } from '../src/gomoku/learn';
import type { GomokuBoard, GomokuPlayer, Pt } from '../src/types';

LEVEL_CONFIG[3].timeMs = 500;
const N = 15;
const empty = (): GomokuBoard => Array.from({ length: N }, () => new Array(N).fill(0));
const clone = (b: GomokuBoard): GomokuBoard => b.map((r) => [...r]) as GomokuBoard;
const stones = (b: GomokuBoard): number => b.reduce((n, row) => n + row.filter((v) => v).length, 0);
type MoveLog = { x: number; y: number; c: GomokuPlayer };

function demonMove(b: GomokuBoard, player: GomokuPlayer): { m: Pt; fired: string | null } {
  const lesson = checkLesson(clone(b));
  const res = findBestMove(clone(b), player, 4, 'ai', stones(b));
  let m = res.move!;
  let fired: string | null = null;
  if (lesson && m && m.x === lesson.x && m.y === lesson.y) {
    const alt = (res.scores || []).find((s) => s.x !== lesson.x || s.y !== lesson.y);
    if (alt) {
      fired = `此局面(${lesson.x},${lesson.y})为前次败手×${lesson.count} → 改走(${alt.x},${alt.y})`;
      m = alt;
    } else {
      fired = `记忆命中(${lesson.x},${lesson.y})但无备选候选，维持原着`;
    }
  }
  return { m, fired };
}

function playGame(humanColor: GomokuPlayer, scripted: MoveLog[] | null, label: string) {
  console.log(`\n══════ ${label} ══════`);
  const b = empty();
  const full: MoveLog[] = [];
  const humanMoves: MoveLog[] = [];
  const fires: string[] = [];
  let turn: GomokuPlayer = 1;
  let winner: GomokuPlayer | 0 = 0;
  let si = 0;
  while (full.length < 120) {
    let m: Pt;
    if (turn === humanColor) {
      const sp = scripted?.[si];
      m = (sp && b[sp.y][sp.x] === 0) ? (si++, sp) : findBestMove(clone(b), turn, 3, 'ai', stones(b)).move!;
    } else {
      const r = demonMove(b, turn);
      m = r.m;
      if (r.fired) fires.push(`  📖 第${full.length + 1}手 [恶魔${turn === 1 ? '黑' : '白'}(${m.x},${m.y})] ${r.fired}`);
    }
    b[m.y][m.x] = turn;
    full.push({ x: m.x, y: m.y, c: turn });
    if (turn === humanColor) humanMoves.push({ x: m.x, y: m.y, c: turn });
    if (checkWin(b, m.x, m.y)) { winner = turn; break; }
    if (isBoardFull(b)) { winner = 0; break; }
    turn = other(turn);
  }
  for (const f of fires) console.log(f);
  const w = winner === 0 ? '和棋' : winner === humanColor ? '人类胜 🎉' : '恶魔胜 😈';
  console.log(`结果: ${w} · 共${full.length}手`);
  return { winner, full, humanMoves };
}

// ── 挑战循环：直到人类赢一盘（最多5盘，人类档带随机，每盘不同） ──
let win: { winner: GomokuPlayer | 0; full: MoveLog[]; humanMoves: MoveLog[] } | null = null;
for (let attempt = 1; attempt <= 5; attempt++) {
  const g = playGame(1, null, `挑战局 ${attempt} · 人执黑 vs 恶魔白`);
  if (g.winner === 1) { win = g; break; }
}
if (!win) {
  console.log('\n⚠️ 人类5战全负 —— 恶魔防守无懈可击，无法产生败局样本');
  process.exit(0);
}

const op = detectWinningOpening(win.full, 1);
const r = recordLoss(win.full, 1, 4, op?.name ?? null);
console.log(`\n📉 恶魔复盘入库：败局#${r.losses}${op ? `（「${op.name}」${op.exact ? '必胜定式' : '起手式'}）` : ''} · 教训库 ${r.lessons} 条`);

// ── 复盘验证：同一棋谱重放 ──
const g2 = playGame(1, win.humanMoves, '重放局 · 人类原样复刻胜局棋谱');
if (g2.winner === 1) {
  const op2 = detectWinningOpening(g2.full, 1);
  const r2 = recordLoss(g2.full, 1, 4, op2?.name ?? null);
  console.log(`📉 二次入库：败局#${r2.losses} · 教训库 ${r2.lessons} 条`);
}
const g3 = playGame(1, win.humanMoves, '再重放 · 观察多轮学习后的抵抗');

console.log('\n══════ 档案总览 ══════');
console.log(`总败局 ${getLosses().length} · 教训 ${lessonCount()} 条`);
for (const l of getLosses()) {
  console.log(`  ${new Date(l.ts).toLocaleTimeString()} · 人类执${l.human === 1 ? '黑' : '白'} · ${l.moves.length}手 · ${l.opening ?? '未识别开局'}`);
}
