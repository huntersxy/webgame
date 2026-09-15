/* ───────────────────────────────────────────────────────────────
 *  src/ddz/heuristic.ts — 兜底 AI（叫分 + 出牌）
 *
 *  DouZero 模型下载/初始化完成前，AI 用这套轻量启发式顶班；
 *  加载完成后所有走法改由 DouZero 决定，此文件仅保留叫分逻辑
 *  （DouZero 不参与叫分）。策略参考「手牌强度叫分表」与
 *  「管最小 + 不拆牌」的常见残局常识，够玩但不强。
 * ─────────────────────────────────────────────────────────────── */

import { type DdzState, type DdzCard, sortHand } from './game';
import {
  type Move,
  type MoveInfo,
  getMoveType,
  getLegalMoves,
  moveEquals,
  TYPE_3_1,
  TYPE_3_2,
  TYPE_4_2,
  TYPE_4_22,
  TYPE_BOMB,
  TYPE_KING_BOMB,
  TYPE_PAIR,
  TYPE_PASS,
  TYPE_SERIAL_3_1,
  TYPE_SERIAL_3_2,
  TYPE_SERIAL_PAIR,
  TYPE_SERIAL_SINGLE,
  TYPE_SERIAL_TRIPLE,
  TYPE_SINGLE,
  TYPE_TRIPLE,
  TYPE_WRONG,
} from './rules';

/* ── 叫分 ─────────────────────────────────────────────────────── */

/**
 * 手牌强度 → 叫分 0~3。
 * 评分 = 大王4 + 小王3 + 火箭4 + 炸弹8 + 2×3 + A×1（参考现成斗地主 AI 经验表）
 * ≥18 → 3 分；≥12 → 2 分；≥7 → 1 分；否则不叫。
 */
export function bidScore(cards: DdzCard[]): number {
  const counts = new Map<number, number>();
  for (const c of cards) counts.set(c.code, (counts.get(c.code) ?? 0) + 1);

  let score = 0;
  if (counts.has(30)) score += 4; // 大王
  if (counts.has(20)) score += 3; // 小王
  if (counts.has(30) && counts.has(20)) score += 4; // 火箭
  for (const [, n] of counts) {
    if (n === 4) score += 8; // 炸弹
  }
  score += (counts.get(17) ?? 0) * 3; // 2
  score += (counts.get(14) ?? 0) * 1; // A

  if (score >= 18) return 3;
  if (score >= 12) return 2;
  if (score >= 7) return 1;
  return 0;
}

/* ── 出牌 ─────────────────────────────────────────────────────── */

interface Scored {
  move: Move;
  info: MoveInfo;
}

/** 走法「浪费度」：点数越大越不想出，炸弹/王炸惩罚极重 */
function moveCost(info: MoveInfo): number {
  const rank = info.rank ?? 0;
  switch (info.type) {
    case TYPE_BOMB:
      return 1000 + rank;
    case TYPE_KING_BOMB:
      return 1100;
    case TYPE_SINGLE:
      return rank; // 单牌按点数排
    case TYPE_PAIR:
      return rank * 1.2;
    case TYPE_TRIPLE:
    case TYPE_3_1:
      return rank * 1.5;
    case TYPE_3_2:
      return rank * 1.6;
    case TYPE_SERIAL_SINGLE:
    case TYPE_SERIAL_PAIR:
    case TYPE_SERIAL_TRIPLE:
    case TYPE_SERIAL_3_1:
    case TYPE_SERIAL_3_2:
    case TYPE_4_2:
    case TYPE_4_22:
      return (info.rank ?? 0) * 0.8; // 长牌型优先出（消耗多）
    default:
      return rank;
  }
}

/**
 * 兜底出牌：领出时出「最不值钱」的非炸弹走法（优先长牌型）；
 * 跟牌时出能管上的最小走法，管不上或只想保炸弹则不出。
 * @param state 对局快照
 * @param seat 决策座位
 */
export function heuristicMove(state: DdzState, seat: number): Move {
  const hand = state.hands[seat];
  const legal = getLegalMoves(hand, state.actionSeq);
  if (legal.length === 0) return [];

  const scored: Scored[] = legal
    .filter((m) => m.length > 0)
    .map((m) => ({ move: m, info: getMoveType(m) }));

  // 领出（无压牌目标）
  const rival = rivalMove(state);
  if (rival.length === 0) {
    const nonBomb = scored.filter(
      (s) => s.info.type !== TYPE_BOMB && s.info.type !== TYPE_KING_BOMB,
    );
    if (nonBomb.length === 0) {
      // 全是炸弹：能一手走完就走，否则出单张最小
      const whole = scored.find((s) => s.move.length === hand.length);
      if (whole) return whole.move;
      return [Math.min(...hand)];
    }
    // 优先长牌型，其次点数小的
    nonBomb.sort((a, b) => b.move.length - a.move.length || moveCost(a.info) - moveCost(b.info));
    // 手牌 ≤5 时若有「一手清」机会直接走
    if (hand.length <= 5) {
      const one = scored.find((s) => s.move.length === hand.length);
      if (one) return one.move;
    }
    return nonBomb[0].move;
  }

  // 跟牌：出能管上的最小走法；炸弹不轻易交
  const beats = scored.filter((s) => s.info.type !== TYPE_BOMB && s.info.type !== TYPE_KING_BOMB);
  if (beats.length > 0) {
    beats.sort((a, b) => moveCost(a.info) - moveCost(b.info));
    const pick = beats[0];
    // 对手快出完（≤2 张）时才愿意拆大牌管
    const rivalSeat = state.lastPid;
    const urgent = rivalSeat >= 0 && state.hands[rivalSeat].length <= 2;
    if (urgent || (pick.info.rank ?? 0) <= 14) return pick.move;
    return [];
  }

  // 只剩炸弹能管：对手快出完或自己炸弹后能走完才炸
  const bomb = scored.find(
    (s) => s.info.type === TYPE_BOMB || s.info.type === TYPE_KING_BOMB,
  );
  if (bomb) {
    const rivalSeat = state.lastPid;
    const urgent = rivalSeat >= 0 && state.hands[rivalSeat].length <= 3;
    if (urgent || bomb.move.length === hand.length) return bomb.move;
  }
  return [];
}

function rivalMove(state: DdzState): Move {
  if (state.actionSeq.length === 0) return [];
  const last = state.actionSeq[state.actionSeq.length - 1];
  return last.length === 0 ? (state.actionSeq[state.actionSeq.length - 2] ?? []) : last;
}

/** 手牌排序（对外展示用，点数升序 + 同点花色） */
export function sortedCards(cards: DdzCard[]): DdzCard[] {
  return sortHand(cards);
}

/** 该走法是否在合法集合内（提示/校验共用） */
export function isLegal(legal: Move[], move: Move): boolean {
  return legal.some((m) => moveEquals(m, move));
}

export {
  TYPE_3_1,
  TYPE_3_2,
  TYPE_4_2,
  TYPE_4_22,
  TYPE_BOMB,
  TYPE_KING_BOMB,
  TYPE_PAIR,
  TYPE_PASS,
  TYPE_SERIAL_3_1,
  TYPE_SERIAL_3_2,
  TYPE_SERIAL_PAIR,
  TYPE_SERIAL_SINGLE,
  TYPE_SERIAL_TRIPLE,
  TYPE_SINGLE,
  TYPE_TRIPLE,
  TYPE_WRONG,
};
