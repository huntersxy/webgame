/* ────────────────────────────────────────────────────────────
 *  controllers/xiangqi-controller.ts — Xiangqi game controller
 * ──────────────────────────────────────────────────────────── */

import type { XqBoard, XqSide, XqMove, Difficulty, GameMode, Pt, SearchResult } from '../types';
import { createInitialBoard, findKing, makeMove, undoMoveOnBoard, legalMoves, inCheck, colorOf, typeOf, PIECE_NAME, isRed } from '../xiangqi/rules';
import { LEVEL_CONFIG, MATE, resetXqWarmDepth } from '../xiangqi/search';
import { AIBridge } from '../ai/ai-bridge';
import { AudioEngine } from '../ui/audio';
import { Stats } from '../ui/stats';
import { renderXiangqi, pxToCellXq, type XqRenderState } from '../ui/xiangqi-renderer';
import { appendLog, setStats, toggleProgress, fmtEval } from '../ui/format';
import { applyDemonTheme } from '../ui/demon';

interface XqHistoryEntry extends XqMove {
  cap: import('../types').XqPiece;
  prevCheck: boolean;
}

/* ── 引擎偏好持久化 ──
 * Pikafish 的 NNUE 权重有 48MB。玩家一旦选了「内置 JS·简单」，就说明他不要
 * 这个重对手——把这份选择记下来，下次进象棋页直接不下载，省掉这 48MB。
 * 想换回来只需在 UI 上点「自动·高难」，那时才会真正开始加载。 */
const ENGINE_PREF_KEY = 'xq.enginePref.v1';

function loadEnginePref(): 'auto' | 'js' {
  try { return localStorage.getItem(ENGINE_PREF_KEY) === 'js' ? 'js' : 'auto'; }
  catch { return 'auto'; } // 无痕模式等场景下 localStorage 不可用
}

function saveEnginePref(v: 'auto' | 'js'): void {
  try { localStorage.setItem(ENGINE_PREF_KEY, v); } catch { /* noop */ }
}

function moveStr(m: XqMove | null): string {
  if (!m) return '—';
  const pn = PIECE_NAME[typeOf(m.piece || 'p') ?? 'p']?.[0] ?? '?';
  const cap = m.cap ? `吃${PIECE_NAME[typeOf(m.cap) ?? 'p']?.[0] ?? '?'}` : '→';
  return `${pn}(${m.fx},${m.fy})${cap}(${m.tx},${m.ty})`;
}

export class XiangqiController {
  private canvas: HTMLCanvasElement;
  private ai: AIBridge;
  private audio: AudioEngine;

  private board: XqBoard = createInitialBoard();
  private turn: XqSide = 'r';
  private sel: Pt | null = null;
  private moves: XqMove[] = [];
  private hist: XqHistoryEntry[] = [];
  private log: string[] = [];
  private over = false;
  private winner: XqSide | 'draw' | null = null;
  private last: { fx: number; fy: number; tx: number; ty: number } | null = null;
  private check = false;
  private mode: GameMode = 'ai';
  private human: XqSide = 'r';
  private level: Difficulty = 2;
  private flip = false;
  private thinking = false;
  private viz = true;
  private thinkMoves: Array<XqMove & { v: number; rank?: number }> = [];
  private god = false;
  private godMove: XqMove | null = null;
  private godThinking = false;
  /** 神算期间局面又变了：等这次算完立刻补算，否则神指会停在旧局面 */
  private _godDirty = false;
  /** 「提示」在途：挡住连点造成的重复搜索 */
  private _hintBusy = false;
  /** 局面版本号：走子/悔棋/重开各 +1，用来作废在途的提示与神指结果 */
  private _posSeq = 0;
  private _aiTimer: ReturnType<typeof setTimeout> | null = null;
  /** 搜索代次：重置局面时 +1，作废「重置前发出、重置后才返回」的旧结果 */
  private _searchSeq = 0;
  private _haltAivai = false;
  private _animFrame: number | null = null;
  private _down: { x: number; y: number } | null = null;

