/* ────────────────────────────────────────────────────────────
 *  controllers/go-controller.ts — 围棋控制器
 *
 *  职责：局面与棋谱、轮流落子、AI 调度（含互搏）、形势判断/数子、
 *  面板与日志、渲染器状态拼装。
 *
 *  几个刻意的设计：
 *  · 规则引擎用可变的 GoBoard（play/undo + 快照栈），悔棋就是 undo，
 *    不必重放整局；位置超级劫靠一份「出现过的局面哈希集合」判定。
 *  · 传给 AI 的棋谱只保留最近若干手（网络只需要最近五手），但上一手/
 *    上上手局面要单独给出——网络的历史与征子平面需要它们。
 *  · 在途搜索结果用局面版本号作废：悔棋/重开/换盘之后回来的旧结果
 *    绝不能落到新局面上（与五子棋控制器同一套防串手思路）。
 * ──────────────────────────────────────────────────────────── */

import type { GameMode, GoCandidate, GoLevel, GoMove, GoPositionPayload, GoColor, SearchResult } from '../types';
import { GoBoard, opponent, scorePosition, type GoRuleset } from '../go/rules';
import { AIBridge } from '../ai/ai-bridge';
import { AudioEngine } from '../ui/audio';
import { GoRenderer, type GoRenderState } from '../ui/go-renderer';
import { appendLog, setStats, toggleProgress } from '../ui/format';
import { applyDemonTheme } from '../ui/demon';
import { GO_LEVELS } from '../go/engine';

interface GoHistoryEntry {
  /** 落子索引，-1 = 虚手 */
  move: number;
  color: GoColor;
  /** 落子后的局面哈希（超级劫判重用） */
  hash: number;
}

/** 各尺寸的默认贴目（中国规则惯例） */
function defaultKomi(size: number): number {
  return size >= 19 ? 7.5 : 7;
}

export class GoController {
  private canvas: HTMLCanvasElement;
  private ai: AIBridge;
  private audio: AudioEngine;
  private renderer: GoRenderer;

  private size = 9;
  private komi = 7;
  private readonly ruleset: GoRuleset = 'chinese';
  private board: GoBoard = new GoBoard(9);
  private history: GoHistoryEntry[] = [];
  /** 出现过的局面哈希（位置超级劫） */
  private seenHashes = new Set<number>();

  private mode: GameMode = 'ai';
  private human: GoColor = 1;
  private level: GoLevel = 2;
  private over = false;
  private resultText = '';
  private thinking = false;
  private hover = -1;
  private viz = false;
  private candidates: GoCandidate[] = [];
  private ownership: Float32Array | null = null;
  private showOwnership = false;
  private deadMask: Uint8Array | null = null;
  private hintMove = -1;
  /** 「求一着」在途：挡住连点 */
  private _hintBusy = false;
  /** 建议点呼吸动画相位与定时器（只跑 2.6 秒） */
  private _hintPhase = 0;
  private _hintTimer: ReturnType<typeof setInterval> | null = null;
  /** 请神上身：常驻显示最佳点，每手自动重算 */
  private god = false;
  private godMove = -1;
  private godThinking = false;
  /** 神算期间局面又变了：算完立刻补算，否则神指会停在旧局面 */
  private _godDirty = false;
  private _godPhase = 0;
  private _godTimer: ReturnType<typeof setInterval> | null = null;
  private lastMove = -1;

  /** 局面版本号：任何改变局面的操作都 +1，用来作废在途搜索结果 */
  private _seq = 0;
  private _searchSeq = 0;
  private _aiTimer: ReturnType<typeof setTimeout> | null = null;
  private _aivaiRunning = false;
  private _warming = false;
  private _warmed = false;
  /** 神经网络是否可用：null = 未知/加载中，true = 就绪，false = 失败 */
  private _nnReady: boolean | null = null;
  private _enginePref: 'auto' | 'heuristic' = 'auto';
  private _loadShowTimer: ReturnType<typeof setTimeout> | null = null;
  private _loadText = '🧠 围棋神经网络加载中…';
  private _engineLogged = false;

  constructor(canvas: HTMLCanvasElement, ai: AIBridge, audio: AudioEngine) {
    this.canvas = canvas;
    this.ai = ai;
    this.audio = audio;
    this.renderer = new GoRenderer(canvas);
    this.wireEvents();
    this.newGame();
    this.syncEngineUI();
  }

  /** 玩家是否选了兜底 AI（或网络不可用） */
  private get forceHeuristic(): boolean {
    return this._enginePref === 'heuristic' || this._nnReady === false;
  }

  /* ══════════ 引擎预热 ══════════ */

