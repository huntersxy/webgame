/* ────────────────────────────────────────────────────────────
 *  junqi/render.ts — 军棋棋盘与棋子渲染
 *
 *  视觉：军绿纸面 + 双线枕木铁路 + 木板桥 + 长方形军牌棋子；
 *  支持视图翻转（执蓝时己方在下）、揭棋暗子背面（星徽）、
 *  摆阵高亮、上一步轨迹箭头、走子滑动动画。
 * ──────────────────────────────────────────────────────────── */

import { ADJ, COLS, ROWS, idx, rowOf, colOf, isCamp, isHQ, HQS, ownHalf, type Board, type Piece, type Side, type PType } from './rules';

const X0 = 70;
const Y0 = 44;
const SX = 110;
const SY = 52;
const RIVER = 60;
export const JQ_W = 580;
export const JQ_H = 730;

export const px = (c: number): number => X0 + c * SX;
export const py = (r: number): number => Y0 + r * SY + (r >= 6 ? RIVER : 0);

/** 视图翻转：行 11-r 镜像，列不变 */
export const mirrorNode = (i: number): number => idx(11 - rowOf(i), colOf(i));

export interface JunqiRenderState {
  board: Board;
  sel: number | null;
  targets: number[];
  lastMove: { from: number; to: number } | null;
  over: boolean;
  /** 执蓝 / 摆阵时翻转视图 */
  flipView: boolean;
  hintMove: { from: number; to: number } | null;
  /** 摆阵阶段 */
  setup: boolean;
  setupSide: Side;
  hand: PType | null;
  /** 观察者：人机模式=人类玩家；AI互搏=null（旁观者只见已翻明之子） */
  viewer: Side | null;
  /** 走子动画：piece 从 from 向 to 滑动，t ∈ [0,1] */
  anim: { piece: Piece; from: number; to: number; t: number } | null;
}

/** 该子对观察者是否背面朝上（揭棋：己方全明，对方暗置） */
function faceDown(p: Piece, viewer: Side | null): boolean {
  if (!p.hidden) return false;
  return viewer === null || p.side !== viewer;
}

function dnode(i: number, flipView: boolean): { x: number; y: number } {
  const d = flipView ? mirrorNode(i) : i;
  return { x: px(colOf(d)), y: py(rowOf(d)) };
}

/** 军牌尺寸 */
const TW = 48;
const TH = 32;

