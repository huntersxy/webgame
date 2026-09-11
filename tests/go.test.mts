/* ────────────────────────────────────────────────────────────
 *  go.test.mts — 围棋引擎自测
 *
 *  覆盖四层：
 *   ① 规则：提子 / 禁止自杀 / 打劫 / 悔棋可逆 / 数子
 *   ② 死活特征：Benson 区域、征子、超级劫
 *   ③ 输入编码 + 神经网络：与参考实现（web-katrain，MIT）的输出逐位对齐
 *      （fixture 见 tests/fixtures/go-golden.json）
 *   ④ 搜索：PUCT 出合法着法、统计量自洽、兜底 AI 永远有棋可下
 *
 *  运行：npm run test:go
 * ──────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { GoBoard, emptyBoard, scorePosition, koPointAfterMove, BLACK, WHITE } from '../src/go/rules';
import { computeAreaMap, computePassAliveArea } from '../src/go/area';
import { computeLadderFeatures } from '../src/go/life';
import { encodeFeatures, NUM_SPATIAL_PLANES } from '../src/go/features';
import type { FeatureMove } from '../src/go/features';
import { GoEvaluator, policyFromLogits } from '../src/go/evaluate';
import { GoSearcher, defaultSearchOptions } from '../src/go/mcts';
import { heuristicMove, mulberry32 } from '../src/go/heuristic';
import { parseGoModel } from '../src/go/model';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ok  ${msg}`);
  } else {
    fail++;
    console.error(`FAIL  ${msg}`);
  }
}
function near(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

const idx = (size: number, x: number, y: number): number => y * size + x;

/* ══════════════ ① 规则 ══════════════ */
function testRules(): void {
  console.log('— 规则：提子 / 自杀 / 打劫 —');
  {
    // 黑围住白一子，最后一手提掉（直接摆局面，避免依赖交替落子）
    const s = new Uint8Array(81);
    s[idx(9, 3, 4)] = BLACK;
    s[idx(9, 4, 3)] = BLACK;
    s[idx(9, 5, 4)] = BLACK;
    s[idx(9, 4, 4)] = WHITE; // 白子只剩 (4,5) 一气
    const b = GoBoard.from(9, s, BLACK);
    assert(b.stones[idx(9, 4, 4)] === WHITE, '提子前白子仍在盘上');
    assert(b.isLegal(idx(9, 4, 5)), '黑在最后一气落子合法');
    assert(b.play(idx(9, 4, 5)), '落子成功');
    assert(b.stones[idx(9, 4, 4)] === 0, '落子后白子被提掉');
    assert(b.captures[BLACK - 1] === 1, `黑方提子数 +1（实际 ${b.captures[BLACK - 1]}）`);
  }
  {
    // 禁止自杀：白在只有一口气的点里填
    const stones = new Uint8Array(81);
    stones[idx(9, 1, 0)] = BLACK;
    stones[idx(9, 0, 1)] = BLACK;
    const b = GoBoard.from(9, stones, WHITE);
    assert(!b.isLegal(idx(9, 0, 0)), '白填角上无气之点 = 禁止自杀');
    assert(!b.play(idx(9, 0, 0)), '自杀着法被拒绝');
  }
  {
    // 打劫：提一子且自己成为单子一气 → 对方不能立即回提
    //   y=0: . . W . .     白 (2,0)
    //   y=1: B W . W .     黑 (0,1) 白 (1,1) 白 (3,1)
    //   y=2: . . W . .     白 (2,2)   —— 黑落 (2,1) 提 (1,1)，且黑 (2,1) 单子一气 = 劫
    const s = new Uint8Array(81);
    s[idx(9, 1, 1)] = WHITE;
    s[idx(9, 2, 0)] = WHITE;
    s[idx(9, 3, 1)] = WHITE;
    s[idx(9, 2, 2)] = WHITE;
    s[idx(9, 0, 1)] = BLACK;
    s[idx(9, 1, 0)] = BLACK;
    s[idx(9, 1, 2)] = BLACK;
    const koIdx = idx(9, 2, 1);
    const b = GoBoard.from(9, s, BLACK);
    assert(b.isLegal(koIdx), '黑可以提劫');
    b.play(koIdx);
    assert(b.stones[idx(9, 1, 1)] === 0, '提劫成功');
    assert(b.koPoint === idx(9, 1, 1), `劫点被标出（实际 ${b.koPoint}，期望 ${idx(9, 1, 1)}）`);
    assert(!b.isLegal(idx(9, 1, 1)), '白不能立即回提（打劫禁着）');
    // 白先在别处走一手之后即可回提
    assert(b.isLegal(idx(9, 8, 8)), '白可以在别处落子');
    b.play(idx(9, 8, 8));
    b.play(idx(9, 8, 7)); // 黑应一手
    assert(b.isLegal(idx(9, 1, 1)), '隔一手后白可以回提');
  }
  console.log('— 规则：悔棋可逆 —');
  {
    const b = new GoBoard(9);
    const moves: number[] = [];
    const rng = mulberry32(20240101);
    for (let i = 0; i < 60; i++) {
      const legal: number[] = [];
      for (let p = 0; p < 81; p++) if (b.isLegal(p)) legal.push(p);
      if (legal.length === 0) break;
      const m = legal[Math.floor(rng.next() * legal.length)];
      if (!b.play(m)) break;
      moves.push(m);
    }
    const afterStones = b.stones.slice();
    const afterHash = b.hash;
    const afterCaps = [...b.captures];
    const afterKo = b.koPoint;
    const afterToMove = b.toMove;
    // 全部回退
    let undone = 0;
    while (b.undo()) undone++;
    assert(undone === moves.length, `悔棋次数与落子数一致（${undone}/${moves.length}）`);
    assert(b.stones.every((v) => v === 0), '全部回退后棋盘为空');
    assert(b.captures[0] === 0 && b.captures[1] === 0, '全部回退后提子数归零');
    assert(b.toMove === BLACK, '全部回退后轮到黑方');
    // 重放应完全复原（含哈希）
    for (const m of moves) b.play(m);
    assert(b.stones.every((v, i) => v === afterStones[i]), '重放后盘面与回退前一致');
    assert(b.hash === afterHash, '重放后哈希一致');
    assert(b.captures[0] === afterCaps[0] && b.captures[1] === afterCaps[1], '重放后提子数一致');
    assert(b.koPoint === afterKo && b.toMove === afterToMove, '重放后劫点与轮走方一致');
  }
  {
    // 单步悔棋：提子那手回退必须把被提的子放回来，且自己那手要拿掉
    const s = new Uint8Array(81);
    s[idx(9, 3, 4)] = BLACK;
    s[idx(9, 4, 3)] = BLACK;
    s[idx(9, 5, 4)] = BLACK;
    s[idx(9, 4, 4)] = WHITE;
    const b = GoBoard.from(9, s, BLACK);
    const snap = b.stones.slice();
    b.play(idx(9, 4, 5));
    assert(b.stones[idx(9, 4, 4)] === 0 && b.stones[idx(9, 4, 5)] === BLACK, '提子后盘面符合预期');
    b.undo();
    assert(b.stones.every((v, i) => v === snap[i]), '悔棋后盘面逐点复原（含被提子回归）');
    assert(b.captures[BLACK - 1] === 0, '悔棋后提子数复原');
  }
  console.log('— 规则：数子 —');
  {
    const empty = scorePosition(new Uint8Array(81), 9, 7, 'chinese');
    assert(empty.black === 0 && empty.white === 7, `空盘：黑 0 白 7（实际 ${empty.black}/${empty.white}）`);
    assert(empty.winner === WHITE && near(empty.margin, 7, 1e-9), '空盘白胜 7 目');
  }
  {
    // 黑一条横线封住上半盘 + 一条竖线隔开两片空：两片空区都只挨黑子 → 都算黑地
    const s = new Uint8Array(81);
    for (let x = 0; x <= 8; x++) s[idx(9, x, 3)] = BLACK; // y=3 的黑横线（9 子）
    for (let y = 0; y < 3; y++) s[idx(9, 3, y)] = BLACK; // x=3 的黑竖线（3 子）
    for (let y = 4; y <= 8; y++) s[idx(9, 4, y)] = WHITE; // x=4 的白竖线（5 子）
    const sc = scorePosition(s, 9, 7, 'chinese');
    // 黑子 12 枚；左上 3×3 = 9 空 + 右上 5×3 = 15 空，都只挨黑子 → 黑地 24
    assert(sc.blackStones === 12, `黑子 12 枚（实际 ${sc.blackStones}）`);
    assert(sc.blackTerritory === 24, `黑地 24（实际 ${sc.blackTerritory}）`);
    assert(sc.black === 36, `黑方数子 36（实际 ${sc.black}）`);
    assert(sc.whiteStones === 5 && sc.white === 12, `白 5 子 + 贴目 7 = 12（实际 ${sc.white}）`);
    assert(sc.winner === BLACK, '该局面黑方胜');
  }
  {
    // 死子掩码：把白一子判死，数子时按提子处理
    const s = new Uint8Array(81);
    s[idx(9, 0, 0)] = WHITE;
    for (let x = 1; x < 9; x++) s[idx(9, x, 1)] = BLACK;
    s[idx(9, 1, 0)] = BLACK;
    s[idx(9, 0, 1)] = BLACK;
    const dead = new Uint8Array(81);
    dead[idx(9, 0, 0)] = 1;
    const withDead = scorePosition(s, 9, 0, 'chinese', dead);
    const without = scorePosition(s, 9, 0, 'chinese');
    assert(withDead.black > without.black, '判死白子后黑方得点增加');
  }
}

