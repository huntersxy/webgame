/* ────────────────────────────────────────────────────────────
 *  controllers/campaign-controller.ts — Gomoku campaign controller
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer, Pt } from '../types';
import { createBoard, cloneBoard, checkWin, isBoardFull, other, inBounds, BOARD_SIZE } from '../gomoku/rules';
import { LEVELS, loadProgress, saveProgress, firstPlayable, campaignSearch, type CampaignLevel, type CampaignSearchResult } from '../campaign/engine';
import { AudioEngine } from '../ui/audio';
import { renderGomoku, pxToCellGomoku, GOMOKU_CANVAS_SIZE, type GomokuRenderState } from '../ui/gomoku-renderer';
import { appendLog, setStats, toggleProgress } from '../ui/format';

interface CampHistoryEntry { x: number; y: number; c: GomokuPlayer; }

export class CampaignController {
  private canvas: HTMLCanvasElement;
  private audio: AudioEngine;

  private board: GomokuBoard = createBoard();
  private hist: CampHistoryEntry[] = [];
  private turn: GomokuPlayer = 1;
  private over = false;
  private winLine: Pt[] | null = null;
  private thinking = false;
  private level = 0;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  private _down: { x: number; y: number } | null = null;
  private hover: Pt | null = null;

  constructor(canvas: HTMLCanvasElement, audio: AudioEngine) {
    this.canvas = canvas;
    this.audio = audio;
    this.wireEvents();
    this.startLevel(firstPlayable());
  }

  private get currentLevel(): CampaignLevel {
    return LEVELS[this.level] ?? LEVELS[0];
  }

  private get state(): GomokuRenderState {
    return {
      board: this.board,
      history: this.hist,
      turn: this.turn,
      over: this.over,
      winLine: this.winLine,
      hover: this.hover,
      hint: null,
      viz: false,
      thinkCandidates: [],
      god: false,
      godMove: null,
      godThinking: false,
      human: 1,
    };
  }

  redraw(): void { renderGomoku(this.canvas, this.state); }

  startLevel(id: number): void {
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    const lv = LEVELS[id];
    if (!lv || lv.locked) return;
    this.level = id;
    this.board = createBoard();
    this.hist = [];
    this.turn = 1;
    this.over = false;
    this.winLine = null;
    this.hover = null;
    this.thinking = false;
    this.hideBanner();
    setStats(document.getElementById('camp-stats'), `⚔️ 对阵 <b>${lv.emoji} ${lv.name}</b> · 你执黑先手 · depth${lv.depth}`);
    appendLog(document.getElementById('camp-log'), `🏰 关卡 ${id + 1}：<b>${lv.name}</b> —— ${lv.title}。${lv.desc}`);
    this.renderLevels();
    this.updateTurn();
    this.redraw();
  }

  newGame(): void { this.startLevel(this.level); }

  private place(x: number, y: number): boolean {
    if (this.over || this.thinking) return false;
    if (!this.board || !inBounds(x, y) || this.board[y][x] !== 0) return false;
    this.board[y][x] = this.turn;
    this.hist.push({ x, y, c: this.turn });
    this.audio.move();
    const w = checkWin(this.board, x, y);
    if (w) { this.endGame(this.turn, w); return true; }
    if (isBoardFull(this.board)) { this.endGame(0, null); return true; }
    this.turn = other(this.turn);
    this.updateTurn();
    this.redraw();
    if (!this.over && this.turn === 2) this.aiMove();
    return true;
  }

  private aiMove(): void {
    this.thinking = true;
    toggleProgress(document.getElementById('camp-thinking'), true);
    setStats(document.getElementById('camp-stats'), `⏳ <b>${this.currentLevel.name}</b> 布防中…`);
    this.aiTimer = setTimeout(() => {
      const r = campaignSearch(cloneBoard(this.board), this.currentLevel);
      this.thinking = false;
      toggleProgress(document.getElementById('camp-thinking'), false);
      const ai: GomokuPlayer = 2;
      if (r.move) {
        this.board[r.move.y][r.move.x] = ai;
        this.hist.push({ x: r.move.x, y: r.move.y, c: ai });
        this.audio.move();
        const w = checkWin(this.board, r.move.x, r.move.y);
        const who = this.currentLevel.name;
        if (r.instant) {
          setStats(document.getElementById('camp-stats'), `⚡ <b>${who}</b> 秒断你的杀棋 (${r.move.x},${r.move.y}) · 免搜索`);
          appendLog(document.getElementById('camp-log'), `⚡ <b>秒断杀棋</b> → (${r.move.x},${r.move.y})`);
        } else {
          setStats(document.getElementById('camp-stats'), `✅ <b>${who}</b> · depth${r.depth} · 节点 <b>${r.nodes.toLocaleString()}</b> · ${r.ms}ms · 评估 <b>${r.eval}</b> · 落子 (${r.move.x},${r.move.y})`);
          appendLog(document.getElementById('camp-log'), `🧠 depth<b>${r.depth}</b> · 节点${r.nodes.toLocaleString()} · ${r.ms}ms · 评估${r.eval} · 选 <b>(${r.move.x},${r.move.y})</b>`);
        }
        if (w) { this.endGame(ai, w); }
        else if (isBoardFull(this.board)) { this.endGame(0, null); }
        else { this.turn = 1; this.updateTurn(); this.redraw(); }
      }
    }, 120);
  }

  undo(): void {
    if (this.thinking || this.over) return;
    if (this.hist.length === 0) return;
    const last = this.hist.pop()!;
    this.board[last.y][last.x] = 0;
    if (this.hist.length && this.hist[this.hist.length - 1].c === 2) {
      const p = this.hist.pop()!;
      this.board[p.y][p.x] = 0;
    }
    this.turn = 1;
    this.over = false;
    this.winLine = null;
    this.hideBanner();
    this.redraw();
    this.updateTurn();
    this.audio.undo();
  }

  private endGame(winner: GomokuPlayer | 0, line: Pt[] | null): void {
    this.over = true;
    this.winLine = line;
    const lv = this.currentLevel;
    if (winner === 1) {
      const cleared = Math.max(loadProgress(), this.level + 1);
      saveProgress(cleared);
      this.showBanner(`🏆 <b>破防成功！通关「${lv.emoji} ${lv.name}」</b>`);
      setStats(document.getElementById('camp-stats'), `🏆 你击败了 <b>${lv.name}</b> · 已通关 ${cleared}/${LEVELS.length}`);
      appendLog(document.getElementById('camp-log'), `🏆 <b>通关！</b>${lv.name} 的防线被击破`);
      this.audio.win();
      this.renderLevels();
    } else if (winner === 2) {
      this.showBanner(`🏰 <b>被「${lv.name}」挡住了…</b><br>它封死了你所有进攻线路，再想想怎么破防`);
      setStats(document.getElementById('camp-stats'), `💀 你的攻势被 <b>${lv.name}</b> 全部拦截`);
      appendLog(document.getElementById('camp-log'), `💀 <b>落败</b> —— ${lv.name} 的城墙没有缺口`);
      this.audio.lose();
    } else {
      this.showBanner(`🤝 <b>棋盘满了，和棋</b>`);
    }
    this.redraw();
    this.updateTurn();
  }

  // ── UI ──
  private updateTurn(): void {
    const el = document.getElementById('camp-turn');
    if (el) el.textContent = this.over ? '对局结束' : `轮到 ${this.turn === 1 ? '黑方(你)' : '白方(AI)'} 落子`;
  }

  private showBanner(html: string): void {
    const el = document.getElementById('camp-result');
    if (el) { el.innerHTML = html; el.classList.toggle('hidden', !html); }
  }

  private hideBanner(): void { this.showBanner(''); }

  private renderLevels(): void {
    const el = document.getElementById('camp-list');
    if (!el) return;
    const cleared = loadProgress();
    el.innerHTML = '';
    LEVELS.forEach((lv, i) => {
      const done = i < cleared;
      const cur = i === cleared && !lv.locked;
      const locked = lv.locked;
      const btn = document.createElement('button');
      btn.className = 'camp-card' + (cur ? ' current' : '') + (done ? ' done' : '') + (locked ? ' locked' : '');
      btn.innerHTML = `<span class="n">${i + 1}</span><span class="t"><b>${lv.emoji} ${lv.name}</b><small>${lv.locked ? '未解锁' : '风格：' + (lv.title || lv.name)}</small></span><span class="st">${done ? '✅' : (cur ? '▶' : '🔒')}</span>`;
      if (!lv.locked) btn.addEventListener('click', () => this.startLevel(i));
      el.appendChild(btn);
    });
    const pt = document.getElementById('camp-progress-text');
    if (pt) pt.textContent = `已通关 ${cleared} / ${LEVELS.length}`;
    const pb = document.getElementById('camp-progress-bar');
    if (pb) pb.style.width = (cleared / LEVELS.length * 100) + '%';
    this.updateAICard();
  }

  private updateAICard(): void {
    const lv = this.currentLevel;
    const card = document.getElementById('camp-ai-card');
    if (!card) return;
    if (lv.locked) {
      card.innerHTML = `<div class="camp-ai-head"><span class="camp-ai-emoji">🔒</span><div><b>未解锁</b><small>击败上一关解锁</small></div></div>`;
      return;
    }
    const emojiEl = card.querySelector('.camp-ai-emoji');
    if (emojiEl) emojiEl.textContent = lv.emoji;
    const nameEl = document.getElementById('camp-ai-name');
    if (nameEl) nameEl.textContent = lv.name;
    const styleEl = document.getElementById('camp-ai-style');
    if (styleEl) styleEl.textContent = lv.title || lv.name;
    const descEl = document.getElementById('camp-ai-desc');
    if (descEl) descEl.textContent = lv.desc;
    const tags = document.getElementById('camp-ai-tags');
    if (tags) tags.innerHTML = lv.tags.map((t) => `<span>${t}</span>`).join('');
  }

  private wireEvents(): void {
    // Hover ghost — matches the regular Gomoku game (mouse only).
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const c = pxToCellGomoku(this.canvas, e);
      if (JSON.stringify(c) !== JSON.stringify(this.hover)) { this.hover = c; this.redraw(); }
    });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.redraw(); });
    this.canvas.addEventListener('pointerdown', (e) => { this._down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => {
      const isTap = this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) < 12;
      this._down = null;
      if (!isTap) return;
      const c = pxToCellGomoku(this.canvas, e);
      if (!c) return;
      this.place(c.x, c.y);
    });
    this.canvas.addEventListener('pointercancel', () => { this._down = null; });
    document.getElementById('camp-new')?.addEventListener('click', () => this.newGame());
    document.getElementById('camp-undo')?.addEventListener('click', () => this.undo());
  }
}
