/* ────────────────────────────────────────────────────────────
 *  tornado-controller.ts — 《龙卷风成长记》页面控制器
 *  键盘(WASD/方向键) + 指针按住牵引；HUD、量级进度、最高分。
 *  键盘仅在本页可见时生效，避免劫持其他棋类页的方向键。
 * ──────────────────────────────────────────────────────────── */

import { TornadoGame, TIERS, TORNADO_VIEW, tierScoreGoal } from '../tornado/game';
import type { GpuRenderer, NarrativeState } from '../tornado/gpu/renderer';
import type { AudioEngine } from '../ui/audio';
import { Stats } from '../ui/stats';
import { mustEl } from '../ui/dom';

const KEY_BEST = 'tornado.best.v1';
/** 看过开场 CG 的标记：同一浏览器只播一次，重开不再打扰 */
const KEY_INTRO_SEEN = 'tornado.intro.seen.v1';
const MOVE_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd']);
/** 冲刺键：空格或 Shift，两种习惯都照顾 */
const DASH_KEYS = new Set([' ', 'shift']);
/** 触屏冲刺：双击画布的判定窗口（毫秒） */
const DOUBLE_TAP_MS = 280;

/** 叙事阶段：开场 CG / 正常游玩 / 过场动画 / 结局 CG */
type Phase = 'intro' | 'play' | 'cine' | 'finale';

/** 开场与结局 CG 的时长（秒） */
const INTRO_DUR = 4.2;
const FINALE_DUR = 6.0;
/** 量级跃迁的过场动画时长（秒）：转场本身 1.5~1.8s，过场稍长以留出字幕时间 */
const CINE_DUR = 2.4;

export class TornadoController {
  private game = new TornadoGame();
  private keys = new Set<string>();
  private ptr: { x: number; y: number } | null = null;
  private last = 0;
  private best = +(localStorage.getItem(KEY_BEST) ?? '0') || 0;
  private winCounted = false;
  private bounceCool = 0;
  private readonly section: HTMLElement | null;
  private dpr = 1;
  /**
   * 渲染后端。null＝尚未决定（首帧前完成探测）。
   *
   * 为什么必须提前决定：一张 canvas 的上下文类型是不可逆的——一旦调用过
   * getContext('2d')，就再也拿不到 'webgpu'。所以这里先异步尝试建立 GPU
   * 渲染器，成功走 vgpu，失败或不可用则回退到 Canvas 2D，中途不再切换。
   */
  private gpu: GpuRenderer | null = null;
  private backend: 'pending' | 'webgpu' | 'canvas2d' = 'pending';
  /** 上一帧的渲染状态：GPU 路径由渲染器回读，Canvas 路径由 paint 使用 */
  private ctx2d: CanvasRenderingContext2D | null = null;

  /* ── 叙事：CG 与过场动画 ────────────────────────────── */

  private phase: Phase = 'play';
  /** 当前阶段已进行的时间（秒） */
  private phaseT = 0;
  /** 过场动画字幕（进入 cine 时按目标量级填充） */
  private cineTitle = '';
  private cineSubtitle = '';

  private narrative: NarrativeState = {
    cg: null, cgProgress: 0, cine: 0, cinePhase: 0, cineTitle: '', cineSubtitle: '',
  };

