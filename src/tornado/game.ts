/* ────────────────────────────────────────────────────────────
 *  tornado/game.ts — 《龙卷风成长记》核心引擎
 *
 *  玩法（大鱼吃小鱼式成长）：
 *    • 玩家控制小龙卷风，卷走「比自己小的物体」壮大体积；
 *    • 撞上「比自己大的物体会被弹开」，没有任何惩罚；
 *    • 清空当前地图后：龙卷风保持画面中的大小置于正中，
 *      镜头以「风眼扩张」的转场推远，由小街一路铺展到大城，
 *      进入下一个量级：街道 → 楼房 → 城市 → 国家 → 洲 → 全地球。
 *
 *  转场（本文件的核心机制）：
 *    • 镜头比例尺每个量级独立设定（camScale），相邻两关的换手点
 *      满足 r_旧 · camScale_旧 = r_新 · camScale_新，因此龙卷风在
 *      换手瞬间的屏幕尺寸与屏幕位置完全连续，没有跳变；
 *    • 换手发生在转场段的末尾：镜头推远的终点就是新关镜头的起点，
 *      换手当帧立即回到 play，新量级可以立刻操作；
 *    • 世界坐标整体偏移 worldOffset 让新旧世界逐像素对齐，
 *      交接后归零、新量级以正常坐标系继续；
 *    • 地表网格与建筑共用同一支「世界 → 屏幕」相机变换，
 *      相机移动时两者严格同步，不会相对滑动；
 *    • 新地形不再是「切一刀」，而是围绕风眼像涟漪一样铺开淡入
 *      （wipe + 全局淡出），配合无限延伸的程序化地表无缝接管。
 *
 *  纯 Canvas 2D 渲染，无外部资源；emoji 作物体贴图。
 * ──────────────────────────────────────────────────────────── */

const VIEW = 640;
const WORLD_K = 1.75;
const R_MAX = 220;

export interface TierDef {
  name: string;
  en: string;
  ground: [string, string];
  grid: string;
  baseR: number;
  count: number;
  /** 本量级的镜头比例尺（世界 1 单位 → 屏幕像素）；越大＝看得越近。由 baseR 与 SCREEN_SHRINK 推导 */
  camScale: number;
  /** 本量级的标称移动速度：量级越大绝对速度越快，画面观感一致 */
  moveV: number;
  pool: Array<{ e: string; s: number }>;
}

export const TIERS: TierDef[] = [
  {
    name: '街道内', en: 'STREET', ground: ['#c5d1c8', '#a4b5aa'], grid: 'rgba(70,90,80,.12)',
    baseR: 22, count: 16, camScale: 0, moveV: 360,
    pool: [
      { e: '🪨', s: 14 }, { e: '🗑️', s: 17 }, { e: '🪣', s: 16 }, { e: '🧹', s: 14 },
      { e: '🪑', s: 18 }, { e: '📮', s: 17 }, { e: '🧱', s: 16 }, { e: '🛞', s: 16 },
      { e: '🚲', s: 21 }, { e: '🛵', s: 22 }, { e: '🌳', s: 21 }, { e: '🪴', s: 16 },
    ],
  },
  {
    name: '大楼房', en: 'BLOCKS', ground: ['#ddd0b2', '#c2ae85'], grid: 'rgba(110,90,50,.12)',
    baseR: 29, count: 14, camScale: 0, moveV: 470,
    pool: [
      { e: '🌲', s: 25 }, { e: '🏠', s: 27 }, { e: '🏚️', s: 29 }, { e: '🏪', s: 30 },
      { e: '🏘️', s: 33 }, { e: '🏫', s: 34 }, { e: '🏗️', s: 35 }, { e: '⛽', s: 26 },
    ],
  },
  {
    name: '城市', en: 'CITY', ground: ['#c6cfdd', '#a3b1c6'], grid: 'rgba(55,70,95,.12)',
    baseR: 39, count: 12, camScale: 0, moveV: 600,
    pool: [
      { e: '⛲', s: 33 }, { e: '🏢', s: 39 }, { e: '🏬', s: 43 }, { e: '🌃', s: 44 },
      { e: '🏟️', s: 48 }, { e: '🗼', s: 51 }, { e: '🌆', s: 46 }, { e: '🏙️', s: 53 },
    ],
  },
  {
    name: '国家', en: 'NATION', ground: ['#ccd4b0', '#adb98c'], grid: 'rgba(80,85,50,.12)',
    baseR: 53, count: 10, camScale: 0, moveV: 760,
    pool: [
      { e: '🚄', s: 52 }, { e: '⛩️', s: 56 }, { e: '🏯', s: 60 }, { e: '🛕', s: 61 },
      { e: '🗽', s: 65 }, { e: '🏛️', s: 68 }, { e: '🏞️', s: 62 }, { e: '🌋', s: 72 },
    ],
  },
  {
    name: '洲', en: 'CONTINENT', ground: ['#c2d4ac', '#9ab77f'], grid: 'rgba(60,85,45,.12)',
    baseR: 73, count: 9, camScale: 0, moveV: 950,
    pool: [
      { e: '🗿', s: 70 }, { e: '⛰️', s: 75 }, { e: '🏜️', s: 79 }, { e: '🧊', s: 75 },
      { e: '🌊', s: 73 }, { e: '🏔️', s: 83 }, { e: '🗻', s: 88 }, { e: '🌋', s: 92 },
    ],
  },
  {
    name: '全地球', en: 'EARTH', ground: ['#a8cde6', '#7fb0d4'], grid: 'rgba(30,70,110,.12)',
    baseR: 99, count: 8, camScale: 0, moveV: 1180,
    pool: [
      { e: '🏝️', s: 88 }, { e: '🗺️', s: 96 }, { e: '🌍', s: 107 }, { e: '🌎', s: 111 },
      { e: '🌏', s: 114 }, { e: '🌕', s: 101 }, { e: '🌋', s: 120 },
    ],
  },
];

/**
 * 每次转场把世界在屏幕上「推开」多少倍（大于 1 才是真正的推远）。
 * 基础守恒项让换手瞬间龙卷风屏幕尺寸不变，这里再额外推远一点点：
 * 世界逐关在屏幕上收小、龙卷风在画面里的占比缓慢上升，
 * 但幅度必须很小，否则就变成玩家抱怨的「转场时突然缩一下」。
 * 1.04：五段转场累积推远约 1.22×，龙卷风屏幕半径 22px → 26.8px。
 */
const SCREEN_SHRINK = [1.04, 1.04, 1.04, 1.04, 1.04];

/** 本量级龙卷风在屏幕上的半径（px）；r·camScale 全量级恒等于它 */
const TORNADO_SCREEN_R = 22;

/* 镜头比例尺由「屏幕占比守恒」推导，不手写常量：
 * 基础项 baseR_旧/baseR_新 保证换手瞬间龙卷风屏幕尺寸不变（无跳变），
 * 再乘 SCREEN_SHRINK 才是这次转场真正的「推远」。于是每一关开局
 * 龙卷风都还有 15~22px，而世界本身一关比一关大——「由小街到大城」。 */
