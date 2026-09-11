/* 残局强弱实测：从「剩 N 空」的真实局面出发，让困难档与恶魔档对弈。
 *
 * 恶魔档与困难档在开局阶段深度接近（7~8 层），真正的差异在残局：恶魔档从
 * 剩 14 空起切换为完全搜索（精确求解），困难档始终用评估函数。这个脚本就是
 * 量化那部分差异——同一批残局、双方轮流执黑执白。
 *
 * 环境变量：
 *   ENDGAME_BUDGET  每手毫秒预算（默认 800，便于快速跑出统计）
 *   ENDGAME_GAMES   每个残局的对局数（默认 4）
 */
import { CELLS, initialPosition, legalMoves, place, other, result, toCells, discCount } from '../src/othello/rules';
import type { OthPosition } from '../src/othello/rules';
import { findBestMove } from '../src/othello/search';
import type { Difficulty } from '../src/types';

const BUDGET = Number(process.env.ENDGAME_BUDGET ?? '800');
const PER_POS = Number(process.env.ENDGAME_GAMES ?? '4');

/** 指定难度的 agent；budgetOverride 用一个统一预算替换档位默认预算 */
function agent(level: Difficulty, budgetOverride?: number) {
  return (pos: OthPosition, cells: Uint8Array): number => {
    const res = findBestMove(cells, pos.side, level, 'ai', 60, budgetOverride);
    const m = res.move;
    if (!m || m.pass) return -1;
    return m.y * 8 + m.x;
  };
}

/** 从随机对局里采样「剩 N 空」的局面（保证双方都有合法着法） */
function sampleEndgame(targetEmpties: number, seed: number): OthPosition | null {
  let r = seed >>> 0;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 0xffffffff);
  for (let attempt = 0; attempt < 400; attempt++) {
    let pos = initialPosition();
    for (let ply = 0; ply < 120; ply++) {
      const empties = CELLS - (discCount(pos, 1) + discCount(pos, 2));
      if (empties <= targetEmpties) {
        const ms = legalMoves(pos);
        const oppHas = legalMoves({ ...pos, side: other(pos.side) }).length > 0;
        if (ms.length > 1 && oppHas) return pos;
        break;
      }
      const ms = legalMoves(pos);
      if (!ms.length) {
        if (!legalMoves({ ...pos, side: other(pos.side) }).length) break;
        pos = { ...pos, side: other(pos.side) };
        continue;
      }
      pos = place(pos, ms[(rnd() * ms.length) | 0])!.pos;
    }
  }
  return null;
}

function playGame(black: (p: OthPosition, c: Uint8Array) => number, white: typeof black, start: OthPosition): { winner: 0 | 1 | 2; black: number; white: number } {
  let pos: OthPosition = { ...start, side: 1 };
  for (let ply = 0; ply < 80; ply++) {
    const st = result(pos);
    if (st.over) return { winner: st.winner, black: st.black, white: st.white };
    const idx = (pos.side === 1 ? black : white)(pos, toCells(pos));
    if (idx < 0) {
      pos = { ...pos, side: other(pos.side) };
      if (!legalMoves(pos).length) { const r = result(pos); return { winner: r.winner, black: r.black, white: r.white }; }
      continue;
    }
    const pl = place(pos, idx);
    if (!pl) throw new Error(`非法着法 ${idx}`);
    pos = pl.pos;
  }
  const r = result(pos);
  return { winner: r.winner, black: r.black, white: r.white };
}

console.log(`== 残局对局：困难档 vs 恶魔档（每手 ${BUDGET}ms，每个局面 ${PER_POS} 局，双方轮流先手）==`);
const hard = agent(3, BUDGET);
const demon = agent(4, BUDGET);
let hardWin = 0, demonWin = 0, draw = 0;
let idx = 0;
for (const target of [12, 14, 16, 18]) {
  for (let g = 0; g < PER_POS; g++) {
    seedLoop:
    for (let seed = idx * 977 + 1; seed < idx * 977 + 60; seed++) {
      const pos = sampleEndgame(target, seed);
      if (!pos) continue;
      idx++;
      // 交替执黑
      const demonIsBlack = idx % 2 === 1;
      const r = demonIsBlack
        ? playGame(demon, hard, pos)
        : playGame(hard, demon, pos);
      const winner = r.winner;
      const demonWon = winner !== 0 && ((winner === 1) === demonIsBlack);
      if (winner === 0) draw++;
      else if (demonWon) demonWin++;
      else hardWin++;
      console.log(`  剩${CELLS - (discCount(pos, 1) + discCount(pos, 2))}空 第${idx}局：恶魔${demonIsBlack ? '执黑' : '执白'} → ${winner === 0 ? '和' : (demonWon ? '恶魔胜' : '困难胜')}（黑 ${r.black}:${r.white} 白）`);
      break seedLoop;
    }
  }
}
console.log(`\n结果：恶魔 ${demonWin} 胜 · 困难 ${hardWin} 胜 · 和 ${draw}`);
const rate = demonWin / Math.max(1, demonWin + hardWin);
console.log(`恶魔档在残局对局中的得分率：${(rate * 100).toFixed(0)}%`);
process.exit(0);
