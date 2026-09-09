/* ────────────────────────────────────────────────────────────
 *  tornado-controller.ts — 《龙卷风成长记》页面控制器
 *  键盘(WASD/方向键) + 指针按住牵引；HUD、量级进度、最高分。
 * ──────────────────────────────────────────────────────────── */

import { TornadoGame, TIERS, TORNADO_VIEW } from '../tornado/game';
import type { AudioEngine } from '../ui/audio';
import { Stats } from '../ui/stats';

const KEY_BEST = 'tornado.best.v1';

export class TornadoController {
  private game = new TornadoGame();
  private keys = new Set<string>();
  private ptr: { x: number; y: number } | null = null;
  private raf = 0;
  private last = 0;
  private best = +(localStorage.getItem(KEY_BEST) ?? '0') || 0;
  private winCounted = false;

  constructor(private canvas: HTMLCanvasElement, private audio: AudioEngine) {
    if (import.meta.env.DEV) (window as any).__tornadoGame = this.game; // 开发调试钩子
    this.bind();
    this.game.onEat = (big) => { if (big) this.audio.check(); else this.audio.capture(); };
    this.game.onBounce = () => this.audio.bad();
    this.game.onTierUp = () => this.audio.hint();
    this.game.onWin = () => {
      this.audio.win();
      if (!this.winCounted) { this.winCounted = true; Stats.add(true); }
      this.saveBest();
      const el = document.getElementById('t-result');
      if (el) {
        el.classList.remove('hidden');
        el.textContent = `🌍 你卷走了整个地球！最终得分 ${this.game.score.toLocaleString()}`;
      }
    };
    this.buildTierList();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ── input ──
  private bind(): void {
    window.addEventListener('keydown', (e) => {
      if (document.activeElement && /INPUT|TEXTAREA/.test((document.activeElement as HTMLElement).tagName)) return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) {
        this.keys.add(k);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => { this.keys.clear(); this.ptr = null; });

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

    document.getElementById('t-restart')?.addEventListener('click', () => this.restart());
    document.getElementById('t-restart-tier')?.addEventListener('click', () => {
      this.game.restartTier();
      this.winCounted = false;
      document.getElementById('t-result')?.classList.add('hidden');
      this.audio.undo();
    });
    document.getElementById('t-sound')?.addEventListener('click', (e) => {
      this.audio.enabled = !this.audio.enabled;
      const b = e.currentTarget as HTMLElement;
      b.classList.toggle('on', this.audio.enabled);
      b.textContent = this.audio.enabled ? '🔊 音效开' : '🔇 音效关';
    });
  }

  restart(): void {
    this.game.reset();
    this.winCounted = false;
    document.getElementById('t-result')?.classList.add('hidden');
    this.audio.select();
  }

  // ── loop ──
  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.canvas.offsetParent) return; // 页面不可见时挂起（切回时 redraw() 恢复）
    const kx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
    const ky = (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0) - (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0);
    this.game.update(dt, { kx, ky, tx: this.ptr?.x ?? null, ty: this.ptr?.y ?? null });
    const ctx = this.canvas.getContext('2d');
    if (ctx) this.game.render(ctx);
    this.updateHud();
  };

  redraw(): void {
    this.last = performance.now();
    const ctx = this.canvas.getContext('2d');
    if (ctx) this.game.render(ctx);
    this.updateHud();
  }

  // ── HUD ──
  private updateHud(): void {
    const g = this.game;
    const set = (id: string, v: string) => {
      const el = document.getElementById(id);
      if (el && el.textContent !== v) el.textContent = v;
    };
    set('t-tier', `${TIERS[Math.min(g.tier, TIERS.length - 1)].name} · ${Math.min(g.tier + 1, TIERS.length)}/6`);
    set('t-eaten', `${g.eaten} / ${g.total}`);
    set('t-score', g.score.toLocaleString());
    set('t-radius', `${Math.round(g.r)} px`);
    set('t-best', this.best.toLocaleString());
    set('t-status', g.state === 'zoom' ? '镜头拉远中…' : g.state === 'win' ? '通关！' : g.r >= 150 ? '已是灭世级' : '吞噬中…');
    const pill = document.getElementById('t-turn');
    if (pill) pill.textContent = g.state === 'win' ? '🌍 通关' : `当前量级 ${TIERS[Math.min(g.tier, 5)].name}`;
    // 进度条
    const bar = document.getElementById('t-progress');
    if (bar) bar.style.width = `${g.total ? Math.min(100, (g.eaten / g.total) * 100) : 0}%`;
    // 量级列表状态
    document.querySelectorAll('#t-tier-list .tier-item').forEach((el, i) => {
      el.classList.toggle('current', i === g.tier && g.state !== 'win');
      el.classList.toggle('done', i < g.tier || g.state === 'win');
    });
    if (g.state !== 'play' && g.score > this.best) this.saveBest();
  }

  private saveBest(): void {
    if (this.game.score > this.best) {
      this.best = this.game.score;
      try { localStorage.setItem(KEY_BEST, String(this.best)); } catch { /* noop */ }
    }
  }

  private buildTierList(): void {
    const wrap = document.getElementById('t-tier-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    TIERS.forEach((t, i) => {
      const d = document.createElement('div');
      d.className = 'tier-item';
      d.innerHTML = `<span class="n">${i + 1}</span><div class="t"><b>${t.name}</b><small>${t.en}</small></div><span class="st"></span>`;
      wrap.appendChild(d);
    });
  }
}
