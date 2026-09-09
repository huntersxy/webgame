/* 与恶魔对弈体验测试：
 *   第1局 人执黑(困难500ms) vs 恶魔白 —— 看胜负与漏防
 *   第2局 恶魔执黑 vs 人白 —— 看恶魔进攻力
 *   第3局 人执黑复刻第1局棋谱 —— 验证败局记忆触发（复盘能力）
 *   第4局 人执黑再复刻 —— 看它是否已经"学会"
 * 复刻 gomoku-controller 的恶魔记忆接线：checkLesson → 若搜索结果==败手则改走次优。 */

// localStorage shim for learn.ts
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

import { findBestMove, LEVEL_CONFIG } from '../src/gomoku/search';
import { checkWin, isBoardFull, other } from '../src/gomoku/rules';
import { checkLesson, recordLoss, detectWinningOpening, getLosses, lessonCount } from '../src/gomoku/learn';
import { GomokuEngine } from '../src/gomoku/engine';
import type { GomokuBoard, GomokuPlayer, Pt } from '../src/types';

LEVEL_CONFIG[3].timeMs = 500; // 人类陪练预算

const N = 15;
const empty = (): GomokuBoard => Array.from({ length: N }, () => new Array(N).fill(0));
const clone = (b: GomokuBoard): GomokuBoard => b.map((r) => [...r]) as GomokuBoard;
const stones = (b: GomokuBoard): number => b.reduce((n, row) => n + row.filter((v) => v).length, 0);

interface MoveLog { x: number; y: number; c: GomokuPlayer }
interface GameResult {
  winner: GomokuPlayer | 0;
  moves: number;
  humanMoves: MoveLog[];
  fullMoves: MoveLog[];
  demonLines: string[];
  lessonFires: string[];
  blunders: string[];
  instants: number;
  demonMs: number[];
}

/** 人类侧：引擎困难档 */
function humanMove(b: GomokuBoard, player: GomokuPlayer): Pt {
  const r = findBestMove(clone(b), player, 3, 'ai', stones(b));
  return r.move!;
}

/** 恶魔侧：完整复刻 controller 的记忆接线 */
function demonMove(b: GomokuBoard, player: GomokuPlayer, g: GameResult): Pt {
  const lesson = checkLesson(clone(b));
  const res = findBestMove(clone(b), player, 4, 'ai', stones(b));
  let m = res.move!;
  const who = player === 1 ? '黑' : '白';
  const tag = `d${res.depth} ${res.ms}ms nodes=${res.nodes} eval=${res.eval}${res.instant ? ' ⚡秒断' : ''}${res.book ? ' 📖开局库' : ''}`;
  if (res.instant) g.instants++;
  g.demonMs.push(res.ms);

  if (lesson && m && m.x === lesson.x && m.y === lesson.y) {
    const alt = (res.scores || []).find((s) => s.x !== lesson.x || s.y !== lesson.y);
    if (alt) {
      const line = `📖 恶魔记忆触发：局面第${stones(b)}手，前次走(${lesson.x},${lesson.y})落败×${lesson.count} → 改走(${alt.x},${alt.y})`;
      g.lessonFires.push(line);
      m = alt;
    }
  }

  // 漏防检测：恶魔落子前，人类有恰好1个成五点且恶魔没有自己的成五抢先 → 必须堵
  const chk = new GomokuEngine();
  chk.load2D(b);
  const humanIdx = (player === 1 ? 1 : 0);
  const threat = chk.winCellCount(humanIdx) === 1 ? chk.winCell(humanIdx) : -1;
  const ownCounter = chk.winCellCount(player - 1) > 0;
  const tx = threat % N;
  const ty = Math.floor(threat / N);
  if (threat >= 0 && !ownCounter && (m.x !== tx || m.y !== ty)) {
    g.blunders.push(`☠️ 漏防：(${tx},${ty}) 有人类成五点未堵，恶魔走了(${m.x},${m.y}) [${who}]`);
  }
  g.demonLines.push(`  恶魔${who} (${m.x},${m.y}) ${tag}${lesson ? ` [记忆×${lesson.count}]` : ''}`);
  return m;
}

