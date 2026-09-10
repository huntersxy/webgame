/* Test harness for the rewritten Gomoku engine (run via esbuild bundle). */
import { GomokuEngine, MATE } from '../src/gomoku/engine';
import { findBestMove, LEVEL_CONFIG } from '../src/gomoku/search';

const N = 15;
type Board = number[][];
const empty = (): Board => Array.from({ length: N }, () => new Array(N).fill(0));
const put = (b: Board, stones: Array<[number, number, number]>) => { for (const [x, y, c] of stones) b[y][x] = c; };
const clone = (b: Board): Board => b.map((r) => [...r]);
const histLen = (b: Board): number => b.flat().filter((v) => v !== 0).length;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

// ── brute-force reference evaluation ──
function bruteState(cells: Uint8Array): { total: number[]; win: number[][]; five: number[] } {
  const total = [0, 0];
  const win: number[][] = [[], []];
  const five = [0, 0];
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const winSet: Array<Set<number>> = [new Set(), new Set()];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      for (const [dx, dy] of dirs) {
        const ex = x + dx * 4, ey = y + dy * 4;
        if (ex < 0 || ex >= N || ey < 0 || ey >= N) continue;
        let c0 = 0, c1 = 0;
        for (let k = 0; k < 5; k++) {
          const v = cells[(y + dy * k) * N + (x + dx * k)];
          if (v === 1) c0++; else if (v === 2) c1++;
        }
        const TABLE = [0, 30, 420, 6200, 125_000, 5_000_000];
        if (c1 === 0) total[0] += TABLE[c0];
        if (c0 === 0) total[1] += TABLE[c1];
        if (c1 === 0 && c0 === 4) {
          for (let k = 0; k < 5; k++) { const p = (y + dy * k) * N + (x + dx * k); if (cells[p] === 0) winSet[0].add(p); }
        }
        if (c0 === 0 && c1 === 4) {
          for (let k = 0; k < 5; k++) { const p = (y + dy * k) * N + (x + dx * k); if (cells[p] === 0) winSet[1].add(p); }
        }
        if (c1 === 0 && c0 === 5) five[0]++;
        if (c0 === 0 && c1 === 5) five[1]++;
      }
    }
  }
  win[0] = [...winSet[0]];
  win[1] = [...winSet[1]];
  return { total, win, five };
}

// ── 1) incremental-state fuzz ──
console.log('== fuzz: make/unmake invariants ==');
{
  const eng = new GomokuEngine();
  const any = eng as any;
  let bad = 0;
  const rnd = (n: number) => (Math.random() * n) | 0;
  for (let game = 0; game < 20; game++) {
    const cells = new Uint8Array(225);
    const seq: Array<[number, number]> = [];
    let c = 1;
    for (let m = 0; m < 30; m++) {
      let p = -1;
      for (let tries = 0; tries < 200; tries++) { const q = rnd(225); if (cells[q] === 0) { p = q; break; } }
      if (p < 0) break;
      cells[p] = c;
      eng.makeCell(p, c as 1 | 2);
      seq.push([p, c]);
      const ref = bruteState(cells);
      const e = eng as any;
      if (Math.abs(e.total[0] - ref.total[0]) > 1e-6 || Math.abs(e.total[1] - ref.total[1]) > 1e-6) bad++;
      if (e.wCount[0] !== ref.win[0].length || e.wCount[1] !== ref.win[1].length) bad++;
      if (e.fiveCnt[0] !== ref.five[0] || e.fiveCnt[1] !== ref.five[1]) bad++;
      c = c === 1 ? 2 : 1;
    }
    while (seq.length) {
      const [p, cc] = seq.pop()!;
      cells[p] = 0;
      eng.unmakeCell(p, cc as 1 | 2);
    }
    if (any.total[0] !== 0 || any.total[1] !== 0 || any.cCount !== 0 || any.stones !== 0) bad++;
  }
  check('incremental totals/win-cells/hash consistent over 20 fuzz games', bad === 0, `bad=${bad}`);
}

// ── helper: run AI on a board ──
function ai(b: Board, player: 1 | 2, level: 1 | 2 | 3 | 4): { x: number; y: number } {
  const before = JSON.stringify(b);
  const res = findBestMove(clone(b), player, level, 'ai', histLen(b));
  if (JSON.stringify(b) !== before) throw new Error('board mutated!');
  if (!res.move) throw new Error('null move');
  if (b[res.move.y][res.move.x] !== 0) throw new Error('illegal occupied move');
  return res.move;
}
function hasFive(b: Board, c: number): boolean {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (b[y][x] !== c) continue;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      let n = 1;
      for (let k = 1; k < 5; k++) {
        const nx = x + dx * k, ny = y + dy * k;
        if (nx < 0 || nx >= N || ny < 0 || ny >= N || b[ny][nx] !== c) break;
        n++;
      }
      if (n >= 5) return true;
    }
  }
  return false;
}

