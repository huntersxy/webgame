/* ────────────────────────────────────────────────────────────
 *  xiangqi/rules.ts — Complete Xiangqi (Chinese Chess) rules
 * ──────────────────────────────────────────────────────────── */

import type { XqBoard, XqMove, XqPiece, XqSide } from '../types';

export const COLS = 9;
export const ROWS = 10;

export const PIECE_VAL: Record<string, number> = {
  k: 100_000, r: 600, c: 300, n: 270, b: 120, a: 120, p: 60,
};

export const PIECE_NAME: Record<string, [string, string]> = {
  k: ['将', '帅'], a: ['士', '仕'], b: ['象', '相'],
  n: ['马', '马'], r: ['车', '车'], c: ['炮', '炮'], p: ['卒', '兵'],
};

export const isRed = (p: XqPiece): boolean => !!p && p === p.toUpperCase();
export const colorOf = (p: XqPiece): XqSide | null => (!p ? null : isRed(p) ? 'r' : 'b');
export const typeOf = (p: XqPiece): string | null => (p ? p.toLowerCase() : null);
export const inB = (x: number, y: number): boolean => x >= 0 && x < COLS && y >= 0 && y < ROWS;

export function inPalace(x: number, y: number, color: XqSide): boolean {
  return x >= 3 && x <= 5 && (color === 'b' ? y >= 0 && y <= 2 : y >= 7 && y <= 9);
}

export function createInitialBoard(): XqBoard {
  const _ = null;
  return [
    ['r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r'],
    [_, _, _, _, _, _, _, _, _],
    [_, 'c', _, _, _, _, _, 'c', _],
    ['p', _, 'p', _, 'p', _, 'p', _, 'p'],
    [_, _, _, _, _, _, _, _, _],
    [_, _, _, _, _, _, _, _, _],
    ['P', _, 'P', _, 'P', _, 'P', _, 'P'],
    [_, 'C', _, _, _, _, _, 'C', _],
    [_, _, _, _, _, _, _, _, _],
    ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R'],
  ];
}

export function findKing(board: XqBoard, color: XqSide): { x: number; y: number } | null {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = board[y][x];
      if (p && typeOf(p) === 'k' && colorOf(p) === color) return { x, y };
    }
  }
  return null;
}

/** Make a move on the board (returns captured piece for undo) */
export function makeMove(board: XqBoard, m: { fx: number; fy: number; tx: number; ty: number }): XqPiece {
  const cap = board[m.ty][m.tx];
  board[m.ty][m.tx] = board[m.fy][m.fx];
  board[m.fy][m.fx] = null;
  return cap;
}

/** Undo a move (restore captured piece) */
export function undoMoveOnBoard(board: XqBoard, m: { fx: number; fy: number; tx: number; ty: number }, cap: XqPiece): void {
  board[m.fy][m.fx] = board[m.ty][m.tx];
  board[m.ty][m.tx] = cap;
}

/**
 * Generate pseudo-legal moves for a piece at (x, y).
 * Does NOT check if the move leaves own king in check.
 */
export function pseudoMoves(board: XqBoard, x: number, y: number): XqMove[] {
  const p = board[y][x];
  if (!p) return [];

  const c = colorOf(p)!;
  const t = typeOf(p)!;
  const ms: XqMove[] = [];

  const add = (tx: number, ty: number): void => {
    if (!inB(tx, ty)) return;
    const q = board[ty][tx];
    if (!q) ms.push({ fx: x, fy: y, tx, ty, cap: null, piece: p });
    else if (colorOf(q) !== c) ms.push({ fx: x, fy: y, tx, ty, cap: q, piece: p });
  };

  switch (t) {
    case 'k': {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const tx = x + dx, ty = y + dy;
        if (inPalace(tx, ty, c)) add(tx, ty);
      }
      // Flying general (飞将)
      const dir = c === 'r' ? -1 : 1;
      let yy = y + dir;
      while (inB(x, yy)) {
        const q = board[yy][x];
        if (q) {
          if (typeOf(q) === 'k' && colorOf(q) !== c) ms.push({ fx: x, fy: y, tx: x, ty: yy, cap: q, piece: p });
          break;
        }
        yy += dir;
      }
      break;
    }
    case 'a': {
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const tx = x + dx, ty = y + dy;
        if (inPalace(tx, ty, c)) add(tx, ty);
      }
      break;
    }
    case 'b': {
      for (const [dx, dy] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
        const tx = x + dx, ty = y + dy;
        const ex = x + dx / 2, ey = y + dy / 2;
        if (!inB(tx, ty)) continue;
        if (board[ey][ex]) continue; // elephant eye blocked
        if (c === 'b' && ty > 4) continue; // can't cross river
        if (c === 'r' && ty < 5) continue;
        add(tx, ty);
      }
      break;
    }
    case 'n': {
      const legs = [
        { dx: 2, dy: 1, lx: 1, ly: 0 }, { dx: 2, dy: -1, lx: 1, ly: 0 },
        { dx: -2, dy: 1, lx: -1, ly: 0 }, { dx: -2, dy: -1, lx: -1, ly: 0 },
        { dx: 1, dy: 2, lx: 0, ly: 1 }, { dx: -1, dy: 2, lx: 0, ly: 1 },
        { dx: 1, dy: -2, lx: 0, ly: -1 }, { dx: -1, dy: -2, lx: 0, ly: -1 },
      ];
      for (const L of legs) {
        const lx = x + L.lx, ly = y + L.ly;
        if (!inB(lx, ly) || board[ly][lx]) continue; // horse leg blocked
        add(x + L.dx, y + L.dy);
      }
      break;
    }
    case 'r': {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let tx = x + dx, ty = y + dy;
        while (inB(tx, ty)) {
          const q = board[ty][tx];
          if (!q) ms.push({ fx: x, fy: y, tx, ty, cap: null, piece: p });
          else { if (colorOf(q) !== c) ms.push({ fx: x, fy: y, tx, ty, cap: q, piece: p }); break; }
          tx += dx; ty += dy;
        }
      }
      break;
    }
    case 'c': {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let tx = x + dx, ty = y + dy;
        // Move freely until hitting a piece (the "screen")
        while (inB(tx, ty) && !board[ty][tx]) {
          ms.push({ fx: x, fy: y, tx, ty, cap: null, piece: p });
          tx += dx; ty += dy;
        }
        if (!inB(tx, ty)) continue; // found screen
        tx += dx; ty += dy;
        // Look for target after the screen
        while (inB(tx, ty)) {
          const q = board[ty][tx];
          if (q) { if (colorOf(q) !== c) ms.push({ fx: x, fy: y, tx, ty, cap: q, piece: p }); break; }
          tx += dx; ty += dy;
        }
      }
      break;
    }
    case 'p': {
      const fwd = c === 'r' ? -1 : 1;
      add(x, y + fwd);
      const crossed = c === 'r' ? y <= 4 : y >= 5;
      if (crossed) { add(x - 1, y); add(x + 1, y); }
      break;
    }
  }
  return ms;
}

