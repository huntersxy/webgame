/* ────────────────────────────────────────────────────────────
 *  tests/ddz.test.mts — 斗地主规则 / 编码 / 对局自测
 *
 *  覆盖：牌型判定（14 类 + 错型）、走法生成与压牌过滤、
 *  编码器黄金值（cards2array / x 维度 / z 布局）、
 *  叫分流程、春天/反春结算，以及全程启发式驱动的随机对局不变量。
 * ──────────────────────────────────────────────────────────── */

import { check, section, finish } from './harness.mts';
import {
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
  type Move,
  getLegalMoves,
  getMoveType,
  isBombMove,
} from '../src/ddz/rules';
import { DdzGame, newDeck, positionOf, type DdzState } from '../src/ddz/game';
import { cards2array, getObs } from '../src/ddz/encoder';
import { bidScore, heuristicMove } from '../src/ddz/heuristic';

/** 可复现随机数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function type(move: Move): number {
  return getMoveType(move).type;
}

/* ══════════ 牌型判定 ══════════ */

section('牌型判定 getMoveType');
check('空 = 不出', type([]) === TYPE_PASS);
check('单张', type([5]) === TYPE_SINGLE && getMoveType([5]).rank === 5);
check('对子', type([7, 7]) === TYPE_PAIR && getMoveType([7, 7]).rank === 7);
check('王炸 [20,30]', type([20, 30]) === TYPE_KING_BOMB);
check('两张异点非王炸 = 错型', type([5, 7]) === TYPE_WRONG);
check('三张', type([9, 9, 9]) === TYPE_TRIPLE);
check('三张带异点两张 = 错型', type([9, 9, 9, 5, 7]) === TYPE_WRONG);
check('炸弹', type([6, 6, 6, 6]) === TYPE_BOMB);
check('三带一', type([8, 8, 8, 3]) === TYPE_3_1 && getMoveType([3, 8, 8, 8]).rank === 8);
check('三带二（对子）', type([8, 8, 8, 3, 3]) === TYPE_3_2 && getMoveType([3, 3, 8, 8, 8]).rank === 8);
check('对子+对子 = 错型', type([3, 3, 8, 8]) === TYPE_WRONG);
check('顺子 3-7', type([3, 4, 5, 6, 7]) === TYPE_SERIAL_SINGLE && getMoveType([3, 4, 5, 6, 7]).rank === 3);
check('四张连牌 = 错型（顺子最少 5 张）', type([3, 4, 5, 6]) === TYPE_WRONG);
check('顺子到 A 封顶', type([10, 11, 12, 13, 14]) === TYPE_SERIAL_SINGLE);
check('含 2 的「顺子」= 错型', type([10, 11, 12, 13, 14, 17]) === TYPE_WRONG);
check('含王的「顺子」= 错型', type([11, 12, 13, 14, 20]) === TYPE_WRONG);
check('连对 334455', type([3, 3, 4, 4, 5, 5]) === TYPE_SERIAL_PAIR && getMoveType([3, 3, 4, 4, 5, 5]).len === 3);
check('两对不成连对', type([3, 3, 4, 4]) === TYPE_WRONG);
check('飞机 333444', type([3, 3, 3, 4, 4, 4]) === TYPE_SERIAL_TRIPLE && getMoveType([3, 3, 3, 4, 4, 4]).len === 2);
check('飞机带单 33344456', type([3, 3, 3, 4, 4, 4, 5, 6]) === TYPE_SERIAL_3_1);
check('飞机带对 3334445566', type([3, 3, 3, 4, 4, 4, 5, 5, 6, 6]) === TYPE_SERIAL_3_2);
check('四带二（两单）', type([5, 5, 5, 5, 3, 8]) === TYPE_4_2 && getMoveType([3, 5, 5, 5, 5, 8]).rank === 5);
check('四带二（一对）', type([5, 5, 5, 5, 8, 8]) === TYPE_4_2);
check('四带两对', type([5, 5, 5, 5, 8, 8, 9, 9]) === TYPE_4_22 && getMoveType([5, 5, 5, 5, 8, 8, 9, 9]).rank === 5);
check('四带三单 = 错型', type([5, 5, 5, 5, 3, 8, 9]) === TYPE_WRONG);
check('炸弹判定 isBombMove', isBombMove([4, 4, 4, 4]) && isBombMove([20, 30]) && !isBombMove([3, 3]));

