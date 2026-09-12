/* ────────────────────────────────────────────────────────────
 *  ui/xiangqi-renderer.ts — Canvas rendering for Xiangqi board
 * ──────────────────────────────────────────────────────────── */

import type { XqBoard, XqMove, XqSide, Pt } from '../types';
import { COLS, ROWS, PIECE_NAME, isRed, typeOf, colorOf } from '../xiangqi/rules';

const CW = 560;
const CH = 620;
const MX = 40;
const MY = 40;
const CELL = 60;

export interface XqRenderState {
  board: XqBoard;
  turn: XqSide;
  sel: Pt | null;
  moves: XqMove[];
  last: { fx: number; fy: number; tx: number; ty: number } | null;
  check: boolean;
  flip: boolean;
  over: boolean;
  viz: boolean;
  thinkMoves: Array<XqMove & { v: number; rank?: number }>;
  god: boolean;
  godMove: XqMove | null;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function L2S(state: XqRenderState, x: number, y: number): { sx: number; sy: number } {
  return state.flip ? { sx: COLS - 1 - x, sy: ROWS - 1 - y } : { sx: x, sy: y };
}

function L2SY(state: XqRenderState, r: number): number {
  return state.flip ? (ROWS - 1 - r) * CELL : r * CELL;
}

function palaceLines(ctx: CanvasRenderingContext2D, state: XqRenderState, isBottom: boolean): void {
  const rows = isBottom ? [7, 8, 9] : [0, 1, 2];
  const y0 = MY + L2SY(state, rows[0]);
  const y2 = MY + L2SY(state, rows[2]);
  const X = (lx: number) => MX + (state.flip ? COLS - 1 - lx : lx) * CELL;
  ctx.strokeStyle = 'rgba(90,50,10,.9)';
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(X(3), y0); ctx.lineTo(X(5), y2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(X(5), y0); ctx.lineTo(X(3), y2); ctx.stroke();
}

function cornerMarks(ctx: CanvasRenderingContext2D, state: XqRenderState, x: number, y: number): void {
  const { sx, sy } = L2S(state, x, y);
  if (x === 0 || x === 8) return;
  const X = MX + sx * CELL, Y = MY + sy * CELL;
  const d = 4, l = 14;
  ctx.strokeStyle = 'rgba(90,50,10,.9)';
  ctx.lineWidth = 1.6;
  for (const dx of (sx > 0 && sx < 8 ? [-1, 1] : (sx === 0 ? [1] : [-1]))) {
    for (const dy of [-1, 1]) {
      const cx = X + dx * d, cy = Y + dy * d;
      ctx.beginPath();
      ctx.moveTo(cx, cy + dy * -l); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * -l, cy);
      ctx.stroke();
    }
  }
}

export function renderXiangqi(canvas: HTMLCanvasElement, state: XqRenderState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, CW, CH);

  // Board background
  const g = ctx.createLinearGradient(0, 0, CW, CH);
  g.addColorStop(0, '#f0cd87');
  g.addColorStop(1, '#c8923f');
  ctx.fillStyle = g;
  rr(ctx, 0, 0, CW, CH, 18);
  ctx.fill();

  ctx.strokeStyle = 'rgba(90,50,10,.9)';
  ctx.lineWidth = 1.6;

  // Horizontal lines
  for (let r = 0; r < ROWS; r++) {
    ctx.beginPath(); ctx.moveTo(MX, MY + L2SY(state, r)); ctx.lineTo(CW - MX, MY + L2SY(state, r)); ctx.stroke();
  }

