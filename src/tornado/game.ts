/* ────────────────────────────────────────────────────────────
 *  tornado/game.ts — 《龙卷风成长记》核心引擎
 *
 *  玩法（大鱼吃小鱼式成长）：
 *    • 玩家控制小龙卷风，卷走「比自己小的物体」壮大体积；
 *    • 撞上「比自己大的物体会被弹开」，没有任何惩罚；
 *    • 清空当前地图后：镜头拉远（缩放动画）+ 相对缩小，
 *      进入下一个量级：街道 → 楼房 → 城市 → 国家 → 洲 → 全地球。
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
  pool: Array<{ e: string; s: number }>;
}

export const TIERS: TierDef[] = [
  {
    name: '街道内', en: 'STREET', ground: ['#c5d1c8', '#a4b5aa'], grid: 'rgba(70,90,80,.12)',
    baseR: 22, count: 16,
    pool: [
      { e: '🪨', s: 14 }, { e: '🗑️', s: 17 }, { e: '🪣', s: 16 }, { e: '🧹', s: 14 },
      { e: '🪑', s: 18 }, { e: '📮', s: 17 }, { e: '🧱', s: 16 }, { e: '🛞', s: 16 },
      { e: '🚲', s: 21 }, { e: '🛵', s: 22 }, { e: '🌳', s: 21 }, { e: '🪴', s: 16 },
    ],
  },
  {
    name: '大楼房', en: 'BLOCKS', ground: ['#ddd0b2', '#c2ae85'], grid: 'rgba(110,90,50,.12)',
    baseR: 29, count: 14,
    pool: [
      { e: '🌲', s: 25 }, { e: '🏠', s: 27 }, { e: '🏚️', s: 29 }, { e: '🏪', s: 30 },
      { e: '🏘️', s: 33 }, { e: '🏫', s: 34 }, { e: '🏗️', s: 35 }, { e: '⛽', s: 26 },
    ],
  },
  {
    name: '城市', en: 'CITY', ground: ['#c6cfdd', '#a3b1c6'], grid: 'rgba(55,70,95,.12)',
    baseR: 39, count: 12,
    pool: [
      { e: '⛲', s: 33 }, { e: '🏢', s: 39 }, { e: '🏬', s: 43 }, { e: '🌃', s: 44 },
      { e: '🏟️', s: 48 }, { e: '🗼', s: 51 }, { e: '🌆', s: 46 }, { e: '🏙️', s: 53 },
    ],
  },
  {
    name: '国家', en: 'NATION', ground: ['#ccd4b0', '#adb98c'], grid: 'rgba(80,85,50,.12)',
    baseR: 53, count: 10,
    pool: [
      { e: '🚄', s: 52 }, { e: '⛩️', s: 56 }, { e: '🏯', s: 60 }, { e: '🛕', s: 61 },
      { e: '🗽', s: 65 }, { e: '🏛️', s: 68 }, { e: '🏞️', s: 62 }, { e: '🌋', s: 72 },
    ],
  },
  {
    name: '洲', en: 'CONTINENT', ground: ['#c2d4ac', '#9ab77f'], grid: 'rgba(60,85,45,.12)',
    baseR: 73, count: 9,
    pool: [
      { e: '🗿', s: 70 }, { e: '⛰️', s: 75 }, { e: '🏜️', s: 79 }, { e: '🧊', s: 75 },
      { e: '🌊', s: 73 }, { e: '🏔️', s: 83 }, { e: '🗻', s: 88 }, { e: '🌋', s: 92 },
    ],
  },
  {
    name: '全地球', en: 'EARTH', ground: ['#a8cde6', '#7fb0d4'], grid: 'rgba(30,70,110,.12)',
    baseR: 99, count: 8,
    pool: [
      { e: '🏝️', s: 88 }, { e: '🗺️', s: 96 }, { e: '🌍', s: 107 }, { e: '🌎', s: 111 },
      { e: '🌏', s: 114 }, { e: '🌕', s: 101 }, { e: '🌋', s: 120 },
    ],
  },
];

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
  zoomT = 0;            // 转场进度 0..1
  tierStartScore = 0;   // 本量级起始分（本关重置时回滚到此）
  shake = 0;
  time = 0;
  world = VIEW * WORLD_K;

  // 事件回调（控制器接音效）
  onEat: (big: boolean) => void = () => {};
  onBounce: () => void = () => {};
  onTierUp: (tier: number) => void = () => {};
  onWin: () => void = () => {};

  constructor() { this.reset(); }

  reset(): void {
    this.state = 'play';
    this.tier = 0;
    this.score = 0;
    this.zoomT = 0;
    this.spawnTier();
  }

  /** 本关重置：重新生成当前量级的建筑与地形，得分回滚到本关开始时 */
  restartTier(): void {
    if (this.tier >= TIERS.length) this.tier = TIERS.length - 1;
    this.state = 'play';
    this.zoomT = 0;
    this.score = this.tierStartScore;
    this.spawnTier();
  }

  private spawnTier(): void {
    const def = TIERS[this.tier];
    this.tierStartScore = this.score;
    this.world = VIEW * WORLD_K;
    this.r = def.baseR;
    this.x = this.world / 2;
    this.y = this.world / 2;
    this.vx = this.vy = 0;
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
        if (Math.hypot(x - this.x, y - this.y) < tr + this.r + 150) continue;
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
    const spawnObj = (p: { e: string; s: number }) => {
      for (let tries = 0; tries < 90; tries++) {
        const x = M + Math.random() * (this.world - M * 2);
        const y = M + Math.random() * (this.world - M * 2);
        if (Math.hypot(x - this.x, y - this.y) < p.s + this.r + 60) continue;
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
      this.zoomT += dt / 1.9;
      if (this.zoomT >= 1) {
        this.tier++;
        if (this.tier >= TIERS.length) { this.state = 'win'; this.onWin(); return; }
        this.spawnTier();
        this.state = 'play';
        this.zoomT = 0;
      }
      return;
    }
    if (this.state === 'win') return;

    // ── 运动 ──
    const ACC = 980;
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
    const vmax = 360;
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
        if (this.eaten >= this.total) {
          this.state = 'zoom';
          this.zoomT = 0;
          this.onTierUp(this.tier + 1);
        }
      } else {
        // 弹开：无惩罚
        const nx = dx / (d || 1);
        const ny = dy / (d || 1);
        const push = reach - d + 2;
        this.x += nx * push;
        this.y += ny * push;
        const kick = 160 + (o.r - this.r) * 3;
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
      const kick = 150 + t.r * 1.2;
      this.vx = nx * kick + this.vx * 0.3;
      this.vy = ny * kick + this.vy * 0.3;
      this.shake = 0.7;
      this.burst(t.x + nx * t.r * 0.8, t.y + ny * t.r * 0.8, '', 4);
      this.onBounce();
    }
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
  render(ctx: CanvasRenderingContext2D): void {
    const zoom = this.state === 'zoom' ? 1 - 0.8 * ease(this.zoomT) : 1;
    const dispR = this.state === 'zoom'
      ? this.r + (TIERS[Math.min(this.tier + 1, TIERS.length - 1)].baseR - this.r) * ease(this.zoomT)
      : this.r;

    ctx.save();
    ctx.clearRect(0, 0, VIEW, VIEW);
    // 镜头：跟随龙卷风（贴边钳制）+ 转场缩放 + 弹开抖动
    const shx = this.shake * (Math.random() - 0.5) * 8;
    const shy = this.shake * (Math.random() - 0.5) * 8;
    const camX = clamp(this.x - VIEW / (2 * zoom), 0, Math.max(0, this.world - VIEW / zoom));
    const camY = clamp(this.y - VIEW / (2 * zoom), 0, Math.max(0, this.world - VIEW / zoom));
    ctx.translate(VIEW / 2 + shx, VIEW / 2 + shy);
    ctx.scale(zoom, zoom);
    ctx.translate(-(camX + VIEW / (2 * zoom)), -(camY + VIEW / (2 * zoom)));

    const def = TIERS[this.tier];
    // 地面
    const g = ctx.createLinearGradient(camX, camY, camX + VIEW / zoom, camY + VIEW / zoom);
    g.addColorStop(0, def.ground[0]);
    g.addColorStop(1, def.ground[1]);
    ctx.fillStyle = g;
    ctx.fillRect(camX - 4, camY - 4, VIEW / zoom + 8, VIEW / zoom + 8);
    // 网格纹理
    ctx.strokeStyle = def.grid;
    ctx.lineWidth = 1.5;
    const gs = 72;
    const gx0 = Math.floor(camX / gs) * gs;
    const gy0 = Math.floor(camY / gs) * gs;
    ctx.beginPath();
    for (let x = gx0; x < camX + VIEW / zoom + gs; x += gs) { ctx.moveTo(x, camY); ctx.lineTo(x, camY + VIEW / zoom); }
    for (let y = gy0; y < camY + VIEW / zoom + gs; y += gs) { ctx.moveTo(camX, y); ctx.lineTo(camX + VIEW / zoom, y); }
    ctx.stroke();
    // 世界边界
    ctx.strokeStyle = 'rgba(28,43,51,.25)';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, this.world, this.world);

    // 地面装饰（道路 / 田块 / 海浪）与地形障碍
    this.drawGroundDecor(ctx);
    for (const t of this.terrain) this.drawTerrain(ctx, t);

    // 物体（不透明；被卷走时进入吸入动画）
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const o of this.objects) {
      if (o.dead && !o.suck) continue;
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

    // 粒子 & 环
    for (const rg of this.rings) {
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
      ctx.strokeStyle = rg.c;
      ctx.globalAlpha = Math.max(0, rg.life / 0.45);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
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

    // 龙卷风
    this.drawTornado(ctx, this.x, this.y, dispR);

    ctx.restore();

    // 转场字幕
    if (this.state === 'zoom' && this.zoomT > 0.25) {
      const nxt = TIERS[Math.min(this.tier + 1, TIERS.length - 1)];
      ctx.save();
      ctx.globalAlpha = Math.min(1, (this.zoomT - 0.25) * 2.4);
      ctx.fillStyle = 'rgba(28,43,51,.55)';
      ctx.fillRect(0, VIEW / 2 - 44, VIEW, 88);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 22px "PingFang SC","Microsoft YaHei",system-ui';
      ctx.fillText(`镜头拉远 · 前方进入「${this.tier + 1 >= TIERS.length ? '？' : nxt.name}」`, VIEW / 2, VIEW / 2 - 10);
      ctx.font = '13px system-ui';
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.fillText('你已卷走本阶段的一切 —— 世界在你眼中变小了', VIEW / 2, VIEW / 2 + 20);
      ctx.restore();
    }
    // 暗角
    const vg = ctx.createRadialGradient(VIEW / 2, VIEW / 2, VIEW * 0.42, VIEW / 2, VIEW / 2, VIEW * 0.72);
    vg.addColorStop(0, 'rgba(28,43,51,0)');
    vg.addColorStop(1, 'rgba(28,43,51,.09)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, VIEW, VIEW);
  }

  /** 地面装饰：低量级画道路街区，中量级画田块林斑，高量级画海浪 */
  private drawGroundDecor(ctx: CanvasRenderingContext2D): void {
    const rng = mulberry32(this.tier * 9973 + 7);
    const W = this.world;
    ctx.save();
    if (this.tier <= 2) {
      // 道路：横竖各 3 条沥青带 + 白色虚线中心线
      const roads: Array<{ v: boolean; p: number }> = [];
      for (let i = 0; i < 3; i++) roads.push({ v: false, p: W * (0.16 + 0.32 * i) + (rng() - 0.5) * 90 });
      for (let i = 0; i < 3; i++) roads.push({ v: true, p: W * (0.2 + 0.3 * i) + (rng() - 0.5) * 90 });
      ctx.fillStyle = 'rgba(62,72,84,.16)';
      for (const rd of roads) {
        if (rd.v) ctx.fillRect(rd.p - 17, 0, 34, W);
        else ctx.fillRect(0, rd.p - 17, W, 34);
      }
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([16, 22]);
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
    } else if (this.tier <= 4) {
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

  /** 屏幕(canvas)逻辑坐标 → 世界坐标，与 render 的相机变换互逆 */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const zoom = this.state === 'zoom' ? 1 - 0.8 * ease(this.zoomT) : 1;
    const camX = clamp(this.x - VIEW / (2 * zoom), 0, Math.max(0, this.world - VIEW / zoom));
    const camY = clamp(this.y - VIEW / (2 * zoom), 0, Math.max(0, this.world - VIEW / zoom));
    return {
      x: camX + VIEW / (2 * zoom) + (sx - VIEW / 2) / zoom,
      y: camY + VIEW / (2 * zoom) + (sy - VIEW / 2) / zoom,
    };
  }

  private drawTornado(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    const h = r * 2.1;
    ctx.save();
    ctx.translate(x, y);
    // 接触阴影
    ctx.beginPath();
    ctx.ellipse(0, r * 0.55, r * 0.9, r * 0.24, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(28,43,51,.18)';
    ctx.fill();
    // 锥体填充
    ctx.beginPath();
    ctx.moveTo(-r * 0.85, r * 0.35);
    ctx.quadraticCurveTo(-r * 0.2, -h * 0.5, -r * 0.52, -h);
    ctx.lineTo(r * 0.52, -h);
    ctx.quadraticCurveTo(r * 0.2, -h * 0.5, r * 0.85, r * 0.35);
    ctx.closePath();
    ctx.fillStyle = 'rgba(96,120,138,.28)';
    ctx.fill();
    // 旋转螺纹
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const yy = r * 0.35 - h * t;
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
      const yy = r * 0.2 - h * (0.25 + t * 0.6);
      const w = r * (0.95 - 0.5 * t);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * w, yy + Math.sin(a * 1.7) * 4, Math.max(2, r * 0.09), 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${30 + i * 18},30%,${40 + i * 6}%,.75)`;
      ctx.fill();
    }
    ctx.restore();
  }
}

function ease(t: number): number { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
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
