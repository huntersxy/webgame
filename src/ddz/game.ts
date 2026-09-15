/* ───────────────────────────────────────────────────────────────
 *  src/ddz/game.ts — 斗地主对局状态机
 *
 *  标准三人玩法：发牌 17×3 + 底 3，叫分 0/1/2/3 定地主，
 *  出牌跟牌，炸弹/王炸翻倍，春天/反春再翻倍，按叫分结算。
 *  状态字段与 DouZero game.py 对齐（actionSeq / lastMoveDict /
 *  playedCards / bombNum），便于编码器直接消费。
 * ─────────────────────────────────────────────────────────────── */

import {
  type Move,
  getMoveType,
  getLegalMoves,
  isBombMove,
  moveEquals,
  sortMove,
  TYPE_PASS,
} from './rules';

/** 一张物理牌：code 为 DouZero 牌值（3..14,17,20,30），suit 0=♠ 1=♥ 2=♣ 3=♦，王为 -1 */
export interface DdzCard {
  code: number;
  suit: number;
}

export type DdzPosition = 'landlord' | 'landlord_down' | 'landlord_up';
export type DdzPhase = 'bid' | 'play' | 'over';

/** 座位：0 = 自己（下侧），1 = 右家，2 = 左家；出牌顺序 0→1→2→0 */
export type Seat = 0 | 1 | 2;

/** 可序列化的对局状态快照（传给 Worker 用，只含纯数据） */
export interface DdzState {
  hands: number[][];
  landlordSeat: number;
  actionSeq: Move[];
  lastMoveBySeat: Move[];
  playedBySeat: Move[];
  bombNum: number;
  lastPid: number;
  movesPlayedCount: number[];
  turn: number;
}

export interface BidRecord {
  seat: number;
  value: number;
}

export interface DdzResult {
  winnerSide: 'landlord' | 'farmers';
  landlordSeat: number;
  baseScore: number;
  bombNum: number;
  spring: boolean;
  antiSpring: boolean;
  multiplier: number;
  /** 每座座位的积分变化（地主 ±2×底分×倍数，农民 ∓1×） */
  deltas: number[];
}

const RANK_CODES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17];

/** 新一副牌（54 张） */
export function newDeck(): DdzCard[] {
  const deck: DdzCard[] = [];
  for (const code of RANK_CODES) {
    for (let suit = 0; suit < 4; suit++) deck.push({ code, suit });
  }
  deck.push({ code: 20, suit: -1 });
  deck.push({ code: 30, suit: -1 });
  return deck;
}

/** Fisher–Yates 洗牌（返回新数组） */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 座位 → DouZero 角色（与官方座位轮转一致：地主→地主下家→地主上家） */
export function positionOf(landlordSeat: number, seat: number): DdzPosition {
  if (seat === landlordSeat) return 'landlord';
  return (seat - landlordSeat + 3) % 3 === 1 ? 'landlord_down' : 'landlord_up';
}

/** 手牌按 DouZero 牌值升序（王在最右），并保持同点数内 suit 顺序 */
export function sortHand(cards: DdzCard[]): DdzCard[] {
  return [...cards].sort((a, b) => a.code - b.code || a.suit - b.suit);
}

function handCodes(cards: DdzCard[]): number[] {
  return cards.map((c) => c.code).sort((a, b) => a - b);
}

export class DdzGame {
  phase: DdzPhase = 'bid';
  /** 是否处于出牌阶段（叫分结束后、有人走完前） */
  get playing(): boolean {
    return this.phase === 'play';
  }
  hands: DdzCard[][] = [[], [], []];
  bottom: DdzCard[] = [];
  landlordSeat = -1;
  turn = 0;

  // 叫分
  bidTurn = 0;
  highestBid = 0;
  highestBidder = -1;
  bidsMade = 0;
  bids: BidRecord[] = [];

  // 出牌
  actionSeq: Move[] = [];
  lastMoveBySeat: Move[] = [[], [], []];
  playedBySeat: Move[] = [[], [], []];
  bombNum = 0;
  lastPid = -1;
  movesPlayedCount = [0, 0, 0];

  result: DdzResult | null = null;