  // Vertical lines (split at river)
  for (let c = 0; c < COLS; c++) {
    const { sx } = L2S(state, c, 0);
    const X = MX + sx * CELL;
    ctx.beginPath(); ctx.moveTo(X, MY); ctx.lineTo(X, MY + 4 * CELL); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X, MY + 5 * CELL); ctx.lineTo(X, CH - MY); ctx.stroke();
  }

  // Outer border
  ctx.lineWidth = 3;
  ctx.strokeRect(MX, MY, (COLS - 1) * CELL, (ROWS - 1) * CELL);

  // Palace diagonals
  palaceLines(ctx, state, false);
  palaceLines(ctx, state, true);

  // Corner marks at cannon/pawn positions
  [[1,2],[7,2],[1,7],[7,7],[0,3],[2,3],[4,3],[6,3],[8,3],[0,6],[2,6],[4,6],[6,6],[8,6]].forEach(([x, y]) => cornerMarks(ctx, state, x, y));

  // River text
  ctx.fillStyle = 'rgba(90,50,10,.85)';
  ctx.font = '26px "Kaiti SC","STKaiti",serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const riverY = MY + 4.5 * CELL;
  ctx.fillText('楚', MX + 2 * CELL, riverY);
  ctx.fillText('河', MX + 3 * CELL, riverY);
  ctx.fillText('汉', MX + 5 * CELL, riverY);
  ctx.fillText('界', MX + 6 * CELL, riverY);

  // Last move highlight
  if (state.last) {
    const a = L2S(state, state.last.fx, state.last.fy);
    const b = L2S(state, state.last.tx, state.last.ty);
    ctx.strokeStyle = 'rgba(46,204,113,.9)';
    ctx.lineWidth = 3;
    ctx.strokeRect(MX + a.sx * CELL - 24, MY + a.sy * CELL - 24, 48, 48);
    ctx.strokeStyle = 'rgba(255,210,80,.95)';
    ctx.strokeRect(MX + b.sx * CELL - 24, MY + b.sy * CELL - 24, 48, 48);
  }

  // Legal move dots
  state.moves.forEach((m) => {
    const { sx, sy } = L2S(state, m.tx, m.ty);
    const X = MX + sx * CELL, Y = MY + sy * CELL;
    ctx.fillStyle = state.board[m.ty][m.tx] ? 'rgba(231,60,60,.9)' : 'rgba(46,204,113,.9)';
    ctx.beginPath(); ctx.arc(X, Y, state.board[m.ty][m.tx] ? 10 : 8, 0, Math.PI * 2); ctx.fill();
    if (state.board[m.ty][m.tx]) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X, Y, 10, 0, Math.PI * 2); ctx.stroke(); }
  });

  // AI think-move arrows
  if (state.viz && state.thinkMoves.length > 0 && !state.over) {
    const cols = ['#ffd54a', '#ff9f43', '#7ed6ff', '#a29bfe', '#fd79a8', '#00cec9'];
    state.thinkMoves.slice(0, 5).forEach((m, idx) => {
      if (m.fx == null) return;
      const a = L2S(state, m.fx, m.fy);
      const b = L2S(state, m.tx, m.ty);
      const x1 = MX + a.sx * CELL, y1 = MY + a.sy * CELL;
      const x2 = MX + b.sx * CELL, y2 = MY + b.sy * CELL;
      const isBest = idx === 0;
      ctx.save();
      ctx.globalAlpha = isBest ? 0.95 : 0.55;
      ctx.strokeStyle = cols[idx % cols.length];
      ctx.lineWidth = isBest ? 4 : 2.5;
      if (!isBest) ctx.setLineDash([7, 5]);
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const r1 = 26, r2 = 28;
      const sx = x1 + Math.cos(ang) * r1, sy = y1 + Math.sin(ang) * r1;
      const ex = x2 - Math.cos(ang) * r2, ey = y2 - Math.sin(ang) * r2;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cols[idx % cols.length];
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(ang - 0.45) * 12, ey - Math.sin(ang - 0.45) * 12);
      ctx.lineTo(ex - Math.cos(ang + 0.45) * 12, ey - Math.sin(ang + 0.45) * 12);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = isBest ? '#ffd54a' : 'rgba(10,15,25,.85)';
      ctx.beginPath(); ctx.arc(x1 + 18, y1 - 18, isBest ? 11 : 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isBest ? '#1a1206' : '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(idx + 1), x1 + 18, y1 - 18);
      if (isBest && m.v != null) {
        ctx.fillStyle = 'rgba(20,10,0,.8)';
        const label = String(m.v >= 999000 ? '绝杀' : m.v);
        ctx.font = 'bold 11px system-ui';
        const w = ctx.measureText(label).width + 12;
        ctx.fillRect((x1 + x2) / 2 - w / 2, (y1 + y2) / 2 - 22, w, 18);
        ctx.fillStyle = '#ffd54a';
        ctx.fillText(label, (x1 + x2) / 2, (y1 + y2) / 2 - 13);
      }
      ctx.restore();
    });
  }

  // Pieces
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = state.board[y][x];
      if (!p) continue;
      const { sx, sy } = L2S(state, x, y);
      const X = MX + sx * CELL, Y = MY + sy * CELL;
      const red = isRed(p);
      const t = typeOf(p)!;
      const sel = state.sel && state.sel.x === x && state.sel.y === y;
      const isChk = state.check && t === 'k' && colorOf(p) === state.turn;
      ctx.save();
      if (sel || isChk) { ctx.shadowColor = sel ? '#2ecc71' : '#ff2d2d'; ctx.shadowBlur = 18; }
      else { ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3; }
      const gg = ctx.createRadialGradient(X - 8, Y - 10, 4, X, Y, 26);
      if (red) { gg.addColorStop(0, '#fff3e0'); gg.addColorStop(0.55, '#f8d9a0'); gg.addColorStop(1, '#d99a3c'); }
      else { gg.addColorStop(0, '#f4f6f8'); gg.addColorStop(0.55, '#dfe6ec'); gg.addColorStop(1, '#9aa7b4'); }
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(X, Y, 24, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeStyle = isChk ? '#ff2d2d' : (red ? '#a31212' : '#1f2d3d');
      ctx.beginPath(); ctx.arc(X, Y, 24, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(X, Y, 19, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = red ? '#b81f1f' : '#1c2733';
      ctx.font = 'bold 24px "Kaiti SC","STKaiti",serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(PIECE_NAME[t][red ? 1 : 0], X, Y + 1);
      ctx.restore();
    }
  }

  // God mode overlay — drawn last so nothing (pieces/arrows) covers it
  drawGodOverlay(ctx, state);
}

