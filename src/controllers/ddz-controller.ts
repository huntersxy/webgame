/* ───────────────────────────────────────────────────────────────
 *  src/controllers/ddz-controller.ts — 斗地主控制器
 *
 *  DOM 牌桌（不用 Canvas）：手牌扇面点选、叫分条、出牌/不出/提示，
 *  两个电脑座位。AI 走 DouZero（Web Worker + onnxruntime-web），
 *  模型就绪前用内置牌理启发式顶班；叫分固定走启发式强度表。
 * ─────────────────────────────────────────────────────────────── */

import type { AudioEngine } from '../ui/audio';
import { appendLog } from '../ui/format';
import { Stats } from '../ui/stats';
import { mustEl } from '../ui/dom';
import { DdzGame, type DdzCard } from '../ddz/game';
import { type Move, type MoveInfo, getMoveType } from '../ddz/rules';
import { DouzeroEngine } from '../ddz/douzero';
import { bidScore, heuristicMove } from '../ddz/heuristic';

const SEAT_NAMES = ['你', '电脑·右家', '电脑·左家'];
const RANK_LABEL: Record<number, string> = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 17: '2', 20: '小王', 30: '大王',
};
const SUIT_LABEL = ['♠', '♥', '♣', '♦'];
const TYPE_NAME: Record<number, string> = {
  0: '不出', 1: '单', 2: '对', 3: '三张', 4: '炸弹', 5: '王炸',
  6: '三带一', 7: '三带二', 8: '顺子', 9: '连对', 10: '飞机',
  11: '飞机带单', 12: '飞机带对', 13: '四带二', 14: '四带两对',
};

export class DoudizhuController {
  private game = new DdzGame();
  private engine = new DouzeroEngine();
  private enginePref: 'auto' | 'heuristic' = 'auto';
  private selected = new Set<number>();
  private hintList: Move[] = [];
  private hintIdx = -1;
  private seq = 0;
  private busy = false;
  private shownPlayed: (Move | 'pass' | null)[] = [null, null, null];
  private nnReady: boolean | null = null;
  private soundOn = true;