  constructor(private canvas: HTMLCanvasElement, private audio: AudioEngine) {
    // 调试/自动化用：暴露当前局面（转场连续性冒烟脚本会读它）
    (window as any).__tornadoGame = this.game;
    this.section = mustEl('view-tornado');
    this.applyDpr();
    this.bind();
    this.game.onEat = (big) => { if (big) this.audio.check(); else this.audio.capture(); };
    this.game.onBounce = () => {
      if (this.bounceCool > 0) return;
      this.bounceCool = 0.12;
      this.audio.bad();
    };
    // 量级跃迁：音效 + 过场演出（字幕按目标量级生成）
    this.game.onTierUp = (tier) => {
      this.audio.hint();
      this.startCine(tier);
    };
    // 通关：转入结局 CG，结算条由 CG 结束后再显示
    this.game.onWin = () => this.finishRun();
    // 达成量级分数线：给一声提示音，并把评价带进接下来的过场字幕
    this.game.onGoal = () => {
      this.audio.check();
      this.goalFlash = 1;
    };
    this.buildTierList();
    this.last = performance.now();
    // 首次进入本页先播开场 CG（同一浏览器只播一次，之后直接开局）
    let seenIntro = false;
    try { seenIntro = localStorage.getItem(KEY_INTRO_SEEN) === '1'; } catch { /* 隐私模式下读不到就当没看过 */ }
    if (!seenIntro) this.enterPhase('intro');
    void this.initBackend();
    requestAnimationFrame(this.loop);
    window.addEventListener('resize', () => this.applyDpr());
  }

  /* ── 叙事推进 ────────────────────────────────────────── */

  private enterPhase(p: Phase): void {
    this.phase = p;
    this.phaseT = 0;
  }

  /** 开场 CG 播完：记标记并直接开局 */
  private finishIntro(): void {
    try { localStorage.setItem(KEY_INTRO_SEEN, '1'); } catch { /* 存不了就下次再播 */ }
    this.enterPhase('play');
  }

  /** 通关：进入结局 CG，并把成绩落库 */
  private finishRun(): void {
    this.enterPhase('finale');
    this.audio.win();
    if (!this.winCounted) { this.winCounted = true; Stats.add(true); }
    this.saveBest();
  }

  /** 结局 CG 结束：显示结算条，等待玩家重开 */
  private finishFinale(): void {
    this.enterPhase('play');
    const g = this.game;
    const el = mustEl('t-result');
    el.classList.remove('hidden');
    const grade = g.goalsHit >= TIERS.length ? 'S' : g.goalsHit >= TIERS.length - 2 ? 'A' : g.goalsHit >= 2 ? 'B' : 'C';
    el.textContent = `🌍 你卷走了整个地球！得分 ${g.score.toLocaleString()} · 评价 ${grade} · 最高连击 ${g.bestCombo} · 达成 ${g.goalsHit}/${TIERS.length} 个量级目标`;
  }

  /**
   * 每帧推进叙事状态。CG / 过场期间暂停玩法更新，
   * 这样画面演出不会被模拟层的运动打断（也避免玩家在 CG 里误操作）。
   */
  private advanceNarrative(dt: number): boolean {
    this.phaseT += dt;
    const nar = this.narrative;

    switch (this.phase) {
      case 'intro': {
        nar.cg = 'intro';
        nar.cgProgress = Math.min(1, this.phaseT / INTRO_DUR);
        nar.cine = 0;
        if (this.phaseT >= INTRO_DUR) this.finishIntro();
        return true;   // 暂停玩法
      }
      case 'finale': {
        nar.cg = 'finale';
        nar.cgProgress = Math.min(1, this.phaseT / FINALE_DUR);
        nar.cine = 0;
        if (this.phaseT >= FINALE_DUR) this.finishFinale();
        return true;
      }
      case 'cine': {
        nar.cg = null;
        nar.cinePhase = Math.min(1, this.phaseT / CINE_DUR);
        // 中段最强、两端淡出，字幕才不会硬切
        nar.cine = Math.sin(nar.cinePhase * Math.PI);
        nar.cineTitle = this.cineTitle;
        nar.cineSubtitle = this.cineSubtitle;
        if (this.phaseT >= CINE_DUR) {
          this.enterPhase('play');
          nar.cine = 0;
        }
        // 过场期间玩法继续推进，只是画面被演出覆盖
        return false;
      }
      default: {
        nar.cg = null;
        nar.cine = 0;
        nar.cineTitle = '';
        nar.cineSubtitle = '';
        return false;
      }
    }
  }

