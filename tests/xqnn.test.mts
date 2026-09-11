/* 象棋神经网络自检：ONNX 解析 / 编码 / 与 onnxruntime 逐位对齐 / 搜索行为。
   run via esbuild bundle（--format=cjs，与 go.test.mts 一致）。 */
import { readFileSync } from 'node:fs';
import * as tf from '@tensorflow/tfjs-core';

// 静态 import 会被 esbuild 当作无副作用摇掉，CPU 后端就注册不上
const { } = await import('@tensorflow/tfjs-backend-cpu');

import { parseXqNet, XqNet } from '../src/xqnn/model';
import { parseOnnx } from '../src/xqnn/onnx';
import { encodeBoard, moveTable, actionIndex, NUM_ACTIONS, NUM_CHANNELS } from '../src/xqnn/encoding';
import { XqnnEvaluator } from '../src/xqnn/evaluate';
import { XqSearcher, XQNN_LEVELS } from '../src/xqnn/search';
import { createInitialBoard, legalMoves, makeMove, inCheck, findKing, ROWS, COLS } from '../src/xiangqi/rules';
import { boardToFen } from '../src/xiangqi/fen';
import type { XqBoard, XqMove, XqSide } from '../src/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

const MODEL = 'public/xqnn/chess_model.onnx';
const buf = readFileSync(MODEL);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

/* ── ① ONNX 图结构 ── */
{
  const g = parseOnnx(ab);
  check('图输入为 board', g.inputs.length === 1 && g.inputs[0] === 'board', g.inputs.join(','));
  check('图输出为 policy/value', g.outputs.join(',') === 'policy,value', g.outputs.join(','));
  const convs = g.nodes.filter((n) => n.opType === 'Conv').length;
  check('Conv 节点 15 个（输入卷积 + 6×2 残差 + 两个头）', convs === 15, String(convs));
  const bns = g.nodes.filter((n) => n.opType === 'BatchNormalization').length;
  check('BatchNormalization 已被导出器折进 Conv（图里应为 0 个）', bns === 0, String(bns));
  const ops = new Set(g.nodes.map((n) => n.opType));
  check('算子集合在预期内', [...ops].every((o) => ['Conv', 'Relu', 'Add', 'Gemm', 'Tanh', 'Shape', 'Constant', 'Gather', 'Unsqueeze', 'Concat', 'Reshape'].includes(o)), [...ops].join(','));
}

/* ── ② 权重解析（按形状识别 + 断言） ── */
let weights: ReturnType<typeof parseXqNet>;
{
  weights = parseXqNet(ab);
  check('输入卷积 [128,15,3,3] 已取到', weights.convIn.w.length === 128 * 15 * 9, String(weights.convIn.w.length));
  check('6 个残差块', weights.blocks.length === 6, String(weights.blocks.length));
  check('策略全连接 [2086,180]', weights.policyFc.w.length === NUM_ACTIONS * 2 * ROWS * COLS);
  check('价值全连接 [128,90] / [1,128]', weights.valueFc1.w.length === 128 * ROWS * COLS && weights.valueFc2.w.length === 128);
}

/* ── ③ 走法表与编码 ── */
{
  const t = moveTable();
  check(`走法表规模 = ${NUM_ACTIONS}（与上游策略头维度一致）`, t.from.length === NUM_ACTIONS, String(t.from.length));
  check('炮二平五 (7,1)→(7,4) 可查到下标', actionIndex(7 * COLS + 1, 7 * COLS + 4) >= 0);
  check('非法着法返回 -1', actionIndex(0, 0) === -1);

  const planes = encodeBoard(createInitialBoard(), 'r');
  let pieces = 0;
  for (let i = 0; i < 14 * 90; i++) if (planes[i] === 1) pieces++;
  let sideFlag = 0;
  for (let i = 14 * 90; i < 15 * 90; i++) sideFlag += planes[i];
  check('初始局面：棋子通道 32 个 1', pieces === 32, String(pieces));
  check('初始局面：行棋方通道（红走）全 1', sideFlag === 90, String(sideFlag));
  const black = encodeBoard(createInitialBoard(), 'b');
  let blackFlag = 0;
  for (let i = 14 * 90; i < 15 * 90; i++) blackFlag += black[i];
  check('黑走时行棋方通道全 0', blackFlag === 0, String(blackFlag));
  check('通道数常量一致', NUM_CHANNELS === 15 && planes.length === 15 * 90);
}

/* ── ④ 与 onnxruntime 参考输出逐位对齐 ── */
function parseFenBoard(fen: string): { board: XqBoard; side: XqSide } {
  const board = Array.from({ length: ROWS }, () => Array(COLS).fill(null)) as XqBoard;
  const [placement, side] = fen.split(' ');
  placement.split('/').forEach((row, y) => {
    let x = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '9') x += Number(ch);
      else board[y][x++] = ch;
    }
  });
  return { board, side: side === 'w' ? 'r' : 'b' };
}