TIERS[0].camScale = TORNADO_SCREEN_R / TIERS[0].baseR;
for (let i = 1; i < TIERS.length; i++) {
  TIERS[i].camScale = TIERS[i - 1].camScale
    * (TIERS[i - 1].baseR / TIERS[i].baseR)
    * SCREEN_SHRINK[i - 1];
}

/* 转场：第 i 段从量级 i 换到 i+1。rate＝这一段结束时镜头比开始时退远多少倍，
 * 也就是「世界又大了多少倍」；与段时长一起制造越往后越宏大的推远感。 */
const MOVE_RATE = [1.45, 1.62, 1.78, 1.92, 2.02];
const SEG_DUR = [1.5, 1.5, 1.6, 1.7, 1.8];
/**
 * 换手点（新老世界交接)在转场进度中的位置。
 * 1 表示「段尾即换手」：镜头推远与本量级交接在同一帧完成，
 * 交接后立即回到 play，不会出现「卡在转场里连推好几关」。
 */
const HANDOFF_P = 1;
/** 风眼铺开时参与调色的圆环宽度，需覆盖到屏幕四角 */
const WIPE_SPAN = VIEW * 0.74;
/** 地面装饰离屏画布的分辨率（1120 世界单位映射到这么多像素） */
const DECOR_PX = 512;
/** 一帧最多平铺几块装饰；推得极远时格子会碎成几百片，超出就交给细网格 */
const DECOR_TILE_CAP = 16;

export interface Obj {
  x: number; y: number; r: number; e: string; seed: number; dead: boolean;
  /** 被卷起时的吸入动画状态（dead 后仍渲染一段时间） */
  suck?: { t: number; sx: number; sy: number };
}
/** 不可破坏的地形障碍 */
export interface Terrain {
  kind: 'lake' | 'boulder' | 'mount' | 'forest';
  x: number; y: number; r: number; seed: number;
}
interface Particle {
  x: number; y: number; vx: number; vy: number; life: number; max: number; c: string; sz: number;
}
interface Ring { x: number; y: number; r: number; max: number; life: number; c: string }

export interface Input {
  kx: number; ky: number;          // 键盘方向 (-1..1)
  tx: number | null; ty: number | null; // 指针目标（世界坐标）
}

export type GameState = 'play' | 'zoom' | 'win';

export class TornadoGame {
  state: GameState = 'play';
  tier = 0;
  x = 0; y = 0;
  vx = 0; vy = 0;
  r = TIERS[0].baseR;
  score = 0;
  objects: Obj[] = [];
  terrain: Terrain[] = [];
  particles: Particle[] = [];
  rings: Ring[] = [];
  eaten = 0;
  /** 转场进度 0..1（state === 'zoom' 时有效，跨段连续） */
  zoomT = 0;
  /** 世界坐标偏移：转场时连续插值，让新旧两套世界坐标无缝对齐 */
  worldOffset = { x: 0, y: 0 };
  /** 当前镜头比例尺（世界 1 单位 → 屏幕多少像素） */
  viewScale = TIERS[0].camScale;
  tierStartScore = 0;   // 本量级起始分（本关重置时回滚到此）
  shake = 0;
  time = 0;
  world = VIEW * WORLD_K;

  private transCur = 0;      // 当前段序号
  private transP = 0;        // 当前段内进度
  private transTime = 0;     // 当前段已经过秒数
  private transRate = MOVE_RATE[0];
  private handoffDone = false;
  private camA = TIERS[0].camScale;
  private camB = TIERS[1].camScale;
  /** 各量级地面装饰的离屏画布（1120 世界单位 → DECOR_PX 像素） */
  private decorCache = new Map<number, HTMLCanvasElement>();

  // 事件回调（控制器接音效）
  onEat: (big: boolean) => void = () => {};
  onBounce: () => void = () => {};
  onTierUp: (tier: number) => void = () => {};
  onWin: () => void = () => {};

  constructor() {
    this.reset();
  }

  reset(): void {
    this.tier = 0;
    this.score = 0;
    this.zoomT = 0;
    this.viewScale = TIERS[0].camScale;
    this.worldOffset = { x: 0, y: 0 };
    this.transCur = 0;
    this.transP = 0;
    this.transTime = 0;
    this.handoffDone = false;
    this.buildTier();
    this.placePlayer();
    this.state = 'play';
  }

  /** 本关重置：重新生成当前量级的建筑与地形，得分回滚到本关开始时 */
  restartTier(): void {
    if (this.tier >= TIERS.length) this.tier = TIERS.length - 1;
    this.score = this.tierStartScore;
    this.zoomT = 0;
    this.viewScale = TIERS[this.tier].camScale;
    this.worldOffset = { x: 0, y: 0 };
    this.transP = 0;
    this.transTime = 0;
    this.handoffDone = false;
    this.buildTier();
    this.placePlayer();
    this.state = 'play';
  }

  private placePlayer(): void {
    this.r = TIERS[this.tier].baseR;
    this.x = this.world / 2;
    this.y = this.world / 2;
    this.vx = this.vy = 0;
  }