/* ══════════════ ② 死活特征 ══════════════ */
function testLife(): void {
  console.log('— 死活：Benson 双活 —');
  {
    // 经典两只眼：黑在角落做出两只真眼
    const s = new Uint8Array(361);
    for (let y = 0; y <= 5; y++) for (let x = 0; x <= 5; x++) s[idx(19, x, y)] = BLACK;
    s[idx(19, 2, 2)] = 0;
    s[idx(19, 4, 4)] = 0;
    // 外面围一圈白
    for (let i = 0; i <= 6; i++) {
      s[idx(19, i, 6)] = WHITE;
      s[idx(19, 6, i)] = WHITE;
    }
    const area = computeAreaMap(s, 19);
    assert(area[idx(19, 2, 2)] === BLACK && area[idx(19, 4, 4)] === BLACK, '两只眼的空间归黑（Benson 活棋）');
    assert(area[idx(19, 0, 0)] === BLACK, '活棋棋子自身归黑');
    const pa = computePassAliveArea(s, 19);
    assert(pa[idx(19, 3, 3)] === BLACK, '眼之间的黑子被判定为无条件活棋');
  }
  {
    // 未活棋的棋子也应有归属（KataGo nonPassAliveStones 口径）
    const s = new Uint8Array(81);
    s[idx(9, 4, 4)] = BLACK;
    const area = computeAreaMap(s, 9);
    assert(area[idx(9, 4, 4)] === BLACK, '孤子按自身颜色计入区域图');
  }
  console.log('— 死活：征子 —');
  {
    // 角上两气、对方先走可征吃：白 (1,1)，黑 (1,2)(2,1)
    const s = new Uint8Array(81);
    s[idx(9, 1, 1)] = WHITE;
    s[idx(9, 1, 2)] = BLACK;
    s[idx(9, 2, 1)] = BLACK;
    const f = computeLadderFeatures(s, 9, -1, WHITE);
    assert(f.laddered[idx(9, 1, 1)] === 1, '角上两气的白子被判为「可被征吃」');
    // 三气的子不该被判征
    const s2 = new Uint8Array(81);
    s2[idx(9, 4, 4)] = WHITE;
    s2[idx(9, 4, 5)] = BLACK;
    s2[idx(9, 5, 4)] = BLACK;
    const f2 = computeLadderFeatures(s2, 9, -1, WHITE);
    assert(f2.laddered[idx(9, 4, 4)] === 0, '三气的白子不算被征');
  }
  console.log('— 规则：劫点推算 —');
  {
    const s = new Uint8Array(81);
    s[idx(9, 1, 1)] = WHITE;
    s[idx(9, 2, 0)] = WHITE;
    s[idx(9, 3, 1)] = WHITE;
    s[idx(9, 2, 2)] = WHITE;
    s[idx(9, 0, 1)] = BLACK;
    s[idx(9, 1, 0)] = BLACK;
    s[idx(9, 1, 2)] = BLACK;
    const geo = GoBoard.from(9, s, BLACK).geo;
    const ko = koPointAfterMove(s, geo, idx(9, 2, 1), BLACK);
    assert(ko === idx(9, 1, 1), `koPointAfterMove 给出劫点 (${ko}，期望 ${idx(9, 1, 1)})`);
  }
}

