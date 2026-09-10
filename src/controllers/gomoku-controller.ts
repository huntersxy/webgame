/* ────────────────────────────────────────────────────────────
 *  controllers/gomoku-controller.ts — Gomoku game controller
 *  Coordinates board state, AI bridge, rendering, and UI panel.
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer, Difficulty, GameMode, Pt, GomokuMove, SearchResult } from '../types';
import { createBoard, cloneBoard, checkWin, isBoardFull, other, inBounds } from '../gomoku/rules';
import { evaluateBoard } from '../gomoku/eval';
import { LEVEL_CONFIG, resetGomokuWarmDepth } from '../gomoku/search';
import { AIBridge } from '../ai/ai-bridge';
import { AudioEngine } from '../ui/audio';
import { Stats } from '../ui/stats';
import { renderGomoku, pxToCellGomoku, gomokuScorePercent, type GomokuRenderState } from '../ui/gomoku-renderer';
import { appendLog, setStats, toggleProgress, fmtEval } from '../ui/format';
import { applyDemonTheme } from '../ui/demon';
import { checkLesson, detectWinningOpening, recordLoss, lessonCount, getLosses } from '../gomoku/learn';

interface HistoryEntry { x: number; y: number; c: GomokuPlayer; }

export class GomokuController {
  private canvas: HTMLCanvasElement;
  private ai: AIBridge;
  private audio: AudioEngine;

  private board: GomokuBoard = createBoard();
  private history: HistoryEntry[] = [];
  private turn: GomokuPlayer = 1;
  private over = false;
  private winLine: Pt[] | null = null;
  private mode: GameMode = 'ai';
  private human: GomokuPlayer = 1;
  private level: Difficulty = 2;
  private hover: Pt | null = null;
  private hintPos: Pt | null = null;
  private thinking = false;
  private viz = false; // 候选点默认不显示，想要的人自己勾
  private thinkCandidates: Array<GomokuMove & { v: number; rank?: number }> = [];
  private god = false;
  private godMove: GomokuMove | null = null;
  private godThinking = false;
  private _aiTimer: ReturnType<typeof setTimeout> | null = null;
  private _godTimer: ReturnType<typeof setInterval> | null = null;
  private _haltAivai = false;
  private _animFrame: number | null = null;
  private _down: { x: number; y: number } | null = null;
  private _openingWarned = false;
  /** 搜索代次：每次重置局面 +1，用于作废「重置前发出、重置后才返回」的旧结果 */
  private _searchSeq = 0;
  private _engineLogged = false;
  private _warmed = false;
  private _warming = false;
  private _loadShowTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次加载进度文案：加载期间 AI 落子后会把它恢复回顶栏，别被「AI 思考中」顶掉 */
  private _loadText = '🧩 Rapfi 引擎预热中…';

  constructor(canvas: HTMLCanvasElement, ai: AIBridge, audio: AudioEngine) {
    this.canvas = canvas;
    this.ai = ai;
    this.audio = audio;
    this.wireEvents();
    this.newGame();
    this.startAnimLoop();
  }

  private get state(): GomokuRenderState {
    return {
      board: this.board,
      history: this.history,
      turn: this.turn,
      over: this.over,
      winLine: this.winLine,
      hover: this.hover,
      hint: this.hintPos,
      viz: this.viz,
      thinkCandidates: this.thinkCandidates,
      god: this.god,
      godMove: this.godMove,
      godThinking: this.godThinking,
      human: this.human,
    };
  }

  private startAnimLoop(): void {
    const loop = () => {
      // Only redraw if there's animated content (god mode, candidates, hint)
      if (this.god || this.hintPos || (this.viz && this.thinkCandidates.length > 0 && !this.over)) {
        this.redraw();
      }
      this._animFrame = requestAnimationFrame(loop);
    };
    this._animFrame = requestAnimationFrame(loop);
  }

  redraw(): void { renderGomoku(this.canvas, this.state); }

  newGame(): void {
    resetGomokuWarmDepth(); // new game → drop any warm-start adaptive depth
    this._searchSeq++; // 在途搜索的结果作废（clearTimeout 拦不住已经 await 出去的那次）
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
    if (this._godTimer) { clearInterval(this._godTimer); this._godTimer = null; }
    this.board = createBoard();
    this.history = [];
    this.turn = 1;
    this.over = false;
    this.winLine = null;
    this.hintPos = null;
    this.thinking = false;
    this.thinkCandidates = [];
    this.godMove = null;
    this.godThinking = false;
    this._haltAivai = false;
    this._openingWarned = false;
    this.hideResult();
    this.updatePanel();
    this.redraw();
    const cfg = LEVEL_CONFIG[this.level];
    const modeName = this.mode === 'aivai' ? '🤖AI互搏观战' : (this.mode === 'pvp' ? '双人对战' : '人机对战');
    setStats(document.getElementById('g-think-stats'), `新对局 · ${modeName} · 难度 <b>${cfg.name}</b> · 等待行棋…`);
    if (this.god) this.startGodTimer();
    if (this.mode === 'ai' && this.human === 2) this.aiMove();
    else if (this.mode === 'aivai') this.aiMove();
    else this.refreshGod();
  }

  /** 兜底：从给定点向外找第一个空点（引擎返回非法着法时用；棋盘满则返回 null） */
  private firstEmptyNear(x: number, y: number): GomokuMove | null {
    for (let r = 0; r <= 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (inBounds(nx, ny) && this.board[ny][nx] === 0) return { x: nx, y: ny, v: 0 };
        }
      }
    }
    return null;
  }

  private place(x: number, y: number): boolean {
    if (this.over || this.thinking) return false;
    if (this.mode === 'aivai') return false;
    if (!inBounds(x, y) || this.board[y][x] !== 0) return false;
    this.board[y][x] = this.turn;
    this.history.push({ x, y, c: this.turn });
    this.hintPos = null;
    this.godMove = null;
    this.audio.move();
    this.checkWinningOpening();
    const w = checkWin(this.board, x, y);
    if (w) { this.over = true; this.winLine = w; this.onGameEnd(this.turn); }
    else if (isBoardFull(this.board)) { this.over = true; this.onGameEnd(0); }
    else { this.turn = other(this.turn); }
    this.updatePanel();
    this.redraw();
    if (!this.over && this.mode === 'ai' && this.turn !== this.human) this.aiMove();
    else this.refreshGod();
    return true;
  }

  private async aiMove(): Promise<void> {
    this.thinking = true;
    this.showThinking(true);
    toggleProgress(document.getElementById('g-think-progress'), true);
    const cfg = LEVEL_CONFIG[this.level];
    this.setGlobalStatus(`AI 思考中…(${cfg.name})`);
    this.redraw();
    setStats(document.getElementById('g-think-stats'), `⏳ <b>${cfg.name}</b> 运算中… 正在展开候选…`);
    const delay = this.level === 4 ? 60 : (this.level === 3 ? 40 : 20);
    const seq = ++this._searchSeq;
    this._aiTimer = setTimeout(async () => {
      const aiPlayer = this.turn;
      const lesson = this.level === 4 ? checkLesson(cloneBoard(this.board)) : null;
      // Rapfi 引擎按落子顺序重摆棋盘，必须把棋谱一并传过去（只给 2D 棋盘
      // 无法还原顺序，引擎会因奇偶失配静默放弃摆盘——曾表现为不拦横线）。
      const moves = this.history.map((h) => ({ x: h.x, y: h.y, c: h.c }));
      const res = await this.ai.searchGomoku(cloneBoard(this.board), aiPlayer, this.level, this.mode, moves.length, moves);
      // 这段 await 期间局面可能已被重置（新开局 / 换执子 / 换模式都会走 newGame）。
      // 不作校验的话，为旧局面算出的着法会落到新棋盘上——甚至直接盖掉玩家
      // 刚落下的子（表现为「AI 下在我的棋子上」）。
      if (seq !== this._searchSeq) return;
      let m = res.move;
      // Demon memory: if this exact position was lost before and the search
      // wants to repeat the losing move, pick the next-best scored candidate.
      if (lesson && m && m.x === lesson.x && m.y === lesson.y) {
        const alt = (res.scores || []).find((s) => s.x !== lesson.x || s.y !== lesson.y);
        if (alt) {
          appendLog(document.getElementById('g-think-log'), `📖 <b>恶魔记忆</b>：此局面前次走 (${lesson.x},${lesson.y}) 落败（第${lesson.count}次教训）→ 改走 <b>(${alt.x},${alt.y})</b>`);
          m = alt;
        }
      }
      // 兜底：引擎若返回越界或已占用的点，绝不覆盖盘上已有的棋子
      if (m && (!inBounds(m.x, m.y) || this.board[m.y][m.x] !== 0)) {
        const alt = (res.scores || []).find((s) => inBounds(s.x, s.y) && this.board[s.y][s.x] === 0);
        const fix = alt ?? this.firstEmptyNear(m.x, m.y);
        appendLog(document.getElementById('g-think-log'),
          `⚠️ 引擎返回非法落点 (${m.x},${m.y})，已改用 ${fix ? `(${fix.x},${fix.y})` : '无可用空点'}`);
        m = fix ?? null;
      }
      this.thinkCandidates = (res.scores || []).map((s, i) => ({ ...s, rank: i + 1 }));
      this.thinking = false;
      this.showThinking(false);
      toggleProgress(document.getElementById('g-think-progress'), false);

      const who = aiPlayer === 1 ? '黑' : '白';
      const engineName = res.engine === 'rapfi-multi' ? '🧩Rapfi·多线程' : res.engine === 'rapfi-single' ? '🧩Rapfi·单线程' : res.engine === 'js' ? '内置引擎' : '';
      if ((res.engine === 'rapfi-multi' || res.engine === 'rapfi-single') && !this._engineLogged) {
        this._engineLogged = true;
        appendLog(document.getElementById('g-think-log'), `🧩 <b>Rapfi WASM 引擎已接入</b>（${res.engine === 'rapfi-multi' ? '多线程构建' : '单线程构建 · 服务器未启用 COOP/COEP 时自动降级'}）`);
      }
      if (res.opening) {
        setStats(document.getElementById('g-think-stats'), `⚡ <b>${who}</b> 开局速答 (${m?.x},${m?.y})${engineName ? ' · ' + engineName : ''}`);
        appendLog(document.getElementById('g-think-log'), `⚡ 开局速答 [${who}] → (${m?.x},${m?.y})${engineName ? ` · ${engineName}` : ''}（开局谱固定应手，未启动搜索）`);
      } else if (res.instant) {
        setStats(document.getElementById('g-think-stats'), `⚡ <b>${who}·${cfg.name}</b> 秒断胜负手 (${m?.x},${m?.y}) · 直接成五/堵五${engineName ? ' · ' + engineName : ''}`);
        appendLog(document.getElementById('g-think-log'), `⚡ <b>即时胜负手</b> [${who}] → (${m?.x},${m?.y}) · depth${res.depth}免搜索`);
      } else {
        const top = (res.scores || []).slice(0, 5).map((s, i) => `#${i + 1}(${s.x},${s.y}):${s.v > 99999 ? '胜' : s.v}`).join(' ');
        const ev = fmtEval(res.eval, 100000);
        // 引擎还在加载时本手走了内置 JS 引擎，说明一下，免得看起来像引擎坏了
        const pending = res.engine === 'js' && this._warming
          ? ' <span style="color:#d69a2e">· 引擎加载中，本手先用内置引擎</span>' : '';
        const boost = res.boosted ? ` <span style="color:#ff6b6b">·劣势加深→depth${res.depth}</span>` : '';
        setStats(document.getElementById('g-think-stats'), `✅ <b>${who}·${cfg.name}</b>${engineName ? `〔${engineName}〕` : ''} depth${res.depth} · 节点 <b>${res.nodes.toLocaleString()}</b> · ${res.ms}ms · 评估 <b>${ev}</b> · 选 (${m?.x},${m?.y})${boost}${pending}`);
        appendLog(document.getElementById('g-think-log'), `🧠${engineName ? `<b>${engineName}</b>·` : ''} depth<b>${res.depth}</b> · 节点${res.nodes.toLocaleString()} · ${res.ms}ms · 评估${ev} · 选<b>(${m?.x},${m?.y})</b>${res.boosted ? ' · <span style="color:#ff6b6b">劣势加深</span>' : ''}${pending}<br><span class="cand">${top}</span>`);
      }

      if (m) {
        this.board[m.y][m.x] = aiPlayer;
        this.history.push({ x: m.x, y: m.y, c: aiPlayer });
        this.hintPos = null;
        this.godMove = null;
        this.audio.move();
        const w = checkWin(this.board, m.x, m.y);
        if (w) { this.over = true; this.winLine = w; this.onGameEnd(aiPlayer); }
        else if (isBoardFull(this.board)) { this.over = true; this.onGameEnd(0); }
        else { this.turn = other(aiPlayer); }
      }
      this.updatePanel();
      this.redraw();
      this.setGlobalStatus(this._warming ? this._loadText : 'AI 就绪');
      if (!this.over && this.mode === 'aivai' && !this._haltAivai) {
        this._aiTimer = setTimeout(() => this.aiMove(), 10);
      } else {
        this.refreshGod();
      }
    }, delay);
  }

  stopAivai(): void {
    this._haltAivai = true;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
    if (!this.over) appendLog(document.getElementById('g-think-log'), '⏹ <b>已停止AI互搏</b>，可悔棋/新开一局');
    this.updatePanel();
    this.setGlobalStatus('AI 就绪');
  }

  private stopAivaiSilent(): void {
    this._haltAivai = true;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
  }

  undo(): void {
    if (this.thinking) return;
    if (!this.history.length) return;
    if (this.mode === 'ai') {
      const target = this.human;
      do {
        const h = this.history.pop();
        if (!h) break;
        this.board[h.y][h.x] = 0;
        this.turn = this.history.length % 2 === 0 ? 1 : 2;
        if (this.history.length === 0) { this.turn = 1; break; }
      } while (this.turn !== target && this.history.length > 0);
    } else {
      const h = this.history.pop()!;
      this.board[h.y][h.x] = 0;
      this.turn = h.c;
    }
    this.over = false;
    this.winLine = null;
    this.thinkCandidates = [];
    this.godMove = null;
    this.hintPos = null;
    this.hideResult();
    this.updatePanel();
    this.redraw();
    this.audio.undo();
    if (this.mode === 'aivai') { this.stopAivaiSilent(); this.refreshGod(); return; }
    if (this.mode === 'ai' && !this.over && this.turn !== this.human) this.aiMove();
    else this.refreshGod();
  }

  async showHint(): Promise<void> {
    if (this.over || this.thinking || this.godThinking) return;
    setStats(document.getElementById('g-think-stats'), '👉 恶魔正在附体算招… depth4全开，请稍候');
    setTimeout(async () => {
      const moves = this.history.map((h) => ({ x: h.x, y: h.y, c: h.c }));
      const res = await this.ai.hintGomoku(cloneBoard(this.board), this.turn, this.mode, moves.length, moves);
      const m = res.move;
      if (m) {
        const engineName = res.engine === 'rapfi-multi' ? '🧩Rapfi·多线程' : res.engine === 'rapfi-single' ? '🧩Rapfi·单线程' : res.engine === 'js' ? '内置引擎' : '';
        this.thinkCandidates = (res.scores || []).map((s, i) => ({ ...s, rank: i + 1 }));
        appendLog(document.getElementById('g-think-log'), `💡 <b>恶魔支招</b>${engineName ? `〔${engineName}〕` : ''} depth${res.depth} · 推荐<b>(${m.x},${m.y})</b> · 评估${fmtEval(res.eval, 100000)} · 节点${res.nodes.toLocaleString()} · ${res.ms}ms`);
        setStats(document.getElementById('g-think-stats'), `💡 恶魔支招 depth${res.depth} · 推荐 (${m.x},${m.y}) · 节点${res.nodes.toLocaleString()} · ${res.ms}ms${engineName ? ' · ' + engineName : ''}`);
        this.hintPos = { x: m.x, y: m.y };
        this.redraw();
        this.audio.hint();
        setTimeout(() => { this.hintPos = null; this.redraw(); }, 4000);
      }
    }, 30);
  }

  toggleGod(): void {
    this.god = !this.god;
    const btn = document.getElementById('g-god');
    if (btn) { btn.classList.toggle('on', this.god); btn.textContent = this.god ? '🛌 送神离开' : '🙏 请神上身'; }
    if (this.god) {
      appendLog(document.getElementById('g-think-log'), '🙏 <b>恶魔附体！请神上身成功</b>，每手都将用 depth4 给你指 👇 最佳点');
      this.startGodTimer();
      this.refreshGod();
    } else {
      this.godMove = null;
      this.godThinking = false;
      if (this._godTimer) { clearInterval(this._godTimer); this._godTimer = null; }
      appendLog(document.getElementById('g-think-log'), '🛌 已送神，神指消失');
      this.redraw();
    }
  }

  private startGodTimer(): void {
    if (this._godTimer) return;
    this._godTimer = setInterval(() => { if (this.god && this.godMove && !this.over) this.redraw(); }, 550);
  }

  private refreshGod(): void {
    if (!this.god || this.over || this.thinking || this.godThinking) return;
    if (this.mode === 'aivai' && !this._haltAivai) return;
    this.godThinking = true;
    setTimeout(async () => {
      try {
        const moves = this.history.map((h) => ({ x: h.x, y: h.y, c: h.c }));
        const res = await this.ai.hintGomoku(cloneBoard(this.board), this.turn, this.mode, moves.length, moves);
        this.godMove = res.move;
        this.redraw();
      } finally { this.godThinking = false; }
    }, 40);
  }

  private onGameEnd(winner: GomokuPlayer | 0): void {
    const banner = document.getElementById('gomoku-result');
    banner?.classList.remove('hidden');
    if (this._godTimer) { clearInterval(this._godTimer); this._godTimer = null; }
    if (winner === 0) { if (banner) banner.textContent = '🤝 和棋！棋盘已满，旗鼓相当。'; this.audio.win(); Stats.add(false); }
    else if (this.mode === 'aivai') { if (banner) banner.textContent = `🤖 互搏结束！${winner === 1 ? '黑方AI' : '白方AI'} 五连获胜！`; this.audio.win(); }
    else if (this.mode === 'ai' && winner === this.human) {
      // ── Demon lost to the human: record, review & warn ──
      const opening = detectWinningOpening(this.history, this.human);
      const { losses, lessons } = recordLoss(this.history, this.human, this.level, opening?.name ?? null);
      const log = document.getElementById('g-think-log');
      if (opening) {
        if (banner) banner.textContent = `⚠️ 你用了「${opening.name}」黑棋必胜开局！恶魔已记录这次惨败并开始学习。`;
        appendLog(log, `📉 <b>恶魔败北并复盘</b>：检测到人类使用 <b>「${opening.name}」${opening.exact ? '必胜定式' : '必胜起手式'}</b>。已存入败局档案 #${losses}，从 ${lessons} 条教训中学习——下次会避开相同应对。`);
      } else {
        if (banner) banner.textContent = '🎉 恭喜！你击败了 AI！';
        appendLog(log, `📉 <b>恶魔败北并复盘</b>：已记录败局 #${losses}（${this.history.length} 手），习得教训共 ${lessons} 条，下次遇到相似局面将避开败手。`);
      }
      this.audio.lose(); Stats.add(true);
    }
    else if (this.mode === 'ai') { if (banner) banner.textContent = '🤖 AI 获胜，再接再厉！点「🔄 新开一局」再来。'; this.audio.lose(); Stats.add(false); }
    else { if (banner) banner.textContent = `🏆 ${winner === 1 ? '黑方' : '白方'} 五连获胜！`; this.audio.win(); Stats.add(true); }
  }

  /** Warn once per game when the human (playing black) opens with a known
   *  black-winning opening — even if the demon ends up winning anyway. */
  private checkWinningOpening(): void {
    if (this._openingWarned || this.mode !== 'ai') return;
    const op = detectWinningOpening(this.history, this.human);
    if (!op) return;
    this._openingWarned = true;
    appendLog(document.getElementById('g-think-log'), `⚠️ <b>人类正在使用「${op.name}」${op.exact ? '必胜定式' : '必胜起手式'}</b>（黑棋先手必胜）！恶魔已进入戒备与学习模式。`);
    setStats(document.getElementById('g-think-stats'), `⚠️ 检测到黑棋必胜开局「${op.name}」 — 恶魔加强戒备`);
  }

  // ── UI helpers ──
  private updatePanel(): void {
    const modeTag = this.mode === 'aivai' ? '🤖互搏' : (this.thinking ? 'AI 思考中…' : (this.godThinking ? '👇神算中…' : '对弈中'));
    const turnEl = document.getElementById('gomoku-turn');
    if (turnEl) turnEl.textContent = this.over ? '对局结束' : `轮到 ${this.turn === 1 ? '黑方' : '白方'} 落子${this.mode === 'aivai' ? ' · AI互搏中' : ''}${this.god ? ' · 神附体👇' : ''}`;
    const stepsEl = document.getElementById('g-steps');
    if (stepsEl) stepsEl.textContent = String(this.history.length);
    const statusEl = document.getElementById('g-status');
    if (statusEl) statusEl.textContent = this.over ? '已结束' : modeTag;
    const pct = gomokuScorePercent(this.board, this.human);
    const barEl = document.getElementById('g-score-bar');
    if (barEl) barEl.style.width = pct + '%';
    const v = evaluateBoard(this.board, this.human);
    const scoreText = document.getElementById('g-score-text');
    if (scoreText) scoreText.textContent = v > 1500 ? '我方大优' : v > 400 ? '我方稍优' : v < -1500 ? 'AI 大优' : v < -400 ? 'AI 稍优' : '均势';
  }

  private showThinking(on: boolean): void { document.getElementById('gomoku-thinking')?.classList.toggle('hidden', !on); }

  /**
   * 预热 Rapfi 引擎。进入五子棋页面时调用：首次需下载 wasm + NNUE 权重
   * （约 11MB），提前加载可以让玩家落下首子后立刻看到 AI 应手，而不是
   * 卡在「AI 思考中」等下载。开局两手的应手本来就不经过引擎。
   */
  warmUp(): void {
    if (this._warmed || this._warming) return;
    this._warming = true;
    // 加载很快（已缓存）时不闪这一下，超过 300ms 才显示
    this._loadShowTimer = setTimeout(() => this.showEngineLoad(true), 300);
    this.setEngineLoad(0, 0, '引擎加载中…');
    this.setGlobalStatus('🧩 Rapfi 引擎预热中…');
    void this.ai.warmUpGomoku((loaded, total, src) => {
      const mb = (n: number) => (n / 1048576).toFixed(1);
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      this.setEngineLoad(pct, loaded, `引擎加载中… ${mb(loaded)}/${mb(total)} MB`);
      if (src === 'prefetch' && total) {
        this._loadText = `🧩 Rapfi 引擎预热中… ${pct}%（${mb(loaded)}/${mb(total)} MB）`;
        this.setGlobalStatus(this._loadText);
      }
    }).then(({ ok, variant }) => {
      this._warming = false;
      this._warmed = ok;
      if (this._loadShowTimer !== null) { clearTimeout(this._loadShowTimer); this._loadShowTimer = null; }
      this.showEngineLoad(false);
      if (ok) {
        this.setGlobalStatus('AI 就绪');
        appendLog(document.getElementById('g-think-log'),
          `🧩 <b>Rapfi 引擎已预加载</b>（${variant === 'multi' ? '多线程构建' : '单线程构建'}）· 落子无需等待`);
        this._engineLogged = true; // 避免首次搜索时重复播报
      } else {
        this.setGlobalStatus('AI 就绪（内置引擎）');
      }
    });
  }

  /** 引擎加载进度条：只在画布可见时才有意义，收起来时就清掉百分比 */
  private setEngineLoad(pct: number, loaded: number, text: string): void {
    const bar = document.getElementById('g-engine-bar');
    const pctEl = document.getElementById('g-engine-pct');
    const stateEl = document.getElementById('g-engine-state');
    if (bar) bar.style.width = `${pct}%`;
    if (stateEl) stateEl.textContent = text;
    if (pctEl) pctEl.textContent = loaded ? `${pct}%` : '';
  }

  private showEngineLoad(on: boolean): void {
    document.getElementById('gomoku-engine-load')?.classList.toggle('hidden', !on);
    if (on) this.setEngineLoad(0, 0, '引擎加载中…');
  }

  private hideResult(): void { document.getElementById('gomoku-result')?.classList.add('hidden'); }
  private setGlobalStatus(t: string): void { (window as any).setGlobalStatus?.(t); }

  // ── Event wiring ──
  private wireEvents(): void {
    // Pointer events handle both mouse & touch uniformly (mobile-first).
    // hover is only applied on fine pointers; touch clears it to avoid stuck highlights.
    this.canvas.addEventListener('pointerdown', (e) => {
      this._down = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const c = pxToCellGomoku(this.canvas, e);
      if (JSON.stringify(c) !== JSON.stringify(this.hover)) { this.hover = c; this.redraw(); }
    });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.redraw(); });
    this.canvas.addEventListener('pointerup', (e) => {
      // Only treat as a move if it's a clean tap (little drag) — avoids
      // accidental placement while the user scrolls/pans on mobile.
      const isTap = this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) < 12;
      this._down = null;
      const c = pxToCellGomoku(this.canvas, e);
      this.hover = null;
      if (!isTap || !c) { this.redraw(); return; }
      if (this.mode === 'aivai') return;
      if (this.mode === 'ai' && this.turn !== this.human) return;
      this.place(c.x, c.y);
    });
    this.canvas.addEventListener('pointercancel', () => { this._down = null; this.hover = null; this.redraw(); });

    // Segmented controls
    this.segWire('g-mode', (v) => { this.mode = v as GameMode; if (v === 'aivai') appendLog(document.getElementById('g-think-log'), '🤖 <b>AI互搏观战开始</b>，双方都用当前难度恶战到底'); this.newGame(); });
    this.segWire('g-color', (v) => { this.human = +v as GomokuPlayer; this.newGame(); });
    this.segWire('g-level', (v) => {
      this.level = +v as Difficulty;
      applyDemonTheme('g', this.level, this.audio);
      const cfg = LEVEL_CONFIG[this.level];
      setStats(document.getElementById('g-think-stats'), `难度切换 → <b>${cfg.name}</b> · 棋力档 ${cfg.depth <= 2 ? '低' : cfg.depth >= 30 ? '满' : '中'}`);
      appendLog(document.getElementById('g-think-log'), `⚙️ 难度切换 → <b>${cfg.name}</b>${this.level === 4 ? ' · <span style="color:#ff6b6b">恶魔全开，不留情面</span>' : ''}`);
      this.updatePanel();
    });

    const gv = document.getElementById('g-viz') as HTMLInputElement | null;
    gv?.addEventListener('change', (e) => { this.viz = (e.target as HTMLInputElement).checked; this.redraw(); });

    document.getElementById('g-new')?.addEventListener('click', () => this.newGame());
    document.getElementById('g-undo')?.addEventListener('click', () => this.undo());
    document.getElementById('g-hint')?.addEventListener('click', () => this.showHint());
    document.getElementById('g-god')?.addEventListener('click', () => this.toggleGod());
    document.getElementById('g-demon-memory')?.addEventListener('click', () => this.openDemonMemory());
    document.getElementById('g-stop')?.addEventListener('click', () => this.stopAivai());
    document.getElementById('g-sound')?.addEventListener('click', (e) => {
      this.audio.enabled = !this.audio.enabled;
      const btn = e.target as HTMLButtonElement;
      btn.textContent = this.audio.enabled ? '🔊 音效开' : '🔇 音效关';
      btn.classList.toggle('on', this.audio.enabled);
      // Keep demon BGM in sync with the sound toggle.
      if (this.level === 4) { if (this.audio.enabled) this.audio.startBGM(); else this.audio.stopBGM(); }
    });
  }

  /** Open the demon defeat-archive panel (五子棋). */
  private openDemonMemory(): void {
    const modal = document.getElementById('demon-memory-modal');
    const stats = document.getElementById('demon-memory-stats');
    const list = document.getElementById('demon-memory-list');
    if (!modal || !stats || !list) return;

    const losses = getLosses();
    const lessons = lessonCount();
    stats.innerHTML = lessons > 0
      ? `<span class="pill">📖 已学教训 <b>${lessons}</b> 条</span><span class="pill">📉 败局 <b>${losses.length}</b> 局</span>`
      : `<span class="pill">📉 败局 <b>${losses.length}</b> 局 · 尚无教训（先输一局让恶魔复盘）</span>`;

    if (losses.length === 0) {
      list.innerHTML = `<div class="memory-empty">🤖 恶魔从未输过……直到你亲手终结它的不败神话。<br><small>赢一局「😈恶魔」难度，这里就会出现档案。</small></div>`;
    } else {
      const rows = losses.map((l, i) => {
        const when = new Date(l.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const opp = l.human === 1 ? '黑(你)' : '白(你)';
        const opening = l.opening ? `<span class="tag-warn">⚠️ ${l.opening}</span>` : '';
        const finalMove = l.moves[l.moves.length - 1];
        const last = `末手 (${finalMove?.x},${finalMove?.y})`;
        return `<div class="memory-row">
          <div class="m-left"><b>#${losses.length - i}</b></div>
          <div class="m-body">
            <div>${when} · 执${opp} · ${l.moves.length} 手 ${opening}</div>
            <small>${last} · level${l.level}</small>
          </div>
        </div>`;
      }).join('');
      list.innerHTML = rows;
    }

    modal.classList.remove('hidden');
    document.getElementById('demon-memory-close')?.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  }

  private segWire(id: string, fn: (v: string) => void): void {
    const el = document.getElementById(id);
    el?.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      fn(b.dataset.v!);
    }));
  }
}
