/* ────────────────────────────────────────────────────────────
 *  tornado-controller.ts — 《龙卷风成长记》页面控制器
 *  键盘(WASD/方向键) + 指针按住牵引；HUD、量级进度、最高分。
 *  键盘仅在本页可见时生效，避免劫持其他棋类页的方向键。
 * ──────────────────────────────────────────────────────────── */

import { TornadoGame, TIERS, TORNADO_VIEW } from '../tornado/game';
import type { AudioEngine } from '../ui/audio';
import { Stats } from '../ui/stats';
import { mustEl } from '../ui/dom';

const KEY_BEST = 'tornado.best.v1';
const MOVE_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd']);

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
    this.game.onTierUp = () => this.audio.hint();
    this.game.onWin = () => {
      this.audio.win();
      if (!this.winCounted) { this.winCounted = true; Stats.add(true); }
      this.saveBest();
      const el = mustEl('t-result');
      el.classList.remove('hidden');
      el.textContent = `🌍 你卷走了整个地球！最终得分 ${this.game.score.toLocaleString()}`;
    };
    this.buildTierList();
    this.last = performance.now();
    requestAnimationFrame(this.loop);
    window.addEventListener('resize', () => this.applyDpr());
  }

  /** 高分屏：提高内部缓冲分辨率，CSS 尺寸不变 */
  private applyDpr(): void {
    const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
    if (dpr === this.dpr && this.canvas.width === Math.round(TORNADO_VIEW * dpr)) return;
    this.dpr = dpr;
    this.canvas.width = Math.round(TORNADO_VIEW * dpr);
    this.canvas.height = Math.round(TORNADO_VIEW * dpr);
  }

  private isVisible(): boolean {
    return !!this.section?.classList.contains('active');
  }

  // ── input ──
  private bind(): void {
    window.addEventListener('keydown', (e) => {
      if (!this.isVisible()) return;
      if (document.activeElement && /INPUT|TEXTAREA/.test((document.activeElement as HTMLElement).tagName)) return;
      const k = e.key.toLowerCase();
      if (MOVE_KEYS.has(k)) {
        this.keys.add(k);
        e.preventDefault();
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

    mustEl('t-restart').addEventListener('click', () => this.restart());
    mustEl('t-restart-tier').addEventListener('click', () => {
      this.game.restartTier();
      // 通关统计不因「本关重置」清零，避免重复刷 Stats；完整重新开始才重置
      mustEl('t-result').classList.add('hidden');
      this.audio.undo();
    });
    mustEl('t-sound').addEventListener('click', (e) => {
      this.audio.enabled = !this.audio.enabled;
      const b = e.currentTarget as HTMLElement;
      b.classList.toggle('on', this.audio.enabled);
      b.textContent = this.audio.enabled ? '🔊 音效开' : '🔇 音效关';
    });
  }

  restart(): void {
    this.game.reset();
    this.winCounted = false;
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
    const kx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
    const ky = (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0) - (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0);
    this.game.update(dt, { kx, ky, tx: this.ptr?.x ?? null, ty: this.ptr?.y ?? null });
    this.paint();
    this.updateHud();
  };

  private paint(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.game.render(ctx);
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
