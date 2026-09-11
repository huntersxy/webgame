/* ────────────────────────────────────────────────────────────
 *  ui/go-renderer.ts — Canvas rendering for the Go board
 *  围棋棋盘渲染器：只负责画，不持有任何棋局状态。
 *  控制器每帧把完整状态交给 draw()，命中判定用 hitTest()。
 *  本文件不依赖 src/go/*，也不引入任何运行时依赖。
 * ──────────────────────────────────────────────────────────── */

/** 交点状态：0 = 空点，1 = 黑子，2 = 白子 */
export type GoStone = 0 | 1 | 2;

/** AI 候选点：i = 棋盘下标（y * size + x），v = 当前行棋方胜率 0..1（用于标签与热度色） */
export interface GoCandidate {
  i: number;
  v: number;
}

export interface GoRenderState {
  size: number;                    // 9 | 13 | 19
  stones: Uint8Array;              // 长度 size*size，行优先，0/1/2
  toMove: 1 | 2;
  lastMove: number;                // 棋盘下标，-1 表示无
  hover: number;                   // 指针下的棋盘下标，-1 表示无
  ghost: boolean;                  // hover 位置合法时是否画半透明的「下一手」
  ownership: Float32Array | null;  // 长度 size*size，+1 黑方归属、-1 白方归属（形势判断/数目）；null = 关闭
  candidates: GoCandidate[] | null; // AI 候选点（小圆点 + 数字）；null = 关闭
  deadStones: Uint8Array | null;   // 长度 size*size，1 = 终局数目时标记的死子（画叉）
  /** 「求一着」建议点（棋盘下标，-1 = 无）：画绿色虚线环 + 「推荐」角标 */
  hint: number;
  /** 建议点的呼吸动画相位 0..1（控制器在提示后的一两秒内推动它，之后停在 0） */
  hintPhase: number;
  /** 请神上身：开启时在该点画紫色「神」标记 */
  god: boolean;
  /** 神指的最佳点（棋盘下标，-1 = 还没算出来） */
  godMove: number;
  /** 神标记的动画相位 0..1（请神期间由控制器持续推动） */
  godPhase: number;
  dimmed: boolean;                 // AI 思考中 / 终局：轻微降低棋子对比度
}

/* ── 尺寸与配色常量 ───────────────────────────────────────── */

/** 逻辑基准边长（CSS 像素）：与五子棋 620 的画布保持一致的观感 */
const BASE_CSS = 620;
/** 实测盒子小于这个宽度时按「布局还没稳定」处理：忽略它，免得把画布钉死成一条细缝 */
const MIN_CSS = 240;
/** 后备缓冲倍率上限：与龙卷风控制器一致，避免超大画布拖慢每帧重绘 */
const MAX_DPR = 2.5;
const TAU = Math.PI * 2;

/** 列标签：围棋坐标跳过 I，A..T 正好 19 个字母 */
const COL_LABELS = 'ABCDEFGHJKLMNOPQRST';

/** 星位（天元/星）坐标，按路数取值 */
const STARS_9: ReadonlyArray<readonly [number, number]> = [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]];
const STARS_13: ReadonlyArray<readonly [number, number]> = [[3, 3], [9, 3], [3, 9], [9, 9], [6, 6]];
const STARS_19: ReadonlyArray<readonly [number, number]> = [
  [3, 3], [9, 3], [15, 3],
  [3, 9], [9, 9], [15, 9],
  [3, 15], [9, 15], [15, 15],
];

/** 形势判断方块：低不透明度，靠 globalAlpha 再乘一次归属强度 */
const OWN_BLACK = 'rgba(16,16,16,.5)';
const OWN_WHITE = 'rgba(255,255,255,.86)';

/** 候选点热度色：从灰绿（低胜率）过渡到站点主色薄荷绿 / accent-ink（高胜率） */
const HEAT: readonly string[] = [
  'rgba(122,134,140,.80)',
  'rgba(94,140,140,.82)',
  'rgba(66,152,140,.86)',
  'rgba(38,160,140,.90)',
  'rgba(16,168,140,.94)',
  'rgba(11,125,104,.96)',
];

/** 画布圆角矩形路径（与五子棋渲染器的 roundRect 同一套写法） */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : (v > hi ? hi : v);
}

