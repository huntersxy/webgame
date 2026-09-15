/* ───────────────────────────────────────────────────────────────
 *  src/ddz/rules.ts — 斗地主走法引擎
 *
 *  移植自 DouZero 官方实现（kwai/DouZero，Apache-2.0）的
 *  move_detector.py / move_generator.py / move_selector.py，
 *  牌值编码与其完全一致：
 *    3~10 = 3..10，J=11，Q=12，K=13，A=14，2=17，小王=20，大王=30
 *  （用 17/20/30 让「顺子连续性」天然排除 2 与王，与官方同款技巧）
 * ─────────────────────────────────────────────────────────────── */

/** 走法类型编号，与官方 utils.py 保持一致 */
export const TYPE_PASS = 0;
export const TYPE_SINGLE = 1;
export const TYPE_PAIR = 2;
export const TYPE_TRIPLE = 3;
export const TYPE_BOMB = 4;
export const TYPE_KING_BOMB = 5;
export const TYPE_3_1 = 6;
export const TYPE_3_2 = 7;
export const TYPE_SERIAL_SINGLE = 8;
export const TYPE_SERIAL_PAIR = 9;
export const TYPE_SERIAL_TRIPLE = 10;
export const TYPE_SERIAL_3_1 = 11;
export const TYPE_SERIAL_3_2 = 12;
export const TYPE_4_2 = 13;
export const TYPE_4_22 = 14;
export const TYPE_WRONG = 15;

/** 顺子最少 5 张、连对最少 3 对、飞机最少 2 连（官方 utils.py 常量） */
const MIN_SINGLE_CARDS = 5;
const MIN_PAIRS = 3;
const MIN_TRIPLES = 2;

/** 走法 = 升序排列的牌值数组，如 [5,5,5,6,6,6,7,8] */
export type Move = number[];

export interface MoveInfo {
  type: number;
  /** 主牌点数（单/对/三/炸弹取该点，带牌与飞机取三张或主体的最小点） */
  rank?: number;
  /** 顺子/连对/飞机的「连数」（不同点数个数） */
  len?: number;
}

/** 牌值排序（升序），数组会被原地排序 */
export function sortMove(move: Move): Move {
  move.sort((a, b) => a - b);
  return move;
}

/** 两个走法是否为同一组牌（都先升序） */
export function moveEquals(a: Move, b: Move): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

/** 统计每个点数的张数 */
function countMap(move: Move): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of move) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
}

/** 连续序列判定（输入需已升序）——官方 is_continuous_seq */
function isContinuousSeq(sorted: number[]): boolean {
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1] - sorted[i] !== 1) return false;
  }
  return true;
}

