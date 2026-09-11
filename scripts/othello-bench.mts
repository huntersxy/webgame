/* 黑白棋 AI 实力测量（一次性基准脚本，跑法：node .tmp/bench.mjs 由 esbuild 打包后执行）
 *
 * 做三件事：
 *   1. 各难度档自对弈赛（固定开局 + 交替先手），统计胜率
 *   2. 对「随机落子」和「一层贪心」两个基线跑分，给一个量级判断
 *   3. 实测各档在真实局面下的平均搜索深度与节点数
 *
 * 注意：自对弈只能说明各档相对强弱，不能换算成人类段位或 Elo。
 */
import {
  CELLS, initialPosition, legalMoves, place, other, result, toCells, discCount,
} from '../src/othello/rules';
import type { OthPosition } from '../src/othello/rules';
import { findBestMove } from '../src/othello/search';
import type { Difficulty } from '../src/types';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
};

type Agent = (pos: OthPosition, cells: Uint8Array) => number;

/** 难度档 agent */
function levelAgent(level: Difficulty): Agent {
  return (pos, cells) => {
    const res = findBestMove(cells, pos.side, level, 'ai', 60);
    const m = res.move;
    if (!m || m.pass) return -1;
    return (m.y) * 8 + m.x; // Pt 的 y 自下而上，与内部索引一致
  };
}

/** 基线：随机合法着法 */
const randomAgent: Agent = (pos) => {
  const ms = legalMoves(pos);
  return ms.length ? ms[(Math.random() * ms.length) | 0] : -1;
};

/** 基线：一层贪心（角 > 行动力 > 翻子数） */
const greedyAgent: Agent = (pos) => {
  const ms = legalMoves(pos);
  if (!ms.length) return -1;
  const corners = [0, 7, 56, 63];
  let best = ms[0], bestS = -Infinity;
  for (const i of ms) {
    const pl = place(pos, i);
    if (!pl) continue;
    let s = pl.flipped * 2;
    if (corners.includes(i)) s += 100;
    // 对手行动力越少越好
    const oppMob = legalMoves(pl.pos).length;
    s -= oppMob * 3;
    if (s > bestS) { bestS = s; best = i; }
  }
  return best;
};

/** 跑一局，返回终局盘面 */
function playGame(black: Agent, white: Agent): OthPosition {
  let pos = initialPosition();
  for (let ply = 0; ply < 200; ply++) {
    const st = result(pos);
    if (st.over) break;
    const cells = toCells(pos);
    const agent = pos.side === 1 ? black : white;
    const idx = agent(pos, cells);
    if (idx < 0) {
      // 停手
      const next = { ...pos, side: other(pos.side) };
      if (!legalMoves(next).length) break;
      pos = next;
      continue;
    }
    const pl = place(pos, idx);
    if (!pl) throw new Error(`agent 返回非法着法 ${idx}`);
    pos = pl.pos;
  }
  return pos;
}

function match(a: Agent, b: Agent, games: number): { aWin: number; bWin: number; draw: number } {
  let aWin = 0, bWin = 0, draw = 0;
  for (let g = 0; g < games; g++) {
    const aIsBlack = g % 2 === 0; // 交替先手，消掉先后手优势
    const final = aIsBlack ? playGame(a, b) : playGame(b, a);
    const r = result(final);
    if (r.winner === 0) { draw++; continue; }
    const aWon = (r.winner === 1) === aIsBlack;
    if (aWon) aWin++; else bWin++;
  }
  return { aWin, bWin, draw };
}

// 恶魔档单局可达 1~2 分钟，故按档位缩减局数。
// BENCH_SECTION 只跑指定小节（pair / base / depth），BENCH_ONLY 限定参与的档位，便于分段后台跑。
const FULL = Number(process.env.BENCH_FULL ?? '0') === 1;
const SECTION = process.env.BENCH_SECTION ?? 'all';
const ONLY = (process.env.BENCH_ONLY ?? '').split(',').filter(Boolean).map(Number);
const inOnly = (l: Difficulty) => ONLY.length === 0 || ONLY.includes(l);
const gamesFor = (a: Difficulty, b: Difficulty) => {
  const hi = Math.max(a, b);
  if (hi === 4) return FULL ? 12 : 2;
  if (hi === 3) return FULL ? 12 : 4;
  return 12;
};
const baseGames = FULL ? 20 : 10;