function starPoints(size: number): ReadonlyArray<readonly [number, number]> {
  if (size === 9) return STARS_9;
  if (size === 13) return STARS_13;
  return STARS_19; // 19 路（含非标准路数的兜底：越界星位在绘制时会被跳过）
}

export class GoRenderer {
  private canvas: HTMLCanvasElement;

  /** 当前路数 */
  private size = 19;
  /** 逻辑边长（CSS 像素）：所有几何量都在这套坐标里算，绘制时再乘 DPR */
  private cssSize = BASE_CSS;
  private dpr = 1;
  /** 几何/贴图缓存是否已就绪 */
  private ready = false;
  /** 窗口尺寸变化后允许尝试一次放大到基准尺寸；没有它就不会逐帧反复试探 */
  private growPending = false;

  // ── 几何缓存：setSize()/尺寸变化时重算，draw() 只读 ──
  private pad = 0;       // 棋盘边距：网格居中，左/下这段留白里放坐标标签
  private originX = 0;   // 左上角第一个交点的逻辑坐标
  private originY = 0;
  private cell = 1;      // 相邻交点间距
  private gridW = 0;     // 网格区边长 = cell * (size - 1)
  private stoneR = 1;
  private starR = 3;
  private gridLineW = 1;
  private borderLineW = 2;
  private labelFont = 12;
  private spritePad = 0; // 棋子贴图内为投影预留的空白

