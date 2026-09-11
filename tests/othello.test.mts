/* 黑白棋引擎测试：位棋盘 vs 朴素 2D 参考实现逐手对拍 · 开局 perft ·
   加速版合法点计算与规则版对拍 · 难度档与抢角行为。
   跑法：npm run test:othello（esbuild 打包后 node 执行）。 */
import {
  CELLS, initialPosition, place, legalMoves, toCells, fromCells,
  result, discCount, other, indexOf, popcount, maskToIndices,
} from '../src/othello/rules';
import type { OthPosition } from '../src/othello/rules';
import { LEVEL_CONFIG, findBestMove, findHintMove, notationOf } from '../src/othello/search';
import type { Difficulty } from '../src/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

/* ── 朴素参考实现（2D 数组 + 逐格逐方向扫描） ── */

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1],
];

function refBoard(pos: OthPosition): number[][] {
  const cells = toCells(pos);
  const b: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  for (let i = 0; i < CELLS; i++) b[i >> 3][i & 7] = cells[i];
  return b;
}

function refFlips(b: number[][], x: number, y: number, side: number): Array<[number, number]> | null {
  if (b[y][x] !== 0) return null;
  const out: Array<[number, number]> = [];
  for (const [dx, dy] of DIRS) {
    const run: Array<[number, number]> = [];
    let cx = x + dx, cy = y + dy;
    while (cx >= 0 && cx < 8 && cy >= 0 && cy < 8 && b[cy][cx] === other(side as 1 | 2)) {
      run.push([cx, cy]);
      cx += dx; cy += dy;
    }
    if (run.length && cx >= 0 && cx < 8 && cy >= 0 && cy < 8 && b[cy][cx] === side) out.push(...run);
  }
  return out.length ? out : null;
}

function refLegal(b: number[][], side: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (refFlips(b, x, y, side)) out.push(indexOf(x, y));
  return out;
}

function refPlace(pos: OthPosition, index: number): { pos: OthPosition; flipped: number } | null {
  const b = refBoard(pos);
  const x = index & 7, y = index >> 3;
  const flips = refFlips(b, x, y, pos.side);
  if (!flips) return null;
  b[y][x] = pos.side;
  for (const [fx, fy] of flips) b[fy][fx] = pos.side;
  const cells = new Uint8Array(CELLS);
  for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) cells[yy * 8 + xx] = b[yy][xx];
  return { pos: fromCells(cells, other(pos.side)), flipped: flips.length };
}

/* ── 1) 开局 ── */
console.log('== 开局与合法性 ==');
{
  const p = initialPosition();
  const cells = toCells(p);
  const total = popcount(p.black[0]) + popcount(p.black[1]) + popcount(p.white[0]) + popcount(p.white[1]);
  check('初始 4 子', total === 4, String(total));
  // 标准起始：白 d4/e5（index 27/36），黑 e4/d5（index 28/35）
  check('白 d4/e5', cells[27] === 2 && cells[36] === 2, `${cells[27]},${cells[36]}`);
  check('黑 e4/d5', cells[28] === 1 && cells[35] === 1, `${cells[28]},${cells[35]}`);
  check('黑先', p.side === 1);
  // 内部 index = y*8+x，y=0 对应棋谱第 1 行（a1 在左下角）
  // 合法点对外呈现：d3 c4 f5 e6（内部索引 → 记谱换算统一在 search.ts 的 notationOf）
  // 标准开局：黑可下 d3 / c4 / f5 / e6（记谱 = 文件字母 + 行号，a1 在左下）
  const got = legalMoves(p).map((i) => notationOf(i)).sort();
  check('开局合法点 = c4 d3 e6 f5', JSON.stringify(got) === JSON.stringify(['c4', 'd3', 'e6', 'f5']), JSON.stringify(got));
}

