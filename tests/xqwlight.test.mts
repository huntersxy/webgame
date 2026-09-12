/* XQWLight（象棋小巫师）经典引擎自检：把上游原样搬运的 JS 放进 vm 跑，
   验证「从 FEN 求着法 → ICCS → 本项目 XqMove」这条链接得通、走法合法。 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createInitialBoard, legalMoves, makeMove, inCheck, ROWS, COLS } from '../src/xiangqi/rules';
import { boardToFen, uciToXqMove } from '../src/xiangqi/fen';
import { XQWLIGHT_LEVELS } from '../src/xiangqi/xqwlight';
import type { XqBoard, XqMove, XqSide } from '../src/types';
import { check, finish } from './harness.mts';


/* ── 在 vm 里按 public/xqwlight/engine-worker.js 的方式加载引擎 ── */
const DIR = 'public/xqwlight/';
const ctx = vm.createContext({ console });
for (const f of ['position.js', 'search.js', 'book.js']) {
  vm.runInContext(readFileSync(DIR + f, 'utf8'), ctx, { filename: f });
}
vm.runInContext('var __pos = new Position(); var __search = new Search(__pos, 16);', ctx);
const G = ctx as unknown as {
  Position: new () => unknown;
  Search: new (pos: unknown, level: number) => unknown;
  __pos: { fromFen(fen: string): void; distance: number };
  __search: { searchMain(depth: number, millis: number): number; allNodes?: number };
  SRC(mv: number): number;
  DST(mv: number): number;
  FILE_X(sq: number): number;
  RANK_Y(sq: number): number;
  FILE_LEFT: number;
  RANK_TOP: number;
  COORD_XY(x: number, y: number): number;
};

/** 与 public/xqwlight/engine-worker.js 里的 move2Iccs 完全同一套公式
 *  （字母与档位都必须过 fromCharCode，否则会拼成 "B50" 这种错位结果） */
function move2Iccs(mv: number): string {
  const sqSrc = G.SRC(mv);
  const sqDst = G.DST(mv);
  return String.fromCharCode(65 + G.FILE_X(sqSrc) - G.FILE_LEFT) + String.fromCharCode(57 - G.RANK_Y(sqSrc) + G.RANK_TOP) + '-' +
    String.fromCharCode(65 + G.FILE_X(sqDst) - G.FILE_LEFT) + String.fromCharCode(57 - G.RANK_Y(sqDst) + G.RANK_TOP);
}

/** 本项目格 (x,y) → ICCS 单格串（走引擎自己的 COORD_XY，端到端验证坐标映射） */
function move2IccsFromXY(x: number, y: number): string {
  const sq = G.COORD_XY(x + G.FILE_LEFT, y + G.RANK_TOP);
  return String.fromCharCode(65 + G.FILE_X(sq) - G.FILE_LEFT) + String.fromCharCode(57 - G.RANK_Y(sq) + G.RANK_TOP);
}

function engineMove(board: XqBoard, side: XqSide, millis = 400, depth = 8): { mv: XqMove | null; iccs: string; nodes: number; ms: number } {  G.__pos.fromFen(boardToFen(board, side));
  G.__pos.distance = 0;
  const t0 = Date.now();
  const raw = G.__search.searchMain(depth, millis);
  const ms = Date.now() - t0;
  const nodes = Number(G.__search.allNodes) || 0;
  if (!raw) return { mv: null, iccs: '', nodes, ms };
  const iccs = move2Iccs(raw);
  return { mv: uciToXqMove(iccs.replace('-', '').toLowerCase(), board), iccs, nodes, ms };
}

/* ── ① 上游脚本可用 ── */
check('position.js / search.js / book.js 已加载（Position/Search 就位）', typeof G.Position === 'function' && typeof G.Search === 'function');
check('开局库 BOOK_DAT 已加载', Array.isArray((ctx as { BOOK_DAT?: unknown[] }).BOOK_DAT) && ((ctx as { BOOK_DAT: unknown[] }).BOOK_DAT.length > 0));

/* ── ② 初始局面：着法合法，且走的是开局库（瞬间出着） ── */
{
  const board = createInitialBoard();
  const r = engineMove(board, 'r', 500);
  const legal = !!r.mv && legalMoves(board, 'r').some((m) => m.fx === r.mv!.fx && m.fy === r.mv!.fy && m.tx === r.mv!.tx && m.ty === r.mv!.ty);
  check(`初始局面给出合法着法（${r.iccs}）`, legal, `${r.iccs} ${JSON.stringify(r.mv)}`);
  check('首手来自开局库（节点数为 0 且毫秒级返回）', r.nodes === 0 && r.ms < 200, `nodes=${r.nodes} ms=${r.ms}`);

  const b = engineMove(board, 'b', 500);
  const legalB = !!b.mv && legalMoves(board, 'b').some((m) => m.fx === b.mv!.fx && m.fy === b.mv!.fy && m.tx === b.mv!.tx && m.ty === b.mv!.ty);
  check(`黑方首手合法（${b.iccs}）`, legalB, b.iccs);
}

