/* ────────────────────────────────────────────────────────────
 *  xiangqi/fen.ts — FEN + UCI 坐标编解码
 *
 *  象棋的两套引擎吃的都是 FEN 字符串与 ICCS/UCCI 走法（形如 "h2e2"），
 *  而我们内部用的是 2D 棋盘 + {fx,fy,tx,ty}。这一层负责两者之间的无损转换：
 *    · 神经网络引擎（src/xqnn/）：FEN 只用于测试与 fixture，正式路径直接用棋盘编码
 *    · XQWLight（src/xiangqi/xqwlight.ts）：每手把 FEN 喂给引擎，着法按 ICCS 收回
 *
 *  坐标约定（与标准象棋 FEN 一致）：
 *    · FEN 从【黑方底线】开始往下逐行书写 → FEN 第 y 行 = board[y]
 *    · 每行从左到右 → 第 x 个字符 = board[y][x]（x=0 即 a 列）
 *    · 大写 = 红方，小写 = 黑方（与本题 XqBoard 完全一致）
 *    · UCI 格：file = 'a' + x，rank = 9 - y（红方底线为 rank 0）
 *      例：红帅在 (4,9) → "e0"；黑将在 (4,0) → "e9"
 *    · FEN 行棋方：红 = 'w'，黑 = 'b'（与 xqbase 的 FEN 写法一致）
 * ──────────────────────────────────────────────────────────── */

import type { XqBoard, XqMove, XqSide } from '../types';
import { COLS, ROWS } from './rules';

/** 棋盘坐标 → UCI 格名（"e0"）。越界返回 null。 */
export function xyToSquare(x: number, y: number): string | null {
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return null;
  return String.fromCharCode(97 + x) + (9 - y);
}

/** UCI 格名 → 棋盘坐标。非法返回 null。 */
export function squareToXY(sq: string): { x: number; y: number } | null {
  if (sq.length !== 2) return null;
  const x = sq.charCodeAt(0) - 97;
  const rank = sq.charCodeAt(1) - 48;
  if (x < 0 || x >= COLS || rank < 0 || rank > 9) return null;
  return { x, y: 9 - rank };
}

/** XqMove → UCI 走法（"h2e2"）。 */
export function xqMoveToUci(m: XqMove): string {
  return `${xyToSquare(m.fx, m.fy) ?? ''}${xyToSquare(m.tx, m.ty) ?? ''}`;
}

/**
 * UCI 走法 → XqMove。棋子与吃子从 board 上现取，保证 piece/cap 字段正确。
 * 只做形状校验；合法性（是否真能走）由调用方用 legalMoves 复核。
 */
export function uciToXqMove(uci: string, board: XqBoard): XqMove | null {
  const s = uci.trim().toLowerCase();
  if (!/^[a-i][0-9][a-i][0-9]$/.test(s)) return null;
  const from = squareToXY(s.slice(0, 2));
  const to = squareToXY(s.slice(2, 4));
  if (!from || !to) return null;
  const piece = board[from.y][from.x];
  if (!piece) return null; // 起点无子：引擎给了个不存在的着法
  return {
    fx: from.x,
    fy: from.y,
    tx: to.x,
    ty: to.y,
    piece,
    cap: board[to.y][to.x] ?? null,
  };
}

/** 2D 棋盘 + 行棋方 → 象棋 FEN。 */
export function boardToFen(board: XqBoard, turn: XqSide): string {
  const rows: string[] = [];
  for (let y = 0; y < ROWS; y++) {
    let s = '';
    let empty = 0;
    for (let x = 0; x < COLS; x++) {
      const p = board[y][x];
      if (!p) {
        empty++;
        continue;
      }
      if (empty) {
        s += String(empty);
        empty = 0;
      }
      s += p;
    }
    if (empty) s += String(empty);
    rows.push(s);
  }
  return `${rows.join('/')} ${turn === 'r' ? 'w' : 'b'} - - 0 1`;
}

/** 初始局面 FEN（用于调试/自检）。 */
export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