await tf.setBackend('cpu');
await tf.ready();
const net = new XqNet(weights);
{
  const fx = JSON.parse(readFileSync('tests/fixtures/xqnn-golden.json', 'utf8')) as {
    positions: Array<{ label: string; fen: string; value: number; policy: number[] }>;
  };
  check('fixture 局面数 ≥ 6', fx.positions.length >= 6, String(fx.positions.length));

  let worstPolicy = 0;
  let worstValue = 0;
  let topMismatch = 0;
  for (const p of fx.positions) {
    const { board, side } = parseFenBoard(p.fen);
    const out = await net.forward(encodeBoard(board, side));
    let maxDiff = 0;
    for (let i = 0; i < out.policy.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out.policy[i] - p.policy[i]));
    worstPolicy = Math.max(worstPolicy, maxDiff);
    worstValue = Math.max(worstValue, Math.abs(out.value - p.value));
    const top = (arr: ArrayLike<number>) => Array.from(arr).map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, 8).map((t) => t.i).join(',');
    if (top(out.policy) !== top(p.policy)) topMismatch++;
  }
  check(`策略 logits 与 onnxruntime 一致（最大偏差 ${worstPolicy.toExponential(2)} < 2e-3）`, worstPolicy < 2e-3, worstPolicy.toExponential(3));
  check(`价值与 onnxruntime 一致（最大偏差 ${worstValue.toExponential(2)} < 2e-3）`, worstValue < 2e-3, worstValue.toExponential(3));
  check('每个局面的 top-8 着法完全一致', topMismatch === 0, String(topMismatch));
}

/* ── ⑤ 策略头的棋理：开局 top 着法应是正经开局 ── */
{
  const ev = new XqnnEvaluator();
  await ev.load(ab, 'cpu');
  const out = await ev.evaluateBoard(createInitialBoard(), 'r');
  const t = moveTable();
  const top = Array.from(out.policy)
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 5)
    .map(({ i }) => `${t.from[i]}-${t.to[i]}`);
  const legalSet = new Set(legalMoves(createInitialBoard(), 'r').map((m) => `${m.fy * COLS + m.fx}-${m.ty * COLS + m.tx}`));
  check('策略 top-5 全部是合法着法', top.every((s) => legalSet.has(s)), top.join(' '));
  // 炮二平五 (7,1)->(7,4) 是象棋最经典的开局之一，受过大师棋谱训练的网络应当给出高分
  const centerCannon = out.policy[actionIndex(7 * COLS + 1, 7 * COLS + 4)];
  const all = Array.from(out.policy).sort((a, b) => b - a);
  const rank = all.findIndex((v) => v === centerCannon) + 1;
  check(`炮二平五在网络先验里排名靠前（第 ${rank} 名 / 2086）`, rank > 0 && rank <= 60, String(rank));
}

/* ── ⑥ 融合搜索：合法性 / 一步杀 / 时间预算 ── */
{
  const ev = new XqnnEvaluator();
  await ev.load(ab, 'cpu');
  const searcher = new XqSearcher(ev);

  const board = createInitialBoard();
  const t0 = Date.now();
  const res = await searcher.search(board, 'r', 1, 'ai');
  const ms = Date.now() - t0;
  const legal = !!res.move && legalMoves(board, 'r').some((m) => m.fx === res.move!.fx && m.fy === res.move!.fy && m.tx === res.move!.tx && m.ty === res.move!.ty);
  check('初始局面：神经网络引擎给出合法着法', legal, JSON.stringify(res.move));
  check('返回里带 engine 标记与后端', res.engine === 'xqnn' && !!res.backend, `${res.engine}/${res.backend}`);
  check('搜索在合理时间内返回（< 60s；Node 的 CPU 后端比浏览器 GPU 慢一到两个数量级）', ms < 60_000, `${ms}ms`);
  check('搜索不改动传入棋盘', boardToFen(board, 'r').startsWith('rnbakabnr/9/1c5c1/'), boardToFen(board, 'r'));

  // 一步杀：红车 (8,3) 下底 (8,0) 将军且控底线 → 杀（局面本身合法，黑将此时未被将军）
  const mate = createInitialBoard();
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) mate[y][x] = null;
  mate[0][4] = 'k';
  mate[9][3] = 'K';   // 红帅错开一列，避免双方主帅照面（飞将）导致局面非法
  mate[1][0] = 'R';
  mate[3][8] = 'R';
  check('杀型局面本身合法（红走时黑将未被将军）', !inCheck(mate, 'b'));
  const mateRes = await searcher.search(mate, 'r', 2, 'ai');
  const mateOk = !!mateRes.move && mateRes.move.fx === 8 && mateRes.move.fy === 3 && mateRes.move.tx === 8 && mateRes.move.ty === 0;
  check('一步杀局面：直接走出杀着（i6-i9）', mateOk, mateRes.move ? `${mateRes.move.fx},${mateRes.move.fy}->${mateRes.move.tx},${mateRes.move.ty}` : 'null');
  check('杀棋分被标注为绝杀', Math.abs(mateRes.eval) >= 10_000, String(mateRes.eval));

  // 随机中局若干：着法都必须合法
  let legalCount = 0;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let g = 0; g < 2; g++) {
    const b = createInitialBoard();
    let side: XqSide = 'r';
    for (let i = 0; i < 12 + g * 8; i++) {
      const ms2 = legalMoves(b, side);
      if (!ms2.length) break;
      makeMove(b, ms2[Math.floor(rnd() * ms2.length)]);
      side = side === 'r' ? 'b' : 'r';
    }
    const r = await searcher.search(b, side, 1, 'ai');
    const ok = !!r.move && legalMoves(b, side).some((m) => m.fx === r.move!.fx && m.fy === r.move!.fy && m.tx === r.move!.tx && m.ty === r.move!.ty);
    const oppKnocked = ok && !inCheck(b, side) && findKing(b, side === 'r' ? 'b' : 'r');
    if (ok && oppKnocked) legalCount++;
  }
  check('随机中局 2/2 给出合法着法', legalCount === 2, String(legalCount));

  check('难度档配置齐全且窗口随难度收紧', XQNN_LEVELS[1].window > XQNN_LEVELS[3].window && XQNN_LEVELS[4].temperature === 0);
  check('恶魔档网络窗口 ≤ 30 分（不会顶掉战术着法）', XQNN_LEVELS[4].window <= 30, String(XQNN_LEVELS[4].window));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