  private readonly rng: () => number;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
    this.deal();
  }

  private deal(): void {
    const deck = shuffle(newDeck(), this.rng);
    this.hands = [
      sortHand(deck.slice(0, 17)),
      sortHand(deck.slice(17, 34)),
      sortHand(deck.slice(34, 51)),
    ];
    this.bottom = deck.slice(51);
    this.turn = Math.floor(this.rng() * 3) as Seat;
    this.bidTurn = this.turn;
  }

  /** 叫分：value 0=不叫，1/2/3=分值；返回是否推进了阶段 */
  bid(seat: number, value: number): boolean {
    if (this.phase !== 'bid' || seat !== this.bidTurn) return false;
    if (value !== 0 && value <= this.highestBid) return false;
    this.bids.push({ seat, value });
    if (value > this.highestBid) {
      this.highestBid = value;
      this.highestBidder = seat;
    }
    this.bidsMade += 1;

    // 叫 3 分直接定地主；否则一圈叫完，无人叫分则重发
    if (value === 3 || this.bidsMade >= 3) {
      if (this.highestBidder === -1) {
        this.redeal();
        return true;
      }
      this.startPlay();
      return true;
    }
    this.bidTurn = (this.bidTurn + 1) % 3;
    return false;
  }

  private redeal(): void {
    this.hands = [[], [], []];
    this.bottom = [];
    this.bids = [];
    this.bidsMade = 0;
    this.highestBid = 0;
    this.highestBidder = -1;
    this.deal();
  }

  private startPlay(): void {
    this.landlordSeat = this.highestBidder;
    this.hands[this.landlordSeat] = sortHand([
      ...this.hands[this.landlordSeat],
      ...this.bottom,
    ]);
    this.turn = this.landlordSeat;
    this.lastPid = this.landlordSeat;
    this.phase = 'play';
  }

  /** 当前出牌顺序下的合法走法（牌值数组），领出时含全部牌型 */
  legalMoves(seat: number): Move[] {
    if (this.phase !== 'play' || seat !== this.turn) return [];
    return getLegalMoves(handCodes(this.hands[seat]), this.actionSeq);
  }

  /** 当前轮到的座位是否允许「不出」（存在跟牌目标时才可 pass） */
  canPass(seat: number): boolean {
    if (this.phase !== 'play' || seat !== this.turn) return false;
    return this.rivalMove().length !== 0;
  }

  /** 需要压的目标走法；空数组 = 自由领出 */
  rivalMove(): Move {
    if (this.actionSeq.length === 0) return [];
    const last = this.actionSeq[this.actionSeq.length - 1];
    return last.length === 0 ? (this.actionSeq[this.actionSeq.length - 2] ?? []) : last;
  }

  /**
   * 出牌：cards 为选中的物理牌。校验其牌值组合是否为当前合法走法。
   * 返回 null 表示成功；否则为错误原因（供 UI 提示）。
   */
  play(seat: number, cards: DdzCard[]): string | null {
    const codes = sortMove(cards.map((c) => c.code));
    return this.playCodes(seat, codes);
  }

  /** 直接以牌值出牌（AI / 提示走这条入口） */
  playCodes(seat: number, codes: number[]): string | null {
    if (this.phase !== 'play' || seat !== this.turn) return '还没轮到你出牌';
    if (codes.length === 0) return '请先选牌';
    const info = getMoveType(codes);
    if (info.type === 15) return '不是合法牌型';

    const legal = this.legalMoves(seat);
    if (!legal.some((m) => moveEquals(m, codes))) {
      return this.rivalMove().length === 0 ? '不是合法牌型' : '管不上上家的牌';
    }

    this.applyMove(seat, codes);
    return null;
  }

  /** 不出（跟牌阶段） */
  pass(seat: number): string | null {
    if (this.phase !== 'play' || seat !== this.turn) return '还没轮到你';
    if (!this.canPass(seat)) return '你正在领出，必须出牌';
    this.applyMove(seat, []);
    return null;
  }

  private applyMove(seat: number, codes: Move): void {
    if (codes.length > 0) {
      this.lastPid = seat;
      if (isBombMove(codes)) this.bombNum += 1;
      this.movesPlayedCount[seat] += 1;
      // 从手牌里扣掉这些牌值（同点数任意物理牌均可）
      for (const code of codes) {
        const idx = this.hands[seat].findIndex((c) => c.code === code);
        if (idx >= 0) this.hands[seat].splice(idx, 1);
      }
      this.playedBySeat[seat].push(...codes);
    }
    this.lastMoveBySeat[seat] = [...codes];
    this.actionSeq.push([...codes]);

    if (this.hands[seat].length === 0) {
      this.settle(seat);
      return;
    }
    this.turn = (this.turn + 1) % 3;
  }

  private settle(winnerSeat: number): void {
    this.phase = 'over';
    const landlordWon = winnerSeat === this.landlordSeat;
    const farmers = [0, 1, 2].filter((s) => s !== this.landlordSeat);

    // 春天：地主赢且两农民一张未出；反春：农民赢且地主只出过一手
    const spring = landlordWon && farmers.every((s) => this.playedBySeat[s].length === 0);
    const antiSpring =
      !landlordWon &&
      this.movesPlayedCount[this.landlordSeat] === 1 &&
      this.playedBySeat[this.landlordSeat].length > 0;

    const baseScore = Math.max(1, this.highestBid);
    const multiplier = 2 ** this.bombNum * (spring || antiSpring ? 2 : 1);

    const deltas = [0, 0, 0];
    const unit = baseScore * multiplier;
    if (landlordWon) {
      deltas[this.landlordSeat] = 2 * unit;
      for (const s of farmers) deltas[s] = -unit;
    } else {
      deltas[this.landlordSeat] = -2 * unit;
      for (const s of farmers) deltas[s] = unit;
    }

    this.result = {
      winnerSide: landlordWon ? 'landlord' : 'farmers',
      landlordSeat: this.landlordSeat,
      baseScore,
      bombNum: this.bombNum,
      spring,
      antiSpring,
      multiplier,
      deltas,
    };
  }

  /** 序列化快照（给 AI Worker / 编码器） */
  snapshot(): DdzState {
    return {
      hands: this.hands.map((h) => handCodes(h)),
      landlordSeat: this.landlordSeat,
      actionSeq: this.actionSeq.map((m) => [...m]),
      lastMoveBySeat: this.lastMoveBySeat.map((m) => [...m]),
      playedBySeat: this.playedBySeat.map((m) => [...m]),
      bombNum: this.bombNum,
      lastPid: this.lastPid,
      movesPlayedCount: [...this.movesPlayedCount],
      turn: this.turn,
    };
  }

  /** seat 的角色名（供 UI 显示地主/农民） */
  roleOf(seat: number): 'landlord' | 'farmer' {
    return seat === this.landlordSeat ? 'landlord' : 'farmer';
  }
}

/** 供编码器/记录器：当前需要压的走法（空 = 领出） */
export function rivalOfSeq(actionSeq: Move[]): Move {
  if (actionSeq.length === 0) return [];
  const last = actionSeq[actionSeq.length - 1];
  return last.length === 0 ? (actionSeq[actionSeq.length - 2] ?? []) : last;
}

export { TYPE_PASS };