  /** 玩家选的引擎：auto = 优先 Pikafish、不可用则回退内置 JS；js = 只用内置 JS。
   *  恶魔档不受它影响——恶魔固定走 Pikafish（见 forceJs）。 */
  private enginePref: 'auto' | 'js' = loadEnginePref();
  /** Pikafish 是否可用：null = 还在加载/未知，true = 就绪，false = 加载失败 */
  private _engineReady: boolean | null = null;
  private _warmed = false;
  private _warming = false;
  private _engineLogged = false;
  private _loadShowTimer: ReturnType<typeof setTimeout> | null = null;
  /** 恶魔档退回内置引擎只提示一次 */
  private _fallbackWarned = false;

  constructor(canvas: HTMLCanvasElement, ai: AIBridge, audio: AudioEngine) {
    this.canvas = canvas;
    this.ai = ai;
    this.audio = audio;
    this.wireEvents();
    this.newGame();
    this.startAnimLoop();
    this.syncEngineUI();
    // 注意：不在这里 warmUp()——象棋面板可能一直没被打开过，
    // 会和五子棋的 Rapfi 抢带宽。由 main.ts 在切到象棋页时触发。
  }

  private get state(): XqRenderState {
    return {
      board: this.board,
      turn: this.turn,
      sel: this.sel,
      moves: this.moves,
      last: this.last,
      check: this.check,
      flip: this.flip,
      over: this.over,
      viz: this.viz,
      thinkMoves: this.thinkMoves,
      god: this.god,
      godMove: this.godMove,
    };
  }

  /** 是否强制使用内置 JS 引擎（不加载、不等待 Pikafish）。恶魔档固定走 Pikafish。 */
  private get forceJs(): boolean {
    return this.level !== 4 && this.enginePref === 'js';
  }