function playGame(humanColor: GomokuPlayer, scripted: MoveLog[] | null, label: string): GameResult {
  console.log(`\n══════ ${label} ══════`);
  const b = empty();
  const g: GameResult = { winner: 0, moves: 0, humanMoves: [], fullMoves: [], demonLines: [], lessonFires: [], blunders: [], instants: 0, demonMs: [] };
  let turn: GomokuPlayer = 1;
  let si = 0;
  while (g.moves < 120) {
    const isHuman = turn === humanColor;
    let m: Pt;
    if (isHuman) {
      const sp = scripted?.[si];
      if (sp && b[sp.y][sp.x] === 0) { m = sp; si++; }
      else m = humanMove(b, turn);
    } else {
      m = demonMove(b, turn, g);
    }
    b[m.y][m.x] = turn;
    g.moves++;
    g.fullMoves.push({ x: m.x, y: m.y, c: turn });
    if (isHuman) g.humanMoves.push({ x: m.x, y: m.y, c: turn });
    if (checkWin(b, m.x, m.y)) { g.winner = turn; break; }
    if (isBoardFull(b)) { g.winner = 0; break; }
    turn = other(turn);
  }
  for (const l of g.demonLines) console.log(l);
  for (const l of g.lessonFires) console.log(l);
  for (const l of g.blunders) console.log(l);
  const w = g.winner === 0 ? '和棋' : g.winner === humanColor ? '人类胜 🎉' : '恶魔胜 😈';
  const avg = g.demonMs.length ? Math.round(g.demonMs.reduce((a, x) => a + x, 0) / g.demonMs.length) : 0;
  const mx = g.demonMs.length ? Math.max(...g.demonMs) : 0;
  console.log(`结果: ${w} · 共${g.moves}手 · 恶魔均耗时${avg}ms(峰值${mx}ms) · 秒断${g.instants}次 · 漏防${g.blunders.length}次 · 记忆触发${g.lessonFires.length}次`);
  return g;
}

// ── 第1局：人执黑 vs 恶魔白 ──
const g1 = playGame(1, null, '第1局 · 人执黑 vs 恶魔白');
if (g1.winner === 1) {
  const op = detectWinningOpening(g1.fullMoves, 1);
  const r = recordLoss(g1.fullMoves, 1, 4, op?.name ?? null);
  console.log(`📉 恶魔复盘：败局#${r.losses} 已归档${op ? `（开局「${op.name}」${op.exact ? '必胜定式' : '起手式'}）` : ''}，教训库 ${r.lessons} 条`);
} else {
  console.log('第1局恶魔获胜 —— 无需复盘');
}

// ── 第2局：恶魔执黑进攻 ──
const g2 = playGame(2, null, '第2局 · 恶魔执黑 vs 人白');

// ── 第3局：人类复刻第1局开局，验证记忆 ──
const g3 = playGame(1, g1.humanMoves, '第3局 · 人执黑复刻第1局棋谱（复盘能力验证）');
if (g3.winner === 1) {
  const op = detectWinningOpening(g3.fullMoves, 1);
  const r = recordLoss(g3.fullMoves, 1, 4, op?.name ?? null);
  console.log(`📉 恶魔再次复盘：败局#${r.losses}，教训库 ${r.lessons} 条`);
}

// ── 第4局：再复刻一次，看学习是否收敛 ──
const g4 = playGame(1, g1.humanMoves, '第4局 · 同一棋谱第三次挑战（记忆收敛观察）');

// ── 败局档案总览 ──
console.log('\n══════ 恶魔败局档案（弹窗同款数据） ══════');
const losses = getLosses();
console.log(`总败局: ${losses.length} · 教训总数: ${lessonCount()}`);
for (const l of losses) {
  console.log(`  败局 ${new Date(l.ts).toLocaleTimeString()} · 人类执${l.human === 1 ? '黑' : '白'} · ${l.moves.length}手 · 开局: ${l.opening ?? '未识别'}`);
}
