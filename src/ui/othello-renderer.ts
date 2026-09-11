/* ────────────────────────────────────────────────────────────
 *  ui/othello-renderer.ts — 黑白棋棋盘渲染（Canvas 2D）
 *
 *  与五子棋渲染器同一套视觉语言：木纹底、圆角、最后一手标记、
 *  候选/提示/神指标记。黑白棋额外画合法性小圆点与「刚被翻掉」的
 *  棋子高亮，让翻转过程一眼可读。
 * ──────────────────────────────────────────────────────────── */

import type { OthBoard, OthDisc, Pt } from '../types';
import { ptOfIndex, indexOfPt } from '../othello/search';

const SIZE = 620;
const PAD = 40;
const GAP = (SIZE - PAD * 2) / 8;
const R = GAP * 0.42;

export interface OthRenderState {
  /** 64 格棋盘（0 空 / 1 黑 / 2 白），index = y*8+x（y 自上而下） */
  board: OthBoard;
  turn: OthDisc;
  over: boolean;
  /** 人类执子（AI 模式下用于标记合法点） */
  human: OthDisc;
  /** 显示合法性小圆点 */
  showLegal: boolean;
  /** 合法落点（对外索引） */
  legal: number[];
  /** 最后一手 */
  last: Pt | null;
  /** 最后一手翻掉的棋子（对外索引） */
  lastFlipped: number[];
  /** 求一着高亮 */
  hint: Pt | null;
  /** 请神上身标记 */
  god: boolean;
  godMove: Pt | null;
  /** 思考中（画布上压一层轻微遮罩文案由 DOM 负责，这里只做落点抑制） */
  thinking: boolean;
  /** 翻转动画进度 0..1（1 = 已落定） */
  flipProgress: number;
  /** 正在翻转的棋子（对外索引） */
  flipping: number[];
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

/**
 * 棋盘格中心。
 * 逻辑 row = 0 是棋谱第 1 行，而画布上把 rank 8 放在最上面 → 画布行 = 7 - row。
 * 这是全项目唯一做视觉行翻转的地方（点击换算见 pxToCellOth）。
 */
export function centerOf(index: number): { x: number; y: number } {
  const p = ptOfIndex(index);
  return { x: PAD + p.x * GAP + GAP / 2, y: PAD + (7 - p.y) * GAP + GAP / 2 };
}

function drawBoardBack(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  g.addColorStop(0, '#0f5132');
  g.addColorStop(0.5, '#0b6b3a');
  g.addColorStop(1, '#084d2a');
  ctx.fillStyle = g;
  roundRect(ctx, 0, 0, SIZE, SIZE, 20);
  ctx.fill();

  // 网格线
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.lineWidth = 1.6;
  for (let i = 0; i <= 8; i++) {
    const p = PAD + i * GAP;
    ctx.beginPath(); ctx.moveTo(PAD, p); ctx.lineTo(SIZE - PAD, p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, PAD); ctx.lineTo(p, SIZE - PAD); ctx.stroke();
  }
  // 四个星位（黑白棋传统标记）
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  for (const [x, y] of [[2, 2], [6, 2], [2, 6], [6, 6]]) {
    ctx.beginPath();
    ctx.arc(PAD + x * GAP, PAD + y * GAP, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 画一枚棋子；color 已确定，pw 用于翻转动画的横向压缩 */
function drawDisc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: OthDisc,
  squash = 1,
): void {
  const rx = R * squash;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.5)';
  ctx.shadowBlur = 9;
  ctx.shadowOffsetY = 3;
  const g = ctx.createRadialGradient(cx - rx * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
  if (color === 1) {
    g.addColorStop(0, '#6e6e6e');
    g.addColorStop(0.45, '#232323');
    g.addColorStop(1, '#000');
  } else {
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.7, '#eaeaea');
    g.addColorStop(1, '#b9b9b9');
  }
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(1.5, rx), R, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function renderOth(canvas: HTMLCanvasElement, state: OthRenderState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, SIZE, SIZE);
  drawBoardBack(ctx);

  // 合法落点提示（人类回合 + 开启显示）
  if (state.showLegal && !state.over && !state.thinking) {
    for (const i of state.legal) {
      const c = centerOf(i);
      ctx.save();
      ctx.fillStyle = state.turn === 1 ? 'rgba(255,255,255,.28)' : 'rgba(0,0,0,.28)';
      ctx.beginPath();
      ctx.arc(c.x, c.y, R * 0.34, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // 棋子
  const flipping = new Set(state.flipping);
  for (let i = 0; i < 64; i++) {
    const v = state.board[i];
    if (!v) continue;
    const c = centerOf(i);
    let squash = 1;
    if (flipping.has(i)) {
      // 翻转动画：横向压缩到 0.12 再展开，模拟翻面
      const t = Math.min(1, Math.max(0, state.flipProgress));
      squash = Math.abs(Math.cos(Math.PI * t));
      squash = Math.max(0.12, squash);
    }
    drawDisc(ctx, c.x, c.y, v as OthDisc, squash);
  }

  // 刚被翻掉的棋子：金色描边
  for (const i of state.lastFlipped) {
    const c = centerOf(i);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,196,0,.95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R + 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // 最后一手：红圈
  if (state.last) {
    const c = centerOf(indexOfPt(state.last));
    ctx.save();
    ctx.strokeStyle = '#ff3b30';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // 求一着：绿色虚线脉冲
  if (state.hint) {
    const c = centerOf(indexOfPt(state.hint));
    const p = 1 + Math.sin(Date.now() / 150) * 0.12;
    ctx.save();
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 3;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, (R + 6) * p, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // 请神上身：紫色神指
  if (state.god && state.godMove && !state.over) {
    const gi = indexOfPt(state.godMove);
    if (state.board[gi] === 0) {
      const c = centerOf(gi);
      const p = 1 + Math.sin(Date.now() / 300) * 0.14;
      ctx.save();
      ctx.strokeStyle = '#b388ff';
      ctx.lineWidth = 4;
      ctx.shadowColor = '#7c4dff';
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(c.x, c.y, (R + 9) * p, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(124,77,255,.18)';
      ctx.beginPath();
      ctx.arc(c.x, c.y, (R + 9) * p, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7c4dff';
      ctx.beginPath();
      ctx.arc(c.x - R - 4, c.y - R - 6, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('神', c.x - R - 4, c.y - R - 6);
      ctx.font = '28px "Segoe UI Emoji","Noto Color Emoji",serif';
      ctx.fillText('👇', c.x, c.y - R - 22 + Math.sin(Date.now() / 300) * 4);
      ctx.restore();
    }
  }
}

/** 画布坐标 → 对外格索引；点不中返回 null */
export function pxToCellOth(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): number | null {
  const r = canvas.getBoundingClientRect();
  const sx = SIZE / r.width;
  const sy = SIZE / r.height;
  const px = (e.clientX - r.left) * sx;
  const py = (e.clientY - r.top) * sy;
  const x = Math.floor((px - PAD) / GAP);
  const y = Math.floor((py - PAD) / GAP);
  if (x < 0 || x > 7 || y < 0 || y > 7) return null;
  // 画布行自上而下（rank 8 在顶），逻辑 row = 7 - 画布行
  return indexOfPt({ x, y: 7 - y });
}

export { SIZE as OTH_CANVAS_SIZE };

/** 局势条百分比：子数差映射到 5%~95% */
export function othScorePercent(board: OthBoard, human: OthDisc): number {
  let b = 0, w = 0;
  for (let i = 0; i < 64; i++) {
    if (board[i] === 1) b++;
    else if (board[i] === 2) w++;
  }
  const total = Math.max(1, b + w);
  const mine = human === 1 ? b : w;
  return Math.max(5, Math.min(95, (mine / total) * 100));
}