/* ══════════ 合法走法 ══════════ */

section('合法走法 getLegalMoves');
{
  const lead = getLegalMoves([3, 4], []);
  check(
    '领出：单牌全列且不可不出',
    lead.length === 2 && lead.some((m) => m[0] === 3) && lead.some((m) => m[0] === 4) && !lead.some((m) => m.length === 0),
  );
}
{
  const follow = getLegalMoves([3, 4, 4], [[5]]);
  check('跟单管不上：只剩不出', follow.length === 1 && follow[0].length === 0);
}
{
  const follow = getLegalMoves([3, 7, 7, 7, 7], [[5]]);
  check(
    '跟单：大牌 + 炸弹均可',
    follow.some((m) => m.length === 1 && m[0] === 7) && follow.some((m) => m.length === 4) && follow.some((m) => m.length === 0),
  );
}
{
  const follow = getLegalMoves([3, 3, 8, 8], [[5, 5]]);
  check('跟对：只有大对与不出', follow.some((m) => m[0] === 8 && m.length === 2) && !follow.some((m) => m.length === 1));
}
{
  const follow = getLegalMoves([7, 8, 9, 10, 11], [[3, 4, 5, 6, 7]]);
  check('跟顺子：等长更大', follow.some((m) => m.length === 5 && m[0] === 7) && follow.some((m) => m.length === 0));
}
{
  const seq: Move[] = [[5], [], []];
  const lead = getLegalMoves([3], seq);
  check('两手不出后轮到领出者：自由出且不可不出', lead.length === 1 && lead[0][0] === 3);
}
{
  const follow = getLegalMoves([20, 30], [[4, 4, 4, 4]]);
  check(
    '对炸弹：王炸可压（含不出）',
    follow.some((m) => m.length === 2 && m[0] === 20) && follow.some((m) => m.length === 0),
  );
}
{
  const follow = getLegalMoves([3, 8], [[4, 4, 4, 4]]);
  check('对炸弹管不上：只剩不出', follow.length === 1 && follow[0].length === 0);
}
{
  const follow = getLegalMoves([4, 4, 4, 4], [[20, 30]]);
  check('对王炸无解：只剩不出', follow.length === 1 && follow[0].length === 0);
}
{
  const hand: Move = [3, 3, 3, 3, 4, 4, 4, 4, 20, 30];
  const lead = getLegalMoves(hand, []);
  check(
    '领出含全部炸弹/王炸',
    lead.some((m) => m.length === 4 && m[0] === 3) && lead.some((m) => m.length === 4 && m[0] === 4) && lead.some((m) => m.length === 2 && m[0] === 20),
  );
  check('领出枚举无重复', new Set(lead.map((m) => m.join(','))).size === lead.length);
}

/* ══════════ 编码器 ══════════ */

section('编码器 encoder');
{
  const a = cards2array([3, 3, 3, 3]);
  check('四张 3 → 列 0 全 1', a[0] === 1 && a[1] === 1 && a[2] === 1 && a[3] === 1 && a[4] === 0);
  const b = cards2array([3]);
  check('单张 3 → 仅 row0', b[0] === 1 && b[1] === 0);
  const c = cards2array([20]);
  check('小王 → 下标 52', c[52] === 1 && c[53] === 0 && c.length === 54);
  const d = cards2array([30]);
  check('大王 → 下标 53', d[53] === 1);
  const e = cards2array([]);
  check('空走法 → 全 0', e.every((v) => v === 0));
  const f = cards2array([17, 17]);
  check('对 2 → 列 12（下标 48/49）', f[48] === 1 && f[49] === 1);
}