  /** 进入某个量级的过场演出 */
  private startCine(tier: number): void {
    const t = TIERS[Math.min(tier, TIERS.length - 1)];
    const prev = TIERS[Math.max(0, Math.min(tier - 1, TIERS.length - 1))];
    this.cineTitle = `${t.name}`;
    this.cineSubtitle = `${prev.en} → ${t.en} · 脚下的世界正在铺展开来`;
    this.enterPhase('cine');
  }

  /**
   * 选择渲染后端。WebGPU 可用且能建立设备时走 vgpu；否则退回 Canvas 2D。
   * 两条路径共享同一份模拟与相机状态，玩法完全一致。
   *
   * vgpu 走动态 import：它只在进入本页时才加载，落在独立 chunk 里，
   * 主包与其余八款游戏完全不受影响（站点其余部分不碰 WebGPU）。
   */
  private async initBackend(): Promise<void> {
    const hasGpu = typeof navigator !== 'undefined'
      && !!(navigator as Navigator & { gpu?: unknown }).gpu;
    if (hasGpu) {
      try {
        const { createGpuRenderer } = await import('../tornado/gpu/renderer');
        this.gpu = await createGpuRenderer(
          this.canvas,
          () => this.game.renderState(),
          () => ({
            objects: this.game.objects,
            terrain: this.game.terrain,
            particles: this.game.particles,
            rings: this.game.rings,
            tier: this.game.tier,
            time: this.game.time,
            // 立体漏斗要用世界坐标（屏幕位置由渲染器自己算），
            // 半径用当前实际半径，转场时会连续变化
            tornadoX: this.game.x,
            tornadoY: this.game.y,
            tornadoR: this.game.r,
            dashFx: this.game.dashFx,
          }),
          () => this.narrative,
          // 设备丢失等致命错误：退回 Canvas 2D，游戏继续可玩
          (err) => {
            console.warn('[tornado] WebGPU 渲染中断，回退 Canvas 2D', err);
            this.fallbackToCanvas2d();
          },
        );
        this.backend = 'webgpu';
        document.documentElement.dataset.tornadoBackend = 'webgpu';
        return;
      } catch (err) {
        console.warn('[tornado] WebGPU 不可用，使用 Canvas 2D', err);
      }
    }
    this.fallbackToCanvas2d();
  }

  /** 退回 Canvas 2D：释放 GPU 资源，并把画布交还给 2D 上下文 */
  private fallbackToCanvas2d(): void {
    if (this.backend === 'canvas2d') return;
    try { this.gpu?.dispose(); } catch { /* 释放失败不影响回退 */ }
    this.gpu = null;
    this.backend = 'canvas2d';
    document.documentElement.dataset.tornadoBackend = 'canvas2d';
    // 交给 2D 前必须保证尺寸按 DPR 设好（GPU 路径下 surface 自己管过尺寸）
    this.dpr = 1;
    this.applyDpr();
    this.ctx2d = null;
    this.paintCanvas2d();
  }

  /** 高分屏：提高内部缓冲分辨率，CSS 尺寸不变 */
  private applyDpr(): void {
    const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
    if (dpr === this.dpr && this.canvas.width === Math.round(TORNADO_VIEW * dpr)) return;
    this.dpr = dpr;
    this.canvas.width = Math.round(TORNADO_VIEW * dpr);
    this.canvas.height = Math.round(TORNADO_VIEW * dpr);
    this.gpu?.resize();
  }

  private isVisible(): boolean {
    return !!this.section?.classList.contains('active');
  }

  /** 最近一次触屏点击时间（判定双击冲刺） */
  private lastTap = 0;
  /** 达成目标时的一次性闪烁强度 0..1（转为 0 即淡出） */
  private goalFlash = 0;

