/* ────────────────────────────────────────────────────────────
 *  junqi-controller.ts — 军棋对局控制器（人机 / AI 互搏）
 *
 *  阶段：摆阵（明棋人机可选，自定义布阵）→ 对战。
 *  玩法：明棋（全明）/ 揭棋（双方暗置随机布阵，首动翻明）。
 *  揭棋细则：暗子按通用走法（铁路直线 + 公路一步）移动，走子即
 *  翻明；交战双方同时翻明；翻出地雷/军旗则本手作罢、轮换对方。
 * ──────────────────────────────────────────────────────────── */

import type { GameMode, Difficulty, SearchResult, JqMove } from '../types';
import {
  randomBoard, randomLayout, legalMoves, hasAnyMove, other,
  validateLayout, layoutComplete, autofillLayout, makeJqMove, PIECE_COUNTS,
  rowOf, colOf, isCamp, ownHalf,
  type Board, type Side, type Piece, type PType,
} from '../junqi/rules';
import { renderJunqi, pxToNode, JQ_W, JQ_H, type JunqiRenderState } from '../junqi/render';
import { JQ_LEVEL_CONFIG, JQ_MATE, describeMove } from '../junqi/ai';
import { AIBridge } from '../ai/ai-bridge';
import type { AudioEngine } from '../ui/audio';
import { Stats } from '../ui/stats';
import { appendLog, setStats, toggleProgress } from '../ui/format';

type PlayStyle = 'open' | 'flip';
type Phase = 'setup' | 'battle';

interface Snap {
  board: Board;
  turn: Side;
  lastMove: { from: number; to: number } | null;
  moveNo: number;
}

const sideName = (s: Side): string => (s === 'r' ? '红' : '蓝');
const sideTag = (s: Side): string => (s === 'r' ? '#b13a2f' : '#2b5f8f');

export class JunqiController {
  private board: Board = [];
  private turn: Side = 'r';
  private phase: Phase = 'setup';
  private style: PlayStyle = 'open';
  private mode: GameMode = 'ai';
  private human: Side = 'r';
  private level: Difficulty = 2;
  private flipView = false;

  private sel: number | null = null;
  private targets: number[] = [];
  private lastMove: { from: number; to: number } | null = null;
  private hintMove: { from: number; to: number } | null = null;
  private hand: PType | null = null;
  private over = false;
  private winner: Side | null = null;
  private draw = false;
  private history: Snap[] = [];
  private moveNo = 0;
  private thinking = false;