function baseState(): DdzState {
  return {
    hands: [[3], [4], [5]],
    landlordSeat: 0,
    actionSeq: [],
    lastMoveBySeat: [[], [], []],
    playedBySeat: [[], [], []],
    bombNum: 0,
    lastPid: -1,
    movesPlayedCount: [0, 0, 0],
    turn: 0,
  };
}

{
  const s = baseState();
  const obs = getObs(s, 0);
  check('地主视角 xDim=373', obs.xDim === 373);
  check('单手牌候选 n=1', obs.legalActions.length === 1 && obs.xBatch.length === 373);
  check(
    'x 黄金值：我的 3 在 0、他牌在 54+4/54+8、动作在 319',
    obs.xBatch[0] === 1 && obs.xBatch[54 + 4] === 1 && obs.xBatch[54 + 8] === 1 && obs.xBatch[319] === 1,
  );
  check('x 黄金值：剩牌 one-hot（各剩 1 张 → 下标 0）', obs.xBatch[270] === 1 && obs.xBatch[287] === 1);
  check('x 黄金值：炸弹 one-hot（0 → 下标 0）', obs.xBatch[304] === 1);
  check('z 维度 [1,5,162]', obs.zBatch.length === 5 * 162);
  check('z 全 0（未出过牌）', obs.zBatch.every((v) => v === 0));
}
{
  const s = baseState();
  s.actionSeq = [[5], [7, 7]];
  const obs = getObs(s, 0);
  // 15 手左补空：…, [](12), [5](13), [7,7](14)；row4 = 手 12/13/14
  check('z 黄金值：第 13 手 [5] 落在 4*162+54+8', obs.zBatch[4 * 162 + 54 + 8] === 1);
  check('z 黄金值：第 14 手对 7 落在 4*162+108+16/17', obs.zBatch[4 * 162 + 108 + 16] === 1 && obs.zBatch[4 * 162 + 108 + 17] === 1);
  check('z 黄金值：前 13 手全 0', obs.zBatch.slice(0, 4 * 162).every((v) => v === 0));
}
{
  const s = baseState();
  s.actionSeq = [[5]];
  const up = getObs(s, 2); // 座位 2 = 地主下家
  const farmer = getObs(s, 0 + 3 - 0 - 2); // 座位 1 = 地主上家
  check('农民视角 xDim=484', up.xDim === 484 && farmer.xDim === 484);
  check('农民 x 行长 484', up.xBatch.length === up.legalActions.length * 484);
}
{
  const s = baseState();
  s.landlordSeat = 1;
  check('角色映射：地主1 → 座位2 下家、座位0 上家', positionOf(1, 2) === 'landlord_down' && positionOf(1, 0) === 'landlord_up');
  const obs = getObs(s, 0);
  check('上家视角 484 维（地主在 1）', obs.xDim === 484);
}

/* ══════════ 叫分 ══════════ */