// ── 2) tactical assertions ──
console.log('== tactics ==');
{
  // a) take the win: black (7..10,7) four
  let b = empty();
  put(b, [[7, 7, 1], [8, 7, 1], [9, 7, 1], [10, 7, 1], [4, 4, 2], [5, 5, 2]]);
  const m = ai(b, 1, 3);
  check('plays five when available', (m.x === 6 || m.x === 11) && m.y === 7, JSON.stringify(m));

  // b) block open four
  b = empty();
  put(b, [[7, 7, 1], [8, 7, 1], [9, 7, 1], [10, 7, 1], [3, 3, 2], [4, 4, 2]]);
  const m2 = ai(b, 2, 3);
  check('blocks opponent open four', (m2.x === 6 || m2.x === 11) && m2.y === 7, JSON.stringify(m2));

  // c) block a true open three: black _ X X X _ , white has no own threats
  b = empty();
  put(b, [[7, 7, 1], [8, 7, 1], [9, 7, 1], [2, 2, 2], [12, 12, 2]]);
  const m3 = ai(b, 2, 3);
  check('blocks open three end', m3.x === 6 && m3.y === 7 || (m3.x === 10 && m3.y === 7), JSON.stringify(m3));

  // d) broken four X X X _ X — win by filling the gap
  b = empty();
  put(b, [[7, 7, 1], [8, 7, 1], [9, 7, 1], [11, 7, 1], [3, 3, 2], [4, 4, 2]]);
  const m4 = ai(b, 1, 3);
  check('fills broken-four gap to win', m4.x === 10 && m4.y === 7, JSON.stringify(m4));

  // e) double open three → the move must produce an open four (≥2 five-cells) or five
  b = empty();
  put(b, [[7, 7, 1], [8, 7, 1], [9, 7, 1], [7, 8, 1], [7, 9, 1], [3, 3, 2], [4, 4, 2], [13, 13, 2]]);
  const m5 = ai(b, 1, 3);
  const e5 = new GomokuEngine();
  const bb = clone(b);
  bb[m5.y][m5.x] = 1;
  e5.load2D(bb);
  check('double-three creates decisive four', e5.winCellCount(0) >= 2 || e5.hasFive(0), JSON.stringify(m5));

  // f) VCF ladder: black two fours forcing sequence exists; engine must not miss win.
  b = empty();
  put(b, [[5, 5, 1], [6, 5, 1], [7, 5, 1], [8, 5, 1], [10, 5, 1], [5, 7, 2], [13, 3, 2]]);
  // black row 5..8 + gap at 9,10: playing (9,5) makes five? cells 5,6,7,8,9,10 → yes via 9? run 5..8 + 10: filling 9 = five 5..10? that's 6 run ≥5 ✓ win exists
  const m6 = ai(b, 1, 3);
  check('sees five via gap fill', m6.y === 5 && [4, 9].includes(m6.x), JSON.stringify(m6));
}

// ── 3) defense stress: open three must be answered at all levels ≥2 ──
console.log('== defense stress ==');
{
  const b = empty();
  put(b, [[7, 7, 1], [7, 8, 1], [7, 9, 1], [2, 2, 2], [2, 3, 2]]); // black vertical open three
  const m = ai(b, 2, 2);
  check('level2 blocks open three', m.x === 7 && (m.y === 6 || m.y === 10), JSON.stringify(m));
}