  private aiSeq = 0;
  private _haltAivai = false;
  private _aiTimer: ReturnType<typeof setTimeout> | null = null;
  private _down: { x: number; y: number } | null = null;
  private setupErr: string | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private ai: AIBridge,
    private audio: AudioEngine,
  ) {
    canvas.width = JQ_W;
    canvas.height = JQ_H;
    this.wireEvents();
    this.resetGame();
  }

  /* ── 对局生命周期 ─────────────────────────────────────────── */

  /** 按当前设置重开：AI互搏直接开战，人机（明棋/揭棋）进入摆阵 */
  resetGame(): void {
    this.aiSeq++;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
    this._haltAivai = false;
    this.thinking = false;
    this.showThinking(false);
    toggleProgress(document.getElementById('jq-think-progress'), false);
    this.sel = null;
    this.targets = [];
    this.lastMove = null;
    this.hintMove = null;
    this.hand = null;
    this.over = false;
    this.winner = null;
    this.draw = false;
    this.history = [];
    this.moveNo = 0;
    this.hideResult();
    this.clearLogs();
    if (this.mode === 'aivai') {
      this.startBattle(true);
    } else {
      // 人机：明棋 / 揭棋都可自定义摆阵（揭棋里己方棋子自己可见）
      this.phase = 'setup';
      this.flipView = this.human === 'b';
      this.setupErr = null;
      this.board = new Array(60).fill(null);
      const log = document.getElementById('jq-log');
      if (log) log.innerHTML = '<div class="empty">摆阵完成后开始对战</div>';
      this.updatePanel();
      this.redraw();
    }
  }

  private startBattle(randomBoth: boolean): void {
    this.phase = 'battle';
    this.flipView = this.mode === 'ai' && this.human === 'b';
    if (randomBoth) {
      this.board = randomBoard();
    } else {
      // 摆阵阶段的己方棋子已在 board 上，补上对方随机布阵
      const opp = other(this.human);
      for (const { node, piece } of randomLayout(opp, 500)) this.board[node] = piece;
    }
    if (this.style === 'flip') {
      // 揭棋：全部暗置（对对方暗置；自己始终可见己方）
      for (const p of this.board) if (p) p.hidden = true;
    }
    this.turn = 'r';
    this.updatePanel();
    this.redraw();
    const styleName = this.style === 'flip' ? '揭棋' : '明棋';
    if (this.mode === 'aivai') {
      appendLog(document.getElementById('jq-log'), `🤖 <b>AI 互搏观战开始</b>（${styleName} · ${JQ_LEVEL_CONFIG[this.level].name}），红先蓝后恶战到底`);
      this.scheduleAi(650);
    } else {
      appendLog(document.getElementById('jq-log'), `⚔ <b>对战开始</b>（${styleName} · 你执${sideName(this.human)}，${JQ_LEVEL_CONFIG[this.level].name} AI）`);
      if (this.turn !== this.human) this.scheduleAi(650);
    }
  }

  /* ── 摆阵 ────────────────────────────────────────────────── */

  private trayNeed(): Partial<Record<PType, number>> {
    const placed: Partial<Record<PType, number>> = {};
    for (const p of this.board) if (p && p.side === this.human) placed[p.type] = (placed[p.type] ?? 0) + 1;
    const need: Partial<Record<PType, number>> = {};
    for (const [t, n] of PIECE_COUNTS) {
      const left = n - (placed[t] ?? 0);
      if (left > 0) need[t] = left;
    }
    return need;
  }

  private setupRandom(): void {
    this.board = new Array(60).fill(null);
    for (const { node, piece } of randomLayout(this.human, 1)) this.board[node] = piece;
    this.hand = null;
    this.setupErr = null;
    this.audio.select();
    this.updatePanel();
    this.redraw();
  }

  private setupClear(): void {
    this.board = new Array(60).fill(null);
    this.hand = null;
    this.setupErr = null;
    this.audio.undo();
    this.updatePanel();
    this.redraw();
  }

  private setupAutofill(): void {
    const err = autofillLayout(this.board, this.human);
    this.hand = null;
    this.setupErr = err;
    this.audio[err ? 'bad' : 'select']();
    this.updatePanel();
    this.redraw();
  }

  private handleSetupClick(node: number): void {
    if (!ownHalf(node, this.human) || isCamp(node)) {
      this.audio.bad();
      this.setupErr = '只能放在己方半场，行营必须留空';
      this.updatePanel();
      return;
    }
    this.setupErr = null;
    const existing = this.board[node];
    if (this.hand) {
      if (existing) this.board[node] = null; // 取回后再放置（交换）
      this.board[node] = { id: 1 + Math.floor(Math.random() * 9999), side: this.human, type: this.hand };
      this.audio.select();
    } else if (existing) {
      this.board[node] = null;
      this.hand = existing.type; // 取回手中
      this.audio.undo();
    } else {
      this.audio.bad();
      return;
    }
    this.updatePanel();
    this.redraw();
  }

  /* ── 对战点击 ────────────────────────────────────────────── */

  private handleBattleClick(node: number): void {
    if (this.over || this.thinking) return;
    if (this.mode === 'aivai') return;
    if (this.turn !== this.human) return;
    const p = this.board[node];

    if (this.sel !== null && this.targets.includes(node)) { this.applyMove(this.sel, node); return; }
    if (p && p.side === this.human) {
      this.sel = node;
      this.targets = legalMoves(this.board, node);
      this.audio.select();
      this.updatePanel();
      this.redraw();
      return;
    }
    this.sel = null;
    this.targets = [];
    this.updatePanel();
    this.redraw();
  }

  private onClick(e: PointerEvent): void {
    const node = pxToNode(this.canvas, e.clientX, e.clientY, this.flipView);
    if (node === null) return;
    if (this.phase === 'setup') this.handleSetupClick(node);
    else this.handleBattleClick(node);
  }

  /* ── 走子（人类与 AI 共用） ───────────────────────────────── */

  private snapshot(): void {
    this.history.push({
      board: this.board.map((p) => (p ? { ...p } : null)),
      turn: this.turn,
      lastMove: this.lastMove ? { ...this.lastMove } : null,
      moveNo: this.moveNo,
    });
    if (this.history.length > 400) this.history.shift();
  }

  private applyMove(from: number, to: number): void {
    const att = this.board[from]!;
    const def = this.board[to] ?? null;
    const defWasHidden = def?.hidden === true;
    this.snapshot();
    this.hintMove = null;
    this.sel = null;
    this.targets = [];

    // 揭棋：攻击即翻明守方；攻方无论胜负都不翻明（胜则继续潜伏，亡则子消失）
    if (def && defWasHidden) def.hidden = false;

    let text = '';
    const rec = makeJqMove(this.board, from, to);
    const flagWin = rec.flag;
    const revealNote = defWasHidden && !this.knownToViewer(def!) ? `（翻明：${def!.type}）` : '';
    const an = this.label(att);
    const dn = def ? this.label(def) : '';
    if (!def) {
      text = `${an} → ${coord(to)}`;
    } else if (rec.flag) {
      text = `${an} 扛旗！${revealNote}`;
    } else if (rec.attOut && rec.defOut) {
      text = `${an} ⚔ ${dn} · 同归于尽${revealNote}`;
    } else if (rec.attOut) {
      text = `${an} 撞上 ${dn} · 阵亡${revealNote}`;
    } else {
      text = `${an} 吃 ${dn}${revealNote}`;
    }

    this.moveNo++;
    this.lastMove = { from, to };
    appendLog(document.getElementById('jq-log'),
      `<b style="color:${sideTag(att.side)}">${this.moveNo}.${sideName(att.side)}</b> ${text}`);
    if (!flagWin) this.audio.move();
    this.turn = other(this.turn);
    if (flagWin) { this.finish(att.side); return; }
    this.afterMoveCommon();
  }

  /** 观察者（人机模式下的人类玩家）是否知道该子身份 */
  private knownToViewer(p: Piece): boolean {
    return this.mode === 'ai' ? p.side === this.human : !p.hidden;
  }

  /** 日志中的棋子名：观察者未知身份的暗子显示「暗子」 */
  private label(p: Piece): string {
    return `${sideName(p.side)}${this.knownToViewer(p) ? p.type : '暗子'}`;
  }

  /** 走子后的回合切换 / 终局 / 调度下一手 */
  private afterMoveCommon(): void {
    if (!this.over) {
      if (!hasAnyMove(this.board, this.turn)) {
        this.finish(other(this.turn));
      } else if (this.moveNo >= 240) {
        this.finish(null);
      }
    }
    this.updatePanel();
    this.redraw();
    if (this.over) return;
    if (this.mode === 'aivai') {
      if (!this._haltAivai) this.scheduleAi(420);
    } else if (this.turn !== this.human) {
      this.scheduleAi(280);
    }
  }

  /* ── AI ──────────────────────────────────────────────────── */

  private scheduleAi(delay: number): void {
    if (this._aiTimer) clearTimeout(this._aiTimer);
    this._aiTimer = setTimeout(() => { this._aiTimer = null; void this.aiMove(); }, delay);
  }

  private async aiMove(): Promise<void> {
    if (this.over || this.phase !== 'battle' || (this.mode === 'ai' && this.turn === this.human)) return;
    const seq = ++this.aiSeq;
    const side = this.turn;
    this.thinking = true;
    this.showThinking(true);
    toggleProgress(document.getElementById('jq-think-progress'), true);
    const cfg = JQ_LEVEL_CONFIG[this.level];
    setStats(document.getElementById('jq-think-stats'),
      `⏳ <b>${sideName(side)}·${cfg.name}</b> 运算中… depth${cfg.depth}${this.style === 'flip' ? ' · 揭棋暗子按期望值评估' : ''}`);
    this.redraw();
    const delay = this.level === 4 ? 80 : 40;
    setTimeout(async () => {
      const res = await this.ai.searchJq(this.cloneBoard(), side, this.level, this.mode, this.style === 'flip', this.moveNo);
      if (seq !== this.aiSeq || this.phase !== 'battle' || this.over || this.turn !== side) { this.thinking = false; return; }
      this.thinking = false;
      this.showThinking(false);
      toggleProgress(document.getElementById('jq-think-progress'), false);
      this.setGlobalStatus('AI 就绪');
      if (!res.move) { this.finish(other(side)); return; }
      this.logThink(side, cfg.name, res);
      this.applyMove(res.move.from, res.move.to);
    }, delay);
  }

  private cloneBoard(): Board {
    return this.board.map((p) => (p ? { ...p } : null));
  }

  private logThink(side: Side, name: string, res: SearchResult<JqMove>): void {
    const m = res.move!;
    const ev = res.eval >= JQ_MATE - 1000 ? '扛旗必胜' : res.eval <= -JQ_MATE + 1000 ? '局势危殆' : (res.eval > 0 ? `+${res.eval}` : `${res.eval}`);
    const pv = (res.pv || []).map((x) => describeMove(this.board, x)).join(' → ') || describeMove(this.board, m);
    setStats(document.getElementById('jq-think-stats'),
      `✅ <b>${sideName(side)}·${name}</b> depth${res.depth} · 节点 <b>${res.nodes.toLocaleString()}</b> · ${res.ms}ms · 评估 <b>${ev}</b><br>主变：${pv}`);
    const top = (res.scores || []).slice(0, 4)
      .map((s) => `${describeMove(this.board, s)}:${s.v >= JQ_MATE - 1000 ? '扛旗' : Math.round(s.v)}`)
      .join(' · ');
    appendLog(document.getElementById('jq-think-log'),
      `🧠 depth<b>${res.depth}</b> · 节点${res.nodes.toLocaleString()} · ${res.ms}ms · 评估${ev} · 选<b>${describeMove(this.board, m)}</b><br><span class="cand">${top}</span>`);
  }

  private stopAivai(): void {
    this._haltAivai = true;
    this.aiSeq++;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
    this.thinking = false;
    this.showThinking(false);
    toggleProgress(document.getElementById('jq-think-progress'), false);
    if (!this.over) appendLog(document.getElementById('jq-log'), '⏹ <b>已暂停 AI 互搏</b>，可悔棋或重新开局');
    this.updatePanel();
    this.setGlobalStatus('AI 就绪');
  }

  /* ── 悔棋 / 求一着 ───────────────────────────────────────── */

  private undo(): void {
    if (this.phase !== 'battle' || !this.history.length) return;
    this.aiSeq++;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
    this.thinking = false;
    this.showThinking(false);
    toggleProgress(document.getElementById('jq-think-progress'), false);
    this.sel = null;
    this.targets = [];
    this.hintMove = null;
    if (this.mode === 'aivai') {
      this._haltAivai = true;
      this.restore(this.history.pop()!);
      if (!this.over) appendLog(document.getElementById('jq-log'), '↩ 悔一手 · <b>互搏已暂停</b>');
    } else {
      this.restore(this.history.pop()!);
      if (this.turn !== this.human && this.history.length) this.restore(this.history.pop()!);
      if (this.turn !== this.human) {
        // 退到开局且轮到 AI（如执蓝开局 AI 先手），让 AI 重新走
        this.scheduleAi(500);
      }
    }
    this.over = false;
    this.winner = null;
    this.draw = false;
    this.hideResult();
    this.audio.undo();
    this.updatePanel();
    this.redraw();
  }

  private restore(s: Snap): void {
    this.board = s.board;
    this.turn = s.turn;
    this.lastMove = s.lastMove;
    this.moveNo = s.moveNo;
  }

  private async hint(): Promise<void> {
    if (this.phase !== 'battle' || this.over || this.thinking || this.mode === 'aivai') return;
    if (this.turn !== this.human) return;
    const seq = ++this.aiSeq;
    this.thinking = true; // 独占 Worker：避免与 AI 搜索请求重叠
    setStats(document.getElementById('jq-think-stats'), '👉 恶魔正在附体算招… depth6 全开，请稍候');
    setTimeout(async () => {
      try {
        const res = await this.ai.hintJq(this.cloneBoard(), this.turn, this.mode, this.style === 'flip', this.moveNo);
        if (seq !== this.aiSeq || this.over || this.phase !== 'battle') return;
        const m = res.move;
        if (m) {
          this.hintMove = m;
          const ev = res.eval >= JQ_MATE - 1000 ? '扛旗在望' : res.eval;
          appendLog(document.getElementById('jq-think-log'),
            `💡 <b>恶魔支招</b> depth${res.depth} · 推荐<b>${describeMove(this.board, m)}</b> · 评估${ev} · 节点${res.nodes.toLocaleString()}`);
          setStats(document.getElementById('jq-think-stats'),
            `💡 恶魔支招 depth${res.depth} · 推荐 ${describeMove(this.board, m)} · ${res.ms}ms`);
          this.audio.hint();
          this.redraw();
          setTimeout(() => {
            if (this.hintMove === m) { this.hintMove = null; this.redraw(); }
          }, 4000);
        }
      } finally {
        this.thinking = false;
      }
    }, 40);
  }

  /* ── 终局 ────────────────────────────────────────────────── */

  private finish(winner: Side | null): void {
    this.over = true;
    this.draw = winner === null;
    this.winner = winner;
    const banner = document.getElementById('jq-result');
    if (banner) {
      banner.classList.remove('hidden');
      if (winner === null) {
        banner.textContent = '🤝 双方鏖战 240 手，判和！';
      } else {
        const byMove = hasAnyMove(this.board, other(winner)) ? '扛旗致胜' : '对手无子可动';
        if (this.mode === 'aivai') {
          banner.textContent = `🤖 互搏结束！${sideName(winner)}方 AI 获胜（${byMove}）`;
        } else if (winner === this.human) {
          banner.textContent = `🎉 你执${sideName(this.human)}战胜了 AI！（${byMove}）`;
        } else {
          banner.textContent = `🤖 AI（${sideName(winner)}方）获胜（${byMove}）`;
        }
      }
    }
    if (this.mode === 'ai' && !this.draw) {
      const humanWin = this.winner === this.human;
      this.audio[humanWin ? 'win' : 'lose']();
      Stats.add(humanWin);
    } else {
      this.audio.win();
    }
    this.showThinking(false);
    toggleProgress(document.getElementById('jq-think-progress'), false);
    this.updatePanel();
  }

  /* ── UI 更新 ─────────────────────────────────────────────── */

  private counts(): { r: number; b: number } {
    let r = 0;
    let b = 0;
    for (const p of this.board) { if (p?.side === 'r') r++; else if (p?.side === 'b') b++; }
    return { r, b };
  }

  redraw(): void {
    const st: JunqiRenderState = {
      board: this.board,
      sel: this.sel,
      targets: this.targets,
      lastMove: this.lastMove,
      over: this.over,
      flipView: this.flipView,
      hintMove: this.hintMove,
      setup: this.phase === 'setup',
      setupSide: this.human,
      hand: this.hand,
      viewer: this.mode === 'ai' ? this.human : null,
    };
    renderJunqi(this.canvas, st);
  }

  private updatePanel(): void {
    const setup = this.phase === 'setup';
    const c = this.counts();
    const turnEl = document.getElementById('jq-turn');
    if (turnEl) {
      let t: string;
      if (setup) t = `摆阵中 · ${sideName(this.human)}方布阵`;
      else if (this.over) t = this.draw ? '和棋' : `${sideName(this.winner!)}方获胜`;
      else t = `轮到 ${sideName(this.turn)}方 走棋${this.mode === 'aivai' ? ' · AI 互搏' : ''}${this.thinking ? ' · 思考中' : ''}`;
      turnEl.textContent = t;
      turnEl.classList.toggle('red', this.turn === 'r');
    }
    const set = (id: string, v: string) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('jq-rcount', String(c.r));
    set('jq-bcount', String(c.b));
    set('jq-moves', String(this.moveNo));
    set('jq-status', setup ? '摆阵阶段' : this.over ? '已结束' : (this.thinking ? 'AI 思考中…' : (this.sel !== null ? `已选 ${this.label(this.board[this.sel]!)} · ${this.targets.length} 个落点` : '对弈中')));

    // 摆阵面板 / 对战控制显隐（人机模式下明棋 / 揭棋都可摆阵）
    const setupOnly = this.mode === 'ai';
    const showSetup = setupOnly && this.phase === 'setup';
    document.getElementById('jq-setup')?.classList.toggle('hidden', !showSetup);
    document.getElementById('jq-color-row')?.classList.toggle('hidden', this.mode === 'aivai');
    const start = document.getElementById('jq-start') as HTMLButtonElement | null;
    if (showSetup) {
      const err = validateLayout(this.board, this.human);
      const done = layoutComplete(this.board, this.human);
      if (start) start.disabled = !done;
      const msg = document.getElementById('jq-setup-msg');
      if (msg) {
        if (err) { msg.textContent = `⚠️ ${err}`; msg.className = 'setup-msg err'; }
        else if (this.setupErr) { msg.textContent = `⚠️ ${this.setupErr}`; msg.className = 'setup-msg err'; }
        else if (done) { msg.textContent = '✅ 布阵完成，可以开始对战'; msg.className = 'setup-msg ok'; }
        else { msg.textContent = `已放 ${this.countPlaced()}/25 枚${this.hand ? ` · 手持：${this.hand}` : ''}`; msg.className = 'setup-msg'; }
      }
      this.renderTray();
    }
    // 对战控制按钮
    document.getElementById('jq-undo')?.classList.toggle('hidden', showSetup);
    document.getElementById('jq-hint')?.classList.toggle('hidden', this.mode === 'aivai');
    document.getElementById('jq-stop')?.classList.toggle('hidden', !(this.mode === 'aivai' && !this.over && !this._haltAivai));
    // 提示行
    const hintEl = document.getElementById('jq-hint-line');
    if (hintEl) {
      hintEl.textContent = setup
        ? '点击下方兵种放入棋盘 · 点击已放的子可取回'
        : this.style === 'flip'
          ? '揭棋：只可见己方棋子 · 攻击暗子即翻明守方 · 攻方不翻明'
          : '点击棋子查看可走位置 · 再点目标落子';
    }
  }

  private countPlaced(): number {
    let n = 0;
    for (const p of this.board) if (p && p.side === this.human) n++;
    return n;
  }

  private renderTray(): void {
    const tray = document.getElementById('jq-tray');
    if (!tray) return;
    const need = this.trayNeed();
    tray.innerHTML = '';
    for (const [t] of PIECE_COUNTS) {
      const left = need[t] ?? 0;
      const chip = document.createElement('button');
      chip.className = 'jq-chip' + (left === 0 ? ' used' : '') + (this.hand === t ? ' on' : '');
      chip.innerHTML = `<span class="jq-chip-name">${t}</span><span class="jq-chip-n">${left}</span>`;
      chip.addEventListener('click', () => {
        if ((need[t] ?? 0) === 0) { this.audio.bad(); return; }
        this.hand = this.hand === t ? null : t;
        this.audio.select();
        this.updatePanel();
        this.redraw();
      });
      tray.appendChild(chip);
    }
  }

  private showThinking(on: boolean): void {
    document.getElementById('jq-thinking')?.classList.toggle('hidden', !on);
  }
  private hideResult(): void {
    document.getElementById('jq-result')?.classList.add('hidden');
  }
  private clearLogs(): void {
    const log = document.getElementById('jq-log');
    if (log) log.innerHTML = '<div class="empty">暂无棋谱</div>';
    const think = document.getElementById('jq-think-log');
    if (think) think.innerHTML = '<div class="empty">对局时自动输出深度 / 节点 / 评估 / 主变</div>';
    setStats(document.getElementById('jq-think-stats'), '等待 AI 行棋…');
  }
  private setGlobalStatus(t: string): void { (window as any).setGlobalStatus?.(t); }

  /* ── 事件绑定 ────────────────────────────────────────────── */

  private wireEvents(): void {
    this.canvas.addEventListener('pointerdown', (e) => { this._down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => {
      const isTap = this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) < 12;
      this._down = null;
      if (!isTap) return;
      this.onClick(e);
    });
    this.canvas.addEventListener('pointercancel', () => { this._down = null; });

    this.seg('jq-style', (v) => { this.style = v as PlayStyle; this.resetGame(); });
    this.seg('jq-mode', (v) => { this.mode = v as GameMode; this.resetGame(); });
    this.seg('jq-color', (v) => { this.human = v as Side; this.resetGame(); });
    this.seg('jq-level', (v) => {
      this.level = +v as Difficulty;
      const cfg = JQ_LEVEL_CONFIG[this.level];
      setStats(document.getElementById('jq-think-stats'), `难度切换 → <b>${cfg.name}</b> · depth${cfg.depth}`);
      appendLog(document.getElementById('jq-think-log'), `⚙️ 难度切换 → <b>${cfg.name}</b> depth${cfg.depth}${this.level === 4 ? ' · 恶魔全开，迭代加深至 6 层' : ''}`);
    });

    document.getElementById('jq-new')?.addEventListener('click', () => this.resetGame());
    document.getElementById('jq-undo')?.addEventListener('click', () => this.undo());
    document.getElementById('jq-hint')?.addEventListener('click', () => void this.hint());
    document.getElementById('jq-stop')?.addEventListener('click', () => this.stopAivai());
    document.getElementById('jq-random')?.addEventListener('click', () => this.setupRandom());
    document.getElementById('jq-clear')?.addEventListener('click', () => this.setupClear());
    document.getElementById('jq-autofill')?.addEventListener('click', () => this.setupAutofill());
    document.getElementById('jq-start')?.addEventListener('click', () => {
      if (!layoutComplete(this.board, this.human)) return;
      this.audio.win();
      this.startBattle(false);
    });
    document.getElementById('jq-sound')?.addEventListener('click', (e) => {
      this.audio.enabled = !this.audio.enabled;
      const b = e.currentTarget as HTMLElement;
      b.classList.toggle('on', this.audio.enabled);
      b.textContent = this.audio.enabled ? '🔊 音效开' : '🔇 音效关';
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

function coord(i: number): string {
  return `${rowOf(i) + 1}-${colOf(i) + 1}`;
}