  /** 生成当前量级的世界内容（不含玩家状态）：转场换手时也会调用 */
  private buildTier(): void {
    const def = TIERS[this.tier];
    this.tierStartScore = this.score;
    this.world = VIEW * WORLD_K;
    this.objects = [];
    this.terrain = [];
    this.particles = [];
    this.rings = [];
    this.eaten = 0;

    const rng = mulberry32(this.tier * 9973 + 17);

    // ── 不可破坏地形：数量/半径随量级温和上升，高关封顶避免迷宫化 ──
    const kinds: Terrain['kind'][] = this.tier <= 1
      ? ['lake', 'boulder', 'lake', 'boulder']
      : this.tier <= 3
        ? ['lake', 'boulder', 'mount', 'forest']
        : ['mount', 'mount', 'lake', 'forest', 'boulder'];
    const tn = this.tier <= 1 ? 3 : this.tier <= 3 ? 4 : 5;
    const trCap = Math.min(def.baseR * 1.35, 92);
    for (let i = 0; i < tn; i++) {
      const tr = trCap * (0.72 + rng() * 0.55);
      for (let tries = 0; tries < 60; tries++) {
        const x = 120 + rng() * (this.world - 240);
        const y = 120 + rng() * (this.world - 240);
        if (Math.hypot(x - this.world / 2, y - this.world / 2) < tr + def.baseR + 150) continue;
        let ok = true;
        for (const o of this.objects) if (Math.hypot(x - o.x, y - o.y) < tr + o.r + 40) { ok = false; break; }
        if (ok) for (const t of this.terrain) if (Math.hypot(x - t.x, y - t.y) < (tr + t.r) * 1.3) { ok = false; break; }
        if (!ok) continue;
        this.terrain.push({ kind: kinds[i % kinds.length], x, y, r: tr, seed: rng() * 9 });
        break;
      }
    }

    // ── 建筑（可卷走）──
    const M = 70;
    const cx = this.world / 2;
    const cy = this.world / 2;
    const spawnObj = (p: { e: string; s: number }) => {
      for (let tries = 0; tries < 90; tries++) {
        const x = M + Math.random() * (this.world - M * 2);
        const y = M + Math.random() * (this.world - M * 2);
        if (Math.hypot(x - cx, y - cy) < p.s + def.baseR + 60) continue;
        let ok = true;
        for (const o of this.objects) {
          if (Math.hypot(x - o.x, y - o.y) < (p.s + o.r) * 1.15) { ok = false; break; }
        }
        if (ok) for (const t of this.terrain) if (Math.hypot(x - t.x, y - t.y) < t.r + p.s + 24) { ok = false; break; }
        if (!ok) continue;
        this.objects.push({ x, y, r: p.s, e: p.e, seed: Math.random() * 7, dead: false });
        return true;
      }
      return false;
    };

    // 保证开局有饵：优先严格小于 baseR 的物体（取最小的 3 种）
    const bait = def.pool
      .filter((p) => p.s < def.baseR)
      .sort((a, b) => a.s - b.s);
    const forced = bait.length ? bait.slice(0, 3) : [def.pool.slice().sort((a, b) => a.s - b.s)[0]];
    for (const p of forced) spawnObj(p);
    for (let i = this.objects.length; i < def.count; i++) {
      spawnObj(def.pool[(Math.random() * def.pool.length) | 0]);
    }
  }

  /** 通关进度以实际生成物为准，避免 spawn 失败导致永久软锁 */
  get total(): number { return this.objects.length; }

  /**
   * 渲染用的龙卷风屏幕半径（px）。
   * 用「本关标称屏幕半径 → 下一关标称屏幕半径」在整段转场里插值，
   * 段尾正好长到下一关的标称值；下一帧换手后 state 已回到 play，
   * 由 r·viewScale 算出的值与之重合，所以换手帧既不缩放、也不位移。
   */
  get dispScreenR(): number {
    if (this.state !== 'zoom') return this.r * this.viewScale;
    // 段号 transCur 在整个段内不变（换手在段尾），所以以此为基准取两端标称值
    const idx = Math.max(0, Math.min(this.transCur, TIERS.length - 1));
    const before = TIERS[idx];
    const next = TIERS[Math.min(idx + 1, TIERS.length - 1)];
    const s0 = before.baseR * before.camScale;
    const s1 = next.baseR * next.camScale;
    return s0 + (s1 - s0) * ease(Math.min(1, this.transP / (HANDOFF_P * 0.97)));
  }

  /** 转场中为 true：世界以新量级的坐标与比例尺绘制 */
  private get shifting(): boolean { return this.state === 'zoom' || this.state === 'win'; }

  update(dt: number, inp: Input): void {
    dt = Math.min(dt, 0.033);
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 3);

    // 吸入动画推进
    for (const o of this.objects) {
      if (o.suck) {
        o.suck.t += dt * 2.6;
        if (o.suck.t >= 1) o.suck = undefined;
      }
    }