/* ── ③ ICCS 编码与项目坐标映射一致 ── */
{
  // 红炮在 (x=1,y=7)，按 ICCS 应为 B2；这条断言把「档位错位」这类 bug 钉死
  const board = createInitialBoard();
  const cannon = move2IccsFromXY(1, 7);
  check(`红炮所在格编码为 B2（实际 ${cannon}）`, cannon === 'B2', cannon);
  const rook = move2IccsFromXY(0, 9);
  check(`红车所在格编码为 A0（实际 ${rook}）`, rook === 'A0', rook);
  const blackPawn = move2IccsFromXY(0, 3);
  check(`黑卒所在格编码为 A6（实际 ${blackPawn}）`, blackPawn === 'A6', blackPawn);

  const c = engineMove(board, 'r', 1, 1);
  check('ICCS 形如 X#-X#', /^[A-I][0-9]-[A-I][0-9]$/.test(c.iccs), c.iccs);
  const mv = uciToXqMove(c.iccs.replace('-', '').toLowerCase(), board);
  check('ICCS 能被项目解码器解析', !!mv, c.iccs);
}

/* ── ④ 一步杀：红车 i6 下底 i9 成杀（构造的局面本身合法：黑将此时未被将军） ── */
{
  const mate = createInitialBoard();
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) mate[y][x] = null;
  mate[0][4] = 'k';   // 黑将 e9
  mate[9][3] = 'K';   // 红帅 d0（故意错开一列，否则双方主帅照面＝飞将，局面非法）
  mate[1][0] = 'R';   // 红车 a8：封住黑将 (4,1) 的逃路
  mate[3][8] = 'R';   // 红车 i6：下底 i9 即将军且控住整条底线 → 杀
  check('杀型局面本身合法（红走时黑将未被将军）', !inCheck(mate, 'b'));
  const r = engineMove(mate, 'r', 800, 6);
  const ok = !!r.mv && r.mv.fx === 8 && r.mv.fy === 3 && r.mv.tx === 8 && r.mv.ty === 0;
  check(`一步杀局面直接走杀着 I6-I9（实际 ${r.iccs}）`, ok, JSON.stringify(r.mv));
  if (r.mv) {
    const after = mate.map((row) => row.slice()) as XqBoard;
    makeMove(after, r.mv);
    check('走完之后黑方确实被将死', inCheck(after, 'b') && legalMoves(after, 'b').length === 0);
  }
}

/* ── ⑤ 随机中局若干：全部合法 ── */
{
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let ok = 0;
  const rounds = 3;
  for (let g = 0; g < rounds; g++) {
    const board = createInitialBoard();
    let side: XqSide = 'r';
    for (let i = 0; i < 10 + g * 6; i++) {
      const ms = legalMoves(board, side);
      if (!ms.length) break;
      makeMove(board, ms[Math.floor(rnd() * ms.length)]);
      side = side === 'r' ? 'b' : 'r';
    }
    const before = boardToFen(board, side);
    const r = engineMove(board, side, 300);
    const legal = !!r.mv && legalMoves(board, side).some((m) => m.fx === r.mv!.fx && m.fy === r.mv!.fy && m.tx === r.mv!.tx && m.ty === r.mv!.ty);
    if (legal) ok++;
    check(`随机中局 ${g + 1}（${side} 走，着法 ${r.iccs}）合法`, legal, r.iccs);
    check(`随机中局 ${g + 1} 不修改传入棋盘`, boardToFen(board, side) === before);
  }
  check(`随机中局 ${ok}/${rounds} 全部合法`, ok === rounds, String(ok));
}

/* ── ⑥ 难度档配置 ── */
check('四档难度都配了时限与深度上限', [1, 2, 3, 4].every((l) => XQWLIGHT_LEVELS[l as 1 | 2 | 3 | 4].millis > 0 && XQWLIGHT_LEVELS[l as 1 | 2 | 3 | 4].depth >= 4));
check('时限随难度递增', XQWLIGHT_LEVELS[1].millis < XQWLIGHT_LEVELS[2].millis && XQWLIGHT_LEVELS[2].millis < XQWLIGHT_LEVELS[3].millis && XQWLIGHT_LEVELS[3].millis < XQWLIGHT_LEVELS[4].millis);

finish('xqwlight');