  /**
   * 刷新「引擎」区块与恶魔档的可用性。
   * 恶魔档只能与 Pikafish 对局，所以引擎没就绪（加载中/加载失败）时
   * 直接把「😈 恶魔」按钮禁用掉，而不是让它降级成内置引擎偷偷开赛。
   */
  private syncEngineUI(): void {
    const demonForced = this.level === 4;                 // 恶魔档固定 Pikafish，不可切换
    this.paintSeg('x-engine', demonForced ? 'auto' : this.enginePref);
    document.getElementById('x-engine')?.querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) => { b.disabled = demonForced; });

    const note = document.getElementById('x-engine-note');
    if (note) note.textContent = this.engineNote(demonForced);

    const demonBtn = document.querySelector<HTMLButtonElement>('#x-level button[data-v="4"]');
    if (demonBtn) {
      const ready = this._engineReady === true;
      demonBtn.disabled = !ready;
      demonBtn.title = ready
        ? '恶魔档：Pikafish 引擎满火力搜索'
        : this._engineReady === false
          ? 'Pikafish 引擎加载失败，恶魔模式不可用（刷新页面可重试）'
          : 'Pikafish 引擎加载中…加载完成后可挑战恶魔';
    }
  }

  private engineNote(demonForced: boolean): string {
    if (demonForced) return '恶魔档固定使用 Pikafish 引擎（高难 · 满火力搜索），不可切换。';
    if (this.enginePref === 'js') return '当前使用内置 JS 引擎（简单 · 已记住此选择，下次不再下载 Pikafish 权重）。';
    if (this._engineReady === true) return '自动：使用 Pikafish 引擎（高难 · WASM）。';
    if (this._engineReady === false) return '自动：Pikafish 加载失败，已回退内置 JS 引擎（简单）。';
    return '自动：优先 Pikafish（高难）；加载完成前先用内置 JS 引擎（简单）应手。';
  }

  /** 程序化设置分段控件的选中项（不触发回调）。 */
  private paintSeg(id: string, value: string): void {
    const el = document.getElementById(id);
    el?.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === value);
    });
  }

  /**
   * 预热 Pikafish 引擎。进入象棋页面时调用：首次需下载 wasm + NNUE 权重
   * （约 48MB），提前加载可以让玩家走完前几手后就能接上引擎，而不是卡在
   * 「AI 深算中」干等下载。加载期间照常下棋（走内置 JS 引擎应手）。
   */
  warmUp(): void {
    if (this._warmed || this._warming) return;
    // 玩家明确选了「内置 JS·简单」：不加载、不下载那 48MB 权重。
    // 想换回来点一下「自动·高难」即可（syncEngineUI 之后会再次触发预热）。
    if (this.enginePref === 'js') {
      this._engineReady = false;
      this.syncEngineUI();
      return;
    }
    this._warming = true;
    // 加载很快（已缓存）时不闪这一下，超过 300ms 才显示
    this._loadShowTimer = setTimeout(() => this.showEngineLoad(true), 300);
    this.setEngineLoad(0, 0, '引擎加载中…');
    this.setGlobalStatus('🧩 Pikafish 引擎预热中…');
    void this.ai.warmUpXq((loaded, total, src) => {
      const mb = (n: number) => (n / 1048576).toFixed(1);
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      this.setEngineLoad(pct, loaded, `引擎加载中… ${mb(loaded)}/${mb(total)} MB`);
      if (src === 'prefetch' && total) {
        this.setGlobalStatus(`🧩 Pikafish 引擎预热中… ${pct}%（${mb(loaded)}/${mb(total)} MB）`);
      }
    }).then(({ ok }) => {
      this._warming = false;
      this._warmed = ok;
      this._engineReady = ok;
      if (this._loadShowTimer !== null) { clearTimeout(this._loadShowTimer); this._loadShowTimer = null; }
      this.showEngineLoad(false);
      if (ok) {
        this.setGlobalStatus('AI 就绪');
        appendLog(document.getElementById('x-think-log'),
          '🧩 <b>Pikafish 引擎已预加载</b>（NNUE 神经网络）· 走子无需等待');
        this._engineLogged = true;
      } else {
        this.setGlobalStatus('AI 就绪（内置引擎）');
        appendLog(document.getElementById('x-think-log'),
          '⚠️ <b>Pikafish 引擎加载失败</b>，已回退内置 JS 引擎；<b>恶魔模式暂不可用</b>（刷新页面可重试）。');
      }
      this.syncEngineUI();
    });
  }

  /** 引擎加载进度条 */
  private setEngineLoad(pct: number, loaded: number, text: string): void {
    const bar = document.getElementById('x-engine-bar');
    const pctEl = document.getElementById('x-engine-pct');
    const stateEl = document.getElementById('x-engine-state');
    if (bar) bar.style.width = `${pct}%`;
    if (stateEl) stateEl.textContent = text;
    if (pctEl) pctEl.textContent = loaded ? `${pct}%` : '';
  }

  private showEngineLoad(on: boolean): void {
    document.getElementById('xiangqi-engine-load')?.classList.toggle('hidden', !on);
    if (on) this.setEngineLoad(0, 0, '引擎加载中…');
  }

  private startAnimLoop(): void {
    const loop = () => {
      // 只在真的有会动的内容（神指 / 候选）时重绘。旧写法只要 god 打开就每帧
      // 全画布重绘，与有没有神指无关——空转的 60fps，纯烧电。
      const godMark = this.god && !!this.godMove && !this.over;
      if (godMark || (this.viz && this.thinkMoves.length > 0 && !this.over)) {
        this.redraw();
      }
      this._animFrame = requestAnimationFrame(loop);
    };
    this._animFrame = requestAnimationFrame(loop);
  }

  redraw(): void { renderXiangqi(this.canvas, this.state); }

  newGame(): void {
    resetXqWarmDepth(); // new game → drop any warm-start adaptive depth
    this._searchSeq++; // 在途搜索作废
    this._posSeq++;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
    this.board = createInitialBoard();
    this.turn = 'r';
    this.sel = null;
    this.moves = [];
    this.hist = [];
    this.over = false;
    this.winner = null;
    this.last = null;
    this.check = false;
    this.log = [];
    this.thinkMoves = [];
    this.godMove = null;
    this.godThinking = false;
    this._haltAivai = false;
    this.flip = this.human === 'b';
    this.hideResult();
    this.renderLog();
    this.updatePanel();
    this.redraw();
    const cfg = LEVEL_CONFIG[this.level];
    const modeName = this.mode === 'aivai' ? '🤖AI互搏观战' : (this.mode === 'pvp' ? '双人对战' : '人机对战');
    setStats(document.getElementById('x-think-stats'), `新对局 · ${modeName} · 难度 <b>${cfg.name}</b> · depth${cfg.depth}+Q${cfg.qd} · 等待行棋…`);
    if (this.mode === 'ai' && this.turn !== this.human) this.aiMove();
    else if (this.mode === 'aivai') this.aiMove();
    else this.refreshGod();
  }

  private applyHuman(fx: number, fy: number, tx: number, ty: number): void {
    if (this.over || this.thinking) return;
    if (this.mode === 'aivai') return;
    const p = this.board[fy][fx];
    if (!p || colorOf(p) !== this.turn) return;
    const ms = legalMoves(this.board, this.turn).filter((m) => m.fx === fx && m.fy === fy);
    const m = ms.find((mv) => mv.tx === tx && mv.ty === ty);
    if (!m) { this.audio.bad(); return; }
    this.pushMove(m);
    this.afterMove(m);
  }

  private pushMove(m: XqMove): void {
    const cap = this.board[m.ty][m.tx] || null;
    this.hist.push({ ...m, cap, prevCheck: this.check });
    this.board[m.ty][m.tx] = this.board[m.fy][m.fx];
    this.board[m.fy][m.fx] = null;
    this.last = { fx: m.fx, fy: m.fy, tx: m.tx, ty: m.ty };
    const pn = PIECE_NAME[typeOf(m.piece)!][colorOf(m.piece) === 'r' ? 1 : 0];
    const capStr = m.cap ? '吃' + PIECE_NAME[typeOf(m.cap)!][colorOf(m.cap) === 'r' ? 1 : 0] : '进';
    this.log.push(`${this.hist.length}. ${colorOf(m.piece) === 'r' ? '红' : '黑'} ${pn} ${capStr} (${m.fx},${m.fy})→(${m.tx},${m.ty})`);
  }

  private afterMove(m: XqMove): void {
    if (m.cap) this.audio.capture(); else this.audio.move();
    this.turn = this.turn === 'r' ? 'b' : 'r';
    this.sel = null;
    this.moves = [];
    this.godMove = null;
    this._posSeq++;
    this.check = inCheck(this.board, this.turn);
    if (this.check) this.audio.check();
    const opp = legalMoves(this.board, this.turn);
    if (opp.length === 0) { this.over = true; this.winner = this.turn === 'r' ? 'b' : 'r'; this.onEnd(); }
    else if (this.hist.length >= 160) { this.over = true; this.winner = 'draw'; this.onEnd(); }
    this.renderLog();
    this.updatePanel();
    this.redraw();
    if (this.over) return;
    if (this.mode === 'aivai' && !this._haltAivai) { this._aiTimer = setTimeout(() => this.aiMove(), 10); return; }
    if (this.mode === 'ai' && this.turn !== this.human) this.aiMove();
    else this.refreshGod();
  }

  private async aiMove(): Promise<void> {
    this.thinking = true;
    this.showThink(true);
    toggleProgress(document.getElementById('x-think-progress'), true);
    const cfg = LEVEL_CONFIG[this.level];
    const who = this.turn === 'r' ? '红' : '黑';
    this.setGlobalStatus(`象棋 AI 深算中…(${cfg.name} depth${cfg.depth})`);
    this.redraw();
    setStats(document.getElementById('x-think-stats'), `⏳ <b>${who}·${cfg.name}</b> 运算中… depth${cfg.depth}+Q${cfg.qd} · 正在展开 ${this.level === 4 ? '全宽度+杀棋延伸' : 'Alpha-Beta'}…`);
    const delay = this.level === 4 ? 60 : 20;
    const seq = ++this._searchSeq;
    this._aiTimer = setTimeout(async () => {
      const aiSide = this.turn;
      const res = await this.ai.searchXq(this.board.map((r) => [...r]), aiSide, this.level, this.mode, this.hist.length, this.forceJs);
      // 局面在这期间被重置（重新摆棋 / 换执子 / 换模式）→ 旧结果作废
      if (seq !== this._searchSeq) return;
      const m = res.move;
      this.thinkMoves = (res.scores || []).map((s, i) => ({ ...s, rank: i + 1 }));
      this.thinking = false;
      this.showThink(false);
      toggleProgress(document.getElementById('x-think-progress'), false);
      this.setGlobalStatus('AI 就绪');
      if (!m) { this.over = true; this.winner = this.turn === 'r' ? 'b' : 'r'; this.onEnd(); this.updatePanel(); this.redraw(); return; }

      const ev = res.eval >= MATE - 1000 ? '绝杀' : res.eval <= -MATE + 1000 ? '被杀' : (res.eval > 0 ? `+${res.eval}` : `${res.eval}`);
      const pvStr = (res.pv || []).slice(0, 4).map(moveStr).join(' → ') || moveStr(m);
      const topStr = (res.scores || []).slice(0, 5).map((s, i) => `#${i + 1}${moveStr(s)}:${s.v >= MATE - 1000 ? '杀' : Math.round(s.v)}`).join('<br>');
      const boost = res.boosted ? ` <span style="color:#ff6b6b">·劣势加深→depth${res.depth}</span>` : '';
      // 引擎来源标注 + 首次接入播报（与五子棋面板一致）
      const engineName = res.engine === 'pikafish' ? ' · 🧩Pikafish' : res.engine === 'js' ? ' · 内置引擎' : '';
      if (res.engine === 'pikafish' && !this._engineLogged) {
        appendLog(document.getElementById('x-think-log'), '🧩 <b>Pikafish WASM 引擎已接入</b>（NNUE 神经网络评估）');
        this._engineLogged = true;
      }
      // 恶魔档只该与 Pikafish 对局：它不可用而退回内置引擎时必须让玩家知道
      if (this.level === 4 && res.engine === 'js' && !this._fallbackWarned) {
        this._fallbackWarned = true;
        appendLog(document.getElementById('x-think-log'), '⚠️ <b>Pikafish 引擎不可用</b>，本局恶魔档已临时改用内置 JS 引擎应手（刷新页面可重试加载）。');
      }
      setStats(document.getElementById('x-think-stats'), `✅ <b>${who}·${cfg.name}</b> depth${res.depth}${res.engine === 'pikafish' ? '' : `+Q${res.qd ?? cfg.qd}`} · 节点 <b>${res.nodes.toLocaleString()}</b> · ${res.ms}ms · 评估 <b>${ev}</b>${engineName}${boost}<br>主变：${pvStr}`);
      appendLog(document.getElementById('x-think-log'), `🧠 depth<b>${res.depth}</b> · 节点${res.nodes.toLocaleString()} · ${res.ms}ms · 评估${ev} · 选<b>${moveStr(m)}</b>${engineName}${res.boosted ? ' · <span style="color:#ff6b6b">劣势加深</span>' : ''}<br><span class="cand">主变 ${pvStr}</span><br><span class="cand">${topStr}</span>`);

      this.pushMove(m);
      this.afterMove(m);
    }, delay);
  }

  stopAivai(): void {
    this._haltAivai = true;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
    if (!this.over) appendLog(document.getElementById('x-think-log'), '⏹ <b>已停止AI互搏</b>，可悔棋/新开一局');
    this.updatePanel();
    this.setGlobalStatus('AI 就绪');
  }

  private stopAivaiSilent(): void {
    this._haltAivai = true;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
  }

  undo(): void {
    if (this.thinking || !this.hist.length) return;
    this.thinkMoves = [];
    this.godMove = null;
    this._posSeq++;
    if (this.mode === 'aivai') this.stopAivaiSilent();
    const n = this.mode === 'ai' ? (this.turn !== this.human ? 1 : 2) : 1;
    for (let i = 0; i < n && this.hist.length; i++) {
      const h = this.hist.pop()!;
      this.board[h.fy][h.fx] = h.piece || this.board[h.ty][h.tx];
      this.board[h.ty][h.tx] = h.cap;
      this.log.pop();
    }
    const l = this.hist[this.hist.length - 1];
    this.last = l ? { fx: l.fx, fy: l.fy, tx: l.tx, ty: l.ty } : null;
    this.turn = this.hist.length % 2 === 0 ? 'r' : 'b';
    this.sel = null;
    this.moves = [];
    this.over = false;
    this.winner = null;
    this.check = inCheck(this.board, this.turn);
    this.hideResult();
    this.renderLog();
    this.updatePanel();
    this.redraw();
    this.audio.undo();
    if (this.mode === 'ai' && !this.over && this.turn !== this.human) this.aiMove();
    else this.refreshGod();
  }

  async hint(): Promise<void> {
    // _hintBusy 挡住连点：每次提示都是一次恶魔档满配搜索
    if (this.over || this.thinking || this.godThinking || this._hintBusy) return;
    this._hintBusy = true;
    this.syncGodUI();          // 亮进度条，别让玩家以为没反应
    const seq = this._posSeq;
    setStats(document.getElementById('x-think-stats'), '👉 恶魔正在附体算招… depth4+Q3全开，请稍候');
    setTimeout(async () => {
      try {
        const res = await this.ai.hintXq(this.board.map((r) => [...r]), this.turn, this.mode, this.hist.length, this.forceJs);
        // 这手算的是「走子/悔棋/重开之前」的局面就丢弃，别把提示画到新局面
        if (seq !== this._posSeq) return;
        const m = res.move;
        if (m) {
          this.thinkMoves = (res.scores || []).map((s, i) => ({ ...s, rank: i + 1 }));
          const ev = res.eval >= MATE - 1000 ? '绝杀' : res.eval;
          appendLog(document.getElementById('x-think-log'), `💡 <b>恶魔支招</b> depth${res.depth}+Q${res.qd} · 推荐<b>${moveStr(m)}</b> · 评估${ev} · 节点${res.nodes.toLocaleString()}`);
          setStats(document.getElementById('x-think-stats'), `💡 恶魔支招 depth${res.depth} · 推荐 ${moveStr(m)} · 节点${res.nodes.toLocaleString()} · ${res.ms}ms`);
          this.sel = { x: m.fx, y: m.fy };
          this.moves = legalMoves(this.board, this.turn).filter((z) => z.fx === m.fx && z.fy === m.fy);
          this.redraw();
          this.audio.hint();
        }
      } finally {
        this._hintBusy = false;
        this.syncGodUI();
      }
    }, 30);
  }

  toggleGod(): void {
    this.god = !this.god;
    if (this.god) {
      appendLog(document.getElementById('x-think-log'), '🙏 <b>恶魔附体！请神上身成功</b>，每手都将用 depth4 给你指 👇 最佳走法');
      this.syncGodUI();
      this.refreshGod();
    } else {
      this.godMove = null;
      this.godThinking = false;
      this._godDirty = false;
      appendLog(document.getElementById('x-think-log'), '🛌 已送神，神指消失');
      this.syncGodUI();
      this.redraw();
    }
  }

  /** 「神在思考」提示 + 按钮态 + 进度条：让玩家知道在算、大概等多久。 */
  private syncGodUI(): void {
    const btn = document.getElementById('x-god');
    if (btn) {
      btn.classList.toggle('on', this.god);
      btn.textContent = !this.god ? '🙏 请神上身' : (this.godThinking ? '🙏 神算中…' : '🛌 送神离开');
    }
    const busy = this.god && this.godThinking;
    document.getElementById('xiangqi-god-thinking')?.classList.toggle('hidden', !busy);
    toggleProgress(document.getElementById('x-think-progress'), busy || this._hintBusy || this.thinking);
    this.updatePanel();
  }

  private refreshGod(): void {
    if (!this.god || this.over || this.thinking) return;
    if (this.mode === 'aivai' && !this._haltAivai) return;
    // 上一次还在算：记脏标记，等它收尾时补算——直接 return 会让神指停在旧局面
    if (this.godThinking) { this._godDirty = true; return; }
    this.godThinking = true;
    this.syncGodUI();          // 立刻亮起「神在思考」，别让玩家干等
    const seq = this._posSeq;
    setTimeout(async () => {
      try {
        const res = await this.ai.hintXq(this.board.map((r) => [...r]), this.turn, this.mode, this.hist.length, this.forceJs);
        // 结果算的是旧局面、或期间已经送神，就丢弃（脏标记会在 finally 里补算）
        if (!this.god || seq !== this._posSeq) return;
        this.godMove = res.move;
        if (res.scores) this.thinkMoves = res.scores.map((s, i) => ({ ...s, rank: i + 1 }));
        this.redraw();
      } finally {
        this.godThinking = false;
        this.syncGodUI();
        if (this._godDirty) { this._godDirty = false; this.refreshGod(); }
      }
    }, 40);
  }

  private onEnd(): void {
    const el = document.getElementById('xiangqi-result');
    el?.classList.remove('hidden');
    const w = this.winner;
    let t = '';
    if (w === 'draw') { t = '🤝 和棋！双方激战 80 回合未分胜负。'; }
    else if (this.mode === 'aivai') { t = `🤖 互搏结束！${w === 'r' ? '红方AI' : '黑方AI'} 将军绝杀获胜！`; this.audio.win(); }
    else if (this.mode === 'ai' && w === this.human) { t = `🎉 绝杀！你执${w === 'r' ? '红' : '黑'}战胜了 AI！`; this.audio.win(); Stats.add(true); }
    else if (this.mode === 'ai') { t = `🤖 AI（${w === 'r' ? '红' : '黑'}）获胜，将军绝杀！`; this.audio.lose(); Stats.add(false); }
    else { t = `🏆 ${w === 'r' ? '红方' : '黑方'} 获胜！`; this.audio.win(); Stats.add(true); }
    if (el) el.textContent = t;
  }

  private updatePanel(): void {
    const t = document.getElementById('xiangqi-turn');
    if (t) t.textContent = this.over ? '对局结束' : `轮到 ${this.turn === 'r' ? '红方' : '黑方'} 走棋${this.check ? ' · 将军！' : ''}${this.mode === 'aivai' ? ' · AI互搏中' : ''}${this.god ? ' · 神附体👇' : ''}`;
    const stepsEl = document.getElementById('x-steps');
    if (stepsEl) stepsEl.textContent = String(Math.floor(this.hist.length / 2) + 1);
    const modeTag = this.mode === 'aivai' ? '🤖互搏' : (this.thinking ? 'AI 思考中…' : (this.godThinking ? '👇神算中…' : '行棋中'));
    const statusEl = document.getElementById('x-status');
    if (statusEl) statusEl.textContent = this.over ? ('胜者：' + (this.winner === 'draw' ? '和棋' : (this.winner === 'r' ? '红' : '黑'))) : ((this.turn === 'r' ? '红' : '黑') + `方${modeTag}` + (this.check ? '（将军）' : ''));
    const cr: string[] = [], cb: string[] = [];
    this.hist.forEach((h) => { if (h.cap) { (colorOf(h.cap) === 'r' ? cb : cr).push(PIECE_NAME[typeOf(h.cap)!][colorOf(h.cap) === 'r' ? 1 : 0]); } });
    const capR = document.getElementById('x-cap-r');
    if (capR) capR.textContent = cr.join(' ') || '—';
    const capB = document.getElementById('x-cap-b');
    if (capB) capB.textContent = cb.join(' ') || '—';
  }

  private renderLog(): void {
    const el = document.getElementById('x-log');
    if (!el) return;
    el.innerHTML = this.log.length ? this.log.slice(-30).map((s) => `<div>${s}</div>`).join('') : '<div class="empty">暂无棋谱，点击棋子开始</div>';
    el.scrollTop = el.scrollHeight;
  }

  private showThink(on: boolean): void { document.getElementById('xiangqi-thinking')?.classList.toggle('hidden', !on); }
  private hideResult(): void { document.getElementById('xiangqi-result')?.classList.add('hidden'); }
  private setGlobalStatus(t: string): void { (window as any).setGlobalStatus?.(t); }

  private wireEvents(): void {
    // Pointer events for mobile-first input: unifies mouse & touch, guards
    // against accidental moves while scrolling, and removes tap delay.
    this.canvas.addEventListener('pointerdown', (e) => {
      this._down = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const isTap = this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) < 12;
      this._down = null;
      if (!isTap) return;
      if (this.thinking || this.over) return;
      if (this.mode === 'aivai') return;
      if (this.mode === 'ai' && this.turn !== this.human) return;
      const c = pxToCellXq(this.canvas, e, this.flip);
      if (!c) return;
      const { x, y } = c;
      const p = this.board[y][x];
      if (this.sel) {
        const m = this.moves.find((mv) => mv.tx === x && mv.ty === y);
        if (m) { this.applyHuman(m.fx, m.fy, m.tx, m.ty); return; }
      }
      if (p && colorOf(p) === this.turn) {
        this.sel = { x, y };
        this.moves = legalMoves(this.board, this.turn).filter((m) => m.fx === x && m.fy === y);
        this.audio.select();
      } else { this.sel = null; this.moves = []; }
      this.redraw();
    });
    this.canvas.addEventListener('pointercancel', () => { this._down = null; });

    this.seg('x-mode', (v) => { this.mode = v as GameMode; if (v === 'aivai') appendLog(document.getElementById('x-think-log'), '🤖 <b>AI互搏观战开始</b>，红黑双方都用当前难度恶战到底'); this.newGame(); });
    this.seg('x-color', (v) => { this.human = v as XqSide; this.newGame(); });
    this.seg('x-level', (v) => {
      // 恶魔档只能与 Pikafish 对局：引擎没就绪就不放行（按钮已禁用，这里再兜一层）
      if (v === '4' && this._engineReady !== true) {
        this.paintSeg('x-level', String(this.level));
        appendLog(document.getElementById('x-think-log'), '🚫 <b>恶魔模式不可用</b>：Pikafish 引擎尚未就绪。');
        return;
      }
      this.level = +v as Difficulty;
      applyDemonTheme('x', this.level, this.audio);
      const cfg = LEVEL_CONFIG[this.level];
      setStats(document.getElementById('x-think-stats'), `难度切换 → <b>${cfg.name}</b> · depth${cfg.depth}+Q${cfg.qd}`);
      appendLog(document.getElementById('x-think-log'), `⚙️ 难度切换 → <b>${cfg.name}</b> depth${cfg.depth}+Q${cfg.qd}${this.level === 4 ? ' · <span style="color:#ff6b6b">恶魔全开，不求你能赢</span>' : ''}`);
      this.syncEngineUI();
      this.updatePanel();
    });

    this.seg('x-engine', (v) => {
      this.enginePref = v === 'js' ? 'js' : 'auto';
      saveEnginePref(this.enginePref); // 记住选择：选「简单」下次就不再下这 48MB
      appendLog(document.getElementById('x-think-log'), this.enginePref === 'js'
        ? '🔧 引擎切换 → <b>内置 JS 引擎（简单）</b>（不再加载、不再等待 Pikafish）'
        : '🔧 引擎切换 → <b>自动（Pikafish·高难）</b>（不可用时回退内置引擎·简单）');
      this.syncEngineUI();
      // 从「内置 JS」切回「自动」时才真正开始加载 Pikafish
      if (this.enginePref === 'auto') this.warmUp();
    });

    const xv = document.getElementById('x-viz') as HTMLInputElement | null;
    xv?.addEventListener('change', (e) => { this.viz = (e.target as HTMLInputElement).checked; this.redraw(); });

    document.getElementById('x-new')?.addEventListener('click', () => this.newGame());
    document.getElementById('x-undo')?.addEventListener('click', () => this.undo());
    document.getElementById('x-hint')?.addEventListener('click', () => this.hint());
    document.getElementById('x-god')?.addEventListener('click', () => this.toggleGod());
    document.getElementById('x-stop')?.addEventListener('click', () => this.stopAivai());
    document.getElementById('x-flip')?.addEventListener('click', () => { this.flip = !this.flip; this.redraw(); });
    document.getElementById('x-sound')?.addEventListener('click', (e) => {
      this.audio.enabled = !this.audio.enabled;
      const btn = e.target as HTMLButtonElement;
      btn.textContent = this.audio.enabled ? '🔊 音效开' : '🔇 音效关';
      btn.classList.toggle('on', this.audio.enabled);
      // Keep demon BGM in sync with the sound toggle.
      if (this.level === 4) { if (this.audio.enabled) this.audio.startBGM(); else this.audio.stopBGM(); }
    });
  }

  private seg(id: string, fn: (v: string) => void): void {
    const el = document.getElementById(id);
    el?.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      fn(b.dataset.v!);
    }));
  }
}
