/* ────────────────────────────────────────────────────────────
 *  junqi/render.ts — 军棋棋盘与棋子渲染
 *  支持视图翻转（执蓝时己方在下）、揭棋暗子背面、摆阵高亮。
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

export function renderJunqi(canvas: HTMLCanvasElement, st: JunqiRenderState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, JQ_W, JQ_H);

  // 底色（军绿纸面）
  ctx.fillStyle = '#e9eee7';
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

  // 连线：公路单线，铁路双线
  const drawn = new Set<string>();
  for (let i = 0; i < ROWS * COLS; i++) {
    for (const e of ADJ[i]) {
      const key = i < e.to ? `${i}-${e.to}` : `${e.to}-${i}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const a = dnode(i, st.flipView);
      const b = dnode(e.to, st.flipView);
      if (e.rail) {
        ctx.strokeStyle = '#5c6b63';
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = '#eef2ee';
        ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      } else {
        ctx.strokeStyle = '#93a29a';
        ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
  }

  // 节点：普通点 / 行营圆 / 大本营方
  for (let i = 0; i < ROWS * COLS; i++) {
    const { x, y } = dnode(i, st.flipView);
    if (isCamp(i)) {
      ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2);
      ctx.fillStyle = '#f7f9f5'; ctx.fill();
      ctx.strokeStyle = '#8fa096'; ctx.lineWidth = 1.6; ctx.stroke();
    } else if (isHQ(i)) {
      ctx.beginPath();
      ctx.roundRect(x - 17, y - 17, 34, 34, 6);
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
      ctx.fillText('大本营', x, y + (rowOf(h) <= 5 ? -24 : 24));
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

  // 上次移动标记
  if (st.lastMove) {
    for (const n of [st.lastMove.from, st.lastMove.to]) {
      const { x, y } = dnode(n, st.flipView);
      ctx.beginPath(); ctx.arc(x, y, 24, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(14,159,133,.4)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 求一着提示
  if (st.hintMove) {
    for (const n of [st.hintMove.from, st.hintMove.to]) {
      const { x, y } = dnode(n, st.flipView);
      ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(214,158,46,.85)';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 合法落点提示
  if (st.sel !== null) {
    for (const t of st.targets) {
      const { x, y } = dnode(t, st.flipView);
      if (st.board[t]) {
        ctx.beginPath(); ctx.arc(x, y, 25, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(217,72,59,.8)';
        ctx.lineWidth = 3;
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(14,159,133,.55)';
        ctx.fill();
      }
    }
    const { x, y } = dnode(st.sel, st.flipView);
    ctx.beginPath(); ctx.arc(x, y, 25, 0, Math.PI * 2);
    ctx.strokeStyle = '#0e9f85';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // 棋子
  for (let i = 0; i < ROWS * COLS; i++) {
    const p = st.board[i];
    if (!p) continue;
    drawPiece(ctx, dnode(i, st.flipView), p, i === st.sel, faceDown(p, st.viewer));
  }
}

function drawPiece(ctx: CanvasRenderingContext2D, { x, y }: { x: number; y: number }, p: Piece, selected: boolean, faceDown: boolean): void {
  const red = p.side === 'r';
  ctx.save();
  ctx.shadowColor = 'rgba(28,43,51,.28)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2.5;
  ctx.beginPath();
  ctx.arc(x, y, 21, 0, Math.PI * 2);
  ctx.fillStyle = faceDown ? (red ? '#e6cdc9' : '#c8d8e8') : (red ? '#fdeeed' : '#e8f1fa');
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, 21, 0, Math.PI * 2);
  ctx.strokeStyle = red ? '#d9483b' : '#3b82c4';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (faceDown) {
    // 暗子背面：内圈虚线 + 星徽
    ctx.beginPath();
    ctx.arc(x, y, 15.5, 0, Math.PI * 2);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = red ? 'rgba(177,58,47,.45)' : 'rgba(43,95,143,.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = red ? '#a03a30' : '#2f5a86';
    ctx.font = 'bold 15px "PingFang SC","Microsoft YaHei",system-ui';
    ctx.fillText('✦', x, y + 1);
  } else {
    ctx.beginPath();
    ctx.arc(x, y, 16.5, 0, Math.PI * 2);
    ctx.strokeStyle = red ? 'rgba(217,72,59,.35)' : 'rgba(59,130,196,.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = red ? '#b13a2f' : '#2b5f8f';
    ctx.font = `bold 14px "PingFang SC","Microsoft YaHei",system-ui`;
    ctx.fillText(p.type, x, y + 1);
  }
  if (selected) {
    ctx.beginPath(); ctx.arc(x, y, 24, 0, Math.PI * 2);
    ctx.strokeStyle = '#0e9f85';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
}

/** 像素 → 节点（26px 容差） */
export function pxToNode(canvas: HTMLCanvasElement, cx: number, cy: number, flipView = false): number | null {
  const rect = canvas.getBoundingClientRect();
  const x = ((cx - rect.left) / rect.width) * JQ_W;
  const y = ((cy - rect.top) / rect.height) * JQ_H;
  let best = -1;
  let bd = 26;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const d = Math.hypot(x - px(c), y - py(r));
      if (d < bd) { bd = d; best = idx(r, c); }
    }
  }
  if (best < 0) return null;
  return flipView ? mirrorNode(best) : best;
}
