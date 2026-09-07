/* ────────────────────────────────────────────────────────────
 *  ui/gomoku-renderer.ts — Canvas rendering for the Gomoku board
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer, Pt } from '../types';
import { BOARD_SIZE } from '../gomoku/rules';
import { evaluateBoard } from '../gomoku/eval';
import type { GomokuMove } from '../types';

const SIZE = 620;
const PAD = 32;
const CELL = (SIZE - PAD * 2) / (BOARD_SIZE - 1);
const STARS: ReadonlyArray<readonly [number, number]> = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];

export interface GomokuRenderState {
  board: GomokuBoard;
  history: Array<{ x: number; y: number; c: GomokuPlayer }>;
  turn: GomokuPlayer;
  over: boolean;
  winLine: Pt[] | null;
  hover: Pt | null;
  hint: Pt | null;
  viz: boolean;
  thinkCandidates: Array<GomokuMove & { v: number; rank?: number }>;
  god: boolean;
  godMove: GomokuMove | null;
  godThinking: boolean;
  human: GomokuPlayer;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawWood(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  g.addColorStop(0, '#eec983');
  g.addColorStop(0.5, '#dfae5c');
  g.addColorStop(1, '#c68f3e');
  ctx.fillStyle = g;
  roundRect(ctx, 0, 0, SIZE, SIZE, 18);
  ctx.fill();
  ctx.save();
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = '#7a4d18';
    ctx.beginPath();
    ctx.moveTo(Math.random() * SIZE, 0);
    ctx.lineTo(Math.random() * SIZE, SIZE);
    ctx.stroke();
  }
  ctx.restore();
}

export function renderGomoku(canvas: HTMLCanvasElement, state: GomokuRenderState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, SIZE, SIZE);
  drawWood(ctx);

  // Grid lines
  ctx.strokeStyle = 'rgba(60,35,5,.85)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < BOARD_SIZE; i++) {
    ctx.beginPath(); ctx.moveTo(PAD, PAD + i * CELL); ctx.lineTo(SIZE - PAD, PAD + i * CELL); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD + i * CELL, PAD); ctx.lineTo(PAD + i * CELL, SIZE - PAD); ctx.stroke();
  }

  // Star points
  ctx.fillStyle = '#3c2305';
  for (const [x, y] of STARS) {
    ctx.beginPath(); ctx.arc(PAD + x * CELL, PAD + y * CELL, 4.5, 0, Math.PI * 2); ctx.fill();
  }

  // Stones
  state.history.forEach((h, idx) => {
    const cx = PAD + h.x * CELL;
    const cy = PAD + h.y * CELL;
    const isLast = idx === state.history.length - 1;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    const g = ctx.createRadialGradient(cx - 5, cy - 6, 2, cx, cy, 17);
    if (h.c === 1) { g.addColorStop(0, '#6b6b6b'); g.addColorStop(0.4, '#222'); g.addColorStop(1, '#000'); }
    else { g.addColorStop(0, '#fff'); g.addColorStop(0.7, '#e8e8e8'); g.addColorStop(1, '#b5b5b5'); }
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, 16, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (isLast) {
      ctx.strokeStyle = h.c === 1 ? '#f6d47c' : '#c92f2f';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(cx, cy, 20, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = h.c === 1 ? '#f6d47c' : '#c92f2f';
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
    }
  });

  // Win line
  if (state.winLine) {
    ctx.strokeStyle = '#ff3b30';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.shadowColor = '#ff3b30';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(PAD + state.winLine[0].x * CELL, PAD + state.winLine[0].y * CELL);
    const last = state.winLine[state.winLine.length - 1];
    ctx.lineTo(PAD + last.x * CELL, PAD + last.y * CELL);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // AI candidate visualization
  if (state.viz && state.thinkCandidates.length > 0 && !state.over) {
    // Only the best candidate is drawn (as a clear gold ring); the rest of
    // the semi-transparent dashed rings / dark rank badges are skipped so they
    // no longer render as clashing black line fragments on the board.
    const best = state.thinkCandidates[0];
    if (best && state.board[best.y] && state.board[best.y][best.x] === 0) {
      const cx = PAD + best.x * CELL;
      const cy = PAD + best.y * CELL;
      ctx.save();
      const p = 1 + Math.sin(Date.now() / 280) * 0.12;
      ctx.strokeStyle = '#ffd54a';
      ctx.lineWidth = 3.5;
      ctx.shadowColor = '#ffb300';
      ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(cx, cy, 20 * p, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,213,74,.22)';
      ctx.beginPath(); ctx.arc(cx, cy, 20 * p, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd54a';
      ctx.beginPath(); ctx.arc(cx - 13, cy - 13, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a1206';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('1', cx - 13, cy - 13);
      ctx.restore();
    }
  }

  // Hint marker
  if (state.hint) {
    const p = 1 + Math.sin(Date.now() / 150) * 0.15;
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.arc(PAD + state.hint.x * CELL, PAD + state.hint.y * CELL, 19 * p, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  // God mode marker
  if (state.god && state.godMove && !state.over && state.board[state.godMove.y] && state.board[state.godMove.y][state.godMove.x] === 0) {
    const gx = PAD + state.godMove.x * CELL;
    const gy = PAD + state.godMove.y * CELL;
    const p = 1 + Math.sin(Date.now() / 300) * 0.15;
    ctx.save();
    ctx.strokeStyle = '#b388ff';
    ctx.lineWidth = 4;
    ctx.shadowColor = '#7c4dff';
    ctx.shadowBlur = 18;
    ctx.beginPath(); ctx.arc(gx, gy, 23 * p, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(124,77,255,.16)';
    ctx.beginPath(); ctx.arc(gx, gy, 23 * p, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#7c4dff';
    ctx.beginPath(); ctx.arc(gx - 18, gy - 20, 11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('神', gx - 18, gy - 20);
    const bob = Math.sin(Date.now() / 300) * 4;
    ctx.font = '30px "Segoe UI Emoji","Noto Color Emoji",serif';
    ctx.fillText('👇', gx, gy - 38 + bob);
    ctx.restore();
  }

  // Hover ghost
  if (state.hover && !state.over && state.board[state.hover.y] && state.board[state.hover.y][state.hover.x] === 0) {
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = state.turn === 1 ? '#000' : '#fff';
    ctx.beginPath(); ctx.arc(PAD + state.hover.x * CELL, PAD + state.hover.y * CELL, 15, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

export function pxToCellGomoku(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): { x: number; y: number } | null {
  const r = canvas.getBoundingClientRect();
  const sx = SIZE / r.width;
  const sy = SIZE / r.height;
  const px = (e.clientX - r.left) * sx - PAD;
  const py = (e.clientY - r.top) * sy - PAD;
  const x = Math.round(px / CELL);
  const y = Math.round(py / CELL);
  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return null;
  const cx = PAD + x * CELL;
  const cy = PAD + y * CELL;
  if (Math.hypot(px - (cx - PAD), py - (cy - PAD)) > CELL * 0.45) return null;
  return { x, y };
}

export { SIZE as GOMOKU_CANVAS_SIZE };

/** Compute score bar percentage for UI */
export function gomokuScorePercent(board: GomokuBoard, human: GomokuPlayer): number {
  const v = evaluateBoard(board, human);
  return Math.max(5, Math.min(95, 50 + v / 600));
}