  // ── input ──
  private bind(): void {
    window.addEventListener('keydown', (e) => {
      if (!this.isVisible()) return;
      if (document.activeElement && /INPUT|TEXTAREA/.test((document.activeElement as HTMLElement).tagName)) return;
      const k = e.key.toLowerCase();
      if (MOVE_KEYS.has(k)) {
        this.keys.add(k);
        e.preventDefault();
        return;
      }
      if (DASH_KEYS.has(k)) {
        // 空格默认会滚动页面，必须挡掉
        e.preventDefault();
        if (!e.repeat) this.tryDash();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => { this.keys.clear(); this.ptr = null; });
    // 离开本页清空按键，避免残留方向键卡住移动
    window.addEventListener('hashchange', () => {
      if (!this.isVisible()) { this.keys.clear(); this.ptr = null; }
    });

    const toWorld = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * TORNADO_VIEW;
      const sy = ((e.clientY - r.top) / r.height) * TORNADO_VIEW;
      return this.game.screenToWorld(sx, sy);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.ptr = toWorld(e);
    });
    this.canvas.addEventListener('pointermove', (e) => { if (this.ptr) this.ptr = toWorld(e); });
    const end = () => { this.ptr = null; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    // 触屏冲刺：双击画布。桌面端用空格/Shift，两边都能触发。
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      const now = performance.now();
      if (now - this.lastTap < DOUBLE_TAP_MS) this.tryDash();
      this.lastTap = now;
    });

