/* ────────────────────────────────────────────────────────────
 *  controllers/othello-controller.ts — 黑白棋对局控制器
 *
 *  与五子棋控制器同一套交互骨架：模式（人机/双人/AI 互搏）、执子、四档难度、
 *  悔棋、求一着、请神上身、思考日志、音效与恶魔主题。
 *
 *  黑白棋特有的两点：
 *    · 停一手（pass）：本方无合法点时自动跳过，日志与顶栏如实播报；双方连续
 *      停手即终局数子。
 *    · 翻转动画：落子后先播放被翻棋子的翻面动画，再落到最终颜色。棋盘数据
 *      在落子瞬间就已更新，动画只负责「视觉上从旧颜色翻到新颜色」。
 * ──────────────────────────────────────────────────────────── */

import type { OthBoard, OthDisc, Difficulty, GameMode, Pt, OthMove, SearchResult } from '../types';
import {
  CELLS, PASS_MOVE, fromCells, legalMoves, maskToIndices, other, place, toCells, isPass, result,
} from '../othello/rules';
import type { OthPosition } from '../othello/rules';
import { LEVEL_CONFIG, ptOfIndex, indexOfPt, notationOf } from '../othello/search';
import { quickEvalCells, counts } from '../othello/evaluate';
import { AIBridge } from '../ai/ai-bridge';
import { AudioEngine } from '../ui/audio';
import { Stats } from '../ui/stats';
import { renderOth, pxToCellOth, othScorePercent, type OthRenderState } from '../ui/othello-renderer';
import { appendLog, setStats, toggleProgress } from '../ui/format';
import { applyDemonTheme, DEMON_NAME } from '../ui/demon';
import { mustEl } from '../ui/dom';

interface HistoryEntry {
  /** 落点对外索引；停一手用 -1 */
  index: number;
  /** 落子方 */
  side: OthDisc;
  /** 这一手翻掉的数量 */
  flipped: number;
  /** 被翻掉的棋子索引（动画中要展示「翻面」） */
  flippedCells: number[];
  /** 落子前的棋盘快照（悔棋直接还原） */
  before: OthBoard;
}

const RESULTS_OVERRIDE = 0;

export class OthelloController {
  private canvas: HTMLCanvasElement;
  private ai: AIBridge;
  private audio: AudioEngine;

  private board: OthBoard = new Uint8Array(CELLS);
  private turn: OthDisc = 1;
  private over = false;
  private winner: 0 | OthDisc = 0;
  private mode: GameMode = 'ai';
  private human: OthDisc = 1;
  private level: Difficulty = 2;
  private history: HistoryEntry[] = [];
  private last: Pt | null = null;
  private lastFlipped: number[] = [];
  private flipping: number[] = [];
  private flipStart = 0;
  private thinking = false;
  private hintPos: Pt | null = null;
  private showLegal = true;
  private god = false;
  private godMove: Pt | null = null;
  private godThinking = false;
  private _godDirty = false;
  private _hintBusy = false;
  private _posSeq = 0;
  private _searchSeq = 0;
  private _aiTimer: ReturnType<typeof setTimeout> | null = null;
  private _haltAivai = false;
  private _down: { x: number; y: number } | null = null;
  private _passNotice = '';
  /**
   * 引擎选择。
   *   'experimental' = Egaroucid（GPL-3.0，1.4MB wasm，64MB 内存）——默认，
   *     实测在同档位对内置引擎 7 战全胜（净胜 23~43 子）
   *   'builtin' = 内置 JS 引擎（零加载、零额外内存），作为可选与兜底
   */
  private enginePref: 'experimental' | 'builtin' = 'experimental';
  /** Egaroucid 是否就绪：null = 未知/加载中，true/false = 已定 */
  private _egarReady: boolean | null = null;
  private _warming = false;
  private _warmed = false;
  private _loadText = '🧠 Egaroucid 引擎预热中…';
  private _egarLogged = false;
  /** 引擎回退只播报一次 */
  private _demonFallbackWarned = false;

  constructor(canvas: HTMLCanvasElement, ai: AIBridge, audio: AudioEngine) {
    this.canvas = canvas;
    this.ai = ai;
    this.audio = audio;
    this.wireEvents();
    this.newGame();
    this.startAnimLoop();
  }