  constructor(private readonly audio: AudioEngine) {
    // 手牌点选
    mustEl('ddz-hand').addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.ddz-card');
      if (!el || el.dataset.idx === undefined) return;
      if (this.game.phase !== 'play' || this.game.turn !== 0 || this.busy) return;
      const idx = Number(el.dataset.idx);
      if (this.selected.has(idx)) this.selected.delete(idx);
      else this.selected.add(idx);
      this.audio.select();
      this.renderHand();
    });

    for (const btn of document.querySelectorAll<HTMLButtonElement>('#ddz-bidbar [data-bid]')) {
      btn.addEventListener('click', () => this.humanBid(Number(btn.dataset.bid)));
    }

    mustEl('ddz-play').addEventListener('click', () => this.humanPlay());
    mustEl('ddz-pass').addEventListener('click', () => this.humanPass());
    mustEl('ddz-hint').addEventListener('click', () => this.hint());
    mustEl('ddz-new').addEventListener('click', () => this.newGame());

    mustEl('ddz-sound').addEventListener('click', () => {
      this.soundOn = !this.soundOn;
      this.audio.enabled = this.soundOn;
      const btn = mustEl('ddz-sound');
      btn.textContent = this.soundOn ? '🔊 音效开' : '🔇 音效关';
      btn.classList.toggle('on', this.soundOn);
    });

    for (const btn of document.querySelectorAll<HTMLButtonElement>('#ddz-engine button')) {
      btn.addEventListener('click', () => {
        this.enginePref = btn.dataset.v === 'heuristic' ? 'heuristic' : 'auto';
        for (const b of document.querySelectorAll('#ddz-engine button')) {
          b.classList.toggle('on', b === btn);
        }
        this.syncEngineUI();
      });
    }

    this.newGame();
  }

  /* ══════════ 生命周期 ══════════ */

  redraw(): void {
    this.renderAll();
  }

  /** 进入视图时调用：预取 DouZero 模型（约 17MB，带进度条） */
  warmUp(): void {
    if (this.engine.ready() || this.busyLoading()) return;
    this.showEngineLoad(true);
    this.engine.warmUp((loaded, total, label) => {
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      this.setEngineLoad(pct, `${label}（${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(0)} MB）`);
    }).then((ok) => {
      this.showEngineLoad(false);
      this.nnReady = ok;
      this.syncEngineUI();
      if (ok) {
        this.setGlobalStatus('AI 就绪');
        appendLog(mustEl('ddz-log'), '🧠 <b>DouZero 模型已就绪</b> · 三个角色网络全部加载完成');
      } else {
        this.setGlobalStatus('AI 就绪（内置牌理兜底）');
        appendLog(
          mustEl('ddz-log'),
          `⚠️ <b>DouZero 模型加载失败</b>：${this.engine.error() ?? '未知原因'}<br>已回退到内置牌理 AI；刷新页面可重试。`,
        );
      }
    });
  }

  private loadingFlag = false;
  private busyLoading(): boolean {
    return this.loadingFlag;
  }

  /* ══════════ 新局与回合驱动 ══════════ */

  private newGame(): void {
    this.seq += 1;
    this.busy = false;
    this.selected.clear();
    this.hintList = [];
    this.hintIdx = -1;
    this.shownPlayed = [null, null, null];
    this.game = new DdzGame();
    mustEl('ddz-result').classList.add('hidden');
    appendLog(mustEl('ddz-log'), '🃏 <b>新一局开始</b> · 发牌完毕，开始叫分');
    this.renderAll();
    this.advance();
  }

  /** 回合推进：叫分/出牌阶段自动调度（人操作则等待按钮） */
  private advance(): void {
    const seq = this.seq;
    if (this.game.phase === 'bid') {
      this.renderAll();
      if (this.game.bidTurn === 0) {
        this.renderBidBar();
        return;
      }
      this.busy = true;
      this.renderTurnPill(`${SEAT_NAMES[this.game.bidTurn]} 叫分中…`);
      window.setTimeout(() => {
        if (seq !== this.seq) return;
        this.busy = false;
        const seat = this.game.bidTurn;
        let v = bidScore(this.game.hands[seat]);
        if (v <= this.game.highestBid) v = 0;
        const advanced = this.game.bid(seat, v);
        appendLog(
          mustEl('ddz-log'),
          `<b>${SEAT_NAMES[seat]}</b> ${v === 0 ? '不叫' : `叫 <b>${v} 分</b>`}`,
        );
        this.audio.move();
        if (advanced && this.game.playing) {
          this.onLandlordDecided();
        }
        this.advance();
      }, 700);
      return;
    }

    if (this.game.phase === 'play') {
      this.renderAll();
      const seat = this.game.turn;
      if (seat === 0) {
        this.busy = false;
        this.syncActionButtons();
        this.renderTurnPill('轮到你出牌');
        return;
      }
      this.busy = true;
      this.syncActionButtons();
      this.renderTurnPill(`${SEAT_NAMES[seat]} 思考中…`);
      window.setTimeout(() => {
        if (seq !== this.seq) return;
        this.runAiMove(seat, seq);
      }, 650);
      return;
    }

    // over
    this.busy = false;
    this.syncActionButtons();
    this.renderTurnPill('对局结束');
    this.renderResult();
  }

  private async runAiMove(seat: number, seq: number): Promise<void> {
    const state = this.game.snapshot();
    let move: Move;
    if (this.enginePref === 'auto' && this.engine.ready()) {
      try {
        const r = await this.engine.decide(state, seat);
        move = r.move;
      } catch {
        move = heuristicMove(state, seat);
      }
    } else {
      move = heuristicMove(state, seat);
    }
    if (seq !== this.seq) return;

    this.applyAiMove(seat, move);
    this.busy = false;
    this.advance();
  }

  private applyAiMove(seat: number, move: Move): void {
    if (move.length === 0) {
      this.game.pass(seat);
      this.shownPlayed[seat] = 'pass';
      appendLog(mustEl('ddz-log'), `<b>${SEAT_NAMES[seat]}</b> 不出`);
    } else {
      const err = this.game.playCodes(seat, move);
      if (err) {
        // 理论不可达：AI 只从合法集合里选。兜底：不出。
        this.game.pass(seat);
        this.shownPlayed[seat] = 'pass';
        appendLog(mustEl('ddz-log'), `<b>${SEAT_NAMES[seat]}</b> 不出`);
      } else {
        this.shownPlayed[seat] = [...move];
        const info = getMoveType(move);
        appendLog(
          mustEl('ddz-log'),
          `<b>${SEAT_NAMES[seat]}</b> ${this.moveText(move, info)}`,
        );
      }
    }
    this.audio.move();
    this.selected.clear();
    this.hintList = [];
    this.hintIdx = -1;
    this.renderAll();
  }

  private onLandlordDecided(): void {
    const ll = this.game.landlordSeat;
    appendLog(
      mustEl('ddz-log'),
      `👑 <b>${SEAT_NAMES[ll]} 当地主</b> · 底分 <b>${this.game.highestBid}</b> 分，拿走 3 张底牌`,
    );
  }

  /* ══════════ 人类操作 ══════════ */

  private humanBid(value: number): void {
    if (this.game.phase !== 'bid' || this.game.bidTurn !== 0 || this.busy) return;
    if (value !== 0 && value <= this.game.highestBid) return;
    const advanced = this.game.bid(0, value);
    appendLog(
      mustEl('ddz-log'),
      `<b>你</b> ${value === 0 ? '不叫' : `叫 <b>${value} 分</b>`}`,
    );
    this.audio.move();
    mustEl('ddz-bidbar').classList.add('hidden');
    if (advanced && this.game.playing) this.onLandlordDecided();
    this.advance();
  }

  private humanPlay(): void {
    if (this.game.phase !== 'play' || this.game.turn !== 0 || this.busy) return;
    const cards: DdzCard[] = [];
    for (const idx of this.selected) cards.push(this.game.hands[0][idx]);
    if (cards.length === 0) {
      this.audio.bad();
      appendLog(mustEl('ddz-log'), '请先点选手牌');
      return;
    }
    const err = this.game.play(0, cards);
    if (err) {
      this.audio.bad();
      appendLog(mustEl('ddz-log'), `❌ ${err}`);
      return;
    }
    const codes = cards.map((c) => c.code).sort((a, b) => a - b);
    this.shownPlayed[0] = codes;
    const info = getMoveType(codes);
    appendLog(mustEl('ddz-log'), `<b>你</b> ${this.moveText(codes, info)}`);
    this.audio.move();
    this.afterHumanAction();
  }

  private humanPass(): void {
    if (this.game.phase !== 'play' || this.game.turn !== 0 || this.busy) return;
    if (!this.game.canPass(0)) {
      this.audio.bad();
      appendLog(mustEl('ddz-log'), '你正在领出，必须出牌');
      return;
    }
    this.game.pass(0);
    this.shownPlayed[0] = 'pass';
    appendLog(mustEl('ddz-log'), '<b>你</b> 不出');
    this.audio.move();
    this.afterHumanAction();
  }

  private afterHumanAction(): void {
    this.selected.clear();
    this.hintList = [];
    this.hintIdx = -1;
    this.renderAll();
    this.advance();
  }

  /** 提示：在合法走法里循环挑一个（先挑启发式最优），自动选中对应手牌 */
  private hint(): void {
    if (this.game.phase !== 'play' || this.game.turn !== 0 || this.busy) return;
    const legal = this.game.legalMoves(0).filter((m) => m.length > 0);
    if (legal.length === 0) {
      this.audio.hint();
      appendLog(mustEl('ddz-log'), '💡 没有能管上的牌，只能「不出」');
      return;
    }
    if (this.hintList.length === 0) {
      const first = heuristicMove(this.game.snapshot(), 0);
      this.hintList = first.length > 0
        ? [first, ...legal.filter((m) => !this.sameMove(m, first))]
        : [...legal];
      this.hintIdx = -1;
    }
    this.hintIdx = (this.hintIdx + 1) % this.hintList.length;
    const move = this.hintList[this.hintIdx];
    this.selectByMove(move);
    this.audio.hint();
    appendLog(
      mustEl('ddz-log'),
      `💡 提示（${this.hintIdx + 1}/${this.hintList.length}）：${this.moveText(move, getMoveType(move))}`,
    );
    this.renderHand();
    this.syncActionButtons();
  }

  private sameMove(a: Move, b: Move): boolean {
    if (a.length !== b.length) return false;
    const sa = [...a].sort((x, y) => x - y);
    const sb = [...b].sort((x, y) => x - y);
    return sa.every((v, i) => v === sb[i]);
  }

  /** 按走法牌值选中手中对应牌（同点数取未被选中的前几张） */
  private selectByMove(move: Move): void {
    this.selected.clear();
    const need = new Map<number, number>();
    for (const c of move) need.set(c, (need.get(c) ?? 0) + 1);
    const hand = this.game.hands[0];
    for (let i = 0; i < hand.length && need.size > 0; i++) {
      const n = need.get(hand[i].code);
      if (n !== undefined && n > 0) {
        this.selected.add(i);
        if (n === 1) need.delete(hand[i].code);
        else need.set(hand[i].code, n - 1);
      }
    }
  }

  /* ══════════ 渲染 ══════════ */

  private renderAll(): void {
    this.renderHand();
    this.renderBottom();
    this.renderPlayed();
    this.renderSeats();
    this.renderInfo();
    this.renderBidBar();
    if (this.game.phase !== 'bid') this.syncActionButtons();
    if (this.game.phase === 'over') this.renderTurnPill('对局结束');
  }

  private renderHand(): void {
    const wrap = mustEl('ddz-hand');
    const hand = this.game.hands[0];
    // 大牌在左（与主流斗地主 App 一致）
    const order = hand.map((_, i) => i).sort((a, b) => hand[b].code - hand[a].code || hand[b].suit - hand[a].suit);
    wrap.innerHTML = '';
    for (const i of order) {
      const c = hand[i];
      const btn = document.createElement('button');
      btn.className = `ddz-card ${this.cardColor(c)}${this.selected.has(i) ? ' selected' : ''}`;
      btn.dataset.idx = String(i);
      btn.type = 'button';
      btn.innerHTML = this.cardInner(c);
      wrap.appendChild(btn);
    }
  }

  private cardColor(c: DdzCard): string {
    if (c.code === 30) return 'red';
    if (c.code === 20) return 'black';
    return c.suit === 1 || c.suit === 3 ? 'red' : 'black';
  }

  private cardInner(c: DdzCard): string {
    if (c.code === 20 || c.code === 30) {
      return `<span class="dc-rank">${RANK_LABEL[c.code]}</span><span class="dc-suit">🃏</span>`;
    }
    const rank = RANK_LABEL[c.code] ?? '?';
    const suit = SUIT_LABEL[c.suit] ?? '';
    return `<span class="dc-rank">${rank}</span><span class="dc-suit">${suit}</span><span class="dc-corner">${suit}</span>`;
  }

  private renderBottom(): void {
    const wrap = mustEl('ddz-bottom');
    wrap.innerHTML = '';
    const revealed = this.game.landlordSeat >= 0;
    for (const c of this.game.bottom) {
      if (revealed) {
        const el = document.createElement('div');
        el.className = `ddz-mini ${this.cardColor(c)}`;
        el.innerHTML = this.cardInner(c);
        wrap.appendChild(el);
      } else {
        const el = document.createElement('div');
        el.className = 'ddz-back';
        wrap.appendChild(el);
      }
    }
  }

  private renderPlayed(): void {
    for (const seat of [0, 1, 2] as const) {
      const wrap = mustEl(`ddz-played-${seat}`);
      wrap.innerHTML = '';
      const shown = this.shownPlayed[seat];
      if (shown === 'pass') {
        const mark = document.createElement('div');
        mark.className = 'ddz-pass-mark';
        mark.textContent = '不出';
        wrap.appendChild(mark);
      } else if (shown && shown.length > 0) {
        for (const code of shown) {
          const el = document.createElement('div');
          el.className = `ddz-mini ${code === 30 ? 'red' : code === 20 ? 'black' : code % 13 === 1 || code % 13 === 2 ? 'red' : 'black'}`;
          el.innerHTML = this.cardInner({ code, suit: this.suitFor(shown, code) });
          wrap.appendChild(el);
        }
      }
    }
  }

  /** 出牌区的展示花色：按手中同点牌回填，无则黑桃 */
  private suitFor(_move: Move, code: number): number {
    for (const c of this.game.hands[0]) {
      if (c.code === code) return c.suit;
    }
    if (code === 30 || code % 13 === 1 || code % 13 === 2) return 1; // ♥ 显示红色系
    return 0;
  }

  private renderSeats(): void {
    for (const seat of [0, 1, 2] as const) {
      mustEl(`ddz-cnt-${seat}`).textContent = `${this.game.hands[seat].length} 张`;
      const roleEl = mustEl(`ddz-role-${seat}`);
      if (this.game.landlordSeat >= 0) {
        roleEl.classList.remove('hidden');
        const isLl = seat === this.game.landlordSeat;
        roleEl.textContent = isLl ? '地主 👑' : '农民';
        roleEl.classList.toggle('farmer', !isLl);
      } else {
        roleEl.classList.add('hidden');
      }
    }
  }

  private renderInfo(): void {
    const side = mustEl('ddz-side');
    if (this.game.phase === 'bid') {
      side.textContent = '叫分中';
    } else if (this.game.landlordSeat >= 0) {
      side.textContent = this.game.landlordSeat === 0 ? '你是地主 👑' : '你是农民';
    }
    mustEl('ddz-base').textContent = this.game.highestBid > 0 ? `${this.game.highestBid} 分` : '—';
    mustEl('ddz-mult').textContent = `×${2 ** this.game.bombNum}`;
    if (this.game.phase === 'over' && this.game.result) {
      const d = this.game.result.deltas[0];
      const scoreEl = mustEl('ddz-score');
      scoreEl.textContent = `${d > 0 ? '+' : ''}${d} 分`;
      scoreEl.style.color = d > 0 ? 'var(--accent-ink)' : d < 0 ? 'var(--danger)' : 'var(--muted)';
    } else {
      mustEl('ddz-score').textContent = '—';
    }
  }

  private renderResult(): void {
    const r = this.game.result;
    if (!r) return;
    const banner = mustEl('ddz-result');
    const humanWon = (r.landlordSeat === 0 && r.winnerSide === 'landlord') ||
      (r.landlordSeat !== 0 && r.winnerSide === 'farmers');
    const d = r.deltas[0];
    const extras: string[] = [];
    if (r.spring) extras.push('🌸 春天 ×2');
    if (r.antiSpring) extras.push('🌱 反春 ×2');
    if (r.bombNum > 0) extras.push(`💣 炸弹 ${r.bombNum} 次`);
    banner.innerHTML =
      `<b>${humanWon ? '🎉 你赢了！' : '😵 你输了…'}</b> ` +
      `${d > 0 ? '+' : ''}${d} 分 · 底分 ${r.baseScore} × 倍数 ×${r.multiplier}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
    banner.classList.remove('hidden');
    banner.classList.toggle('lose', !humanWon);
    if (humanWon) this.audio.win();
    else this.audio.lose();
    Stats.add(humanWon);
  }

  private renderTurnPill(text: string): void {
    mustEl('ddz-turn').textContent = text;
  }

  private renderBidBar(): void {
    const bar = mustEl('ddz-bidbar');
    const show = this.game.phase === 'bid' && this.game.bidTurn === 0;
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    this.renderTurnPill('该你叫分');
    for (const btn of document.querySelectorAll<HTMLButtonElement>('#ddz-bidbar [data-bid]')) {
      const v = Number(btn.dataset.bid);
      btn.disabled = v !== 0 && v <= this.game.highestBid;
    }
  }

  private syncActionButtons(): void {
    const playing = this.game.phase === 'play' && this.game.turn === 0 && !this.busy;
    const playBtn = mustEl<HTMLButtonElement>('ddz-play');
    const passBtn = mustEl<HTMLButtonElement>('ddz-pass');
    const hintBtn = mustEl<HTMLButtonElement>('ddz-hint');
    playBtn.disabled = !playing;
    hintBtn.disabled = !playing;
    passBtn.disabled = !playing || !this.game.canPass(0);
  }

  private moveText(move: Move, info: MoveInfo): string {
    const name = TYPE_NAME[info.type] ?? '牌型';
    const cards = move.map((c) => RANK_LABEL[c] ?? String(c)).join('');
    const extra = info.len !== undefined ? `×${info.len}` : '';
    return `${name}${extra} <b>${cards}</b>`;
  }

  /* ══════════ 引擎 UI ══════════ */

  private setEngineLoad(pct: number, text: string): void {
    mustEl('ddz-engine-bar').style.width = `${pct}%`;
    mustEl('ddz-engine-state').textContent = 'AI 模型加载中…';
    mustEl('ddz-engine-pct').textContent = `${pct}%`;
    mustEl('ddz-engine-note').textContent = text;
  }

  private showEngineLoad(on: boolean): void {
    this.loadingFlag = on;
    mustEl('ddz-engine-load').classList.toggle('hidden', !on);
    if (on) this.setEngineLoad(0, '开始下载模型…');
  }

  private syncEngineUI(): void {
    const note = mustEl('ddz-engine-note');
    note.textContent = this.nnReady === true
      ? 'DouZero 模型已就绪：对手由神经网络驱动。'
      : this.nnReady === false
        ? '模型不可用：当前为内置牌理 AI（棋力较弱）；刷新页面可重试。'
        : '模型加载中：先用内置牌理应战，加载完成后自动切换。';
  }

  private setGlobalStatus(t: string): void {
    (window as unknown as { setGlobalStatus?: (s: string) => void }).setGlobalStatus?.(t);
  }
}