  /**
   * 预热神经网络：首次要下 3.8MB 权重并初始化 TF.js 后端。
   * 进入围棋页时调用；没就绪之前 AI 用常识棋兜底应手，不会卡住。
   */
  warmUp(): void {
    if (this._warmed || this._warming) return;
    this._warming = true;
    this._loadShowTimer = setTimeout(() => this.showEngineLoad(true), 300);
    this.setEngineLoad(0, 0, '神经网络加载中…');
    this.setGlobalStatus('🧠 围棋神经网络预热中…');
    void this.ai.warmUpGo((loaded, total, src) => {
      const mb = (n: number) => (n / 1048576).toFixed(1);
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      this.setEngineLoad(pct, loaded, `神经网络加载中… ${mb(loaded)}/${mb(total)} MB`);
      if (src === 'prefetch' && total) {
        this._loadText = `🧠 围棋神经网络预热中… ${pct}%（${mb(loaded)}/${mb(total)} MB）`;
        this.setGlobalStatus(this._loadText);
      }
    }).then((r) => {
      this._warming = false;
      this._warmed = r.ok;
      this._nnReady = r.ok;
      if (this._loadShowTimer !== null) {
        clearTimeout(this._loadShowTimer);
        this._loadShowTimer = null;
      }
      this.showEngineLoad(false);
      if (r.ok) {
        const backendName = r.backend === 'webgpu' ? 'WebGPU' : r.backend === 'webgl' ? 'WebGL' : r.backend === 'wasm' ? 'WASM' : 'CPU';
        this.setGlobalStatus('AI 就绪');
        appendLog(
          document.getElementById('go-think-log'),
          `🧠 <b>神经网络已就绪</b> · ${r.modelName ?? 'KataGo'} · 后端 <b>${backendName}</b>${r.backend === 'wasm' || r.backend === 'cpu' ? '（<span style="color:#d69a2e">无 GPU 加速，思考会明显变慢</span>）' : ''}`,
        );
      } else {
        this.setGlobalStatus('AI 就绪（常识棋兜底）');
        appendLog(
          document.getElementById('go-think-log'),
          `⚠️ <b>神经网络加载失败</b>：${r.error ?? '未知原因'}<br>已回退到内置常识棋 AI（棋力很弱，仅保证能对局）；刷新页面可重试。`,
        );
      }
      this.syncEngineUI();
    });
  }

  private setEngineLoad(pct: number, loaded: number, text: string): void {
    const bar = document.getElementById('go-engine-bar');
    const pctEl = document.getElementById('go-engine-pct');
    const stateEl = document.getElementById('go-engine-state');
    if (bar) bar.style.width = `${pct}%`;
    if (stateEl) stateEl.textContent = text;
    if (pctEl) pctEl.textContent = loaded ? `${pct}%` : '';
  }

  private showEngineLoad(on: boolean): void {
    document.getElementById('go-engine-load')?.classList.toggle('hidden', !on);
    if (on) this.setEngineLoad(0, 0, '神经网络加载中…');
  }

  /** 引擎区块：恶魔档需要神经网络就绪；不可用时禁用并说明 */
  private syncEngineUI(): void {
    const note = document.getElementById('go-engine-note');
    if (note) {
      note.textContent = this._nnReady === true
        ? `神经网络已就绪：${this.engineLabel()}。恶魔档为满火力搜索。`
        : this._nnReady === false
          ? '神经网络不可用：当前为内置常识棋 AI（棋力弱），恶魔档不可用；刷新可重试。'
          : '神经网络加载中：先用内置常识棋应手，加载完成后自动切换。';
    }
    this.paintSeg('go-engine', this.forceHeuristic ? 'heuristic' : 'auto');
    const demonBtn = document.querySelector<HTMLButtonElement>('#go-level button[data-v="4"]');
    if (demonBtn) {
      const ready = this._nnReady === true && this._enginePref === 'auto';
      demonBtn.disabled = !ready;
      demonBtn.title = ready
        ? '恶魔档：神经网络满火力搜索（访问量 + 时间都拉满）'
        : this._nnReady === false
          ? '神经网络加载失败，恶魔档不可用（刷新页面可重试）'
          : '神经网络加载中…就绪后可挑战恶魔';
    }
  }

  private engineLabel(): string {
    if (this._nnReady !== true) return '常识棋兜底';
    return this._enginePref === 'heuristic' ? '内置常识棋（手动选择）' : 'KataGo 神经网络';
  }

  /* ══════════ 对局 ══════════ */

  newGame(): void {
    this._seq++;
    this._searchSeq++;
    // 互搏开关跟着模式走：切到互搏就自动连下，其它模式一律停。
    // （曾经这里无条件写 false，把「切换到互搏」刚设的 true 冲掉，
    //   表现为互搏只走一手就停住。）
    this._aivaiRunning = this.mode === 'aivai';
    if (this._aiTimer !== null) {
      clearTimeout(this._aiTimer);
      this._aiTimer = null;
    }
    this.komi = defaultKomi(this.size);
    this.board = new GoBoard(this.size);
    this.history = [];
    this.seenHashes = new Set([this.board.hash]);
    this.over = false;
    this.resultText = '';
    this.ownership = null;
    this.showOwnership = false;
    this.deadMask = null;
    this.candidates = [];
    this.clearHint();
    this.godMove = -1;
    this._godDirty = false;
    this.lastMove = -1;
    this.hover = -1;
    this.thinking = false;
    this.renderer.setSize(this.size);
    this.syncEstimateUI();
    this.syncGodUI();
    this.hideResult();
    this.updatePanel();
    this.redraw();
    appendLog(
      document.getElementById('go-think-log'),
      `🆕 <b>新开局</b>：${this.size} 路 · 中国规则（数子）· 贴目 ${this.komi}${this.mode === 'aivai' ? ' · AI 互搏' : this.mode === 'ai' ? ` · 你执${this.human === 1 ? '黑' : '白'}` : ' · 双人对弈'}`,
    );
    this.maybeAIMove();
    this.refreshGodIfMyTurn();
  }