console.log('== 1) 难度档自对弈（高档位缩减局数，交替先手）==');
const LEVELS: Difficulty[] = ([1, 2, 3, 4] as Difficulty[]).filter(inOnly);
const names: Record<Difficulty, string> = { 1: '简单', 2: '普通', 3: '困难', 4: '恶魔' };
const doPair = SECTION === 'all' || SECTION === 'pair';
const doBase = SECTION === 'all' || SECTION === 'base';
const doDepth = SECTION === 'all' || SECTION === 'depth';
const agents = new Map<Difficulty, Agent>(LEVELS.map((l) => [l, levelAgent(l)]));
if (doPair) {
console.log('== 1) 难度档自对弈（高档位缩减局数，交替先手）==');
for (let i = 0; i < LEVELS.length; i++) {
  for (let j = i + 1; j < LEVELS.length; j++) {
    const A = LEVELS[i], B = LEVELS[j];
    const r = match(agents.get(A)!, agents.get(B)!, gamesFor(A, B));
    const rate = (r.aWin / (r.aWin + r.bWin + r.draw || 1)) * 100;
    console.log(`  ${names[A]} vs ${names[B]}: ${r.aWin}-${r.bWin}-${r.draw}（${names[A]} 得分率 ${rate.toFixed(0)}%）`);
    check(`${names[B]} 不弱于 ${names[A]}`, r.bWin >= r.aWin, `${r.aWin}-${r.bWin}`);
  }
}
}

if (doBase) {
console.log('== 2) 对基线跑分（交替先手）==');
for (const lv of LEVELS) {
  // 高档位对基线只需少数几局即可说明问题
  const n = lv >= 3 ? (FULL ? 20 : 4) : baseGames;
  const r1 = match(agents.get(lv)!, randomAgent, n);
  const r2 = match(agents.get(lv)!, greedyAgent, n);
  console.log(`  ${names[lv]} vs 随机: ${r1.aWin}-${r1.bWin}-${r1.draw}（${n} 局）`);
  console.log(`  ${names[lv]} vs 一层贪心: ${r2.aWin}-${r2.bWin}-${r2.draw}（${n} 局）`);
  check(`${names[lv]} 能稳定赢随机`, r1.aWin / n >= 0.9, `${r1.aWin}/${n}`);
}
}

if (doDepth) {
console.log('== 3) 实测搜索深度 / 节点 / 用时（开局与前中盘各取几个局面）==');
{
  const probes: Array<[string, OthPosition]> = [];
  // 用随机对局采样几个不同阶段局面
  let pos = initialPosition();
  for (let ply = 0; ply < 40; ply++) {
    const ms = legalMoves(pos);
    const empties = CELLS - (discCount(pos, 1) + discCount(pos, 2));
    if (empties === 52 || empties === 40 || empties === 28 || empties === 18) probes.push([`剩 ${empties} 空`, pos]);
    if (!ms.length) { pos = { ...pos, side: other(pos.side) }; continue; }
    pos = place(pos, ms[(Math.random() * ms.length) | 0])!.pos;
  }
  for (const lv of LEVELS) {
    const rows: string[] = [];
    for (const [tag, p] of probes) {
      const res = findBestMove(toCells(p), p.side, lv, 'ai', 60);
      rows.push(`${tag}: depth${res.depth} 节点${res.nodes.toLocaleString()} ${res.ms}ms`);
    }
    console.log(`  ${names[lv]} → ${rows.join(' | ')}`);
  }
}
}

console.log(`\n${fail === 0 ? '✅' : '❌'} othello-bench: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