section('叫分 bidScore / 流程');
{
  check('双王 + 炸弹必叫 3', bidScore([
    { code: 30, suit: -1 }, { code: 20, suit: -1 },
    { code: 9, suit: 0 }, { code: 9, suit: 1 }, { code: 9, suit: 2 }, { code: 9, suit: 3 },
    { code: 3, suit: 0 }, { code: 4, suit: 0 }, { code: 5, suit: 0 }, { code: 6, suit: 0 },
    { code: 7, suit: 0 }, { code: 8, suit: 0 }, { code: 10, suit: 0 }, { code: 11, suit: 0 },
    { code: 12, suit: 0 }, { code: 13, suit: 0 }, { code: 14, suit: 0 },
  ]) === 3);
  check('全小牌不叫', bidScore([
    { code: 3, suit: 0 }, { code: 3, suit: 1 }, { code: 4, suit: 0 }, { code: 5, suit: 0 },
    { code: 6, suit: 0 }, { code: 7, suit: 0 }, { code: 8, suit: 0 }, { code: 9, suit: 0 },
    { code: 9, suit: 1 }, { code: 10, suit: 0 }, { code: 10, suit: 1 }, { code: 11, suit: 0 },
    { code: 11, suit: 1 }, { code: 12, suit: 0 }, { code: 13, suit: 0 }, { code: 4, suit: 1 },
    { code: 6, suit: 1 },
  ]) === 0);
}
{
  const g = new DdzGame(rng(7));
  const start = g.bidTurn;
  const a = g.bid(start, 2);
  check('叫 2 分后未定地主（需一圈叫完）', !a && g.phase === 'bid' && g.highestBid === 2);
  check('压分校验：低于/等于最高分被拒', !g.bid((start + 1) % 3, 2) && g.phase === 'bid');
  const b = g.bid((start + 1) % 3, 3);
  check('叫 3 分直接定地主', b && g.phase === 'play' && g.landlordSeat === (start + 1) % 3);
  check('地主拿底牌后 20 张', g.hands[g.landlordSeat].length === 20);
  check('地主先出', g.turn === g.landlordSeat);
}
{
  const g = new DdzGame(rng(11));
  const start = g.bidTurn;
  g.bid(start, 0);
  g.bid((start + 1) % 3, 0);
  const done = g.bid((start + 2) % 3, 0);
  check('三人不叫 → 自动重发且仍在叫分', done && g.phase === 'bid' && g.hands.every((h) => h.length === 17));
}

/* ══════════ 结算 ══════════ */

section('结算 settlement');
{
  // 春天：地主一手走完，农民未出牌
  const g = new DdzGame(rng(3));
  g.phase = 'play';
  g.landlordSeat = 0;
  g.turn = 0;
  g.lastPid = 0;
  g.highestBid = 2;
  g.hands = [[{ code: 3, suit: 0 }], [{ code: 5, suit: 0 }], [{ code: 9, suit: 0 }]];
  const err = g.play(0, g.hands[0]);
  check('一手走完结束', err === null && g.phase === 'over');
  const r = g.result;
  check('春天标记 + 倍数 ×2', !!r && r.spring && r.multiplier === 2 && r.winnerSide === 'landlord');
  check('春天计分：地主 +8 / 农民 -4', !!r && r.deltas[0] === 8 && r.deltas[1] === -4 && r.deltas[2] === -4);
  check('积分和为零', !!r && r.deltas[0] + r.deltas[1] + r.deltas[2] === 0);
}
{
  // 反春：地主只出一手，农民走完
  const g = new DdzGame(rng(5));
  g.phase = 'play';
  g.landlordSeat = 0;
  g.turn = 0;
  g.lastPid = 0;
  g.highestBid = 1;
  g.hands = [
    [{ code: 3, suit: 0 }, { code: 4, suit: 0 }],
    [{ code: 9, suit: 0 }],
    [{ code: 5, suit: 0 }],
  ];
  g.play(0, [g.hands[0][0]]); // 地主出单 3
  const err = g.playCodes(1, [9]); // 右家管上并走完
  check('反春：农民走完', err === null && g.phase === 'over');
  const r = g.result;
  check('反春标记 + 倍数 ×2', !!r && r.antiSpring && r.multiplier === 2 && r.winnerSide === 'farmers');
  check('反春计分：地主 -4 / 农民各 +2', !!r && r.deltas[0] === -4 && r.deltas[1] === 2 && r.deltas[2] === 2);
}
{
  // 炸弹翻倍
  const g = new DdzGame(rng(9));
  g.phase = 'play';
  g.landlordSeat = 0;
  g.turn = 0;
  g.lastPid = 0;
  g.highestBid = 3;
  g.hands = [
    [{ code: 6, suit: 0 }, { code: 6, suit: 1 }, { code: 6, suit: 2 }, { code: 6, suit: 3 }],
    [{ code: 5, suit: 0 }, { code: 5, suit: 1 }],
    [{ code: 9, suit: 0 }],
  ];
  g.playCodes(0, [6, 6, 6, 6]);
  check('炸弹计数 +1', g.bombNum === 1);
  const r = g.result;
  // 地主炸弹走完：反春条件不满足（地主出了 1 手且出过牌 → 恰为 1 手，农民未出 → 其实是春天）
  check('炸弹后结算倍数 ×2 且为春天', !!r && r.bombNum === 1 && r.spring && r.multiplier === 4);
}