    // 粒子/环
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.985; p.vy = p.vy * 0.985 + 260 * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const rg of this.rings) { rg.life -= dt; rg.r += (rg.max - rg.r) * dt * 6; }
    this.rings = this.rings.filter((rg) => rg.life > 0);

    if (this.state === 'zoom') {
      this.advanceTransition(dt);
      return;
    }
    if (this.state === 'win') return;

    // ── 运动 ──
    const ACC = 980 * TIERS[this.tier].camScale;
    const vmax = TIERS[this.tier].moveV;
    if (inp.kx || inp.ky) {
      const l = Math.hypot(inp.kx, inp.ky) || 1;
      this.vx += (inp.kx / l) * ACC * dt;
      this.vy += (inp.ky / l) * ACC * dt;
    } else if (inp.tx !== null && inp.ty !== null) {
      const dx = inp.tx - this.x;
      const dy = inp.ty - this.y;
      const d = Math.hypot(dx, dy);
      if (d > 8) {
        const s = Math.min(1, d / 140);
        this.vx += (dx / d) * ACC * s * dt;
        this.vy += (dy / d) * ACC * s * dt;
      }
    }
    const fr = Math.exp(-3.1 * dt);
    this.vx *= fr; this.vy *= fr;
    const v = Math.hypot(this.vx, this.vy);
    if (v > vmax) { this.vx *= vmax / v; this.vy *= vmax / v; }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.x < this.r * 0.5) { this.x = this.r * 0.5; this.vx = Math.abs(this.vx) * 0.5; }
    if (this.y < this.r * 0.5) { this.y = this.r * 0.5; this.vy = Math.abs(this.vy) * 0.5; }
    if (this.x > this.world - this.r * 0.5) { this.x = this.world - this.r * 0.5; this.vx = -Math.abs(this.vx) * 0.5; }
    if (this.y > this.world - this.r * 0.5) { this.y = this.world - this.r * 0.5; this.vy = -Math.abs(this.vy) * 0.5; }

    // ── 碰撞 ──
    for (const o of this.objects) {
      if (o.dead) continue;
      const dx = this.x - o.x;
      const dy = this.y - o.y;
      const d = Math.hypot(dx, dy);
      const reach = this.r * 0.72 + o.r * 0.72;
      if (d > reach) continue;
      if (this.r > o.r) {
        // 卷走！面积守恒式成长 + 吸入动画
        o.dead = true;
        o.suck = { t: 0, sx: o.x, sy: o.y };
        this.eaten++;
        this.score += Math.round(o.r * 10) + this.tier * 50;
        this.r = Math.min(R_MAX, Math.sqrt(this.r * this.r + o.r * o.r * 0.9));
        this.burst(o.x, o.y, o.e, 10);
        this.rings.push({ x: o.x, y: o.y, r: o.r, max: this.r * 1.6, life: 0.45, c: 'rgba(14,159,133,.55)' });
        this.onEat(o.r > 26);
        if (this.eaten >= this.total) this.beginTransition();
      } else {
        // 弹开：无惩罚
        const nx = dx / (d || 1);
        const ny = dy / (d || 1);
        const push = reach - d + 2;
        this.x += nx * push;
        this.y += ny * push;
        const kick = (160 + (o.r - this.r) * 3) * TIERS[this.tier].camScale;
        this.vx = nx * kick + this.vx * 0.3;
        this.vy = ny * kick + this.vy * 0.3;
        this.shake = 1;
        this.burst(o.x + nx * o.r, o.y + ny * o.r, '', 5);
        this.onBounce();
      }
    }

    // ── 地形障碍：永远弹开（不可破坏） ──
    for (const t of this.terrain) {
      const dx = this.x - t.x;
      const dy = this.y - t.y;
      const d = Math.hypot(dx, dy);
      const reach = this.r * 0.72 + t.r * 0.78;
      if (d > reach) continue;
      const nx = dx / (d || 1);
      const ny = dy / (d || 1);
      this.x += nx * (reach - d + 2);
      this.y += ny * (reach - d + 2);
      const kick = (150 + t.r * 1.2) * TIERS[this.tier].camScale;
      this.vx = nx * kick + this.vx * 0.3;
      this.vy = ny * kick + this.vy * 0.3;
      this.shake = 0.7;
      this.burst(t.x + nx * t.r * 0.8, t.y + ny * t.r * 0.8, '', 4);
      this.onBounce();
    }

    // 兜底：只要本关已经清空就开转场（防止某条路径漏掉了清空判定而卡住）
    if (this.state === 'play' && this.total > 0 && this.eaten >= this.total) this.beginTransition();
  }

  private beginTransition(): void {
    this.state = 'zoom';
    this.zoomT = 0;
    this.transCur = this.tier;
    this.transP = 0;
    this.transTime = 0;
    this.handoffDone = false;
    this.refreshSegment();
    // 转场起点必须接住上一帧：viewScale 从「当前这一关的镜头」起跳
    this.viewScale = this.camA;
    this.onTierUp(this.tier + 1);
  }

  private refreshSegment(): void {
    this.transRate = MOVE_RATE[Math.min(this.transCur, MOVE_RATE.length - 1)];
    this.camA = TIERS[Math.min(this.transCur, TIERS.length - 1)].camScale;
    this.camB = TIERS[Math.min(this.transCur + 1, TIERS.length - 1)].camScale;
  }

  private finishWin(): void {
    this.state = 'win';
    this.tier = TIERS.length - 1;
    this.viewScale = TIERS[TIERS.length - 1].camScale;
    this.worldOffset = { x: 0, y: 0 };
    this.zoomT = 0;
    this.onWin();
  }

  /**
   * 转场推进：一段只负责「本量级 → 下一量级」。
   * 镜头推远的终点（p = 1）就是换手点，两者在同一帧收尾，
   * 交接完立刻把控制权还给玩家（state 回到 play）。
   *
   * 关键：换手不能晚于段尾。早期实现里换手发生在段中（p≈0.55），
   * 但 state 一直停在 zoom，于是新量级既不能操作、又会被残留的
   * 转场循环接着推远，表现就是「进下一图瞬间吃完全部、连着直接通关」。
   */
  private advanceTransition(dt: number): void {
    const dur = SEG_DUR[Math.min(this.transCur, SEG_DUR.length - 1)];
    this.transTime += dt;
    this.transP = Math.min(1, this.transTime / dur);
    const p = this.transP;

    // 末段：没有下一个量级可交接，转场推远走完就通关
    if (this.transCur >= TIERS.length - 1) {
      if (p >= 1) this.finishWin();
      return;
    }

    // 镜头曲线用 smoothstep：起步平缓，避免开场一帧就猛缩（观感上的「突然缩放」）
    this.viewScale = this.camA / (1 + (this.transRate - 1) * smoothstep(p));
    this.zoomT = (this.transCur + p) / TIERS.length;

    if (p >= 1) {
      // 段尾即换手：镜头推远的终点 = 新关镜头起点 = camB，一帧之内没有任何跳变。
      // 换手后立刻交还操作权；worldOffset 归零，新量级以正常坐标系继续。
      this.handoff();
      this.state = 'play';
      this.transTime = 0;
      this.transP = 1;
      this.transCur = this.tier;
      this.viewScale = this.camB;
      this.handoffDone = false;
      if (this.tier >= TIERS.length - 1) this.finishWin();
    }
  }

  /**
   * 换手：把世界坐标整体偏移，使新量级的世界对齐龙卷风此刻所在的位置。
   * 本帧内 viewScale 不变，所以旧世界的画面与新世界的起始画面逐像素相接。
   */
  private handoff(): void {
    this.handoffDone = true;
    this.tier++;
    this.worldOffset = {
      x: this.worldOffset.x + this.x - this.world / 2,
      y: this.worldOffset.y + this.y - this.world / 2,
    };
    this.buildTier();
    this.placePlayer();            // r/坐标交接：屏幕尺寸与位置由镜头续上，视觉连续
  }

  private burst(x: number, y: number, e: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 240;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80,
        life: 0.4 + Math.random() * 0.5, max: 0.9,
        c: e ? '' : `hsla(${(this.tier * 47 + i * 30) % 360},45%,55%,.9)`,
        sz: 3 + Math.random() * 4,
      });
    }
  }

  // ══════════════════ 渲染 ══════════════════

  /**
   * 相机在世界坐标中的视心：恒等于龙卷风位置。
   * 不做贴边钳制——一来转场前后相机位置天然连续（没有起手跳变），
   * 二来世界边界之外也是连续的地形，不需要用钳制来回避空白。
   */
  private camAnchor(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /**
   * 世界 → 屏幕相机变换（与 paint 用的是同一支）。
   * 地表与建筑都必须用它：早先 drawFloor 把它当成屏幕坐标直接平铺，
   * 于是相机一移动，格子钉在屏幕上不动、建筑跟着动，两者相对滑动。
   */
  private camMatrix(scale: number, cam: { x: number; y: number }): { a: number; d: number; e: number; f: number } {
    return { a: scale, d: scale, e: VIEW / 2 - cam.x * scale, f: VIEW / 2 - cam.y * scale };
  }

  /** 最近一次地表绘制用的相机矩阵（单测校验地表与建筑同步；每次渲染都会刷新） */
  floorMatrix: { a: number; d: number; e: number; f: number } | null = null;

  /**
   * 无限延伸的程序化地表：按 LOD 画拼块，屏幕外/世界外同样成立。
   * 固定世界坐标做哈希 → 新地形从同一片地貌里长出来，颜色自然衔接；
   * 配色只做 CSS 颜色替换，绝不把 'rgb()' 拿去当十六进制解析（旧实现因此整片变纯黑）。
   *
   * 地表与世界内容一样走「世界 → 屏幕」相机变换。早先这里以屏幕坐标直接
   * 平铺，结果是相机一移动，建筑（走相机变换）在动、格子（钉在屏幕上）不动，
   * 两者相对滑动——必须使用与 paint 完全相同的这支变换。
   */
  private drawFloor(
    ctx: CanvasRenderingContext2D,
    cam: { x: number; y: number },
    scale: number,
    index: number,
  ): void {
    const col = groundAt(index);
    const s = Math.max(scale, 1e-4);
    const span = VIEW / s;                     // 屏幕可见的世界宽度
    const size = clamp(150 / s, 96, 420);      // 每屏约 4 个地貌格（世界单位）
    const x0 = Math.floor((cam.x - span / 2) / size) * size;
    const y0 = Math.floor((cam.y - span / 2) / size) * size;
    const nx = Math.ceil(span / size) + 2;
    this.floorMatrix = this.camMatrix(s, cam);

    ctx.save();
    ctx.translate(VIEW / 2, VIEW / 2);
    ctx.scale(s, s);
    ctx.translate(-cam.x, -cam.y);
    // ① 地貌拼块：固定网格，走到哪都是同一片地貌
    for (let j = 0; j < nx; j++) {
      for (let i = 0; i < nx; i++) {
        const wx = x0 + i * size;
        const wy = y0 + j * size;
        const cx = Math.round(wx / size);
        const cy = Math.round(wy / size);
        const h = hashInt(cx, cy, index + 5) / 4294967296;
        ctx.fillStyle = this.biomeCss(col, biomeKind(cx, cy, index), h);
        ctx.fillRect(wx - 1, wy - 1, size + 2, size + 2);
      }
    }
    // ② 细网格：让地面读起来像地图/路网，而不是一整块色板。
    //    线宽写在屏幕像素上（世界坐标里除以 s），任何镜头下都是 1.4px。
    ctx.strokeStyle = col.grid;
    ctx.lineWidth = 1.4 / s;
    const g0 = 64;
    const gx0 = Math.floor((cam.x - span / 2) / g0) * g0;
    const gy0 = Math.floor((cam.y - span / 2) / g0) * g0;
    ctx.beginPath();
    for (let x = gx0; x <= cam.x + span / 2 + g0; x += g0) { ctx.moveTo(x, cam.y - span); ctx.lineTo(x, cam.y + span); }
    for (let y = gy0; y <= cam.y + span / 2 + g0; y += g0) { ctx.moveTo(cam.x - span, y); ctx.lineTo(cam.x + span, y); }
    ctx.stroke();
    ctx.restore();
  }

  render(ctx: CanvasRenderingContext2D): void {
    const zooming = this.state === 'zoom';
    const p = this.transP;
    // 换手前后各画一套世界，用连续量驱动，换手帧两侧绘制结果一致
    const drawingNew = zooming && this.handoffDone;
    /** 当前正在绘制的世界所属量级（换手前是旧世界，换手后是新世界） */
    const idx = Math.max(0, Math.min(drawingNew ? this.tier : this.tier - 1, TIERS.length - 1));
    /** 世界 → 屏幕比例尺：以 viewScale 为准，与画地表用的那一支完全一致 */
    const floorScale = this.viewScale;
    const floorCam = this.camAnchor();

    ctx.save();
    ctx.clearRect(0, 0, VIEW, VIEW);
    // 底色：任何缝隙都不该露出画布外的空白
    ctx.fillStyle = TIERS[idx].ground[1];
    ctx.fillRect(0, 0, VIEW, VIEW);

    /* ① 无限延伸的程序化地表：新旧两套地形围绕风眼交叠铺开 */
    this.drawFloor(ctx, floorCam, floorScale, idx);

    /* ② 龙卷风：位置按风眼接力，屏幕尺寸由 dispScreenR 给出，全程连续 */
    const sx = VIEW / 2 + (this.x - floorCam.x) * floorScale;
    const sy = VIEW / 2 + (this.y - floorCam.y) * floorScale;
    this.drawTornado(ctx, sx, sy, this.dispScreenR);

    /* ③ 世界内容：地面装饰 + 地貌 + 建筑，全部挂在世界坐标系里 */
    const paint = (index: number, offset: { x: number; y: number }, alpha: number) => {
      if (alpha <= 0.002) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const s = this.viewScale;
      const halfW = VIEW / (2 * s);
      ctx.translate(VIEW / 2, VIEW / 2);
      ctx.scale(s, s);
      ctx.translate(-floorCam.x - offset.x, -floorCam.y - offset.y);
      // 装饰重复铺满视野：世界之外也是同样的路网/田垄，边界不再是"空地形"。
      // 每关的纹样预渲染成离屏画布，平铺时只做 drawImage；
      // 数量设上限——推得很远时格子会碎成几百片，那时交给地表网格即可。
      const decor = this.tierDecor(index);
      const W = VIEW * WORLD_K;
      const vx0 = floorCam.x + offset.x - halfW;
      const vx1 = floorCam.x + offset.x + halfW;
      const vy0 = floorCam.y + offset.y - halfW;
      const vy1 = floorCam.y + offset.y + halfW;
      const tx0 = Math.floor(vx0 / W);
      const tx1 = Math.floor(vx1 / W);
      const ty0 = Math.floor(vy0 / W);
      const ty1 = Math.floor(vy1 / W);
      let budget = DECOR_TILE_CAP;
      for (let ty = ty0; ty <= ty1 && budget > 0; ty++) {
        for (let tx = tx0; tx <= tx1 && budget > 0; tx++) {
          budget--;
          ctx.drawImage(decor, tx * W, ty * W, W, W);
        }
      }
      for (const t of this.terrain) this.drawTerrain(ctx, t);
      const M = halfW + 200;
      this.drawObjects(ctx, floorCam.x + offset.x - M, floorCam.y + offset.y - M, floorCam.x + offset.x + M, floorCam.y + offset.y + M);
      ctx.restore();
    };

    if (zooming && !drawingNew) {
      // 旧世界：风眼从中心吃掉它，同时整体淡出——不和新地形硬碰硬
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p / 0.62);
      this.wipeMask(ctx, VIEW / 2, VIEW / 2, WIPE_SPAN * (1 - clamp(p / 0.34, 0, 1)), true);
      paint(idx, { x: 0, y: 0 }, 1);
      ctx.restore();
    } else if (zooming) {
      // 新世界：围绕风眼铺开，外围旧地形先淡出、再随铺开被完全接管
      ctx.save();
      ctx.globalAlpha = clamp((p - 0.34) / 0.32, 0, 1);
      this.wipeMask(ctx, VIEW / 2, VIEW / 2, WIPE_SPAN * ease(clamp(p / 0.66, 0, 1)));
      paint(idx, this.worldOffset, 1);
      ctx.restore();
    } else {
      paint(idx, { x: 0, y: 0 }, 1);
    }

    /* ④ 粒子/环/震动：只属于当前世界 */
    ctx.save();
    ctx.translate(VIEW / 2 + this.shake * (Math.random() - 0.5) * 8, VIEW / 2 + this.shake * (Math.random() - 0.5) * 8);
    ctx.scale(this.viewScale, this.viewScale);
    ctx.translate(-floorCam.x, -floorCam.y);
    this.drawFx(ctx);
    ctx.restore();

    ctx.restore();

    if (zooming) this.drawTransitionText(ctx, p);
    this.drawVignette(ctx);
  }

  /** 风眼铺开：把后续绘制限制在以屏幕中心为圆心、半径 r 的圆内（invert＝只留圆外） */
  private wipeMask(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, invert = false): void {
    if (radius >= WIPE_SPAN) return;      // 已完全铺满，无需裁剪
    if (radius <= 0) {
      if (!invert) {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillRect(0, 0, VIEW, VIEW);
        ctx.globalCompositeOperation = 'source-over';
      }
      return;
    }
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    if (invert) {
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.72, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.globalCompositeOperation = 'destination-out';
    } else {
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.72, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'destination-in';
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW, VIEW);
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── 地表 ──

  /** 以 32 世界单位为格的地貌场：同一坐标跨关卡保持连续 */
  private biomeCss(col: GroundCol, kind: number, h: number): string {
    let hex: string;
    if (kind === BIOME.arable) hex = col.arable;
    else if (kind === BIOME.forest) hex = col.forest;
    else if (kind === BIOME.town) hex = col.town;
    else if (kind === BIOME.water) hex = col.water;
    else hex = col.base;
    return shade(hex, (h - 0.5) * 0.1);
  }

  /** 世界内容：地面装饰 + 地貌 + 建筑，全部挂在世界坐标系里 */

  // ── 旧世界/新世界共用的元素 ──

  /** 每个量级的装饰纹样只画一次，之后平铺直接 drawImage（转场时两个量级各一份） */
  private tierDecor(index: number): HTMLCanvasElement {
    const hit = this.decorCache.get(index);
    if (hit) return hit;
    const W = VIEW * WORLD_K;
    const cv = document.createElement('canvas');
    cv.width = DECOR_PX;
    cv.height = DECOR_PX;
    const c2 = cv.getContext('2d');
    if (c2) {
      c2.scale(DECOR_PX / W, DECOR_PX / W);
      this.drawGroundDecor(c2, index);
    }
    this.decorCache.set(index, cv);
    return cv;
  }

  /** 地面装饰：低量级画道路街区，中量级画田块林斑，高量级画海浪 */
  private drawGroundDecor(ctx: CanvasRenderingContext2D, index: number): void {
    const rng = mulberry32(((index + 1) * 9973 + 7) | 0);
    const W = VIEW * WORLD_K;
    ctx.save();
    if (index <= 2) {
      // 道路：横竖各 3 条沥青带 + 白色虚线中心线
      const roads: Array<{ v: boolean; p: number }> = [];
      for (let i = 0; i < 3; i++) roads.push({ v: false, p: W * (0.16 + 0.32 * i) + (rng() - 0.5) * 90 });
      for (let i = 0; i < 3; i++) roads.push({ v: true, p: W * (0.2 + 0.3 * i) + (rng() - 0.5) * 90 });
      const rw = 34 * (index <= 1 ? 1 : 1.4);
      ctx.fillStyle = 'rgba(62,72,84,.16)';
      for (const rd of roads) {
        if (rd.v) ctx.fillRect(rd.p - rw / 2, 0, rw, W);
        else ctx.fillRect(0, rd.p - rw / 2, W, rw);
      }
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.lineWidth = 2.5 * (index <= 1 ? 1 : 1.4);
      ctx.setLineDash([16 * (index <= 1 ? 1 : 1.5), 22 * (index <= 1 ? 1 : 1.5)]);
      ctx.beginPath();
      for (const rd of roads) {
        if (rd.v) { ctx.moveTo(rd.p, 0); ctx.lineTo(rd.p, W); }
        else { ctx.moveTo(0, rd.p); ctx.lineTo(W, rd.p); }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // 街区角落的小绿地
      for (let i = 0; i < 7; i++) {
        const x = rng() * W; const y = rng() * W; const rr = 26 + rng() * 40;
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(88,140,90,.09)'; ctx.fill();
      }
    } else if (index <= 4) {
      // 田野拼布：柔和色块
      for (let i = 0; i < 30; i++) {
        const x = rng() * W; const y = rng() * W;
        const w = 90 + rng() * 190; const h = 70 + rng() * 150;
        ctx.fillStyle = i % 2 ? 'rgba(120,140,70,.10)' : 'rgba(190,170,110,.13)';
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 10);
        ctx.fill();
      }
      // 蜿蜒小路
      ctx.strokeStyle = 'rgba(140,120,80,.20)';
      ctx.lineWidth = 9;
      ctx.beginPath();
      let px = 0; let py = W * (0.3 + rng() * 0.4);
      ctx.moveTo(px, py);
      while (px < W) { px += 130; py += (rng() - 0.5) * 170; ctx.lineTo(px, py); }
      ctx.stroke();
    } else {
      // 海洋：波纹弧线
      ctx.strokeStyle = 'rgba(255,255,255,.4)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      for (let i = 0; i < 60; i++) {
        const x = rng() * W; const y = rng() * W; const rr = 12 + rng() * 16;
        ctx.beginPath();
        ctx.arc(x, y, rr, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
      // 远处暗流
      ctx.strokeStyle = 'rgba(40,90,130,.12)';
      ctx.lineWidth = 26;
      for (let i = 0; i < 4; i++) {
        const y = W * (0.15 + 0.22 * i) + (rng() - 0.5) * 80;
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x <= W; x += 160) ctx.lineTo(x, y + Math.sin(x / 150 + i * 2) * 36);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** 不可破坏地形障碍 */
  private drawTerrain(ctx: CanvasRenderingContext2D, t: Terrain): void {
    ctx.save();
    // 接触阴影
    ctx.beginPath();
    ctx.ellipse(t.x, t.y + t.r * 0.72, t.r * 0.92, t.r * 0.28, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(28,43,51,.16)';
    ctx.fill();
    const rng = mulberry32((t.seed * 1000) | 0);
    if (t.kind === 'lake') {
      ctx.beginPath();
      ctx.ellipse(t.x, t.y, t.r, t.r * 0.72, 0.3, 0, Math.PI * 2);
      ctx.fillStyle = '#7db4d6';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(235,246,250,.8)';
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const yy = t.y - t.r * 0.3 + i * t.r * 0.3;
        ctx.beginPath();
        ctx.arc(t.x - t.r * 0.2 + (rng() - 0.5) * t.r * 0.5, yy, t.r * 0.22, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
    } else if (t.kind === 'boulder') {
      const rocks = [
        { dx: 0, dy: 0, rr: t.r * 0.72 },
        { dx: -t.r * 0.55, dy: t.r * 0.18, rr: t.r * 0.45 },
        { dx: t.r * 0.5, dy: t.r * 0.22, rr: t.r * 0.38 },
      ];
      for (const rk of rocks) {
        ctx.beginPath();
        ctx.ellipse(t.x + rk.dx, t.y + rk.dy, rk.rr, rk.rr * 0.86, rng() * 2, 0, Math.PI * 2);
        ctx.fillStyle = '#8d979e';
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(t.x + rk.dx - rk.rr * 0.25, t.y + rk.dy - rk.rr * 0.35, rk.rr * 0.45, rk.rr * 0.28, -0.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.28)';
        ctx.fill();
      }
    } else if (t.kind === 'mount') {
      const peaks = [
        { dx: -t.r * 0.42, h: t.r * 1.15, w: t.r * 0.75 },
        { dx: t.r * 0.05, h: t.r * 1.5, w: t.r * 0.95 },
        { dx: t.r * 0.55, h: t.r * 1.0, w: t.r * 0.65 },
      ];
      for (const pk of peaks) {
        ctx.beginPath();
        ctx.moveTo(t.x + pk.dx - pk.w, t.y + t.r * 0.5);
        ctx.lineTo(t.x + pk.dx, t.y + t.r * 0.5 - pk.h);
        ctx.lineTo(t.x + pk.dx + pk.w, t.y + t.r * 0.5);
        ctx.closePath();
        ctx.fillStyle = '#7f8c96';
        ctx.fill();
        // 雪顶
        ctx.beginPath();
        ctx.moveTo(t.x + pk.dx - pk.w * 0.26, t.y + t.r * 0.5 - pk.h * 0.76);
        ctx.lineTo(t.x + pk.dx, t.y + t.r * 0.5 - pk.h);
        ctx.lineTo(t.x + pk.dx + pk.w * 0.26, t.y + t.r * 0.5 - pk.h * 0.76);
        ctx.lineTo(t.x + pk.dx + pk.w * 0.1, t.y + t.r * 0.5 - pk.h * 0.66);
        ctx.lineTo(t.x + pk.dx - pk.w * 0.08, t.y + t.r * 0.5 - pk.h * 0.74);
        ctx.closePath();
        ctx.fillStyle = '#eef4f7';
        ctx.fill();
      }
    } else {
      // forest：一簇树冠
      for (let i = 0; i < 7; i++) {
        const a = rng() * Math.PI * 2;
        const dd = rng() * t.r * 0.62;
        const rr = t.r * (0.3 + rng() * 0.22);
        ctx.beginPath();
        ctx.arc(t.x + Math.cos(a) * dd, t.y + Math.sin(a) * dd * 0.8, rr, 0, Math.PI * 2);
        ctx.fillStyle = i % 2 ? '#4d7a52' : '#5d8b60';
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** 建筑（屏幕外剔除，转场时由调用方用 alpha 淡入淡出） */
  private drawObjects(
    ctx: CanvasRenderingContext2D,
    x0: number, y0: number, x1: number, y1: number,
  ): void {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const o of this.objects) {
      if (o.dead && !o.suck) continue;
      if (!o.suck && (o.x < x0 - o.r * 2 || o.x > x1 + o.r * 2 || o.y < y0 - o.r * 2 || o.y > y1 + o.r * 2)) continue;
      if (o.suck) {
        // 螺旋吸入：向龙卷风中心收拢、旋转、缩小
        const e = ease(o.suck.t);
        const px = o.suck.sx + (this.x - o.suck.sx) * e;
        const py = o.suck.sy + (this.y - o.suck.sy) * e;
        const ang = o.suck.t * 9 + o.seed;
        const rad = (1 - e) * o.r * 2.2;
        const sc = 1 - e * 0.85;
        ctx.save();
        ctx.translate(px + Math.cos(ang) * rad, py + Math.sin(ang) * rad * 0.55 - e * this.r * 0.9);
        ctx.rotate(ang * 0.8);
        ctx.scale(sc, sc);
        ctx.font = `${o.r * 2.25}px "Segoe UI Emoji","Noto Color Emoji",serif`;
        ctx.fillText(o.e, 0, 0);
        ctx.restore();
        continue;
      }
      const bob = Math.sin(this.time * 1.4 + o.seed) * 1.6;
      const edible = this.r > o.r;
      // 建筑地基：深色圆角底板，让建筑"落地"而不是漂浮贴纸
      ctx.beginPath();
      ctx.roundRect(o.x - o.r * 1.02, o.y - o.r * 0.62, o.r * 2.04, o.r * 1.62, o.r * 0.34);
      ctx.fillStyle = 'rgba(38,52,60,.20)';
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(o.x - o.r * 0.94, o.y - o.r * 0.72, o.r * 1.88, o.r * 1.5, o.r * 0.3);
      ctx.fillStyle = edible ? 'rgba(244,246,243,.88)' : 'rgba(230,228,224,.86)';
      ctx.fill();
      // 比自己大的：灰色描边 + 半透明「锁」，提示「现在还卷不动」
      if (!edible) {
        ctx.beginPath();
        ctx.roundRect(o.x - o.r * 0.94, o.y - o.r * 0.72, o.r * 1.88, o.r * 1.5, o.r * 0.3);
        ctx.strokeStyle = 'rgba(140,120,110,.45)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 0.45;
        ctx.font = `${Math.max(12, o.r * 0.55)}px "Segoe UI Emoji","Noto Color Emoji",serif`;
        ctx.fillText('🔒', o.x + o.r * 0.62, o.y - o.r * 0.42 + bob);
        ctx.globalAlpha = 1;
      }
      ctx.font = `${o.r * 2.25}px "Segoe UI Emoji","Noto Color Emoji",serif`;
      ctx.fillText(o.e, o.x, o.y + bob);
    }
  }

  /** 粒子与环（已处于世界坐标系） */
  private drawFx(ctx: CanvasRenderingContext2D): void {
    for (const rg of this.rings) {
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
      ctx.strokeStyle = rg.c;
      ctx.globalAlpha = Math.max(0, rg.life / 0.45);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      if (p.c) {
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.sz, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.font = `${p.sz * 4}px "Segoe UI Emoji",serif`;
        ctx.fillText('💨', p.x, p.y);
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawTransitionText(ctx: CanvasRenderingContext2D, p: number): void {
    if (p <= 0.3) return;
    const nxt = TIERS[Math.min(this.tier + 1, TIERS.length - 1)];
    const cur = TIERS[Math.min(this.tier, TIERS.length - 1)];
    ctx.save();
    ctx.globalAlpha = Math.min(1, (p - 0.3) * 2.4) * (1 - Math.max(0, (p - 0.92) / 0.08));
    ctx.fillStyle = 'rgba(28,43,51,.55)';
    ctx.fillRect(0, VIEW / 2 + VIEW * 0.31, VIEW, 80);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 22px "PingFang SC","Microsoft YaHei",system-ui';
    ctx.fillText(`镜头拉远 · 前方进入「${this.tier + 1 >= TIERS.length ? '？' : nxt.name}」`, VIEW / 2, VIEW / 2 + VIEW * 0.31 + 26);
    ctx.font = '13px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.fillText(`${cur.en} → ${nxt.en} · 脚下的世界正在铺展开来`, VIEW / 2, VIEW / 2 + VIEW * 0.31 + 56);
    ctx.restore();
  }

  private drawVignette(ctx: CanvasRenderingContext2D): void {
    const vg = ctx.createRadialGradient(VIEW / 2, VIEW / 2, VIEW * 0.42, VIEW / 2, VIEW / 2, VIEW * 0.72);
    vg.addColorStop(0, 'rgba(28,43,51,0)');
    vg.addColorStop(1, 'rgba(28,43,51,.09)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, VIEW, VIEW);
  }

  /** 屏幕(canvas)逻辑坐标 → 世界坐标，与 render 的相机变换互逆 */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const cam = this.camAnchor();
    const sc = this.shifting ? this.viewScale : TIERS[this.tier].camScale;
    return {
      x: cam.x + (sx - VIEW / 2) / sc,
      y: cam.y + (sy - VIEW / 2) / sc,
    };
  }

  private drawTornado(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
    // 传入的是 r·viewScale：屏幕像素半径；锥体以「风眼」为中心分布
    const r = Math.max(3, radius);
    const h = r * 2.1;
    const base = y + h * 0.5;
    ctx.save();
    ctx.translate(x, base);
    // 接触阴影
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.9, r * 0.24, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(28,43,51,.18)';
    ctx.fill();
    // 锥体填充
    ctx.beginPath();
    ctx.moveTo(-r * 0.85, -r * 0.15);
    ctx.quadraticCurveTo(-r * 0.2, -h * 0.5, -r * 0.52, -h);
    ctx.lineTo(r * 0.52, -h);
    ctx.quadraticCurveTo(r * 0.2, -h * 0.5, r * 0.85, -r * 0.15);
    ctx.closePath();
    ctx.fillStyle = 'rgba(96,120,138,.28)';
    ctx.fill();
    // 旋转螺纹
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const yy = -r * 0.15 - (h - r * 0.3) * t;
      const w = r * (0.92 - 0.55 * t);
      const ph = this.time * 7 + i * 1.15;
      const sq = 0.30;
      ctx.beginPath();
      ctx.ellipse(Math.sin(ph) * w * 0.18, yy, w, w * sq, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(52,74,90,${0.55 - t * 0.22})`;
      ctx.lineWidth = Math.max(2, r * 0.13);
      ctx.stroke();
    }
    // 环绕碎屑
    for (let i = 0; i < 5; i++) {
      const a = this.time * 5.2 + i * 1.26;
      const t = (i % 3) / 2;
      const yy = -r * 0.6 - (h - r * 0.3) * (0.25 + t * 0.6);
      const w = r * (0.95 - 0.5 * t);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * w, yy + Math.sin(a * 1.7) * 4, Math.max(2, r * 0.09), 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${30 + i * 18},30%,${40 + i * 6}%,.75)`;
      ctx.fill();
    }
    ctx.restore();
  }
}

/* ══════════════════ 地表生成（模块级，供转场双方共用） ══════════════════ */

/** 0 荒地 1 田野 2 林地 3 城镇 4 水（索引即 biomeCss 的调色板位置） */
const BIOME = { waste: 0, arable: 1, forest: 2, town: 3, water: 4 } as const;

interface GroundCol {
  base: string;     // 荒地
  arable: string;   // 田野
  forest: string;   // 林地
  town: string;     // 城镇
  water: string;    // 水
  grid: string;     // 地面细网格（读起来像地图/路网）
}

/**
 * 各量级的地表配色：低量级是城市灰绿，中量级田野与林地，高量级海洋。
 * 只作为 patch 的填充色，不参与数值插值——转场时靠「换手瞬间切到新配色」
 * 加风眼铺开遮蔽，避免把 'rgb()' 当十六进制解析这类坑。
 */
const GROUND: GroundCol[] = [
  { base: '#ccd6c9', arable: '#c3d2a4', forest: '#98b487', town: '#cdc7bd', water: '#a3c4d9', grid: 'rgba(92,112,96,.16)' },
  { base: '#dccfb1', arable: '#d3c58d', forest: '#a3b47b', town: '#cbc0a9', water: '#a9c6d6', grid: 'rgba(122,100,60,.16)' },
  { base: '#c7cfdc', arable: '#c3c3ae', forest: '#9c9c86', town: '#c6c3bb', water: '#9fbdd2', grid: 'rgba(64,80,104,.16)' },
  { base: '#cbd4af', arable: '#c6cf96', forest: '#91ae72', town: '#bfbcae', water: '#95b8ce', grid: 'rgba(86,92,56,.16)' },
  { base: '#c2d4ab', arable: '#c0ce8f', forest: '#87a76b', town: '#b6b5a7', water: '#7faacb', grid: 'rgba(66,92,50,.16)' },
  { base: '#a9cde6', arable: '#9dbf9d', forest: '#7fa87c', town: '#b8b6a9', water: '#6ea3ce', grid: 'rgba(36,78,116,.14)' },
];

function groundAt(i: number): GroundCol { return GROUND[Math.max(0, Math.min(GROUND.length - 1, i | 0))]; }

/** 整数哈希：同一世界位置永远得到同样的地貌 */
function hashInt(x: number, y: number, lvl: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(lvl | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 以 32 世界单位为格的地貌场：网格越粗越像地图，同一坐标跨关卡保持连续 */
function biomeKind(cx: number, cy: number, lvl: number): number {
  const h = hashInt(cx, cy, lvl) / 4294967296;
  if (h < 0.16) return BIOME.water;
  if (h < 0.30) return BIOME.town;
  if (h < 0.62) return BIOME.waste;
  if (h < 0.84) return BIOME.arable;
  return BIOME.forest;
}

function css(rgb: [number, number, number]): string {
  return `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`;
}

/** patch 颜色：取调色板基准色，再按哈希做 ±5% 明暗抖动 */
function biomeCss(col: GroundCol, kind: number, h: number): string {
  let hex: string;
  if (kind === BIOME.arable) hex = col.arable;
  else if (kind === BIOME.forest) hex = col.forest;
  else if (kind === BIOME.town) hex = col.town;
  else if (kind === BIOME.water) hex = col.water;
  else hex = col.base;
  return shade(hex, (h - 0.5) * 0.1);
}

/** 按幅度把十六进制色调亮/调暗（amt > 0 提亮，< 0 压暗），永远只喂十六进制 */
function shade(hex: string, amt: number): string {
  const c = hexRgb(hex);
  const target = amt < 0 ? 0 : 255;
  const k = Math.abs(amt);
  return css([c[0] + (target - c[0]) * k, c[1] + (target - c[1]) * k, c[2] + (target - c[2]) * k]);
}

function hexRgb(h: string): [number, number, number] {
  const s = h.charAt(0) === '#' ? h.slice(1) : h;
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ease(t: number): number {
  const k = clamp(t, 0, 1);
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}
function smoothstep(t: number): number {
  const k = clamp(t, 0, 1);
  return k * k * (3 - 2 * k);
}
function clamp(v: number, a: number, b: number): number { return Math.max(a, Math.min(b, v)); }
/** 确定性伪随机（地形/装饰按量级种子生成，每帧一致） */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { VIEW as TORNADO_VIEW };