  private playMove(index: number, silent = false): boolean {
    if (index !== -1) {
      // 位置超级劫：落子后若与历史某一局面完全相同则禁止
      const probe = this.board.clone();
      probe.koPoint = this.board.koPoint;
      if (!probe.play(index)) return false;
      if (this.seenHashes.has(probe.hash)) {
        if (!silent) appendLog(document.getElementById('go-think-log'), '🚫 <b>禁止全局同形</b>（位置超级劫），请换个地方落子。');
        return false;
      }
    }
    const capturedBefore = this.board.captures[0] + this.board.captures[1];
    if (!this.board.play(index)) return false;
    const captured = this.board.captures[0] + this.board.captures[1] - capturedBefore;
    this.history.push({ move: index, color: opponent(this.board.toMove), hash: this.board.hash });
    this.seenHashes.add(this.board.hash);
    this.lastMove = index;
    this._seq++;
    this.candidates = [];
    this.clearHint();

    if (captured > 0) this.audio.capture();
    else if (index >= 0) this.audio.move();

    if (this.board.passes >= 2) {
      this.endByScoring();
    } else {
      this.updatePanel();
      this.redraw();
      // 局面变了：请神开着就重算最佳点
      this.refreshGodIfMyTurn();
    }
    return true;
  }

  private maybeAIMove(): void {
    if (this.over || this.mode === 'pvp') return;
    if (this.mode === 'ai' && this.board.toMove === this.human) return;
    void this.aiMove();
  }

  private async aiMove(): Promise<void> {
    if (this.over || this.thinking) return;
    const aiColor = this.board.toMove;
    this.thinking = true;
    this.showThinking(true);
    toggleProgress(document.getElementById('go-think-progress'), true);
    const cfg = GO_LEVELS[this.level];
    const who = aiColor === 1 ? '黑' : '白';
    this.setGlobalStatus(`AI 思考中…(${cfg.name})`);
    setStats(document.getElementById('go-think-stats'), `⏳ <b>${who}·${cfg.name}</b> 搜索中…`);
    this.redraw();

    const seq = ++this._searchSeq;
    const payload = this.payload();
    // 让浏览器先把「思考中」画出来再进搜索（搜索在 Worker 里，不阻塞 UI）
    await new Promise<void>((resolve) => {
      this._aiTimer = setTimeout(resolve, 16);
    });

    const useGod = this.level === 4;
    const res: SearchResult<GoMove> = await this.ai.searchGo(payload, this.level, {
      forceHeuristic: this.forceHeuristic,
      visitsOverride: useGod ? GO_LEVELS[4].visits : undefined,
      timeMsOverride: useGod ? GO_LEVELS[4].timeMs : undefined,
    });

    // 局面在这段时间里可能被重开/悔棋/改设置 → 结果作废
    if (seq !== this._searchSeq) return;

    this.thinking = false;
    this.showThinking(false);
    toggleProgress(document.getElementById('go-think-progress'), false);
    this.setGlobalStatus(this._warming ? this._loadText : 'AI 就绪');

    let move = res.move ? res.move.i : -1;
    // 兜底：引擎若给出非法点，改走第一个合法点
    if (move >= 0 && (move >= this.board.area || !this.board.isLegal(move))) {
      const legal = this.board.legalMask();
      const alt = legal.indexOf(1);
      appendLog(document.getElementById('go-think-log'), '⚠️ 引擎返回非法着法，已改用第一个合法点。');
      move = alt >= 0 ? alt : -1;
    }

    this.candidates = (res.goCandidates ?? []).map((c) => ({ ...c }));
    if (res.ownership) this.ownership = res.ownership;

    const engineName = res.engine === 'go-nn' ? `神经网络${res.backend ? `·${res.backend === 'webgpu' ? 'WebGPU' : res.backend === 'webgl' ? 'WebGL' : res.backend === 'wasm' ? 'WASM' : 'CPU'}` : ''}` : '常识棋兜底';
    if (res.engine === 'go-nn' && !this._engineLogged) {
      this._engineLogged = true;
      appendLog(document.getElementById('go-think-log'), `🧠 <b>KataGo 小网络</b>（${res.modelName ?? 'b6c96'}）已在本地运行 · 后端 ${res.backend ?? '未知'}`);
    }
    if (this.level === 4 && res.engine !== 'go-nn') {
      appendLog(document.getElementById('go-think-log'), '⚠️ 恶魔档本手由兜底 AI 应手（神经网络未就绪）。');
    }

    const winPct = res.winProb !== undefined ? (res.winProb * 100).toFixed(1) : '—';
    const lead = res.scoreLead !== undefined ? res.scoreLead : 0;
    const coord = move < 0 ? '虚手' : this.coordOf(move);
    const top = this.candidates.slice(0, 4).map((c) => `${c.move >= this.board.area ? 'pass' : this.coordOf(c.move)}:${(c.winProb * 100).toFixed(0)}%`).join(' ');
    setStats(
      document.getElementById('go-think-stats'),
      `✅ <b>${who}·${cfg.name}</b>〔${engineName}〕 访问 <b>${res.visits ?? 0}</b> · ${res.ms}ms · 胜率 <b>${winPct}%</b> · 目差 <b>${lead > 0 ? '+' : ''}${lead.toFixed(1)}</b> · 选 <b>${coord}</b>`,
    );
    appendLog(
      document.getElementById('go-think-log'),
      `🧠 ${who} → <b>${coord}</b> · ${engineName} · 访问${res.visits ?? 0} · ${res.ms}ms · 胜率${winPct}% · 目差${lead.toFixed(1)}${top ? `<br><span class="cand">${top}</span>` : ''}`,
    );

    this.playMove(move);
    if (!this.over && this.mode === 'aivai' && this._aivaiRunning) {
      this._aiTimer = setTimeout(() => this.maybeAIMove(), 220);
    }
  }