function drawGodOverlay(ctx: CanvasRenderingContext2D, state: XqRenderState): void {
  if (!state.god || !state.godMove || state.godMove.fx == null || state.over) return;
  const gm = state.godMove;
  const srcPiece = state.board[gm.fy] && state.board[gm.fy][gm.fx];
  if (!srcPiece) return;

  const a = L2S(state, gm.fx, gm.fy);
  const b = L2S(state, gm.tx, gm.ty);
  const x1 = MX + a.sx * CELL, y1 = MY + a.sy * CELL;
  const x2 = MX + b.sx * CELL, y2 = MY + b.sy * CELL;
  const t = Date.now() / 300;
  const pulse = 1 + Math.sin(t) * 0.08;

  // 1) Source: purple cell tint + pulsing 神 badge on the piece corner
  ctx.save();
  ctx.fillStyle = 'rgba(124,77,255,.16)';
  rr(ctx, x1 - 28, y1 - 28, 56, 56, 10);
  ctx.fill();
  const bx = x1 - 22, by = y1 - 22;
  const bg = ctx.createRadialGradient(bx - 3, by - 4, 2, bx, by, 15);
  bg.addColorStop(0, '#cfa8ff');
  bg.addColorStop(1, '#7c4dff');
  ctx.fillStyle = bg;
  ctx.shadowColor = '#7c4dff';
  ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(bx, by, 13 * pulse, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('神', bx, by + 1);
  ctx.restore();

  // 2) Glowing arrow source → destination
  ctx.save();
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const sx = x1 + Math.cos(ang) * 30, sy = y1 + Math.sin(ang) * 30;
  const ex = x2 - Math.cos(ang) * 32, ey = y2 - Math.sin(ang) * 32;
  ctx.strokeStyle = '#b388ff';
  ctx.lineWidth = 5 * pulse;
  ctx.shadowColor = '#7c4dff';
  ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#b388ff';
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - Math.cos(ang - 0.45) * 16, ey - Math.sin(ang - 0.45) * 16);
  ctx.lineTo(ex - Math.cos(ang + 0.45) * 16, ey - Math.sin(ang + 0.45) * 16);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  // 3) Destination: pulsing target ring + gold corner ticks
  ctx.save();
  const R = 30 + Math.sin(t) * 2;
  ctx.strokeStyle = 'rgba(179,136,255,.95)';
  ctx.lineWidth = 4;
  ctx.shadowColor = '#7c4dff';
  ctx.shadowBlur = 18;
  ctx.beginPath(); ctx.arc(x2, y2, R, 0, Math.PI * 2); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,.7)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.arc(x2, y2, R + 6, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  const c = (R + 2) * 0.707, L = 10;
  ctx.strokeStyle = '#ffd54a';
  ctx.lineWidth = 3.5;
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const cx = x2 + dx * c, cy = y2 + dy * c;
    ctx.beginPath();
    ctx.moveTo(cx - dx * L, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy - dy * L);
    ctx.stroke();
  }
  ctx.restore();

  // 4) 👇 finger bobbing just above the target
  ctx.save();
  const bob = Math.sin(t) * 5;
  ctx.font = '30px "Segoe UI Emoji","Noto Color Emoji",serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = 6;
  ctx.fillText('👇', x2, y2 - 38 + bob);
  ctx.restore();
}

export function pxToCellXq(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }, flip: boolean): { x: number; y: number } | null {
  const r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) * (CW / r.width);
  const py = (e.clientY - r.top) * (CH / r.height);
  const sx = Math.round((px - MX) / CELL);
  const sy = Math.round((py - MY) / CELL);
  if (sx < 0 || sx > 8 || sy < 0 || sy > 9) return null;
  return flip ? { x: 8 - sx, y: 9 - sy } : { x: sx, y: sy };
}

export { CW as XQ_CANVAS_W, CH as XQ_CANVAS_H };