/* ══════════ 随机对局不变量 ══════════ */

section('随机对局 30 局（启发式驱动）');
{
  let ok = true;
  let maxTurns = 0;
  let bombsSeen = 0;
  let landlordWins = 0;
  for (let seed = 1; seed <= 30 && ok; seed++) {
    const rand = rng(seed * 1013904223);
    const g = new DdzGame(rand);
    // 叫分：与控制器同款策略
    let guard = 0;
    while (g.phase === 'bid' && guard++ < 30) {
      const seat = g.bidTurn;
      let v = bidScore(g.hands[seat]);
      if (v <= g.highestBid) v = 0;
      g.bid(seat, v);
    }
    if (g.phase !== 'play') {
      ok = false;
      console.log(`  seed=${seed} 叫分未收敛 phase=${g.phase}`);
      break;
    }
    let prevPasses = 0;
    let turns = 0;
    while (g.phase === 'play' && turns++ < 3000) {
      const seat = g.turn;
      const move = heuristicMove(g.snapshot(), seat);
      let err: string | null;
      if (move.length === 0) {
        err = g.pass(seat);
        prevPasses += 1;
      } else {
        err = g.playCodes(seat, move);
        prevPasses = 0;
      }
      if (err) {
        ok = false;
        console.log(`  seed=${seed} 非法动作 seat=${seat} move=[${move}] err=${err} turn=${turns}`);
        break;
      }
      if (prevPasses > 2) {
        ok = false;
        console.log(`  seed=${seed} 连续三手不出（第 ${turns} 手）`);
        break;
      }
    }
    if (g.phase !== 'over' || !g.result) {
      ok = false;
      console.log(`  seed=${seed} 未正常结束 phase=${g.phase} turns=${turns}`);
      break;
    }
    const totalCards = g.hands.reduce((s, h) => s + h.length, 0) + g.playedBySeat.reduce((s, p) => s + p.length, 0);
    if (totalCards !== 54) {
      ok = false;
      console.log(`  seed=${seed} 牌数不守恒：${totalCards}`);
      break;
    }
    const deltaSum = g.result.deltas[0] + g.result.deltas[1] + g.result.deltas[2];
    if (deltaSum !== 0) {
      ok = false;
      console.log(`  seed=${seed} 积分和不为零：${deltaSum}`);
      break;
    }
    // 炸弹数与序列一致
    const bombsInSeq = g.actionSeq.filter((m) => m.length > 0 && isBombMove(m)).length;
    if (bombsInSeq !== g.result.bombNum) {
      ok = false;
      console.log(`  seed=${seed} 炸弹计数不一致 seq=${bombsInSeq} state=${g.result.bombNum}`);
      break;
    }
    maxTurns = Math.max(maxTurns, turns);
    bombsSeen += bombsInSeq;
    if (g.result.winnerSide === 'landlord') landlordWins += 1;
  }
  check('30 局全部合法结束、牌数守恒、积分/炸弹一致', ok);
  console.log(`  （信息）最多 ${maxTurns} 手结束，共出炸弹 ${bombsSeen} 次，地主胜 ${landlordWins}/30`);
}

/* ══════════ 牌组 ══════════ */

section('牌组 deck');
{
  const deck = newDeck();
  check('54 张且牌值分布正确', deck.length === 54);
  const codes = new Set(deck.map((c) => c.code));
  check('13 点 × 4 花色 + 双王', codes.size === 15 && deck.filter((c) => c.code < 20).length === 52);
}

finish('ddz');