  /* ── 局面工具 ── */

  private position(): OthPosition {
    return fromCells(this.board, this.turn);
  }

  private legalIdx(): number[] {
    if (this.over) return [];
    return legalMoves(this.position());
  }

  private state(): OthRenderState {
    const isHumanTurn = this.mode !== 'aivai' && (this.mode === 'pvp' || this.turn === this.human);
    return {
      board: this.board,
      turn: this.turn,
      over: this.over,
      human: this.human,
      showLegal: this.showLegal && isHumanTurn && !this.thinking,
      legal: this.legalIdx(),
      last: this.last,
      lastFlipped: this.lastFlipped,
      hint: this.hintPos,
      god: this.god,
      godMove: this.godMove,
      thinking: this.thinking,
      flipProgress: this.flipping.length ? Math.min(1, (performance.now() - this.flipStart) / 260) : 1,
      flipping: this.flipping,
    };
  }

  private startAnimLoop(): void {
    const loop = () => {
      const animating = this.flipping.length > 0 && performance.now() - this.flipStart < 300;
      if (animating || this.hintPos || (this.god && this.godMove && !this.over)) {
        if (!animating && this.flipping.length) this.flipping = [];
        this.redraw();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  redraw(): void {
    renderOth(this.canvas, this.state());
  }

  isHumanTurn(): boolean {
    if (this.over || this.thinking) return false;
    if (this.mode === 'aivai') return false;
    if (this.mode === 'pvp') return true;
    return this.turn === this.human;
  }

  /* ── 对局流程 ── */

  newGame(): void {
    this._searchSeq++;
    this._posSeq++;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
    // 标准开局：中央四子。对外索引 i = y*8+x（y 自上而下），
    // 故 a1=56 … h8=7；这里直接写下四枚：d4白 / e4黑 / d5黑 / e5白
    this.board = new Uint8Array(CELLS);
    // 标准开局：白 d4/e5、黑 e4/d5（index 与记谱一致：(rank-1)*8 + file）
    this.board[indexOfPt({ x: 3, y: 3 })] = 2; // d4 白
    this.board[indexOfPt({ x: 4, y: 3 })] = 1; // e4 黑
    this.board[indexOfPt({ x: 3, y: 4 })] = 1; // d5 黑
    this.board[indexOfPt({ x: 4, y: 4 })] = 2; // e5 白
    this.turn = 1;
    this.over = false;
    this.winner = 0;
    this.history = [];
    this.last = null;
    this.lastFlipped = [];
    this.flipping = [];
    this.thinking = false;
    this.hintPos = null;
    this.godMove = null;
    this.godThinking = false;
    this._passNotice = '';
    this._haltAivai = false;
    this.hideResult();
    this.updatePanel();
    this.redraw();
    const cfg = LEVEL_CONFIG[this.level];
    const modeName = this.mode === 'aivai' ? '🤖AI互搏观战' : (this.mode === 'pvp' ? '双人对战' : '人机对战');
    setStats(mustEl('o-think-stats'), `新对局 · ${modeName} · 难度 <b>${cfg.name}</b> · 黑先`);
    this.proceed();
  }

  /** 现在是否该由 AI 落子 */
  private aiToMove(): boolean {
    if (this.over || this.thinking) return false;
    if (this.mode === 'aivai') return !this._haltAivai;
    if (this.mode === 'ai') return this.turn !== this.human;
    return false;
  }

  /**
   * 一手棋（落子或停手）结束后推进对局：该 AI 动就让 AI 动，否则刷新神指。
   *
   * 所有会改变行棋权的地方都必须走这里。坑：停手可能把行棋权**交回刚刚落子的一方**
   * ——AI 落子后人类无合法点被判停一手，于是又轮到 AI——此时若不重新排一次 AI 思考，
   * 顶栏就停在「⏸ 黑方无子可下，自动停一手 · 轮到 白方 落子」，AI 不动、人也下不了。
   */
  private proceed(): void {
    if (!this.aiToMove()) { this.refreshGod(); return; }
    // AI 互搏连走时不直接递归，隔一拍再起手，避免一长串同步调用堆在一次事件里
    if (this.mode === 'aivai') this._aiTimer = setTimeout(() => this.aiMove(), 10);
    else this.aiMove();
  }

  /** 落子（人类/AI 共用）。index < 0 视为停一手。 */
  private applyMove(index: number, side: OthDisc, silent = false): boolean {
    if (this.over) return false;
    const pos = this.position();
    if (index < 0) {
      // 停一手：不落子，只换手
      this.history.push({ index: -1, side, flipped: 0, flippedCells: [], before: this.board.slice() });
      this.turn = other(side);
      this._passNotice = `${side === 1 ? '黑' : '白'}方无子可下，停一手`;
      if (!silent) {
        appendLog(mustEl('o-think-log'), `⏸ <b>${side === 1 ? '黑' : '白'}方停一手</b>（无合法落点）`);
        this.audio.hint();
      }
      this.afterMoveCommon();
      return true;
    }

    const pl = place(pos, index);
    if (!pl) return false;
    const flippedCells = maskToIndices(pl.flippedMask);
    this.history.push({ index, side, flipped: pl.flipped, flippedCells, before: this.board.slice() });
    this.board = toCells(pl.pos);
    this.turn = other(side);
    this.last = ptOfIndex(index);
    // 动画：先以旧颜色显示被翻棋子，再翻成新颜色
    this.flipping = flippedCells.slice();
    this.flipStart = performance.now();
    this.lastFlipped = flippedCells;
    this.hintPos = null;
    this.godMove = null;
    this._posSeq++;
    this._passNotice = '';
    if (!silent) this.audio.move();
    this.afterMoveCommon();
    return true;
  }

  /** 每次落子/停手后统一：推进动画帧、判定终局、切换回合方 */
  private afterMoveCommon(): void {
    const st = this.position();
    // 双方都无合法点 → 终局数子
    if (result(st).over) {
      this.finish(result(st).winner);
      return;
    }
    // 轮走方无合法点：自动停一手
    const nextLegal = legalMoves(this.position());
    if (!nextLegal.length) {
      const side = this.turn;
      this._passNotice = `${side === 1 ? '黑' : '白'}方无子可下，自动停一手`;
      appendLog(mustEl('o-think-log'), `⏸ <b>${side === 1 ? '黑' : '白'}方无子可下</b>，自动停一手`);
      this.history.push({ index: -1, side, flipped: 0, flippedCells: [], before: this.board.slice() });
      this.turn = other(side);
      const gg = result(this.position());
      if (gg.over) { this.finish(gg.winner); return; }
    }
    this.updatePanel();
    this.redraw();
  }

  private finish(winner: 0 | OthDisc): void {
    this.over = true;
    this.winner = winner;
    const { black, white } = counts(this.board);
    const banner = mustEl('o-result');
    banner.classList.remove('hidden');
    const score = `黑 ${black} : ${white} 白`;
    const modeName = this.mode === 'aivai' ? 'AI互搏' : this.mode === 'pvp' ? '' : '';
    void modeName;
    void RESULTS_OVERRIDE;
    if (winner === 0) {
      banner.textContent = `🤝 和棋！${score}`;
      this.audio.win();
      Stats.add(false);
    } else if (this.mode === 'ai') {
      const humanWon = winner === this.human;
      banner.textContent = humanWon ? `🎉 你赢了！${score}` : `🤖 AI 获胜，${score}，再接再厉`;
      if (humanWon) this.audio.lose(); else this.audio.lose();
      Stats.add(humanWon);
    } else if (this.mode === 'pvp') {
      banner.textContent = `🏆 ${winner === 1 ? '黑方' : '白方'} 获胜！${score}`;
      this.audio.win();
      Stats.add(true);
    } else {
      banner.textContent = `🤖 互搏结束：${winner === 1 ? '黑方 AI' : '白方 AI'} 获胜（${score}）`;
      this.audio.win();
    }
    appendLog(mustEl('o-think-log'), `🏁 <b>终局</b> ${score} · ${winner === 0 ? '和棋' : (winner === 1 ? '黑胜' : '白胜')}`);
    this.updatePanel();
    this.redraw();
  }

  /* ── AI ── */

  private async aiMove(): Promise<void> {
    if (this.over) return;
    this.thinking = true;
    this.showThinking(true);
    toggleProgress(mustEl('o-think-progress'), true);
    const cfg = LEVEL_CONFIG[this.level];
    this.setGlobalStatus(`AI 思考中…(${cfg.name})`);
    this.redraw();
    setStats(mustEl('o-think-stats'), `⏳ <b>${cfg.name}</b> 运算中… 正在搜索落点`);
    const seq = ++this._searchSeq;
    const delay = this.level === 4 ? 60 : (this.level === 3 ? 40 : 20);
    this._aiTimer = setTimeout(async () => {
      const side = this.turn;
      if (seq !== this._searchSeq) return;
      const res: SearchResult<OthMove> = await this.ai.searchOth(this.board.slice(), side, this.level, this.mode, this.history.length, this.engineKind);
      if (seq !== this._searchSeq) return;
      this.thinking = false;
      this.showThinking(false);
      toggleProgress(mustEl('o-think-progress'), false);

      const who = side === 1 ? '黑' : '白';
      const mv = res.move;
      const log = mustEl('o-think-log');
      const engineName = res.engine === 'egaroucid' ? '🧠 Egaroucid Web' : '内置引擎';
      if (res.engine === 'egaroucid' && !this._egarLogged) {
        this._egarLogged = true;
        appendLog(log, '🧠 <b>Egaroucid 引擎已接入</b>（1.4MB wasm · 自包含评估表 + 5.3 万局开局库 · 线程隔离运行）');
      } else if (this.enginePref === 'experimental' && this._egarReady === false && res.engine === 'js') {
        if (!this._demonFallbackWarned) {
          this._demonFallbackWarned = true;
          appendLog(log, '⚠️ <b>Egaroucid 加载失败</b>，已回退内置 JS 引擎（刷新页面可重试）。');
        }
      }
      if (!mv || isPass(mv)) {
        // 引擎给出「停一手」。先自己核一遍本地合法点：若仍有合法点却停手，
        // 等于白送行棋权（甚至把局面又交回自己，空转成死循环）。
        const legal = legalMoves(this.position());
        if (legal.length) {
          appendLog(log, `⚠️ <b>引擎未给出着法</b>，本地仍有合法点，改下 <b>${notationOf(legal[0])}</b>`);
          this.applyMove(legal[0], side);
          this.setGlobalStatus('AI 就绪');
          this.proceed();
          return;
        }
        setStats(mustEl('o-think-stats'), `⏸ <b>${who}</b> 无合法落点，停一手`);
        appendLog(log, `⏸ <b>${who}方停一手</b>（引擎确认无合法落点）`);
        this.applyMove(-1, side, true);
        this.setGlobalStatus('AI 就绪');
        this.proceed();
        return;
      }

      const top = (res.scores || []).slice(0, 5)
        .map((s, i) => `#${i + 1}${ptName(s)}(翻${s.f ?? 0})`).join(' ');
      const ev = fmtOthEval(res.eval);
      setStats(mustEl('o-think-stats'),
        `✅ <b>${who}·${cfg.name}</b>〔${engineName}〕${res.book ? ' 开局谱 ' : ''}depth${res.depth} · 节点 <b>${res.nodes.toLocaleString()}</b> · ${res.ms}ms · 评估 <b>${ev}</b> · 选 ${ptName(mv)}（翻 ${mv.f ?? 0}）`);
      appendLog(log, `🧠 <b>${engineName}</b> · ${res.book ? '开局谱 ' : ''}depth<b>${res.depth}</b> · 节点${res.nodes.toLocaleString()} · ${res.ms}ms · 评估${ev} · 选<b>${ptName(mv)}</b> 翻 ${mv.f ?? 0} 子<br><span class="cand">${top}</span>`);

      this.applyMove(indexOfPt(mv), side);
      this.setGlobalStatus('AI 就绪');
      this.proceed();
    }, delay);
  }

  stopAivai(): void {
    this._haltAivai = true;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
    if (!this.over) appendLog(mustEl('o-think-log'), '⏹ <b>已停止AI互搏</b>，可悔棋/新开一局');
    this.updatePanel();
    this.setGlobalStatus('AI 就绪');
  }

  private stopAivaiSilent(): void {
    this._haltAivai = true;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
  }

  /* ── 人类操作 ── */

  placeHuman(index: number): boolean {
    if (!this.isHumanTurn()) return false;
    if (!this.legalIdx().includes(index)) return false;
    const side = this.turn;
    this.applyMove(index, side);
    this.proceed();
    return true;
  }

  undo(): void {
    if (!this.history.length) return;
    // AI 还在思考时也允许悔棋：作废这次搜索、收起「思考中」，
    // 否则玩家点了悔棋却毫无反应（曾是这样）。
    if (this.thinking) {
      this._searchSeq++;
      this.thinking = false;
      this.showThinking(false);
      toggleProgress(mustEl('o-think-progress'), false);
      if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
      this.setGlobalStatus('AI 就绪');
    }
    this._searchSeq++;
    this._posSeq++;
    // 回到「轮到人类」的那一步；双人模式只回退一手
    const target = this.human;
    let guard = 0;
    do {
      const h = this.history.pop();
      if (!h) break;
      this.board = h.before.slice();
      this.turn = h.side;
      this.last = null;
      this.lastFlipped = [];
      this.flipping = [];
      guard++;
      if (this.mode !== 'ai') break;
      if (this.history.length === 0) break;
    } while (this.turn !== target && guard < 4);

    this.over = false;
    this.winner = 0;
    this.hintPos = null;
    this.godMove = null;
    this._passNotice = '';
    this.hideResult();
    this.updatePanel();
    this.redraw();
    this.audio.undo();
    if (this.mode === 'aivai') { this.stopAivaiSilent(); this.refreshGod(); return; }
    this.proceed();
  }

  async showHint(): Promise<void> {
    if (this.over || this.thinking || this.godThinking || this._hintBusy) return;
    if (!this.legalIdx().length) return;
    this._hintBusy = true;
    this.syncGodUI();
    const seq = this._posSeq;
    setStats(mustEl('o-think-stats'), '👉 恶魔正在支招… 满配搜索中，请稍候');
    setTimeout(async () => {
      try {
        const res = await this.ai.hintOth(this.board.slice(), this.turn, this.mode, this.history.length, this.engineKind);
        if (seq !== this._posSeq) return;
        const m = res.move;
        if (m && !isPass(m)) {
          this.hintPos = { x: m.x, y: m.y };
          appendLog(mustEl('o-think-log'),
            `💡 <b>恶魔支招</b> depth${res.depth} · 推荐<b>${ptName(m)}</b>（翻 ${m.f ?? 0}）· 评估${fmtOthEval(res.eval)} · 节点${res.nodes.toLocaleString()} · ${res.ms}ms`);
          setStats(mustEl('o-think-stats'), `💡 恶魔支招 depth${res.depth} · 推荐 ${ptName(m)} · 翻 ${m.f ?? 0} · ${res.ms}ms`);
          this.redraw();
          this.audio.hint();
          setTimeout(() => { this.hintPos = null; this.redraw(); }, 4000);
        } else {
          appendLog(mustEl('o-think-log'), '💡 当前无合法落点，只能停一手');
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
      appendLog(mustEl('o-think-log'), `🙏 <b>${DEMON_NAME}附体！请神上身成功</b>，每手都会标出最佳落点`);
      this.syncGodUI();
      this.refreshGod();
    } else {
      this.godMove = null;
      this.godThinking = false;
      this._godDirty = false;
      appendLog(mustEl('o-think-log'), '🛌 已送神，神指消失');
      this.syncGodUI();
      this.redraw();
    }
  }

  private refreshGod(): void {
    if (!this.god || this.over || this.thinking) return;
    if (this.mode === 'aivai' && !this._haltAivai) return;
    if (!this.legalIdx().length) return;
    if (this.godThinking) { this._godDirty = true; return; }
    this.godThinking = true;
    this.syncGodUI();
    const seq = this._posSeq;
    setTimeout(async () => {
      try {
        const res = await this.ai.hintOth(this.board.slice(), this.turn, this.mode, this.history.length, this.engineKind);
        if (this.god && seq === this._posSeq) {
          const m = res.move;
          this.godMove = m && !isPass(m) ? { x: m.x, y: m.y } : null;
          this.redraw();
        }
      } finally {
        this.godThinking = false;
        this.syncGodUI();
        if (this._godDirty) { this._godDirty = false; this.refreshGod(); }
      }
    }, 40);
  }

  /* ── UI ── */

  private syncGodUI(): void {
    const btn = mustEl('o-god');
    btn.classList.toggle('on', this.god);
    btn.textContent = !this.god ? '🙏 请神上身' : (this.godThinking ? '🙏 神算中…' : '🛌 送神离开');
    const busy = this.god && this.godThinking;
    mustEl('othello-god-thinking').classList.toggle('hidden', !busy);
    toggleProgress(mustEl('o-think-progress'), busy || this._hintBusy || this.thinking);
    this.updatePanel();
  }

  private updatePanel(): void {
    const turnEl = mustEl('othello-turn');
    const t = this.turn === 1 ? '黑方' : '白方';
    turnEl.textContent = this.over
      ? `对局结束 · ${this.winner === 0 ? '和棋' : (this.winner === 1 ? '黑胜' : '白胜')}`
      : `${this._passNotice ? `⏸ ${this._passNotice} · ` : ''}轮到 ${t} 落子${this.mode === 'aivai' ? ' · AI互搏中' : ''}${this.god ? ' · 神附体👇' : ''}`;
    turnEl.classList.toggle('red', this.turn === 1);
    const { black, white } = counts(this.board);
    const set = (id: string, v: string): void => { mustEl(id).textContent = v; };
    set('o-black', String(black));
    set('o-white', String(white));
    set('o-steps', String(this.history.filter((h) => h.index >= 0).length));
    set('o-status', this.over ? '已结束' : (this.thinking ? 'AI 思考中…' : (this.godThinking ? '神算中…' : '对弈中')));
    const pct = othScorePercent(this.board, this.human);
    const bar = mustEl('o-score-bar');
    bar.style.width = `${pct}%`;
    const v = quickEvalCells(this.board, this.turn);
    const txt = mustEl('o-score-text');
    txt.textContent = v > 220 ? '我方大优' : v > 80 ? '我方稍优' : v < -220 ? 'AI 大优' : v < -80 ? 'AI 稍优' : '均势';
  }

  private showThinking(on: boolean): void {
    mustEl('othello-thinking').classList.toggle('hidden', !on);
  }

  /**
   * 预热 Egaroucid 引擎。进入黑白棋页面时调用：1.4MB wasm + 评估表/开局库初始化，
   * 提前加载可以让玩家第一手就吃到真引擎，而不是先被内置引擎应手。
   */
  warmUp(): void {
    if (this._warmed || this._warming) return;
    this._warming = true;
    this.setGlobalStatus(this._loadText);
    void this.ai
      .warmUpOth((loaded, total, src) => {
        const mb = (n: number) => (n / 1048576).toFixed(1);
        const pct = total ? Math.round((loaded / total) * 100) : 0;
        if (src === 'prefetch' && total) {
          this._loadText = `🧠 Egaroucid 引擎预热中… ${pct}%（${mb(loaded)}/${mb(total)} MB）`;
          this.setGlobalStatus(this._loadText);
        }
      })
      .then(({ ok, error }) => {
        this._warming = false;
        this._warmed = ok;
        this._egarReady = ok;
        this.syncEngineUI();
        if (ok) {
          this.setGlobalStatus('AI 就绪');
          appendLog(mustEl('o-think-log'), '🧠 <b>Egaroucid 引擎已预加载</b>（1.4MB wasm）· 落子无需等待');
          this._egarLogged = true;
        } else {
          this.setGlobalStatus('AI 就绪（内置引擎）');
          appendLog(mustEl('o-think-log'),
            `⚠️ <b>Egaroucid 加载失败</b>，已回退内置引擎：${error ?? '未知原因'}`);
        }
      });
  }

  /** 传给 worker 的引擎选择：Egaroucid 未就绪时先用内置引擎应手 */
  private get engineKind(): 'builtin' | 'egar' {
    return this.enginePref === 'experimental' && this._egarReady === true ? 'egar' : 'builtin';
  }

  /** 刷新「引擎」区块与说明文字 */
  private syncEngineUI(): void {
    this.paintSeg('o-engine', this.enginePref);
    const note = mustEl('o-engine-note');
    if (this.enginePref === 'builtin') {
      note.textContent = '当前使用内置 JS 引擎（加载 0 字节、零额外内存）。';
    } else if (this._egarReady === true) {
      note.textContent = '当前使用 Egaroucid（1.4MB wasm · 64MB 内存 · 自包含评估表与 5.3 万局开局库）。';
    } else if (this._egarReady === false) {
      note.textContent = 'Egaroucid 加载失败，已回退内置 JS 引擎（刷新页面可重试）。';
    } else {
      note.textContent = 'Egaroucid 加载中；完成前先用内置引擎应手。';
    }
  }

  private paintSeg(id: string, value: string): void {
    mustEl(id).querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) => b.classList.toggle('on', b.dataset.v === value));
  }

  private hideResult(): void {
    mustEl('o-result').classList.add('hidden');
  }

  private setGlobalStatus(t: string): void {
    (window as any).setGlobalStatus?.(t);
  }

  /* ── 事件 ── */

  private wireEvents(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      this._down = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const isTap = this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) < 12;
      this._down = null;
      if (!isTap) return;
      const idx = pxToCellOth(this.canvas, e);
      if (idx == null) return;
      this.placeHuman(idx);
    });
    this.canvas.addEventListener('pointercancel', () => { this._down = null; });

    const seg = (id: string, fn: (v: string) => void) => {
      const el = mustEl(id);
      el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        fn(b.dataset.v!);
      }));
    };

    seg('o-mode', (v) => {
      this.mode = v as GameMode;
      if (this.mode === 'aivai') appendLog(mustEl('o-think-log'), '🤖 <b>AI互搏观战开始</b>，双方都用当前难度对战');
      this.newGame();
    });
    seg('o-color', (v) => { this.human = Number(v) as OthDisc; this.newGame(); });
    seg('o-level', (v) => {
      this.level = Number(v) as Difficulty;
      applyDemonTheme('o', this.level, this.audio);
      const cfg = LEVEL_CONFIG[this.level];
      setStats(mustEl('o-think-stats'), `难度切换 → <b>${cfg.name}</b> · 时间预算 ${cfg.timeMs}ms`);
      appendLog(mustEl('o-think-log'), `⚙️ 难度切换 → <b>${cfg.name}</b>${this.level === 4 ? ' · <span style="color:#ff6b6b">恶魔全开</span>' : ''}`);
    });

    seg('o-engine', (v) => {
      this.enginePref = v === 'experimental' ? 'experimental' : 'builtin';
      appendLog(mustEl('o-think-log'), this.enginePref === 'builtin'
        ? '🔧 引擎切换 → <b>内置 JS 引擎</b>'
        : '🔧 引擎切换 → <b>Egaroucid</b>（1.4MB wasm · 64MB 内存）');
      if (this.enginePref === 'experimental') this.warmUp();
      this.syncEngineUI();
    });

    const legalToggle = mustEl<HTMLInputElement>('o-legal');
    legalToggle.addEventListener('change', () => { this.showLegal = !!legalToggle.checked; this.redraw(); });

    mustEl('o-new').addEventListener('click', () => this.newGame());
    mustEl('o-undo').addEventListener('click', () => this.undo());
    mustEl('o-hint').addEventListener('click', () => this.showHint());
    mustEl('o-god').addEventListener('click', () => this.toggleGod());
    mustEl('o-stop').addEventListener('click', () => this.stopAivai());
    mustEl('o-sound').addEventListener('click', (e) => {
      this.audio.enabled = !this.audio.enabled;
      const btn = e.target as HTMLButtonElement;
      btn.textContent = this.audio.enabled ? '🔊 音效开' : '🔇 音效关';
      btn.classList.toggle('on', this.audio.enabled);
      if (this.level === 4) { if (this.audio.enabled) this.audio.startBGM(); else this.audio.stopBGM(); }
    });
  }
}

/**
 * 黑白棋评估显示：引擎给的是「子数差」口径（正 = 当前行棋方净胜子数）。
 * 不能用象棋/五子棋的 fmtEval —— 那个在阈值边界会把 0 判成「必胜」。
 */
function fmtOthEval(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 60) return '胜势';
  if (v <= -60) return '败势';
  if (v > 0) return `+${v}`;
  return `${v}`;
}

/** 界面坐标 → 记谱（a1 在左下，换算只在 othello/search.ts 里做） */
function ptName(m: Pt): string {
  if (isPass(m) || m.x < 0) return '停一手';
  return notationOf(indexOfPt(m));
}

export { PASS_MOVE };