    mustEl('t-restart').addEventListener('click', () => this.restart());
    mustEl('t-restart-tier').addEventListener('click', () => {
      this.game.restartTier();
      // 通关统计不因「本关重置」清零，避免重复刷 Stats；完整重新开始才重置
      mustEl('t-result').classList.add('hidden');
      this.audio.undo();
    });
    mustEl('t-dash').addEventListener('click', () => this.tryDash());
    mustEl('t-sound').addEventListener('click', (e) => {
      this.audio.enabled = !this.audio.enabled;
      const b = e.currentTarget as HTMLElement;
      b.classList.toggle('on', this.audio.enabled);
      b.textContent = this.audio.enabled ? '🔊 音效开' : '🔇 音效关';
    });
  }

  /** 冲刺：由键盘、触屏双击或 HUD 按钮触发 */
  private tryDash(): void {
    if (this.phase !== 'play') return;
    if (this.game.dash()) this.audio.capture();
  }

  restart(): void {
    this.game.reset();
    this.winCounted = false;
    this.enterPhase('play');
    mustEl('t-result').classList.add('hidden');
    this.audio.select();
  }

  // ── loop ──
  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.isVisible() || !this.canvas.offsetParent) return;
    this.bounceCool = Math.max(0, this.bounceCool - dt);
    this.goalFlash = Math.max(0, this.goalFlash - dt * 0.8);
    // CG / 过场会接管这一帧：CG 期间暂停玩法，过场期间玩法继续但画面由演出覆盖
    const paused = this.advanceNarrative(dt);
    if (!paused) {
      const kx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
      const ky = (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0) - (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0);
      this.game.update(dt, { kx, ky, tx: this.ptr?.x ?? null, ty: this.ptr?.y ?? null });
    }
    this.paint();
    this.updateHud();
  };

  private paint(): void {
    // 后端尚未决定时什么都不画：此刻若取 2D 上下文，就会永久失去
    // 拿到 'webgpu' 上下文的机会（同一张 canvas 只能有一种上下文类型）。
    if (this.backend === 'pending') return;
    if (this.backend === 'webgpu' && this.gpu) {
      this.gpu.render();
      return;
    }
    this.paintCanvas2d();
  }

  /** Canvas 2D 兜底路径：与移植前逐行等价 */
  private paintCanvas2d(): void {
    if (!this.ctx2d) {
      this.ctx2d = this.canvas.getContext('2d');
      if (!this.ctx2d) return;
    }
    const ctx = this.ctx2d;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // CG 与过场在无 WebGPU 时也要能看：用 2D 画同构的简化版本，
    // 保证「任何浏览器都能玩」——只是画面朴素一些。
    if (this.narrative.cg || this.narrative.cine > 0.01) {
      this.paintNarrative2d(ctx);
      return;
    }
    this.game.render(ctx);
  }

  /** CG / 过场的 Canvas 2D 简化版（WebGPU 不可用时的降级表现） */
  private paintNarrative2d(ctx: CanvasRenderingContext2D): void {
    const nar = this.narrative;
    const S = TORNADO_VIEW;
    ctx.save();
    if (nar.cg) {
      // 天空 → 地平线 → 龙卷风剪影的静态构图，按进度做淡入
      const g = ctx.createLinearGradient(0, 0, 0, S);
      if (nar.cg === 'finale') {
        g.addColorStop(0, '#04060f');
        g.addColorStop(1, '#0b1426');
      } else {
        g.addColorStop(0, '#3d6b9e');
        g.addColorStop(1, '#f7dbad');
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      const hy = nar.cg === 'finale' ? S * 0.5 : S * 0.58;
      if (nar.cg === 'finale') {
        // 星球 + 涡旋
        const rg = ctx.createRadialGradient(S * 0.44, S * 0.46, S * 0.02, S * 0.5, S * 0.5, S * 0.3);
        rg.addColorStop(0, '#3f7fd0');
        rg.addColorStop(0.7, '#1d4a86');
        rg.addColorStop(1, '#0a1b33');
        ctx.fillStyle = rg;
        ctx.beginPath(); ctx.arc(S * 0.5, S * 0.5, S * 0.3, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = '#25302f';
        ctx.fillRect(0, hy, S, S - hy);
      }
      // 龙卷风剪影
      ctx.globalAlpha = Math.min(1, nar.cgProgress * 2.2);
      ctx.fillStyle = nar.cg === 'finale' ? 'rgba(255,255,255,.85)' : 'rgba(20,26,30,.9)';
      ctx.beginPath();
      const cx = nar.cg === 'finale' ? S * 0.42 : S * 0.56;
      const top = nar.cg === 'finale' ? S * 0.36 : hy - S * 0.42;
      ctx.moveTo(cx - S * 0.02, hy);
      ctx.quadraticCurveTo(cx - S * 0.09, (hy + top) / 2, cx - S * 0.08, top);
      ctx.lineTo(cx + S * 0.08, top);
      ctx.quadraticCurveTo(cx + S * 0.09, (hy + top) / 2, cx + S * 0.02, hy);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      // 标题
      ctx.fillStyle = 'rgba(255,255,255,.94)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 30px "PingFang SC","Microsoft YaHei",system-ui';
      ctx.globalAlpha = Math.min(1, nar.cgProgress * 3) * (1 - Math.max(0, (nar.cgProgress - 0.85) / 0.15));
      ctx.fillText(nar.cg === 'finale' ? '🌍 行星级' : '🌪️ 龙卷风成长记', S / 2, S * 0.16);
      ctx.globalAlpha = 1;
    } else {
      // 过场：压暗 + 上下边条 + 字幕
      ctx.fillStyle = `rgba(10,16,22,${0.42 * nar.cine})`;
      ctx.fillRect(0, 0, S, S);
      const barH = S * 0.13 * nar.cine;
      ctx.fillStyle = '#05080b';
      ctx.fillRect(0, 0, S, barH);
      ctx.fillRect(0, S - barH, S, barH);
      const a = Math.sin(nar.cinePhase * Math.PI) * nar.cine;
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 28px "PingFang SC","Microsoft YaHei",system-ui';
      ctx.fillText(nar.cineTitle, S / 2, S / 2 - 12);
      if (nar.cineSubtitle) {
        ctx.font = '14px system-ui';
        ctx.fillStyle = 'rgba(255,255,255,.82)';
        ctx.fillText(nar.cineSubtitle, S / 2, S / 2 + 22);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  redraw(): void {
    this.last = performance.now();
    this.applyDpr();
    this.paint();
    this.updateHud();
  }

  // ── HUD ──
  private updateHud(): void {
    const g = this.game;
    const set = (id: string, v: string) => {
      const el = mustEl(id);
      if (el.textContent !== v) el.textContent = v;
    };
    set('t-tier', `${TIERS[Math.min(g.tier, TIERS.length - 1)].name} · ${Math.min(g.tier + 1, TIERS.length)}/6`);
    set('t-eaten', `${g.eaten} / ${g.total}`);
    set('t-score', g.score.toLocaleString());
    set('t-radius', this.radiusLabel(g.r));
    set('t-best', this.best.toLocaleString());
    set('t-status', g.state === 'zoom' ? '镜头拉远中…' : g.state === 'win' ? '通关！' : g.r >= 200 ? '已是灭世级' : '吞噬中…');

    // ── 连击：只在有连击时显示，避免静态界面干扰 ──
    const comboEl = mustEl('t-combo');
    if (g.combo >= 2) {
      comboEl.classList.remove('hidden');
      comboEl.textContent = `×${g.comboMul.toFixed(2)} 连击 ${g.combo}`;
      // 剩余窗口越短越淡，形成「快断了」的紧迫感
      comboEl.style.opacity = String(0.45 + 0.55 * Math.min(1, g.comboT / 2.2));
    } else {
      comboEl.classList.add('hidden');
    }

    // ── 冲刺：可用时高亮，冷却时显示进度 ──
    const dashEl = mustEl('t-dash');
    const ready = g.canDash;
    dashEl.classList.toggle('ready', ready);
    dashEl.textContent = ready ? '💨 冲刺（空格）' : g.dashCd > 0
      ? `冲刺冷却 ${g.dashCd.toFixed(1)}s`
      : `冲刺需 ${4} 连击`;

    // ── 量级目标：达成即标记，给熟练玩家额外追求 ──
    const goalEl = mustEl('t-goal');
    const goal = tierScoreGoal(g.tier);
    const got = g.score - g.tierStartScore;
    goalEl.textContent = g.tierGoalHit
      ? '⭐ 本关目标已达成'
      : `目标 ${got.toLocaleString()} / ${goal.toLocaleString()}`;
    goalEl.classList.toggle('done', g.tierGoalHit);

    const pill = mustEl('t-turn');
    pill.textContent = g.state === 'win' ? '🌍 通关' : `当前量级 ${TIERS[Math.min(g.tier, 5)].name}`;
    // 进度条
    const bar = mustEl('t-progress');
    bar.style.width = `${g.total ? Math.min(100, (g.eaten / g.total) * 100) : 0}%`;
    // 量级列表状态
    document.querySelectorAll('#t-tier-list .tier-item').forEach((el, i) => {
      el.classList.toggle('current', i === g.tier && g.state !== 'win');
      el.classList.toggle('done', i < g.tier || g.state === 'win');
    });
    if (g.state !== 'play' && g.score > this.best) this.saveBest();
  }

  private radiusLabel(r: number): string {
    if (r >= 200) return '灭世';
    if (r >= 150) return '巨型';
    if (r >= 110) return '超大';
    if (r >= 80) return '大型';
    if (r >= 50) return '中型';
    return '小型';
  }

  private saveBest(): void {
    if (this.game.score > this.best) {
      this.best = this.game.score;
      try { localStorage.setItem(KEY_BEST, String(this.best)); } catch { /* noop */ }
    }
  }

  private buildTierList(): void {
    const wrap = mustEl('t-tier-list');
    wrap.innerHTML = '';
    TIERS.forEach((t, i) => {
      const d = document.createElement('div');
      d.className = 'tier-item';
      d.innerHTML = `<span class="n">${i + 1}</span><div class="t"><b>${t.name}</b><small>${t.en}</small></div><span class="st"></span>`;
      wrap.appendChild(d);
    });
  }
}