  /**
   * 求一着：满配搜索但不落子。
   * 反馈分三层，避免「点了没反应」：① 按钮变「计算中…」+ 棋盘上浮出
   * 计算提示层；② 思考面板与控制台日志各写一行；③ 出结果后棋盘上画
   * 绿色虚线环 + 「推荐」角标，并做约 2.6 秒的呼吸动画。
   */
  async hint(): Promise<void> {
    if (this.over || this._hintBusy) return;
    this._hintBusy = true;
    this.clearHint();
    const btn = document.getElementById('go-hint') as HTMLButtonElement | null;
    const btnText = btn?.textContent ?? '💡 求一着';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '🔎 计算中…';
    }
    this.showThinkingText('🔎 正在计算最佳点…（满配搜索）');
    toggleProgress(document.getElementById('go-think-progress'), true);
    setStats(document.getElementById('go-think-stats'), '🔎 <b>求一着</b> 满配搜索中… 正在展开候选');
    this.setGlobalStatus('🔎 正在计算最佳点…');

    const seq = ++this._searchSeq;
    let res;
    try {
      res = await this.ai.searchGo(this.payload(), 4, { forceHeuristic: this.forceHeuristic });
    } finally {
      this._hintBusy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = btnText;
      }
      this.showThinking(false);
      toggleProgress(document.getElementById('go-think-progress'), false);
    }

    if (seq !== this._searchSeq) return;
    this.setGlobalStatus('AI 就绪');
    const move = res.move ? res.move.i : -1;
    const visits = res.visits ?? 0;
    const winPct = res.winProb !== undefined ? (res.winProb * 100).toFixed(1) : '—';
    const lead = res.scoreLead ?? 0;
    if (move < 0) {
      setStats(document.getElementById('go-think-stats'), `💡 建议：<b>虚手</b> · 访问 ${visits}`);
      appendLog(document.getElementById('go-think-log'), '💡 建议：<b>虚手</b>（当前局面已无有价值的大场）');
    } else {
      this.hintMove = move;
      const coord = this.coordOf(move);
      setStats(
        document.getElementById('go-think-stats'),
        `💡 建议 <b>${coord}</b> · 访问 <b>${visits}</b> · ${res.ms}ms · 胜率 <b>${winPct}%</b> · 目差 <b>${lead.toFixed(1)}</b>`,
      );
      appendLog(
        document.getElementById('go-think-log'),
        `💡 建议落子 <b>${coord}</b> · 访问${visits} · 胜率${winPct}% · 目差${lead.toFixed(1)}（棋盘上已用绿圈标出）`,
      );
      this.startHintFlash();
    }
    this.audio.hint();
    this.redraw();
  }

  /** 提示点的呼吸动画：只跑约 2.6 秒，结束后停住（不常驻重绘） */
  private startHintFlash(): void {
    if (this._hintTimer !== null) clearInterval(this._hintTimer);
    this._hintPhase = 0;
    const started = Date.now();
    this._hintTimer = setInterval(() => {
      this._hintPhase = (this._hintPhase + 0.06) % 1;
      this.redraw();
      if (Date.now() - started > 2600) {
        if (this._hintTimer !== null) clearInterval(this._hintTimer);
        this._hintTimer = null;
        this._hintPhase = 0;
        this.redraw();
      }
    }, 70);
  }

  /** 清掉建议标记与它的动画 */
  private clearHint(): void {
    this.hintMove = -1;
    if (this._hintTimer !== null) {
      clearInterval(this._hintTimer);
      this._hintTimer = null;
    }
    this._hintPhase = 0;
  }

  /* ══════════ 请神上身 ══════════ */

  /** 开关请神：开启后常驻显示当前局面最佳点，且每落一手自动重算 */
  toggleGod(): void {
    this.god = !this.god;
    if (!this.god) {
      this.godMove = -1;
      this.godThinking = false;
      this._godDirty = false;
      this.stopGodPulse();
      appendLog(document.getElementById('go-think-log'), '🛌 <b>送神离开</b>：不再显示最佳点。');
      this.syncGodUI();
      this.redraw();
      return;
    }
    appendLog(
      document.getElementById('go-think-log'),
      '🙏 <b>请神上身</b>：棋盘上会常驻标出当前最佳点（满配搜索），每落一手自动重算。',
    );
    // 请神标记本身就是最佳点，绿色「推荐」圈此时是重复信息，直接收掉
    this.clearHint();
    this.startGodPulse();
    this.syncGodUI();
    void this.refreshGodIfMyTurn();
  }

  /**
   * 按轮次决定要不要请神：
   * · 人机模式只有「轮到玩家」时才需要神指——AI 还没应手就抢着算，既白费
   *   算力，神指也会停在马上要变的局面上（与五子棋的请神语义一致）。
   * · 双人模式两边都是人，轮到谁就为谁算。
   * · 互搏观战不需要神指，直接清掉。
   * 不适合算的时候先清掉旧标记，免得指着过期的点。
   */
  private refreshGodIfMyTurn(): void {
    if (!this.god || this.over) return;
    const skip =
      this.mode === 'aivai' || (this.mode === 'ai' && this.board.toMove !== this.human);
    if (skip) {
      if (this.godMove >= 0 || this.godThinking) {
        this.godMove = -1;
        this.syncGodUI();
        this.redraw();
      }
      return;
    }
    void this.refreshGod();
  }

  /**
   * 重算并显示最佳点。
   * 神算期间若局面又变了（玩家抢着落子、悔棋、AI 应手），只置脏标记，
   * 等这一轮算完立刻补一轮——否则神指会停在旧局面，看着像指错了。
   */
  async refreshGod(): Promise<void> {
    if (!this.god || this.over) return;
    if (this.godThinking) {
      this._godDirty = true;
      return;
    }
    // AI 正在思考时先别抢 worker，等它落子后（playMove → refreshGod）再算
    if (this.thinking) {
      this._godDirty = true;
      return;
    }
    this.godThinking = true;
    this.syncGodUI();
    const seq = this._seq;
    const res = await this.ai.searchGo(this.payload(), 4, { forceHeuristic: this.forceHeuristic });
    this.godThinking = false;
    if (!this.god) {
      this.syncGodUI();
      return;
    }
    // 局面已变：结果作废，直接补算
    if (seq !== this._seq) {
      this._godDirty = false;
      this.syncGodUI();
      void this.refreshGod();
      return;
    }
    const move = res.move ? res.move.i : -1;
    this.godMove = move >= 0 ? move : -1;
    if (this.godMove >= 0 && this._godPhase === 0) this._godPhase = 0.25;
    this.syncGodUI();
    this.redraw();
    if (this._godDirty) {
      this._godDirty = false;
      void this.refreshGod();
    }
  }

  /** 神标记的持续呼吸动画（只在请神期间跑） */
  private startGodPulse(): void {
    if (this._godTimer !== null) return;
    this._godTimer = setInterval(() => {
      if (!this.god || this.over) return;
      this._godPhase = (this._godPhase + 0.05) % 1;
      this.redraw();
    }, 90);
  }

  private stopGodPulse(): void {
    if (this._godTimer !== null) {
      clearInterval(this._godTimer);
      this._godTimer = null;
    }
    this._godPhase = 0;
  }

  /** 请神按钮与「神在思考」浮层的状态同步 */
  private syncGodUI(): void {
    const btn = document.getElementById('go-god');
    if (btn) {
      btn.classList.toggle('on', this.god);
      btn.textContent = !this.god ? '🙏 请神上身' : this.godThinking ? '🙏 神算中…' : '🛌 送神离开';
    }
    document.getElementById('go-god-thinking')?.classList.toggle('hidden', !(this.god && this.godThinking));
  }

  /** 形势判断按钮的状态同步（开着时按钮变「关闭」并高亮） */
  private syncEstimateUI(): void {
    const btn = document.getElementById('go-estimate');
    if (!btn) return;
    btn.classList.toggle('on', this.showOwnership);
    btn.textContent = this.showOwnership ? '📊 关闭判断' : '📊 形势判断';
  }

  /** 形势判断开关：点一次算并铺上归属，再点一次关掉 */
  async estimate(): Promise<void> {
    if (this.over) return;
    // 已在显示 → 本次点击就是「关掉」
    if (this.showOwnership) {
      this.showOwnership = false;
      this.syncEstimateUI();
      appendLog(document.getElementById('go-think-log'), '📊 已关闭形势判断。');
      this.audio.select();
      this.redraw();
      return;
    }
    if (this.forceHeuristic) {
      appendLog(document.getElementById('go-think-log'), 'ℹ️ 形势判断需要神经网络，当前为兜底 AI。');
      return;
    }
    const btn = document.getElementById('go-estimate') as HTMLButtonElement | null;
    const btnText = btn?.textContent ?? '📊 形势判断';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '📊 计算中…';
    }
    this.setGlobalStatus('📊 形势判断中…');
    let res;
    try {
      res = await this.ai.estimateGo(this.payload());
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = btnText;
      }
    }
    this.setGlobalStatus('AI 就绪');
    if (!res.ownership) {
      appendLog(document.getElementById('go-think-log'), '⚠️ 形势判断失败（神经网络未就绪）。');
      return;
    }
    this.ownership = res.ownership;
    this.showOwnership = true;
    const wp = res.winProb !== undefined ? (res.winProb * 100).toFixed(1) : '—';
    const lead = res.scoreLead ?? 0;
    appendLog(
      document.getElementById('go-think-log'),
      `📊 <b>形势判断</b>：黑方胜率 ${wp}% · 目差 ${lead > 0 ? '黑+' : '白+'}${Math.abs(lead).toFixed(1)}（再点一次可关闭；终局以数子为准）`,
    );
    this.audio.select();
    this.syncEstimateUI();
    this.redraw();
  }

  undo(): void {
    if (this.thinking || this._aivaiRunning) return;
    const plies = this.mode === 'ai' && this.history.length >= 2 ? 2 : 1;
    let done = 0;
    for (let i = 0; i < plies; i++) {
      const last = this.history.pop();
      if (!last) break;
      this.seenHashes.delete(last.hash);
      this.board.undo();
      done++;
    }
    if (done === 0) return;
    this.over = false;
    this.resultText = '';
    this.hideResult();
    this.lastMove = this.history.length > 0 ? this.history[this.history.length - 1].move : -1;
    this.candidates = [];
    this.clearHint();
    this.godMove = -1;
    this._godDirty = false;
    this.ownership = null;
    this.deadMask = null;
    this.showOwnership = false;
    this._seq++;
    this._searchSeq++;
    this.audio.undo();
    this.syncEstimateUI();
    this.updatePanel();
    this.redraw();
    this.refreshGodIfMyTurn();
    appendLog(document.getElementById('go-think-log'), `↩️ 悔棋 ${done} 手`);
    // 悔到 AI 该走时补一手（例如人机模式悔两手后仍轮到玩家）
    if (!this.over && this.mode === 'ai' && this.board.toMove !== this.human) this.maybeAIMove();
  }

  /** 虚手 */
  pass(): void {
    if (this.over || this.thinking) return;
    if (this.mode === 'ai' && this.board.toMove !== this.human) return;
    if (this.board.passes >= 1) {
      appendLog(document.getElementById('go-think-log'), 'ℹ️ 双方连续虚手，终局数子。');
    }
    this.playMove(-1);
    if (!this.over) this.maybeAIMove();
  }

  resign(): void {
    if (this.over) return;
    const loser = this.mode === 'pvp' ? this.board.toMove : this.human;
    this.finish(`${loser === 1 ? '黑' : '白'}方认输 · ${loser === 1 ? '白' : '黑'}方胜`, loser === 1 ? 2 : 1);
    appendLog(document.getElementById('go-think-log'), `🏳️ ${loser === 1 ? '黑' : '白'}方认输`);
  }

  /** 连续虚手 → 数子 */
  private endByScoring(): void {
    const plain = scorePosition(this.board.stones, this.size, this.komi, this.ruleset, null, this.board.captures);

    // 有网络时用它的归属判定死子，结果更接近人类数子
    let dead: Uint8Array | null = null;
    if (this.ownership && !this.forceHeuristic) {
      dead = new Uint8Array(this.board.area);
      let any = false;
      for (let i = 0; i < this.board.area; i++) {
        const c = this.board.stones[i];
        if (c === 0) continue;
        const own = this.ownership[i]; // 黑视角
        const against = c === 1 ? own < 0 : own > 0;
        if (against && Math.abs(own) >= 0.5) {
          dead[i] = 1;
          any = true;
        }
      }
      if (!any) dead = null;
    }
    this.deadMask = dead;
    const adjusted = dead
      ? scorePosition(this.board.stones, this.size, this.komi, this.ruleset, dead, this.board.captures)
      : plain;
    this.showOwnership = true;
    this.syncEstimateUI();
    if (dead) {
      appendLog(document.getElementById('go-think-log'), '🧮 终局数子：已按神经网络死活判断扣除死子（如不认可可「继续下棋」）。');
    } else {
      appendLog(document.getElementById('go-think-log'), '🧮 终局数子：盘上棋子全部按活棋计算。');
    }
    const winner = adjusted.winner === 0 ? '和棋' : `${adjusted.winner === 1 ? '黑' : '白'}方胜`;
    this.finish(
      `${winner} · 黑 ${adjusted.black.toFixed(1)} : 白 ${adjusted.white.toFixed(1)}（贴目 ${this.komi}）· 差 ${adjusted.margin.toFixed(1)}`,
      adjusted.winner,
    );
  }

  private finish(text: string, winner: 0 | GoColor): void {
    this.over = true;
    this._aivaiRunning = false;
    this.thinking = false;
    this.resultText = text;
    const banner = document.getElementById('go-result');
    if (banner) {
      banner.textContent = text;
      banner.classList.remove('hidden');
    }
    setStats(document.getElementById('go-think-stats'), `🏁 <b>${text}</b>`);
    appendLog(document.getElementById('go-think-log'), `🏁 ${text}`);
    if (winner === 0) this.audio.select();
    else if (this.mode === 'pvp' || winner === this.human) this.audio.win();
    else this.audio.lose();
    this.updatePanel();
    this.redraw();
  }

  /** 终局后继续下棋（对死活判定有异议时用） */
  resume(): void {
    if (!this.over) return;
    if (this.board.passes >= 2) {
      // 撤销最后那次虚手，让对局继续
      this.undo();
    }
    this.over = false;
    this.resultText = '';
    this.hideResult();
    this.deadMask = null;
    this.showOwnership = false;
    this.syncEstimateUI();
    this.updatePanel();
    this.redraw();
    this.refreshGodIfMyTurn();
  }

  /* ══════════ 面板 / 渲染 ══════════ */

  redraw(): void {
    this.renderer.draw(this.renderState());
  }

  private renderState(): GoRenderState {
    return {
      size: this.size,
      stones: this.board.stones,
      toMove: this.board.toMove,
      lastMove: this.lastMove,
      hover: this.hover,
      ghost: !this.over && !this.thinking && this.hitIsPlayable(this.hover),
      ownership: this.showOwnership ? this.ownership : null,
      candidates: this.viz && !this.over ? this.candidates.map((c) => ({ i: c.move, v: c.winProb })) : null,
      deadStones: this.deadMask,
      hint: this.god || this.over ? -1 : this.hintMove,
      hintPhase: this._hintPhase,
      god: this.god && !this.over,
      godMove: this.godMove,
      godPhase: this._godPhase,
      dimmed: this.thinking || this.over,
    };
  }

  private hitIsPlayable(index: number): boolean {
    if (index < 0) return false;
    if (this.mode === 'pvp') return true;
    if (this.mode === 'aivai') return false;
    return this.board.toMove === this.human;
  }

  private updatePanel(): void {
    const set = (id: string, text: string): void => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const turnName = this.board.toMove === 1 ? '黑方' : '白方';
    const turn = document.getElementById('go-turn');
    if (turn) {
      if (this.over) turn.textContent = '对局结束';
      else if (this.mode === 'ai') turn.textContent = this.board.toMove === this.human ? `轮到你（${this.human === 1 ? '黑' : '白'}）` : `AI（${turnName}）思考中`;
      else turn.textContent = `轮到 ${turnName} 落子`;
    }
    set('go-steps', String(this.history.length));
    set('go-capture-black', String(this.board.captures[0]));
    set('go-capture-white', String(this.board.captures[1]));
    set('go-komi-text', String(this.komi));
    set('go-status', this.over ? '已终局' : this.thinking ? 'AI 思考中' : '对弈中');

    // 局势条：有网络归属时按归属点差估计，否则按双方子数
    const area = this.board.area;
    let blackShare = 0.5;
    if (this.ownership) {
      let sum = 0;
      for (let i = 0; i < area; i++) sum += this.ownership[i];
      blackShare = Math.min(1, Math.max(0, 0.5 + (sum / area) * 0.5));
    } else {
      const b = this.board.stoneCount() > 0 ? this.board.stones.reduce((n, v) => n + (v === 1 ? 1 : 0), 0) : 0;
      const w = this.board.stones.reduce((n, v) => n + (v === 2 ? 1 : 0), 0);
      blackShare = b + w > 0 ? b / (b + w) : 0.5;
    }
    const bar = document.getElementById('go-score-bar');
    if (bar) bar.style.width = `${(blackShare * 100).toFixed(1)}%`;
    set('go-score-text', this.ownership ? `AI 判断黑 ${(blackShare * 100).toFixed(1)}%` : '（点「形势判断」看 AI 判断）');
  }

  private coordOf(index: number): string {
    const letters = 'ABCDEFGHJKLMNOPQRST';
    const x = index % this.size;
    const y = (index / this.size) | 0;
    return `${letters[x] ?? '?'}${this.size - y}`;
  }

  private hideResult(): void {
    document.getElementById('go-result')?.classList.add('hidden');
  }

  private showThinking(on: boolean): void {
    document.getElementById('go-thinking')?.classList.toggle('hidden', !on);
  }

  /** 显示计算提示层并写入文案（与 AI 落子共用同一个浮层） */
  private showThinkingText(text: string): void {
    const el = document.getElementById('go-thinking');
    if (!el) return;
    el.innerHTML = `<div class="spinner"></div>${text}`;
    el.classList.remove('hidden');
  }

  private setGlobalStatus(t: string): void {
    (window as any).setGlobalStatus?.(t);
  }

  private payload(): GoPositionPayload {
    const prev = this.replayTo(this.history.length - 1);
    const prevPrev = this.replayTo(this.history.length - 2);
    return {
      size: this.size,
      stones: this.board.stones.slice(),
      koPoint: this.board.koPoint,
      toMove: this.board.toMove,
      komi: this.komi,
      moveHistory: this.history.slice(-8).map((h) => ({ move: h.move, color: h.color })),
      prevStones: prev?.stones ?? null,
      prevKoPoint: prev?.koPoint ?? -1,
      prevPrevStones: prevPrev?.stones ?? null,
      prevPrevKoPoint: prevPrev?.koPoint ?? -1,
    };
  }

  /** 重放到第 plyCount 手之后的局面（用于给网络「上一手/上上手」局面） */
  private replayTo(plyCount: number): { stones: Uint8Array; koPoint: number } | null {
    if (plyCount <= 0) return null;
    const b = new GoBoard(this.size);
    for (let i = 0; i < plyCount; i++) {
      if (!b.play(this.history[i].move)) return null;
    }
    return { stones: b.stones.slice(), koPoint: b.koPoint };
  }

  /* ══════════ 交互 ══════════ */

  private paintSeg(id: string, value: string): void {
    document.getElementById(id)?.querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) => b.classList.toggle('on', b.dataset.v === value));
  }

  private segWire(id: string, fn: (v: string) => void): void {
    const el = document.getElementById(id);
    el?.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      fn(b.dataset.v!);
    }));
  }

  private wireEvents(): void {
    let down: { x: number; y: number } | null = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const idx = this.renderer.hitTest(e.clientX, e.clientY);
      if (idx !== this.hover) {
        this.hover = idx;
        this.redraw();
      }
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      this.redraw();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const isTap = down !== null && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12;
      down = null;
      const idx = this.renderer.hitTest(e.clientX, e.clientY);
      this.hover = -1;
      if (!isTap || idx < 0) {
        this.redraw();
        return;
      }
      if (this.over || this.thinking) {
        this.redraw();
        return;
      }
      if (this.mode === 'aivai') return;
      if (this.mode === 'ai' && this.board.toMove !== this.human) return;
      if (!this.playMove(idx)) return;
      this.maybeAIMove();
    });
    this.canvas.addEventListener('pointercancel', () => {
      down = null;
      this.hover = -1;
      this.redraw();
    });

    this.segWire('go-mode', (v) => {
      this.mode = v as GameMode;
      if (v === 'aivai') this._aivaiRunning = true;
      this.newGame();
    });
    this.segWire('go-color', (v) => {
      this.human = Number(v) as GoColor;
      this.newGame();
    });
    this.segWire('go-level', (v) => {
      const lv = Number(v) as GoLevel;
      if (lv === 4 && (this._nnReady !== true || this._enginePref === 'heuristic')) {
        appendLog(document.getElementById('go-think-log'), '🚫 <b>恶魔档不可用</b>：需要神经网络就绪。');
        this.paintSeg('go-level', String(this.level));
        return;
      }
      this.level = lv;
      applyDemonTheme('go', this.level, this.audio);
      setStats(document.getElementById('go-think-stats'), `难度切换 → <b>${GO_LEVELS[lv].name}</b> · 访问上限 ${GO_LEVELS[lv].visits} · 思考上限 ${(GO_LEVELS[lv].timeMs / 1000).toFixed(1)}s`);
      appendLog(document.getElementById('go-think-log'), `⚙️ 难度切换 → <b>${GO_LEVELS[lv].name}</b>${lv === 4 ? ' · <span style="color:#ff6b6b">满火力</span>' : ''}`);
      this.syncEngineUI();
    });
    this.segWire('go-size', (v) => {
      this.size = Number(v);
      appendLog(document.getElementById('go-think-log'), `📐 棋盘切换 → <b>${this.size} 路</b>（贴目 ${defaultKomi(this.size)}）`);
      this.newGame();
    });
    this.segWire('go-engine', (v) => {
      this._enginePref = v === 'heuristic' ? 'heuristic' : 'auto';
      if (this._enginePref === 'heuristic' && this.level === 4) {
        this.level = 2;
        this.paintSeg('go-level', '2');
        applyDemonTheme('go', this.level, this.audio);
      }
      appendLog(
        document.getElementById('go-think-log'),
        this._enginePref === 'heuristic'
          ? '🔧 引擎切换 → <b>内置常识棋（弱）</b>：不加载、不等网络'
          : '🔧 引擎切换 → <b>KataGo 神经网络</b>（未就绪时先用常识棋应手）',
      );
      this.syncEngineUI();
    });

    const viz = document.getElementById('go-viz') as HTMLInputElement | null;
    viz?.addEventListener('change', (e) => {
      this.viz = (e.target as HTMLInputElement).checked;
      this.redraw();
    });

    document.getElementById('go-new')?.addEventListener('click', () => this.newGame());
    document.getElementById('go-undo')?.addEventListener('click', () => this.undo());
    document.getElementById('go-pass')?.addEventListener('click', () => this.pass());
    document.getElementById('go-resign')?.addEventListener('click', () => this.resign());
    document.getElementById('go-hint')?.addEventListener('click', () => void this.hint());
    document.getElementById('go-god')?.addEventListener('click', () => this.toggleGod());
    document.getElementById('go-estimate')?.addEventListener('click', () => void this.estimate());
    document.getElementById('go-resume')?.addEventListener('click', () => this.resume());
    document.getElementById('go-stop')?.addEventListener('click', () => {
      this._aivaiRunning = false;
      appendLog(document.getElementById('go-think-log'), '⏹ 已停止 AI 互搏（可继续手动落子）');
    });
    document.getElementById('go-sound')?.addEventListener('click', (e) => {
      this.audio.enabled = !this.audio.enabled;
      const btn = e.target as HTMLButtonElement;
      btn.textContent = this.audio.enabled ? '🔊 音效开' : '🔇 音效关';
      btn.classList.toggle('on', this.audio.enabled);
      if (this.level === 4) {
        if (this.audio.enabled) this.audio.startBGM();
        else this.audio.stopBGM();
      }
    });
  }
}
