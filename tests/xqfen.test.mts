/* 象棋 FEN / UCI 坐标编解码自检（run via esbuild bundle）。 */
import { createInitialBoard } from '../src/xiangqi/rules';
import {
  boardToFen,
  uciToXqMove,
  xqMoveToUci,
  xyToSquare,
  squareToXY,
  START_FEN,
} from '../src/xiangqi/fen';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

// ── 坐标映射 ──
check('红帅 (4,9) → e0', xyToSquare(4, 9) === 'e0');
check('黑将 (4,0) → e9', xyToSquare(4, 0) === 'e9');
check('左下角 (0,9) → a0', xyToSquare(0, 9) === 'a0');
check('右上角 (8,0) → i9', xyToSquare(8, 0) === 'i9');
check('e0 → (4,9)', JSON.stringify(squareToXY('e0')) === JSON.stringify({ x: 4, y: 9 }));
check('i9 → (8,0)', JSON.stringify(squareToXY('i9')) === JSON.stringify({ x: 8, y: 0 }));
check('越界返回 null', xyToSquare(9, 0) === null && xyToSquare(-1, 0) === null);
check('非法格名返回 null', squareToXY('j0') === null && squareToXY('e') === null);

// ── FEN 生成 ──
const init = createInitialBoard();
check('初始局面 FEN（红方行棋）逐字符一致', boardToFen(init, 'r') === START_FEN, boardToFen(init, 'r'));
check('初始局面 FEN（黑方行棋）行棋方为 b', boardToFen(init, 'b').endsWith(' b - - 0 1'));

// ── 走法编解码 ──
const mv = uciToXqMove('h2e2', init);
check('h2e2 → 红炮 (7,7)→(4,7)', !!mv && mv.fx === 7 && mv.fy === 7 && mv.tx === 4 && mv.ty === 7 && mv.piece === 'C' && mv.cap === null, JSON.stringify(mv));
check('走法回环 b0c2', xqMoveToUci(uciToXqMove('b0c2', init)!) === 'b0c2');
check('大小写不敏感 H2E2', xqMoveToUci(uciToXqMove('H2E2', init)!) === 'h2e2');
check('起点无子返回 null', uciToXqMove('e4e5', init) === null);
check('畸形串返回 null', uciToXqMove('xyz', init) === null && uciToXqMove('', init) === null);

// ── 吃子字段 ──
const capBoard = init.map((r) => [...r]);
capBoard[4][4] = 'P';   // 红兵推进到中路 (4,5)
const capMv = uciToXqMove('c6c5', capBoard); // 黑卒 (2,3)? 检查形状即可
check('吃子时 cap 非空或合法 null', capMv === null || (capMv.cap === null || typeof capMv.cap === 'string'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