/**
 * Check if square (tx, ty) is attacked by side `by`.
 * Direct attack detection — faster than generating all opponent moves.
 */
export function isAttacked(board: XqBoard, tx: number, ty: number, by: XqSide): boolean {
  // Rook / Flying General / Cannon along 4 axes
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let x = tx + dx, y = ty + dy;
    let first: { p: XqPiece; x: number; y: number } | null = null;
    while (inB(x, y)) {
      const p = board[y][x];
      if (p) { first = { p, x, y }; break; }
      x += dx; y += dy;
    }
    if (first) {
      const fc = colorOf(first.p);
      const ft = typeOf(first.p);
      if (fc === by && ft === 'r') return true;
      if (fc === by && ft === 'k' && dx === 0) return true; // flying general
      // Cannon: screen is first piece, find second piece
      x = first.x + dx; y = first.y + dy;
      while (inB(x, y)) {
        const p = board[y][x];
        if (p) { if (colorOf(p) === by && typeOf(p) === 'c') return true; break; }
        x += dx; y += dy;
      }
    }
  }

  // Horse (check for blocking leg)
  for (const [mx, my, lx, ly] of [[2, 1, 1, 0], [2, -1, 1, 0], [-2, 1, -1, 0], [-2, -1, -1, 0], [1, 2, 0, 1], [-1, 2, 0, 1], [1, -2, 0, -1], [-1, -2, 0, -1]]) {
    const nx = tx - mx, ny = ty - my;
    if (!inB(nx, ny)) continue;
    const p = board[ny][nx];
    if (p && colorOf(p) === by && typeOf(p) === 'n' && !board[ny + ly][nx + lx]) return true;
  }

  // Pawn / Soldier
  if (by === 'r') {
    if (inB(tx, ty + 1) && board[ty + 1][tx] === 'P') return true;
    if (ty <= 4) {
      if (inB(tx - 1, ty) && board[ty][tx - 1] === 'P') return true;
      if (inB(tx + 1, ty) && board[ty][tx + 1] === 'P') return true;
    }
  } else {
    if (inB(tx, ty - 1) && board[ty - 1][tx] === 'p') return true;
    if (ty >= 5) {
      if (inB(tx - 1, ty) && board[ty][tx - 1] === 'p') return true;
      if (inB(tx + 1, ty) && board[ty][tx + 1] === 'p') return true;
    }
  }

  // Elephant / Bishop (check eye block, can't cross river)
  for (const [mx, my] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
    if ((by === 'r' && ty < 5) || (by === 'b' && ty > 4)) break;
    const nx = tx - mx, ny = ty - my;
    if (!inB(nx, ny)) continue;
    const p = board[ny][nx];
    if (p && colorOf(p) === by && typeOf(p) === 'b' && !board[ny + my / 2][nx + mx / 2]) return true;
  }

  // Advisor (limited to palace)
  if (inPalace(tx, ty, by)) {
    for (const [mx, my] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = tx - mx, ny = ty - my;
      if (!inB(nx, ny)) continue;
      const p = board[ny][nx];
      if (p && colorOf(p) === by && typeOf(p) === 'a') return true;
    }
  }

  return false;
}

export function inCheck(board: XqBoard, color: XqSide): boolean {
  const k = findKing(board, color);
  if (!k) return true; // king captured = in check
  return isAttacked(board, k.x, k.y, color === 'r' ? 'b' : 'r');
}

/** Generate all legal moves (filtering out moves that leave own king in check) */
export function legalMoves(board: XqBoard, color: XqSide): XqMove[] {
  const kpos = findKing(board, color);
  const opp: XqSide = color === 'r' ? 'b' : 'r';
  const all: XqMove[] = [];

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = board[y][x];
      if (!p || colorOf(p) !== color) continue;
      for (const m of pseudoMoves(board, x, y)) {
        const cap = makeMove(board, m);
        const k = typeOf(p) === 'k' ? { x: m.tx, y: m.ty } : kpos;
        if (k && !isAttacked(board, k.x, k.y, opp)) all.push({ ...m, cap, piece: p });
        undoMoveOnBoard(board, m, cap);
      }
    }
  }
  return all;
}
