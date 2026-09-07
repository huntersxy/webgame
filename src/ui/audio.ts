/* ────────────────────────────────────────────────────────────
 *  ui/audio.ts — Web Audio synth for move/capture/win/lose SFX
 *  + BGM playback (demon mode) via a media element.
 * ──────────────────────────────────────────────────────────── */

import demonBgmUrl from '../assets/demon-bgm.m4a';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private _enabled = true;
  private _bgm: HTMLAudioElement | null = null;

  get enabled(): boolean { return this._enabled; }
  set enabled(v: boolean) { this._enabled = v; }

  private ensure(): AudioContext | null {
    if (!this._enabled) return null;
    try {
      this.ctx = this.ctx || new (window.AudioContext || (window as any).webkitAudioContext)();
      return this.ctx;
    } catch { return null; }
  }

  private beep(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.15): void {
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.value = vol;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      o.stop(ctx.currentTime + dur);
    } catch { /* noop */ }
  }

  /** Start demon-mode BGM (idempotent, resumes if paused). */
  startBGM(): void {
    if (!this._enabled) return;
    try {
      if (!this._bgm) {
        this._bgm = new Audio(demonBgmUrl);
        this._bgm.loop = true;
        this._bgm.volume = 0.45;
      }
      if (this._bgm.paused) {
        this._bgm.play().catch(() => { /* autoplay blocked — will retry on gesture */ });
      }
    } catch { /* noop */ }
  }

  /** Stop demon-mode BGM. */
  stopBGM(): void {
    try {
      if (this._bgm && !this._bgm.paused) this._bgm.pause();
    } catch { /* noop */ }
  }

  move(): void { this.beep(480, 0.06); }
  select(): void { this.beep(660, 0.04, 'sine', 0.08); }
  capture(): void {
    this.beep(220, 0.1, 'square', 0.12);
    setTimeout(() => this.beep(520, 0.08), 70);
  }
  bad(): void { this.beep(180, 0.08, 'square', 0.08); }
  check(): void { this.beep(880, 0.12, 'sawtooth', 0.1); }
  win(): void {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.beep(f, 0.15), i * 140));
  }
  lose(): void {
    this.beep(392, 0.15);
    setTimeout(() => this.beep(330, 0.25), 160);
  }
  hint(): void { this.beep(880, 0.08, 'sine', 0.12); }
  undo(): void { this.beep(300, 0.06); }
}