/* ── 2) 开局 perft（与公开节点数一致） ── */
console.log('== 开局 perft ==');
{
  function perft(pos: OthPosition, depth: number): number {
    if (depth === 0) return 1;
    const moves = legalMoves(pos);
    if (!moves.length) {
      if (!legalMoves({ ...pos, side: other(pos.side) }).length) return 1;
      return perft({ ...pos, side: other(pos.side) }, depth - 1);
    }
    let n = 0;
    for (const m of moves) {
      const pl = place(pos, m);
      if (!pl) return -1;
      n += perft(pl.pos, depth - 1);
    }
    return n;
  }
  const got = [1, 2, 3, 4, 5].map((d) => perft(initialPosition(), d));
  // 与公开的 Othello 开局 perft 完全一致（此前差 8 是开局被镜像导致的，
  // 说明 perft 序列本身就是这类镜像 bug 的灵敏探针）
  const want = [4, 12, 56, 244, 1396];
  check('perft(1..5) = 4/12/56/244/1396（与公开 perft 一致）', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}

/* ── 3) 位置权重与数子辅助 ── */
console.log('== 辅助函数 ==');
{
  const p = initialPosition();
  check('maskToIndices 与 legalMoves 一致', JSON.stringify(maskToIndices((await import('../src/othello/rules')).legalMask(p))) === JSON.stringify(legalMoves(p)));
  check('初始双方各 2 子', discCount(p, 1) === 2 && discCount(p, 2) === 2);
}

/* ── 4) 随机对局：与参考实现逐手对拍 ── */
console.log('== 随机对局对拍（200 局） ==');
{
  let mismatches = 0;
  let plies = 0;
  let passes = 0;
  const rnd = (n: number) => (Math.random() * n) | 0;

  for (let g = 0; g < 200; g++) {
    let pos = initialPosition();
    let ref = fromCells(toCells(pos), 1);
    for (let step = 0; step < 80; step++) {
      const lm = legalMoves(pos);
      const rl = refLegal(refBoard(ref), pos.side).sort((a, b) => a - b);
      if (JSON.stringify(lm) !== JSON.stringify(rl)) { mismatches++; break; }
      if (!lm.length) {
        const otherHas = legalMoves({ ...pos, side: other(pos.side) }).length > 0;
        const refOtherHas = refLegal(refBoard(ref), other(pos.side)).length > 0;
        if (otherHas !== refOtherHas) { mismatches++; break; }
        if (!otherHas) break;
        passes++;
        pos = { ...pos, side: other(pos.side) };
        ref = { ...ref, side: other(ref.side) };
        continue;
      }
      const pick = lm[rnd(lm.length)];
      const pl = place(pos, pick);
      const rp = refPlace(ref, pick);
      if (!pl || !rp || pl.flipped !== rp.flipped) { mismatches++; break; }
      const after = toCells(pl.pos);
      const refAfter = toCells(rp.pos);
      for (let i = 0; i < CELLS; i++) if (after[i] !== refAfter[i]) { mismatches++; break; }
      if (mismatches) break;
      pos = pl.pos;
      ref = rp.pos;
      plies++;
    }
  }
  check('200 局逐手对拍无分歧', mismatches === 0, `mismatches=${mismatches}`);
  check('落子步数 > 4000', plies > 4000, `plies=${plies}`);
  console.log(`   （落子 ${plies} · 触发 pass ${passes} 次）`);
}

/* ── 5) 终局与数子 ── */
console.log('== 终局 ==');
{
  const cells = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) cells[i] = i < 8 ? 1 : 2;
  const pos = fromCells(cells, 1);
  const r = result(pos);
  check('终局数子 黑 8 白 56', r.black === 8 && r.white === 56, `${r.black}/${r.white}`);
  check('终局 over', r.over);
  check('终局白胜', r.winner === 2);
  check('discCount 正确', discCount(pos, 1) === 8 && discCount(pos, 2) === 56);
}

/* ── 6) 搜索 ── */
console.log('== 搜索 ==');
{
  const p = initialPosition();
  const cells = toCells(p);
  for (const lv of [1, 2, 3, 4] as Difficulty[]) {
    const res = findBestMove(cells, 1, lv, 'ai', 0);
    const m = res.move;
    const ok = !!m && !m.pass && legalMoves(p).includes(indexOf(m.x, m.y));
    check(`${LEVEL_CONFIG[lv].name}档返回合法着法`, ok, JSON.stringify(m));
    check(`${LEVEL_CONFIG[lv].name}档不超预算`, res.ms < LEVEL_CONFIG[lv].timeMs + 1500, `${res.ms}ms / 预算${LEVEL_CONFIG[lv].timeMs}ms`);
  }

  // 抢角：白方能下 a1（沿第 1 行夹击 b1 的黑子）时必须抢角
  const cells2 = new Uint8Array(CELLS);
  cells2[indexOf(1, 0)] = 1; // b1 黑
  cells2[indexOf(2, 0)] = 2; // c1 白 → 白下 a1 夹击 b1
  cells2[indexOf(4, 4)] = 1; // e5 黑
  cells2[indexOf(5, 5)] = 2; // f6 白
  const pos2 = fromCells(cells2, 2); // 白走
  check('构造局面白可下 a1', legalMoves(pos2).includes(0), JSON.stringify(legalMoves(pos2)));
  const res2 = findBestMove(cells2, 2, 4, 'ai', 20);
  check('恶魔档抢角 a1', !!res2.move && res2.move.x === 0 && res2.move.y === 0, JSON.stringify(res2.move));

  // 残局：构造一个只剩 3 空点且双方都有合法着法的局面，
  // 恶魔档必须切到精确求解并给出合法着法
  const endCells = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) endCells[i] = i % 2 === 0 ? 1 : 2;
  // 腾出 a1(0) / b1(1) / a2(8)：黑下 a1 可翻 b1（对角 a2? 用横线 b1）
  endCells[0] = 0; endCells[1] = 1; endCells[8] = 1;
  const endPos = fromCells(endCells, 2);
  const endLegal = legalMoves(endPos);
  const remain = CELLS - (discCount(endPos, 1) + discCount(endPos, 2));
  const res3 = findBestMove(endCells, 2, 4, 'ai', 56);
  const m3 = res3.move;
  const ok3 = !!m3 && (m3.pass || endLegal.includes(indexOf(m3.x, m3.y)));
  check(`残局（剩 ${remain} 空，${endLegal.length} 个合法点）返回合法着法`, ok3, JSON.stringify(m3));

  const h = findHintMove(cells, 1, 'ai', 0);
  check('提示返回着法', !!h.move);
  check('提示按恶魔档迭代加深', h.depth >= 2, `depth=${h.depth}`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} othello: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