/* ══════════════ ③ 模型解析 + 输入编码 + 与参考逐位对齐 ══════════════ */
interface GoldenCase {
  id: string;
  boardSize: number;
  komi: number;
  toMove: number;
  stones: number[];
  moves: Array<{ x: number; y: number; c: number }>;
  spatial?: number[];
  global: number[];
  policy: number[];
  policyPass: number[];
  valueLogits: number[];
  scoreValue: number[];
  ownership: number[];
}

function loadModelBytes(): Uint8Array {
  const raw = readFileSync('public/go/g170-b6c96-s175395328-d26788732.bin.gz');
  return new Uint8Array(gunzipSync(raw));
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

async function testGolden(): Promise<void> {
  console.log('— 模型解析 —');
  const bytes = loadModelBytes();
  const model = parseGoModel(bytes);
  assert(model.modelName === 'g170-b6c96-s175395328-d26788732', `模型名 ${model.modelName}`);
  assert(model.modelVersion === 8, `模型版本 ${model.modelVersion}`);
  assert(model.numInputChannels === 22 && model.numInputGlobalChannels === 19, '输入通道 22 / 19');
  assert(model.trunk.numBlocks === 6 && model.trunk.trunkNumChannels === 96, '主干 6 块 × 96 通道');
  assert(model.trunk.conv1.kernelY === 5 && model.trunk.conv1.inChannels === 22, '首层 5×5×22');
  assert(model.policyOutChannels === 1 && model.scoreValueChannels === 4, '策略 1 通道 / 价值 4 通道');
  assert(bytes.length === 4_124_446, `解压后字节数 ${bytes.length}`);

  console.log('— 输入编码（几何 / 气 / 历史 / 全局） —');
  {
    const s = new Uint8Array(81);
    s[idx(9, 4, 4)] = BLACK;
    s[idx(9, 3, 4)] = WHITE;
    s[idx(9, 5, 4)] = WHITE;
    s[idx(9, 4, 3)] = WHITE;
    const f = encodeFeatures({
      size: 9,
      stones: s,
      koPoint: -1,
      toMove: BLACK,
      recentMoves: [{ move: idx(9, 4, 3), color: WHITE }],
      komi: 7,
    });
    const at = (x: number, y: number, c: number): number => f.spatial[(y * 9 + x) * NUM_SPATIAL_PLANES + c];
    let plane0AllOne = true;
    for (let i = 0; i < 81; i++) if (f.spatial[i * NUM_SPATIAL_PLANES] !== 1) plane0AllOne = false;
    assert(plane0AllOne, '平面 0（在盘内）全为 1');
    assert(at(4, 4, 1) === 1 && at(3, 4, 2) === 1, '平面 1/2 分别为己方/对方棋子');
    assert(at(4, 4, 3) === 1, '平面 3：黑 (4,4) 被三面围住只有一气 → 标 1 气');
    assert(at(3, 4, 5) === 1, '平面 5：白 (3,4) 有三气 → 标 3 气');
    assert(at(4, 3, 9) === 1, '平面 9：上一手（白）落点');
    assert(near(f.global[5], -7 / 20, 1e-6), `全局 5：贴目 -7/20（实际 ${f.global[5]}）`);
    assert(f.global[6] === 0 && f.global[7] === 0, '全局 6/7：中国规则为简单劫 → 0');
    assert(f.global[9] === 0, '全局 9：数子法 → 0');
  }

  console.log('— 与参考实现逐位对齐（fixture） —');
  const golden = JSON.parse(readFileSync('tests/fixtures/go-golden.json', 'utf8')) as {
    cases: GoldenCase[];
  };
  const evaluator = new GoEvaluator();
  await evaluator.load(bytes, 'cpu');
  assert(evaluator.ready && evaluator.backend === 'cpu', `评估器就绪（后端 ${evaluator.backend}）`);

  for (const c of golden.cases) {
    const size = c.boardSize;
    const area = size * size;
    const stones = Uint8Array.from(c.stones);
    const toMove = c.toMove as 1 | 2;
    const recent: FeatureMove[] = c.moves.slice(-5).map((m) => ({ move: m.x < 0 ? -1 : idx(size, m.x, m.y), color: m.c as 1 | 2 }));

    const feat = encodeFeatures({ size, stones, koPoint: -1, toMove, recentMoves: recent, komi: c.komi });
    const gDiff = maxAbsDiff(feat.global, c.global);
    assert(gDiff < 1e-5, `${c.id}: 全局通道与参考一致（最大差 ${gDiff.toExponential(1)}）`);

    if (c.spatial) {
      const sDiff = maxAbsDiff(feat.spatial, c.spatial);
      assert(sDiff < 1e-5, `${c.id}: 22 个空间平面与参考一致（最大差 ${sDiff.toExponential(1)}）`);
    }

    const r = await evaluator.evaluateOne({ size, stones, koPoint: -1, toMove, recentMoves: recent, komi: c.komi });
    const logits = new Float32Array(area + 1);
    logits.set(r.policyLogits);
    const ref = new Float32Array(area + 1);
    ref.set(c.policy);
    ref[area] = c.policyPass[0];
    const pDiff = maxAbsDiff(logits, ref);
    assert(pDiff < 1e-4, `${c.id}: 策略 logits 与参考一致（最大差 ${pDiff.toExponential(1)}）`);

    // 胜率（轮走方视角）
    const expV = c.valueLogits.slice(0, 3).map((v) => Math.exp(v));
    const refSide = expV[0] / expV.reduce((a, b) => a + b, 0);
    const mineSide = toMove === 1 ? r.blackWinProb : 1 - r.blackWinProb;
    assert(near(mineSide, refSide, 1e-4), `${c.id}: 胜率一致（${mineSide.toFixed(4)} vs ${refSide.toFixed(4)}）`);

    const oDiff = maxAbsDiff(r.ownership, c.ownership);
    assert(oDiff < 1e-4, `${c.id}: 归属与参考一致（最大差 ${oDiff.toExponential(1)}）`);

    // 概率归一化与合法性：策略质量应集中在少数点上
    const probs = policyFromLogits(logits, area);
    let sum = 0;
    for (let i = 0; i <= area; i++) sum += probs[i];
    assert(near(sum, 1, 1e-5), `${c.id}: 策略概率归一化（Σ=${sum.toFixed(6)}）`);
  }
}

/* ══════════════ ④ 搜索与兜底 ══════════════ */
async function testSearch(): Promise<void> {
  console.log('— 搜索：PUCT —');
  const bytes = loadModelBytes();
  const ev = new GoEvaluator();
  await ev.load(bytes, 'cpu');

  const size = 9;
  const area = size * size;
  const searcher = new GoSearcher(ev, {
    ...defaultSearchOptions(),
    maxVisits: 10,
    maxTimeMs: 120000,
    batchSize: 4,
  });
  const res = await searcher.run({ size, stones: new Uint8Array(area), koPoint: -1, toMove: BLACK, komi: 7, recentMoves: [] });
  assert(res.move >= 0 && res.move < area, `空盘搜索返回盘内着法（${res.move}）`);
  assert(res.visits >= 2 && res.visits <= 10, `访问次数在预算内（${res.visits}）`);
  assert(res.candidates.length > 0, `候选点非空（${res.candidates.length} 个）`);
  assert(res.winProb > 0 && res.winProb < 1, `胜率在 (0,1) 内（${res.winProb.toFixed(3)}）`);
  const visitsSum = res.candidates.reduce((a, c) => a + c.visits, 0);
  assert(visitsSum <= res.visits, `候选访问次数之和不超过总访问（${visitsSum} ≤ ${res.visits}）`);
  // 空盘 9 路贴目 7：黑方胜率应贴近五成（参考实现为 51.4%）
  assert(res.winProb > 0.35 && res.winProb < 0.75, `空盘根值合理（${(res.winProb * 100).toFixed(1)}%）`);

  // 连续两次搜索：第二次的统计不应被第一次污染（曾因 undo 不撤子而累积棋子）
  const board2 = new GoBoard(size);
  board2.play(idx(size, 4, 4));
  const res2 = await searcher.run({
    size,
    stones: board2.stones,
    koPoint: board2.koPoint,
    toMove: board2.toMove,
    komi: 7,
    recentMoves: [{ move: idx(size, 4, 4), color: BLACK }],
  });
  assert(res2.winProb > 0.2 && res2.winProb < 0.8, `第二局搜索根值合理（${(res2.winProb * 100).toFixed(1)}%）`);

  console.log('— 兜底 AI —');
  {
    const b = emptyBoard(9);
    const mv = heuristicMove(b, mulberry32(7));
    assert(mv >= 0 && b.isLegal(mv), `空盘兜底 AI 给出合法着法（${mv}）`);
    // 连续走 60 手都不该出非法着法
    let legal = true;
    for (let i = 0; i < 60 && legal; i++) {
      const m = heuristicMove(b, mulberry32(i * 7919 + 13));
      if (m < 0) break;
      legal = b.play(m);
    }
    assert(legal, '兜底 AI 连续 60 手均为合法着法');
  }
}

async function main(): Promise<void> {
  testRules();
  testLife();
  await testGolden();
  await testSearch();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