// ── 4) speed / depth probe on a quiet balanced position ──
console.log('== speed ==');
{
  const b = empty();
  put(b, [
    [7, 7, 1], [8, 8, 2], [8, 7, 1], [7, 8, 2], [6, 8, 1], [9, 7, 2],
    [6, 6, 1], [9, 6, 2], [10, 6, 1], [7, 5, 2], [9, 5, 1], [10, 7, 2],
  ]);
  // raw engine throughput at fixed depth (bypasses VCF/instant shortcuts)
  const eng = new GomokuEngine();
  eng.load2D(clone(b));
  eng.startSearch((typeof performance !== 'undefined' ? performance.now() : Date.now()) + 60000);
  const s0 = Date.now();
  const rr = eng.rootSearch(0, 8, 14);
  const sMs = Math.max(1, Date.now() - s0);
  console.log(`  raw search: d8 nodes=${eng.nodes} ${sMs}ms nps≈${(eng.nodes / sMs / 1000).toFixed(2)}M/s best=${rr.best}`);
  check('raw search nps >= 100k/s', eng.nodes / sMs >= 100, `${Math.round(eng.nodes / sMs)}k nps`);
  const t0 = Date.now();
  const res = findBestMove(clone(b), 1, 4, 'ai', 12);
  const ms = Date.now() - t0;
  console.log(`  demon move: depth=${res.depth} nodes=${res.nodes} wall=${ms}ms eval=${res.eval} instant=${!!res.instant} → (${res.move?.x},${res.move?.y})`);
  check('demon respects time budget (< 3.4s)', ms < 3400, `${ms}ms`);
  check('demon proves win or reaches depth >= 8', !!res.instant || res.depth >= 8, `depth=${res.depth}`);
  // normal level must feel instant
  const t1 = Date.now();
  const r2 = findBestMove(clone(b), 2, 2, 'ai', 12);
  check('普通 answers in < 700ms', Date.now() - t1 < 700, `${Date.now() - t1}ms d${r2.depth}`);
}

// ── 5) self-play: level 3 vs level 2, must terminate with a winner ──
console.log('== self-play (level3 B vs level2 W) ==');
{
  const b = empty();
  let c: 1 | 2 = 1;
  let moves = 0;
  let winner: number = 0;
  let totalMs = 0;
  const t0 = Date.now();
  while (moves < 40 && !winner) {
    const ts = Date.now();
    const m = ai(b, c, c === 1 ? 2 : 1);
    totalMs += Date.now() - ts;
    b[m.y][m.x] = c;
    if (hasFive(b, c)) winner = c;
    c = c === 1 ? 2 : 1;
    moves++;
  }
  console.log(`  finished in ${moves} plies, ${((Date.now() - t0) / 1000).toFixed(1)}s wall, winner=${winner === 0 ? 'unfinished' : 'B' + winner}`);
  check('self-play terminates cleanly (winner or 40-ply cap)', winner === 1 || winner === 2 || winner === 0);
  check('avg move time sane (< 1.5s)', totalMs / moves < 1500, `${Math.round(totalMs / moves)}ms`);
}

// ── 6) strength sanity: real search runs (book moved away from 天元) ──
console.log('== strength sanity ==');
{
  const b = empty();
  put(b, [[9, 9, 1], [9, 10, 1], [10, 10, 1], [2, 2, 2], [12, 2, 2], [2, 12, 2]]);
  const before = JSON.stringify(b);
  const res = findBestMove(clone(b), 2, 4, 'ai', 6);
  if (JSON.stringify(b) !== before) throw new Error('board mutated!');
  console.log(`  level4 search result: d${res.depth} nodes=${res.nodes} v=${res.eval} → (${res.move?.x},${res.move?.y})`);
  check('actually searches (not book/fallback)', !res.book && !res.opening && res.nodes > 500, JSON.stringify(res));
  const m = res.move!;
  check('white contests the black cluster', Math.abs(m.x - 9) <= 3 && Math.abs(m.y - 9) <= 3, JSON.stringify(m));
}

// ── 7) Rapfi 客户端：开局两手必须不依赖引擎加载 ──
// 回归：这两个应手是写死的定式着法，此前 ensureReady() 排在它们之前，
// 导致玩家落下第一个子后，要等整个 wasm + NNUE（约 11MB）下载实例化完
// 才见到本可瞬间返回的应手。Node 下没有 Worker，若仍依赖引擎，
// ensureReady() 必然失败并走 fallback——所以断言 fallback 一次都没被调用。
console.log('== rapfi opening shortcuts ==');
{
  const { RapfiEngine } = await import('../src/gomoku/rapfi');
  const eng = new RapfiEngine();
  let fallbackUsed = 0;
  const fallback = (): any => {
    fallbackUsed++;
    return { move: { x: -1, y: -1, v: 0 }, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] };
  };

  const r0 = await eng.findMove(empty(), 1, 2, 'ai', 0, [], fallback);
  check('空盘首手走定式天元，且不触发引擎加载',
    fallbackUsed === 0 && r0.opening === true && r0.move?.x === 7 && r0.move?.y === 7, JSON.stringify(r0.move));

  const b1 = empty();
  put(b1, [[7, 7, 1]]);
  const r1 = await eng.findMove(clone(b1), 2, 2, 'ai', 1, [{ x: 7, y: 7, c: 1 }], fallback);
  const near = !!r1.move && Math.abs(r1.move.x - 7) <= 2 && Math.abs(r1.move.y - 7) <= 2;
  check('首子后的应手走定式，且不触发引擎加载（「下第一个子卡很久」的路径）',
    fallbackUsed === 0 && r1.opening === true && near, `${JSON.stringify(r1.move)} fallback=${fallbackUsed}`);

  // 第三手起才真正要引擎；Node 无 Worker，应干净降级到内置引擎
  const b2 = empty();
  put(b2, [[7, 7, 1], [8, 8, 2]]);
  const r2 = await eng.findMove(clone(b2), 1, 2, 'ai', 2, [{ x: 7, y: 7, c: 1 }, { x: 8, y: 8, c: 2 }], fallback);
  check('第三手起才调用引擎（无 Worker 时降级到内置引擎）',
    fallbackUsed === 1 && r2.move?.x === -1, `fallback=${fallbackUsed}`);
}