  // ── 棋子贴图缓存：径向渐变 + 投影只画一次，之后逐帧 drawImage ──
  private blackSprite: HTMLCanvasElement | null = null;
  private whiteSprite: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.sync();
    // 窗口尺寸变化后允许重新尝试放大到基准尺寸；真正的重绘仍由控制器调用 draw() 触发
    window.addEventListener('resize', () => { this.growPending = true; });
  }

  /** 棋盘每边的交点数（9/13/19）。会按画布 CSS 尺寸重新计算几何。 */
  setSize(size: number): void {
    if (size !== this.size) {
      this.size = size;
      this.ready = false; // 路数变了：几何与棋子贴图都要重建
    }
    this.sync();
  }

  /* ── 画布尺寸 / DPR ────────────────────────────────────────
   * styles.css 里只有 `canvas { max-width:100%; height:auto }`，画布不设 CSS 尺寸时
   * width/height 属性本身就是元素的固有 CSS 尺寸——于是「放大后备缓冲」会顺带把元素撑大
   * （宽容器里会滚雪球）。所以这里用内联样式把 CSS 宽度钉在目标逻辑尺寸上，高度交给
   * height:auto 按 1:1 的固有比例保持正方形；窄屏时 max-width:100% 仍可整体缩小。
   * 元素实际盒子被压小时（宽 < 逻辑尺寸），就跟随盒子的真实宽度，保证 1 逻辑像素 = 1 CSS 像素。 */
  private sync(): void {
    const rect = this.canvas.getBoundingClientRect();
    const box = rect.width > 0 ? Math.min(rect.width, rect.height || rect.width) : 0;
    const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));

    let css = this.cssSize;
    // 盒子过小视为布局未稳定：既不测量也不钉宽度，直接沿用当前逻辑尺寸
    const measurable = box >= MIN_CSS;
    if (!this.ready) {
      css = measurable ? box : BASE_CSS; // 首次布局：以实测盒子为基准（可能已被窄屏压缩）
      this.growPending = false;
    } else if (measurable && box + 0.5 < this.cssSize) {
      css = box;                // 被 max-width 压小：逻辑尺寸必须跟随，否则画面会被整体拉伸
      this.growPending = false; // 本轮不再尝试放大，否则会一帧放大一帧缩小地抖动
    } else if (this.growPending) {
      css = BASE_CSS;           // 只在窗口尺寸变化后才尝试长回基准尺寸，撞限就下一帧跟随收缩
      this.growPending = false;
    }
    css = Math.round(clamp(css, MIN_CSS, BASE_CSS));

    if (this.ready && css === this.cssSize && dpr === this.dpr) return; // 无变化：复用几何与贴图

    this.cssSize = css;
    this.dpr = dpr;
    this.canvas.style.width = css + 'px';
    const px = Math.max(1, Math.round(css * dpr));
    if (this.canvas.width !== px || this.canvas.height !== px) {
      this.canvas.width = px;  // 改属性会清空画布与上下文状态，draw() 里每次都重设变换
      this.canvas.height = px;
    }
    this.layout();
    this.ready = true;
  }

  /** 按 cssSize + size 重算网格几何，并重建棋子贴图 */
  private layout(): void {
    const n = this.size;
    const s = this.cssSize;
    // 四边等宽留白：网格天然居中且保持正方形；左/下这段留白正好放坐标标签。
    // 留白随画布缩放，但夹在一个区间里：太小放不下「19」，太大棋盘就瘪了。
    const pad = clamp(s * 0.055, 16, 34);
    this.pad = pad;
    this.originX = pad;
    this.originY = pad;

    const gw = s - pad * 2;
    this.cell = n > 1 ? gw / (n - 1) : gw;
    this.gridW = this.cell * (n - 1);

    // 线宽随格子缩放：19 路要细、9 路要粗，边界线再加粗一档
    this.gridLineW = clamp(this.cell * 0.042, 0.9, 1.4);
    this.borderLineW = this.gridLineW * 2.2;
    this.stoneR = this.cell * 0.46; // 需求：半径 ≈ 0.46 格
    this.starR = clamp(this.cell * 0.115, 2, 4.6);
    this.labelFont = clamp(Math.min(pad * 0.62, this.cell * 0.46), 9, 15);
    this.spritePad = Math.ceil(this.stoneR * 0.72) + 2; // 容纳 shadowBlur + 向下偏移

    this.blackSprite = this.makeStoneSprite(1);
    this.whiteSprite = this.makeStoneSprite(2);
  }

  /** 离屏画一枚棋子（含渐变与投影），之后每帧只 drawImage，指针移动也不会有渐变分配开销 */
  private makeStoneSprite(color: GoStone): HTMLCanvasElement | null {
    const r = this.stoneR;
    const side = (r + this.spritePad) * 2;
    const cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(side * this.dpr));
    cv.height = cv.width;
    const c = cv.getContext('2d');
    if (!c) return null;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // 贴图按 DPR 绘制，drawImage 时再缩回 CSS 尺寸
    const cx = r + this.spritePad;
    const cy = cx;

    // 投影：轻微向下偏移，让棋子从木纹上「浮」起来
    c.save();
    c.shadowColor = 'rgba(48,30,5,.42)';
    c.shadowBlur = r * 0.5;
    c.shadowOffsetY = Math.max(1, r * 0.14);
    const g = c.createRadialGradient(cx - r * 0.34, cy - r * 0.38, r * 0.12, cx, cy, r * 1.05);
    if (color === 1) {
      g.addColorStop(0, '#8a8a8a');
      g.addColorStop(0.32, '#3a3a3a');
      g.addColorStop(0.72, '#141414');
      g.addColorStop(1, '#000');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.5, '#f7f7f4');
      g.addColorStop(0.82, '#e2e0d8');
      g.addColorStop(1, '#bfbcb1');
    }
    c.fillStyle = g;
    c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.fill();
    c.restore();

    // 描边：黑子压一圈深边、白子用淡灰边，保证两种子都能和暖木色分开
    c.lineWidth = Math.max(0.6, r * 0.06);
    c.strokeStyle = color === 1 ? 'rgba(0,0,0,.5)' : 'rgba(150,146,136,.6)';
    c.beginPath(); c.arc(cx, cy, r - c.lineWidth * 0.5, 0, TAU); c.stroke();

    // 黑子左上柔光高光；白子右下内阴影，做出亚光棋子的体积感
    if (color === 1) {
      const h = c.createRadialGradient(cx - r * 0.3, cy - r * 0.36, 0, cx - r * 0.3, cy - r * 0.36, r * 0.66);
      h.addColorStop(0, 'rgba(255,255,255,.5)');
      h.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = h;
    } else {
      const sh = c.createRadialGradient(cx + r * 0.3, cy + r * 0.34, r * 0.04, cx + r * 0.3, cy + r * 0.34, r * 0.92);
      sh.addColorStop(0, 'rgba(120,115,100,.26)');
      sh.addColorStop(1, 'rgba(120,115,100,0)');
      c.fillStyle = sh;
    }
    c.beginPath(); c.arc(cx, cy, r * 0.98, 0, TAU); c.fill();
    return cv;
  }

  /** 画一枚棋子（贴图不可用时退化成纯色圆） */
  private drawStone(ctx: CanvasRenderingContext2D, color: GoStone, cx: number, cy: number): void {
    const sprite = color === 1 ? this.blackSprite : this.whiteSprite;
    const body = (this.stoneR + this.spritePad) * 2;
    if (sprite) {
      ctx.drawImage(sprite, cx - body / 2, cy - body / 2, body, body);
      return;
    }
    ctx.fillStyle = color === 1 ? '#111' : '#f4f2ec';
    ctx.beginPath(); ctx.arc(cx, cy, this.stoneR, 0, TAU); ctx.fill();
  }

  /** 画一帧。纯函数式：状态全从参数来，不读内部对局状态。 */
  draw(state: GoRenderState): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    this.setSize(state.size); // 兜底：state.size 始终优先，控制器忘了调 setSize 也不会画错

    const n = this.size;
    const s = this.cssSize;
    const cell = this.cell;
    const ox = this.originX;
    const oy = this.originY;
    const grid = this.gridW;
    const stones = state.stones;
    const total = n * n;

    // 每帧重设变换：后备缓冲是 DPR 缩放的，且改过 canvas.width 会重置上下文状态
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);

    // 1) 木质底色：沿用五子棋/象棋的暖木渐变；不画木纹线，保持干净的平面观感
    const wood = ctx.createLinearGradient(0, 0, s, s);
    wood.addColorStop(0, '#eec983');
    wood.addColorStop(0.5, '#dfae5c');
    wood.addColorStop(1, '#c68f3e');
    roundRect(ctx, 0, 0, s, s, clamp(s * 0.03, 10, 18));
    ctx.fillStyle = wood;
    ctx.fill();

    // 2) 网格线
    ctx.strokeStyle = 'rgba(60,35,5,.85)';
    ctx.lineWidth = this.gridLineW;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const p = ox + k * cell;
      const q = oy + k * cell;
      ctx.moveTo(ox, q); ctx.lineTo(ox + grid, q);
      ctx.moveTo(p, oy); ctx.lineTo(p, oy + grid);
    }
    ctx.stroke();

    // 3) 外框线：稍粗一圈
    ctx.lineWidth = this.borderLineW;
    ctx.strokeRect(ox, oy, grid, grid);

    // 4) 星位
    ctx.fillStyle = '#3c2305';
    for (const [sx, sy] of starPoints(n)) {
      if (sx >= n || sy >= n) continue;
      ctx.beginPath(); ctx.arc(ox + sx * cell, oy + sy * cell, this.starR, 0, TAU); ctx.fill();
    }

    // 5) 坐标标签：列 A..T（跳过 I）在底部、行号 1..N 沿左侧向上递增
    //    （围棋惯例：左下角是 A1，所以第 y 行的行号是 size - y）
    ctx.fillStyle = 'rgba(96,64,22,.62)';
    ctx.font = `${this.labelFont}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labY = s - this.pad * 0.5;
    for (let x = 0; x < n; x++) {
      ctx.fillText(COL_LABELS[x] ?? String(x + 1), ox + x * cell, labY);
    }
    const labX = this.pad * 0.5;
    for (let y = 0; y < n; y++) {
      ctx.fillText(String(n - y), labX, oy + y * cell);
    }

    // 6) 形势判断：只在空点铺半透明方块，透明度随归属强度变化。
    //    画在棋子之前（网格线之后），棋盘线仍能透过方块看到。
    //    阈值 0.18：网络在空盘/稀疏局面上的归属值本身就在 0 附近抖动
    //    （逐点正负交替），全画出来是一片噪点；只画有把握的点才读得懂。
    if (state.ownership) {
      const own = state.ownership;
      const side = cell * 0.9;
      const half = side / 2;
      const lim = Math.min(total, stones.length, own.length);
      for (let i = 0; i < lim; i++) {
        if (stones[i] !== 0) continue;             // 只标空点
        const v = own[i] ?? 0;
        const a = Math.min(1, Math.abs(v));
        if (a < 0.18) continue;
        ctx.globalAlpha = Math.min(0.95, 0.45 + a * 0.5);
        ctx.fillStyle = v > 0 ? OWN_BLACK : OWN_WHITE;
        ctx.fillRect(ox + (i % n) * cell - half, oy + ((i / n) | 0) * cell - half, side, side);
      }
      ctx.globalAlpha = 1;
    }

    // 7) 棋子：思考中/终局时整体降一点对比度
    ctx.globalAlpha = state.dimmed ? 0.72 : 1;
    for (let i = 0; i < total && i < stones.length; i++) {
      const c = stones[i];
      if (c !== 1 && c !== 2) continue;
      this.drawStone(ctx, c, ox + (i % n) * cell, oy + ((i / n) | 0) * cell);
    }
    ctx.globalAlpha = 1;

    // 8) 死子叉号（终局数目）：黑子上用金色、白子上用红色，保证对比
    if (state.deadStones) {
      const dead = state.deadStones;
      const d = this.stoneR * 0.5;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.6, this.stoneR * 0.2);
      for (let i = 0; i < total && i < dead.length; i++) {
        if (dead[i] !== 1) continue;
        const c = stones[i];
        if (c !== 1 && c !== 2) continue; // 只给棋子画叉
        const cx = ox + (i % n) * cell;
        const cy = oy + ((i / n) | 0) * cell;
        ctx.strokeStyle = c === 1 ? '#ffd54a' : '#d43a3a';
        ctx.beginPath();
        ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
        ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
        ctx.stroke();
      }
      ctx.lineCap = 'butt'; // 复位，避免后续描边继承圆头
    }

    // 9) 最后一手：在棋子上打一个反色小环
    if (state.lastMove >= 0 && state.lastMove < total && state.lastMove < stones.length) {
      const c = stones[state.lastMove];
      if (c === 1 || c === 2) {
        drawLastMark(ctx, ox + (state.lastMove % n) * cell, oy + ((state.lastMove / n) | 0) * cell, this.stoneR, c);
      }
    }

    // 10) hover 半透明「下一手」
    const hover = state.hover;
    if (state.ghost && hover >= 0 && hover < total && hover < stones.length && stones[hover] === 0) {
      ctx.globalAlpha = 0.4;
      this.drawStone(ctx, state.toMove, ox + (hover % n) * cell, oy + ((hover / n) | 0) * cell);
      ctx.globalAlpha = 1;
    }

    // 11) AI 候选点：只画空点，且不盖住最后一手标记。
    //     倒序绘制，让数组靠前（通常是首选）的候选压在最上层。
    if (state.candidates && state.candidates.length > 0) {
      const cands: GoCandidate[] = state.candidates;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let k = cands.length - 1; k >= 0; k--) {
        const cand = cands[k];
        if (!cand) continue;
        const i = cand.i;
        if (i < 0 || i >= total || i >= stones.length) continue;
        if (stones[i] !== 0) continue;
        if (i === state.lastMove) continue;
        const v = clamp(cand.v, 0, 1);
        const cx = ox + (i % n) * cell;
        const cy = oy + ((i / n) | 0) * cell;
        const r = this.stoneR * (0.45 + 0.35 * v); // 胜率越高点越大
        const heat = HEAT[Math.min(HEAT.length - 1, Math.floor(v * HEAT.length))] ?? '#10a88c';
        ctx.fillStyle = heat;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.75)';
        ctx.lineWidth = Math.max(1, r * 0.14);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
        // 标签用胜率整数百分比，够短；三位数时缩小字号避免溢出圆点
        const label = String(Math.round(v * 100));
        const fs = Math.max(8, r * (label.length >= 3 ? 0.7 : 0.95));
        ctx.font = `bold ${fs}px system-ui`;
        ctx.lineWidth = Math.max(1, fs * 0.2);
        ctx.strokeStyle = 'rgba(0,0,0,.35)';
        ctx.strokeText(label, cx, cy + 0.5);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, cx, cy + 0.5);
      }
    }

    // 12) 「求一着」建议点：绿色虚线环 + 光晕 + 「推荐」角标。
    //     呼吸动画由 hintPhase 驱动（控制器只在提示后的一两秒里推动它，
    //     平时停在 0，所以静态帧也不会闪）。
    const hint = state.hint;
    if (hint >= 0 && hint < total && hint < stones.length && stones[hint] === 0) {
      const hx = ox + (hint % n) * cell;
      const hy = oy + ((hint / n) | 0) * cell;
      const pulse = 1 + Math.sin(state.hintPhase * TAU) * 0.13;
      const hr = this.stoneR * 1.18 * pulse;
      ctx.save();
      ctx.fillStyle = 'rgba(34,197,94,.20)';
      ctx.beginPath(); ctx.arc(hx, hy, hr, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = Math.max(2, cell * 0.07);
      ctx.setLineDash([Math.max(5, cell * 0.24), Math.max(4, cell * 0.17)]);
      ctx.beginPath(); ctx.arc(hx, hy, hr, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      // 角标：贴在该点上方，不遮住周围棋子的可读性
      const bw = Math.max(30, cell * 0.86);
      const bh = Math.max(15, cell * 0.38);
      const bx = hx - bw / 2;
      const by = Math.max(2, hy - hr - bh - cell * 0.06);
      ctx.fillStyle = '#22c55e';
      roundRect(ctx, bx, by, bw, bh, bh * 0.45);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(9, bh * 0.62)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('推荐', hx, by + bh / 2 + 0.5);
      ctx.restore();
    }

    // 13) 请神上身：紫色「神」标记 + 下指箭头（与五子棋的请神观感一致）
    if (state.god && state.godMove >= 0 && state.godMove < total && state.godMove < stones.length && stones[state.godMove] === 0) {
      const gx = ox + (state.godMove % n) * cell;
      const gy = oy + ((state.godMove / n) | 0) * cell;
      const pulse = 1 + Math.sin(state.godPhase * TAU) * 0.15;
      const gr = this.stoneR * 1.28 * pulse;
      ctx.save();
      ctx.strokeStyle = '#b388ff';
      ctx.lineWidth = Math.max(2.5, cell * 0.08);
      ctx.shadowColor = '#7c4dff';
      ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(gx, gy, gr, 0, TAU); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(124,77,255,.16)';
      ctx.beginPath(); ctx.arc(gx, gy, gr, 0, TAU); ctx.fill();
      // 左上角「神」角标
      const br = Math.max(9, cell * 0.28);
      ctx.fillStyle = '#7c4dff';
      ctx.beginPath(); ctx.arc(gx - gr * 0.78, gy - gr * 0.86, br, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(10, br * 1.15)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('神', gx - gr * 0.78, gy - gr * 0.86 + 0.5);
      // 下方跳动的指向箭头
      const bob = Math.sin(state.godPhase * TAU) * Math.max(2, cell * 0.16);
      ctx.font = `${Math.max(16, cell * 0.62)}px "Segoe UI Emoji","Noto Color Emoji",serif`;
      ctx.fillText('👇', gx, gy - gr - cell * 0.42 + bob);
      ctx.restore();
    }
  }

  /** 指针位置（clientX/clientY）→ 棋盘下标；超出棋盘或离交点太远返回 -1 */
  hitTest(clientX: number, clientY: number): number {
    this.sync(); // 窗口尺寸变了先跟上，保证换算比例与当前帧一致
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return -1;
    // 画布用 CSS max-width 缩放显示，按元素盒子的实际比例把 client 坐标换算回逻辑坐标
    const px = (clientX - rect.left) * (this.cssSize / rect.width);
    const py = (clientY - rect.top) * (this.cssSize / rect.height);
    const x = Math.round((px - this.originX) / this.cell);
    const y = Math.round((py - this.originY) / this.cell);
    if (x < 0 || x >= this.size || y < 0 || y >= this.size) return -1;
    const dx = px - (this.originX + x * this.cell);
    const dy = py - (this.originY + y * this.cell);
    if (Math.hypot(dx, dy) > this.cell * 0.48) return -1;
    return y * this.size + x;
  }

  /** 棋盘下标的像素中心（画布逻辑坐标，控制器做浮动标签时需加上 canvas 的 rect 偏移） */
  pointOf(index: number): { x: number; y: number } {
    this.sync();
    const n = this.size;
    return {
      x: this.originX + (index % n) * this.cell,
      y: this.originY + ((index / n) | 0) * this.cell,
    };
  }
}

/** 最后一手标记：在棋子上画一个反色小环（黑子上浅环、白子上深环） */
function drawLastMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, stoneR: number, color: GoStone): void {
  ctx.strokeStyle = color === 1 ? '#f2f2f2' : '#1b1b1b';
  ctx.lineWidth = Math.max(1.4, stoneR * 0.18);
  ctx.beginPath(); ctx.arc(cx, cy, stoneR * 0.42, 0, TAU); ctx.stroke();
}