/** C(n,k) 组合枚举（按位置取，与 Python itertools.combinations 一致） */
function combinations(arr: number[], k: number): number[][] {
  if (k === 0) return [[]];
  const res: number[][] = [];
  const cur: number[] = [];
  const pick = (start: number): void => {
    if (cur.length === k) {
      res.push([...cur]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      pick(i + 1);
      cur.pop();
    }
  };
  pick(0);
  return res;
}

/** 判定走法类型——官方 get_move_type 逐行移植 */
export function getMoveType(move: Move): MoveInfo {
  const n = move.length;
  if (n === 0) return { type: TYPE_PASS };

  const counts = countMap(move);
  const size = counts.size;

  if (n === 1) return { type: TYPE_SINGLE, rank: move[0] };

  if (n === 2) {
    if (move[0] === move[1]) return { type: TYPE_PAIR, rank: move[0] };
    if (move[0] === 20 && move[1] === 30) return { type: TYPE_KING_BOMB };
    return { type: TYPE_WRONG };
  }

  if (n === 3) {
    return size === 1 ? { type: TYPE_TRIPLE, rank: move[0] } : { type: TYPE_WRONG };
  }

  if (n === 4) {
    if (size === 1) return { type: TYPE_BOMB, rank: move[0] };
    if (size === 2) {
      if (
        (move[0] === move[1] && move[1] === move[2]) ||
        (move[1] === move[2] && move[2] === move[3])
      ) {
        return { type: TYPE_3_1, rank: move[1] };
      }
    }
    return { type: TYPE_WRONG };
  }

  // 官方顺序：先判顺子，再判 3+2（顺序影响 [3,4,5,6,7] 这类，不可调换）
  if (isContinuousSeq(move)) return { type: TYPE_SERIAL_SINGLE, rank: move[0], len: n };

  if (n === 5) {
    return size === 2 ? { type: TYPE_3_2, rank: move[2] } : { type: TYPE_WRONG };
  }

  // 各点数张数的「直方图」：countOfCounts[v] = 有 v 张的点数个数
  const countOfCounts = new Map<number, number>();
  for (const v of counts.values()) {
    countOfCounts.set(v, (countOfCounts.get(v) ?? 0) + 1);
  }
  const c1 = countOfCounts.get(1) ?? 0;
  const c2 = countOfCounts.get(2) ?? 0;
  const c3 = countOfCounts.get(3) ?? 0;
  const c4 = countOfCounts.get(4) ?? 0;

  if (n === 6) {
    if ((size === 2 || size === 3) && c4 === 1 && (c2 === 1 || c1 === 2)) {
      return { type: TYPE_4_2, rank: move[2] };
    }
  }

  if (n === 8) {
    if (((size === 3 || size === 2) && c4 === 1 && c2 === 2) || c4 === 2) {
      let best = -1;
      for (const [k, v] of counts) {
        if (v === 4 && k > best) best = k;
      }
      return { type: TYPE_4_22, rank: best };
    }
  }

  const keys = [...counts.keys()].sort((a, b) => a - b);
  if (size === c2 && isContinuousSeq(keys)) {
    return { type: TYPE_SERIAL_PAIR, rank: keys[0], len: keys.length };
  }
  if (size === c3 && isContinuousSeq(keys)) {
    return { type: TYPE_SERIAL_TRIPLE, rank: keys[0], len: keys.length };
  }

  // 飞机带翅膀（官方 Type 11 / Type 12 分支）
  if (c3 >= MIN_TRIPLES) {
    const serial3: number[] = [];
    const single: number[] = [];
    const pair: number[] = [];
    for (const [k, v] of counts) {
      if (v === 3) serial3.push(k);
      else if (v === 1) single.push(k);
      else if (v === 2) pair.push(k);
      else return { type: TYPE_WRONG };
    }
    serial3.sort((a, b) => a - b);
    if (isContinuousSeq(serial3)) {
      if (serial3.length === single.length + pair.length * 2) {
        return { type: TYPE_SERIAL_3_1, rank: serial3[0], len: serial3.length };
      }
      if (serial3.length === pair.length && size === serial3.length * 2) {
        return { type: TYPE_SERIAL_3_2, rank: serial3[0], len: serial3.length };
      }
    }
    // 4 连三张时，容忍翅膀本身含三张点数的边界情形（官方同样处理）
    if (serial3.length === 4) {
      if (isContinuousSeq(serial3.slice(1))) {
        return { type: TYPE_SERIAL_3_1, rank: serial3[1], len: serial3.length - 1 };
      }
      if (isContinuousSeq(serial3.slice(0, 3))) {
        return { type: TYPE_SERIAL_3_1, rank: serial3[0], len: serial3.length - 1 };
      }
    }
  }

  return { type: TYPE_WRONG };
}

/** 是否炸弹（含王炸）——用于 bomb_num 倍数统计 */
export function isBombMove(move: Move): boolean {
  const t = getMoveType(move).type;
  return t === TYPE_BOMB || t === TYPE_KING_BOMB;
}

/** 走法生成器——官方 MovesGener 移植 */
export class MovesGener {
  private readonly cardsList: number[];
  private readonly cardsDict: Map<number, number>;

  constructor(cards: Move) {
    this.cardsList = [...cards];
    this.cardsDict = countMap(this.cardsList);
  }

  genType1Single(): Move[] {
    return [...new Set(this.cardsList)].map((i) => [i]);
  }

  genType2Pair(): Move[] {
    const res: Move[] = [];
    for (const [k, v] of this.cardsDict) {
      if (v >= 2) res.push([k, k]);
    }
    return res;
  }

  genType3Triple(): Move[] {
    const res: Move[] = [];
    for (const [k, v] of this.cardsDict) {
      if (v >= 3) res.push([k, k, k]);
    }
    return res;
  }

  genType4Bomb(): Move[] {
    const res: Move[] = [];
    for (const [k, v] of this.cardsDict) {
      if (v === 4) res.push([k, k, k, k]);
    }
    return res;
  }

  genType5KingBomb(): Move[] {
    const res: Move[] = [];
    if (this.cardsList.includes(20) && this.cardsList.includes(30)) res.push([20, 30]);
    return res;
  }

  /** 连续段生成核心——官方 _gen_serial_moves 移植 */
  private genSerialMoves(
    cards: number[],
    minSerial: number,
    repeat: number,
    repeatNum = 0,
  ): Move[] {
    let rn = repeatNum;
    if (rn < minSerial) rn = 0;

    const singleCards = [...new Set(cards)].sort((a, b) => a - b);
    const seqRecords: Array<{ start: number; len: number }> = [];
    let start = 0;
    let i = 0;
    let longest = 1;
    while (i < singleCards.length) {
      if (i + 1 < singleCards.length && singleCards[i + 1] - singleCards[i] === 1) {
        longest += 1;
        i += 1;
      } else {
        seqRecords.push({ start, len: longest });
        i += 1;
        start = i;
        longest = 1;
      }
    }

    const moves: Move[] = [];
    for (const seq of seqRecords) {
      if (seq.len < minSerial) continue;
      const longestList = singleCards.slice(seq.start, seq.start + seq.len);

      if (rn === 0) {
        for (let steps = minSerial; steps <= seq.len; steps++) {
          for (let index = 0; index + steps <= seq.len; index++) {
            const target = longestList.slice(index, index + steps);
            const move: Move = [];
            for (let r = 0; r < repeat; r++) move.push(...target);
            moves.push(move.sort((a, b) => a - b));
          }
        }
      } else {
        if (seq.len < rn) continue;
        for (let index = 0; index + rn <= seq.len; index++) {
          const target = longestList.slice(index, index + rn);
          const move: Move = [];
          for (let r = 0; r < repeat; r++) move.push(...target);
          moves.push(move.sort((a, b) => a - b));
        }
      }
    }
    return moves;
  }

  genType8SerialSingle(repeatNum = 0): Move[] {
    return this.genSerialMoves(this.cardsList, MIN_SINGLE_CARDS, 1, repeatNum);
  }

  genType9SerialPair(repeatNum = 0): Move[] {
    const singlePairs: number[] = [];
    for (const [k, v] of this.cardsDict) {
      if (v >= 2) singlePairs.push(k);
    }
    return this.genSerialMoves(singlePairs, MIN_PAIRS, 2, repeatNum);
  }

  genType10SerialTriple(repeatNum = 0): Move[] {
    const singleTriples: number[] = [];
    for (const [k, v] of this.cardsDict) {
      if (v >= 3) singleTriples.push(k);
    }
    return this.genSerialMoves(singleTriples, MIN_TRIPLES, 3, repeatNum);
  }

  genType11Serial31(repeatNum = 0): Move[] {
    const serial3Moves = this.genType10SerialTriple(repeatNum);
    const res: Move[] = [];
    const seen = new Set<string>();
    for (const s3 of serial3Moves) {
      const s3Set = new Set(s3);
      const newCards = this.cardsList.filter((i) => !s3Set.has(i));
      // 翅膀 = 剩余牌里任取 len(三张连) 张（可含对子拆开的两张同点）
      for (const sub of combinations(newCards, s3Set.size)) {
        const move = [...s3, ...sub];
        const key = move.join(',');
        if (!seen.has(key)) {
          seen.add(key);
          res.push(move);
        }
      }
    }
    return res;
  }

  genType12Serial32(repeatNum = 0): Move[] {
    const serial3Moves = this.genType10SerialTriple(repeatNum);
    const res: Move[] = [];
    const pairRanks = [...this.cardsDict.entries()]
      .filter(([, v]) => v >= 2)
      .map(([k]) => k)
      .sort((a, b) => a - b);
    for (const s3 of serial3Moves) {
      const s3Set = new Set(s3);
      const pairCandidates = pairRanks.filter((k) => !s3Set.has(k));
      // 翅膀 = 剩余对子点里任取 len(三张连) 个点，各出两张
      for (const sub of combinations(pairCandidates, s3Set.size)) {
        const move: Move = [...s3];
        for (const p of sub) move.push(p, p);
        res.push(move.sort((a, b) => a - b));
      }
    }
    return res;
  }

  genType13(): Move[] {
    const fourRanks = [...this.cardsDict.entries()]
      .filter(([, v]) => v === 4)
      .map(([k]) => k);
    const res: Move[] = [];
    const seen = new Set<string>();
    for (const fc of fourRanks) {
      const rest = this.cardsList.filter((c) => c !== fc);
      // 四带二：任意两张（可同点成对）
      for (const sub of combinations(rest, 2)) {
        const move: Move = [fc, fc, fc, fc, ...sub];
        const key = move.join(',');
        if (!seen.has(key)) {
          seen.add(key);
          res.push(move.sort((a, b) => a - b));
        }
      }
    }
    return res;
  }

  genType14(): Move[] {
    const fourRanks = [...this.cardsDict.entries()]
      .filter(([, v]) => v === 4)
      .map(([k]) => k);
    const res: Move[] = [];
    for (const fc of fourRanks) {
      const pairRanks = [...this.cardsDict.entries()]
        .filter(([k, v]) => k !== fc && v >= 2)
        .map(([k]) => k);
      // 四带两对：剩余点里任取两个点各出两张
      for (const sub of combinations(pairRanks, 2)) {
        res.push([fc, fc, fc, fc, sub[0], sub[0], sub[1], sub[1]]);
      }
    }
    return res;
  }

  /** 领出时的全部合法走法（官方 gen_moves，类型顺序与编码训练无关，均可） */
  genMoves(): Move[] {
    return [
      ...this.genType1Single(),
      ...this.genType2Pair(),
      ...this.genType3Triple(),
      ...this.genType6(),
      ...this.genType7(),
      ...this.genType8SerialSingle(),
      ...this.genType9SerialPair(),
      ...this.genType10SerialTriple(),
      ...this.genType11Serial31(),
      ...this.genType12Serial32(),
      ...this.genType13(),
      ...this.genType14(),
      ...this.genType4Bomb(),
      ...this.genType5KingBomb(),
    ];
  }

  genType6(): Move[] {
    const res: Move[] = [];
    for (const t of this.genType1Single()) {
      for (const i of this.genType3Triple()) {
        if (t[0] !== i[0]) res.push([...t, ...i].sort((a, b) => a - b));
      }
    }
    return res;
  }

  genType7(): Move[] {
    const res: Move[] = [];
    for (const t of this.genType2Pair()) {
      for (const i of this.genType3Triple()) {
        if (t[0] !== i[0]) res.push([...t, ...i].sort((a, b) => a - b));
      }
    }
    return res;
  }
}

/** 压牌过滤——官方 move_selector 移植；moves 与 rival 需同类型 */
export function filterBeats(type: number, moves: Move[], rival: Move): Move[] {
  switch (type) {
    case TYPE_SINGLE:
    case TYPE_PAIR:
    case TYPE_TRIPLE:
    case TYPE_BOMB:
    case TYPE_SERIAL_SINGLE:
    case TYPE_SERIAL_PAIR:
    case TYPE_SERIAL_TRIPLE:
      return moves.filter((m) => m[0] > rival[0]);
    case TYPE_3_1:
      return moves.filter((m) => {
        const rs = [...rival].sort((a, b) => a - b);
        const ms = [...m].sort((a, b) => a - b);
        return ms[1] > rs[1];
      });
    case TYPE_3_2:
      return moves.filter((m) => {
        const rs = [...rival].sort((a, b) => a - b);
        const ms = [...m].sort((a, b) => a - b);
        return ms[2] > rs[2];
      });
    case TYPE_SERIAL_3_1:
    case TYPE_SERIAL_3_2: {
      const rivalRank = maxTripleRank(rival);
      return moves.filter((m) => maxTripleRank(m) > rivalRank);
    }
    case TYPE_4_2:
      return moves.filter((m) => {
        const rs = [...rival].sort((a, b) => a - b);
        const ms = [...m].sort((a, b) => a - b);
        return ms[2] > rs[2];
      });
    case TYPE_4_22: {
      const rivalRank = bombRankOf(rival);
      return moves.filter((m) => bombRankOf(m) > rivalRank);
    }
    default:
      return [];
  }
}

function maxTripleRank(move: Move): number {
  const counts = countMap(move);
  let best = -1;
  for (const [k, v] of counts) {
    if (v === 3 && k > best) best = k;
  }
  return best;
}

function bombRankOf(move: Move): number {
  const counts = countMap(move);
  let best = -1;
  for (const [k, v] of counts) {
    if (v === 4 && k > best) best = k;
  }
  return best;
}

/**
 * 当前全部合法走法——官方 game.py get_legal_card_play_actions 移植。
 * @param hand 当前玩家手牌（牌值数组，顺序随意）
 * @param actionSeq 全局出牌序列：每个元素是一手走法（牌值数组），不出为 []
 */
export function getLegalMoves(hand: Move, actionSeq: Move[]): Move[] {
  const mg = new MovesGener(hand);

  // 需要压的目标：序列末尾若为「不出」则看上一手非空走法
  let rival: Move = [];
  if (actionSeq.length !== 0) {
    const last = actionSeq[actionSeq.length - 1];
    rival = last.length === 0 ? (actionSeq[actionSeq.length - 2] ?? []) : last;
  }

  const rivalInfo = getMoveType(rival);
  let moves: Move[] = [];

  switch (rivalInfo.type) {
    case TYPE_PASS:
      moves = mg.genMoves();
      break;
    case TYPE_SINGLE:
      moves = filterBeats(TYPE_SINGLE, mg.genType1Single(), rival);
      break;
    case TYPE_PAIR:
      moves = filterBeats(TYPE_PAIR, mg.genType2Pair(), rival);
      break;
    case TYPE_TRIPLE:
      moves = filterBeats(TYPE_TRIPLE, mg.genType3Triple(), rival);
      break;
    case TYPE_BOMB: {
      const all = [...mg.genType4Bomb(), ...mg.genType5KingBomb()];
      moves = filterBeats(TYPE_BOMB, all, rival);
      break;
    }
    case TYPE_KING_BOMB:
      moves = [];
      break;
    case TYPE_3_1:
      moves = filterBeats(TYPE_3_1, mg.genType6(), rival);
      break;
    case TYPE_3_2:
      moves = filterBeats(TYPE_3_2, mg.genType7(), rival);
      break;
    case TYPE_SERIAL_SINGLE:
      moves = filterBeats(
        TYPE_SERIAL_SINGLE,
        mg.genType8SerialSingle(rivalLen(rivalInfo.len)),
        rival,
      );
      break;
    case TYPE_SERIAL_PAIR:
      moves = filterBeats(
        TYPE_SERIAL_PAIR,
        mg.genType9SerialPair(rivalLen(rivalInfo.len)),
        rival,
      );
      break;
    case TYPE_SERIAL_TRIPLE:
      moves = filterBeats(
        TYPE_SERIAL_TRIPLE,
        mg.genType10SerialTriple(rivalLen(rivalInfo.len)),
        rival,
      );
      break;
    case TYPE_SERIAL_3_1:
      moves = filterBeats(
        TYPE_SERIAL_3_1,
        mg.genType11Serial31(rivalLen(rivalInfo.len)),
        rival,
      );
      break;
    case TYPE_SERIAL_3_2:
      moves = filterBeats(
        TYPE_SERIAL_3_2,
        mg.genType12Serial32(rivalLen(rivalInfo.len)),
        rival,
      );
      break;
    case TYPE_4_2:
      moves = filterBeats(TYPE_4_2, mg.genType13(), rival);
      break;
    case TYPE_4_22:
      moves = filterBeats(TYPE_4_22, mg.genType14(), rival);
      break;
    default:
      moves = [];
  }

  // 压普通牌型时，炸弹与王炸永远可以追打
  if (
    rivalInfo.type !== TYPE_PASS &&
    rivalInfo.type !== TYPE_BOMB &&
    rivalInfo.type !== TYPE_KING_BOMB
  ) {
    moves.push(...mg.genType4Bomb(), ...mg.genType5KingBomb());
  }

  // 有压的目标时，「不出」也是合法动作
  if (rival.length !== 0) moves.push([]);

  return moves.map((m) => [...m].sort((a, b) => a - b));
}

function rivalLen(len: number | undefined): number {
  return len ?? 0;
}