function fiveStar(ctx: CanvasRenderingContext2D, x: number, y: number, R: number): void {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const ang = -Math.PI / 2 + (k * Math.PI) / 5;
    const rad = k % 2 === 0 ? R : R * 0.42;
    const sx = x + Math.cos(ang) * rad;
    const sy = y + Math.sin(ang) * rad;
    if (k === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
}

/** 铁路：深色基线 + 浅色枕木（垂直于线路等距分布） */
function drawRailwayFixed(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  ctx.strokeStyle = '#5c6b63';
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.strokeStyle = '#eef2ee';
  ctx.lineWidth = 1.6;
  const nx = -dy / len;
  const ny = dx / len;
  const ties = Math.max(2, Math.floor(len / 9));
  for (let k = 0; k <= ties; k++) {
    const t = k / ties;
    const cx = a.x + dx * t;
    const cy = a.y + dy * t;
    ctx.beginPath();
    ctx.moveTo(cx - nx * 3, cy - ny * 3);
    ctx.lineTo(cx + nx * 3, cy + ny * 3);
    ctx.stroke();
  }
}

export function renderJunqi(canvas: HTMLCanvasElement, st: JunqiRenderState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, JQ_W, JQ_H);

  // 底色（军绿纸面，带轻微纵向渐变）
  const bg = ctx.createLinearGradient(0, 0, 0, JQ_H);
  bg.addColorStop(0, '#edf0e9');
  bg.addColorStop(1, '#e6ebe2');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, JQ_W, JQ_H);

  // 楚河汉界式河流带
  const ry0 = py(5) + 20;
  const ry1 = py(6) - 20;
  const rg = ctx.createLinearGradient(0, ry0, 0, ry1);
  rg.addColorStop(0, '#c3dcec');
  rg.addColorStop(1, '#a8cde6');
  ctx.fillStyle = rg;
  ctx.fillRect(26, ry0, JQ_W - 52, ry1 - ry0);
  ctx.strokeStyle = 'rgba(255,255,255,.6)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (let k = 0; k < 7; k++) {
    const wx = 60 + k * 78;
    const wy = ry0 + 14 + (k % 2) * 22;
    ctx.beginPath();
    ctx.arc(wx, wy, 11, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(43,95,143,.5)';
  ctx.font = 'bold 15px "Kaiti SC", STKaiti, KaiTi, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('天 堑 河 流', JQ_W / 2, (ry0 + ry1) / 2);

  // 三座木板桥（在连线之下，供铁路横跨）
  const bridgeNodes: Array<[number, number]> = [[5, 0], [5, 2], [5, 4]];
  for (const [, c] of bridgeNodes) {
    const bx = px(c);
    ctx.beginPath();
    ctx.roundRect(bx - 13, ry0 - 3, 26, ry1 - ry0 + 6, 5);
    ctx.fillStyle = '#dccfa8';
    ctx.fill();
    ctx.strokeStyle = '#a8946a';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // 桥板横纹
    ctx.strokeStyle = 'rgba(139,118,80,.5)';
    ctx.lineWidth = 1;
    for (let k = 1; k <= 4; k++) {
      const yy = ry0 + ((ry1 - ry0) * k) / 5;
      ctx.beginPath(); ctx.moveTo(bx - 11, yy); ctx.lineTo(bx + 11, yy); ctx.stroke();
    }
  }

  // 连线：公路单线，铁路深色基线 + 枕木
  const drawn = new Set<string>();
  const edges: Array<{ a: { x: number; y: number }; b: { x: number; y: number }; rail: boolean }> = [];
  for (let i = 0; i < ROWS * COLS; i++) {
    for (const e of ADJ[i]) {
      const key = i < e.to ? `${i}-${e.to}` : `${e.to}-${i}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const a = dnode(i, st.flipView);
      const b = dnode(e.to, st.flipView);
      edges.push({ a, b, rail: e.rail });
    }
  }
  // 先公路后铁路，保证铁路压在公路上
  for (const e of edges) {
    if (e.rail) continue;
    ctx.strokeStyle = '#97a49b';
    ctx.lineWidth = 1.7;
    ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
  }
  for (const e of edges) {
    if (e.rail) drawRailwayFixed(ctx, e.a, e.b);
  }

  // 节点：普通点 / 行营圆 / 大本营方
  for (let i = 0; i < ROWS * COLS; i++) {
    const { x, y } = dnode(i, st.flipView);
    if (isCamp(i)) {
      ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2);
      ctx.fillStyle = '#f6f8f4'; ctx.fill();
      ctx.strokeStyle = '#8fa096'; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    } else if (isHQ(i)) {
      ctx.beginPath();
      ctx.roundRect(x - 18, y - 18, 36, 36, 7);
      ctx.fillStyle = '#f3efdf'; ctx.fill();
      ctx.strokeStyle = '#a0977c'; ctx.lineWidth = 1.6; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = '#7c8b83'; ctx.fill();
    }
  }
  ctx.font = '9px system-ui';
  ctx.fillStyle = '#9a9078';
  for (const s of ['b', 'r'] as const) {
    for (const h of HQS[s]) {
      const { x, y } = dnode(h, st.flipView);
      ctx.fillText('大本营', x, y + (rowOf(h) <= 5 ? -26 : 26));
    }
  }

  // 摆阵阶段：己方半场空位虚线圈
  if (st.setup) {
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.4;
    for (let i = 0; i < ROWS * COLS; i++) {
      if (!ownHalf(i, st.setupSide) || isCamp(i) || st.board[i]) continue;
      const { x, y } = dnode(i, st.flipView);
      ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2);
      ctx.strokeStyle = st.hand ? 'rgba(14,159,133,.55)' : 'rgba(124,139,131,.4)';
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // 行营禁放
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(217,72,59,.4)';
    for (let i = 0; i < ROWS * COLS; i++) {
      if (!ownHalf(i, st.setupSide) || !isCamp(i)) continue;
      const { x, y } = dnode(i, st.flipView);
      ctx.beginPath(); ctx.moveTo(x - 10, y - 10); ctx.lineTo(x + 10, y + 10);
      ctx.moveTo(x + 10, y - 10); ctx.lineTo(x - 10, y + 10);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 上一步：轨迹箭头（from → to）
  if (st.lastMove) {
    const a = dnode(st.lastMove.from, st.flipView);
    const b = dnode(st.lastMove.to, st.flipView);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // 控制点垂直偏移，弧线绕开棋子
    const mx = (a.x + b.x) / 2 + (-dy / len) * 14;
    const my = (a.y + b.y) / 2 + (dx / len) * 14;
    ctx.strokeStyle = 'rgba(14,159,133,.5)';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.stroke();
    // 箭头
    const endAng = Math.atan2(b.y - my, b.x - mx);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - Math.cos(endAng - 0.5) * 9, b.y - Math.sin(endAng - 0.5) * 9);
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - Math.cos(endAng + 0.5) * 9, b.y - Math.sin(endAng + 0.5) * 9);
    ctx.stroke();
    // 起点圈
    ctx.beginPath();
    ctx.arc(a.x, a.y, 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 求一着提示
  if (st.hintMove) {
    ctx.strokeStyle = 'rgba(214,158,46,.85)';
    ctx.lineWidth = 3;
    for (const n of [st.hintMove.from, st.hintMove.to]) {
      const { x, y } = dnode(n, st.flipView);
      ctx.beginPath(); ctx.arc(x, y, 27, 0, Math.PI * 2);
      ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // 合法落点提示
  if (st.sel !== null) {
    for (const t of st.targets) {
      const { x, y } = dnode(t, st.flipView);
      if (st.board[t]) {
        ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(217,72,59,.8)';
        ctx.lineWidth = 3;
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(14,159,133,.55)';
        ctx.fill();
      }
    }
    const { x, y } = dnode(st.sel, st.flipView);
    ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.strokeStyle = '#0e9f85';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // 棋子（军牌）
  for (let i = 0; i < ROWS * COLS; i++) {
    const p = st.board[i];
    if (!p) continue;
    if (st.anim && i === st.anim.from) continue; // 飞行中的棋子最后画
    drawTile(ctx, dnode(i, st.flipView), p, i === st.sel, faceDown(p, st.viewer));
  }
  // 飞行中的棋子（动画）：放大 + 深影，压在所有棋子之上
  if (st.anim) {
    const a = dnode(st.anim.from, st.flipView);
    const b = dnode(st.anim.to, st.flipView);
    const t = st.anim.t;
    const ease = 1 - Math.pow(1 - t, 3);
    const x = a.x + (b.x - a.x) * ease;
    const y = a.y + (b.y - a.y) * ease - Math.sin(t * Math.PI) * 8; // 轻微跃起
    drawTile(ctx, { x, y }, st.anim.piece, false, faceDown(st.anim.piece, st.viewer), 1.08);
  }
}

/** 长方形军牌 */
function drawTile(
  ctx: CanvasRenderingContext2D, { x, y }: { x: number; y: number },
  p: Piece, selected: boolean, faceDown: boolean, scale = 1,
): void {
  const red = p.side === 'r';
  const w = TW * scale;
  const h = TH * scale;
  ctx.save();
  // 阴影
  ctx.shadowColor = 'rgba(28,43,51,.3)';
  ctx.shadowBlur = selected || scale > 1 ? 9 : 5;
  ctx.shadowOffsetY = scale > 1 ? 4 : 2.5;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 7 * scale);
  ctx.fillStyle = faceDown ? (red ? '#e2c7c2' : '#c2d3e4') : (red ? '#fdeeed' : '#e8f1fa');
  ctx.fill();
  ctx.restore();
  // 边框
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 7 * scale);
  ctx.strokeStyle = red ? '#d9483b' : '#3b82c4';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (faceDown) {
    // 暗子背面：内圈虚线 + 五角星徽
    ctx.beginPath();
    ctx.roundRect(x - w / 2 + 4.5, y - h / 2 + 4.5, w - 9, h - 9, 5);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = red ? 'rgba(177,58,47,.5)' : 'rgba(43,95,143,.5)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.setLineDash([]);
    fiveStar(ctx, x, y, 8.5);
    ctx.fillStyle = red ? '#a03a30' : '#2f5a86';
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.roundRect(x - w / 2 + 3.5, y - h / 2 + 3.5, w - 7, h - 7, 5);
    ctx.strokeStyle = red ? 'rgba(217,72,59,.3)' : 'rgba(59,130,196,.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = red ? '#b13a2f' : '#2b5f8f';
    ctx.font = `bold ${Math.round(14 * scale)}px "PingFang SC","Microsoft YaHei",system-ui`;
    ctx.fillText(p.type, x, y + 1);
  }
  if (selected) {
    ctx.beginPath();
    ctx.roundRect(x - w / 2 - 4, y - h / 2 - 4, w + 8, h + 8, 9);
    ctx.strokeStyle = '#0e9f85';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
}

/** 像素 → 节点（27px 容差） */
export function pxToNode(canvas: HTMLCanvasElement, cx: number, cy: number, flipView = false): number | null {
  const rect = canvas.getBoundingClientRect();
  const x = ((cx - rect.left) / rect.width) * JQ_W;
  const y = ((cy - rect.top) / rect.height) * JQ_H;
  let best = -1;
  let bd = 27;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const d = Math.hypot(x - px(c), y - py(r));
      if (d < bd) { bd = d; best = idx(r, c); }
    }
  }
  if (best < 0) return null;
  return flipView ? mirrorNode(best) : best;
}