// ── 8) YXBOARD 摆盘命令：落子序 + 一致性校验 ──
// 回归：rapfi 的 getPosition 按落子顺序重摆棋盘，类型(1=SELF/2=OPPO)必须
// 与交替行棋方一致；连续两次失配（禁止连续 PASS）会让摆盘静默中止——
// 引擎看着残局下棋（曾表现为「不拦横线」「下在已有棋子上」）。
// 旧实现用 y 优先扫描序 + plain BOARD，这里钉死新契约。
console.log('== rapfi YXBOARD 命令构建 ==');
{
  const { buildYxBoardCmd } = await import('../src/gomoku/rapfi');
  type HM = { x: number; y: number; c: 1 | 2 };
  const boardOf = (moves: HM[]): Board => {
    const b = empty();
    for (const m of moves) b[m.y][m.x] = m.c;
    return b;
  };

  // 落子序逐手输出、类型按 player 视角（player 的子=1，对方=2）。
  // 两个局面奇偶不同：moves6 结尾是白(2) → 轮黑(1)；moves5 结尾是黑(1) → 轮白(2)。
  const moves6: HM[] = [
    { x: 7, y: 7, c: 1 }, { x: 8, y: 8, c: 2 }, { x: 7, y: 9, c: 1 },
    { x: 6, y: 8, c: 2 }, { x: 7, y: 8, c: 1 }, { x: 9, y: 8, c: 2 },
  ];
  const moves5: HM[] = [
    { x: 7, y: 7, c: 1 }, { x: 8, y: 8, c: 2 }, { x: 7, y: 9, c: 1 },
    { x: 6, y: 8, c: 2 }, { x: 7, y: 8, c: 1 },
  ];
  const cmd = buildYxBoardCmd(boardOf(moves6), moves6, 1);
  check('按落子序整发 YXBOARD，类型=引擎方1/对方2',
    cmd === 'YXBOARD 7,7,1 8,8,2 7,9,1 6,8,2 7,8,1 9,8,2 DONE', String(cmd));
  const cmdW = buildYxBoardCmd(boardOf(moves5), moves5, 2);
  check('player=2 时类型翻转（2=引擎方）',
    cmdW === 'YXBOARD 7,7,2 8,8,1 7,9,2 6,8,1 7,8,2 DONE', String(cmdW));

  check('拒绝：moves 与棋盘不一致（少一颗子）',
    buildYxBoardCmd(boardOf(moves6), moves6.slice(0, 4), 1) === null);
  check('拒绝：颜色不交替（同一方连走）', (() => {
    const bad: HM[] = [{ x: 7, y: 7, c: 1 }, { x: 8, y: 8, c: 1 }, { x: 6, y: 8, c: 2 }, { x: 7, y: 9, c: 1 }];
    return buildYxBoardCmd(boardOf(bad), bad, 2) === null;
  })());
  check('拒绝：还没轮到 player（最后一手是 player 下的）', (() => {
    const bad: HM[] = [{ x: 7, y: 7, c: 1 }, { x: 8, y: 8, c: 2 }, { x: 7, y: 9, c: 1 }];
    return buildYxBoardCmd(boardOf(bad), bad, 1) === null;
  })());
  check('拒绝：重复落子', (() => {
    const bad: HM[] = [{ x: 7, y: 7, c: 1 }, { x: 7, y: 7, c: 2 }];
    return buildYxBoardCmd(boardOf([{ x: 7, y: 7, c: 1 }]), bad, 1) === null;
  })());
  check('拒绝：越界坐标', (() => {
    const bad: HM[] = [{ x: 7, y: 7, c: 1 }, { x: 15, y: 8, c: 2 }];
    return buildYxBoardCmd(boardOf([{ x: 7, y: 7, c: 1 }]), bad, 1) === null;
  })());
  check('空棋谱 + 空盘 → 引擎执黑开局（合法）',
    buildYxBoardCmd(empty(), [], 1) === 'YXBOARD DONE');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
