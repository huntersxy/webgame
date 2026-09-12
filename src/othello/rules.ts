/* ────────────────────────────────────────────────────────────
 *  othello/rules.ts — 黑白棋规则（64 位位棋盘，两个 32 位字）
 *
 *  为什么不用 BigInt：BigInt 每次运算都分配对象，深搜里是纯开销；
 *  两个 number 的位运算无分配，node 与浏览器都够快。
 *
 *  位序（容易踩坑，务必按此实现）：
 *    index = y*8 + x（0..63）。bit k 表示 index k（大端）：
 *    k < 32 落在 lo，k >= 32 落在 hi = 索引 32..63 的 bit (k-32)。
 *
 *  各方向移位（每个方向只移一格，越界位直接丢弃）：
 *    left  = 索引 +1（位整体左移 1；lo 的 bit31 进位给 hi 的 bit0；
 *            以 !(k&7) 掩码清掉绕到下一行左端的位）
 *    right = 索引 -1（位整体右移 1；hi 的 bit0 借位给 lo 的 bit31）
 *    down  = 索引 +8（位整体左移 8；lo 的高 8 位进位给 hi）
 *    up    = 索引 -8（位整体右移 8；hi 的低 8 位借位给 lo）
 *  斜向 = 两个单步的组合。
 *
 *  射线推进的两个判定（这里曾出过真实 bug，别改回去）：
 *    · 「下一格是对方的子」必须用 **子集判定**（cur 的每一位都在 opp 里），
 *      用「有交集」会把空格也当成对方棋子，凭空多出镜像合法点。
 *    · 夹击成立要求「下一格是自己的子」（单格，用位测试即可）。
 * ──────────────────────────────────────────────────────────── */

import type { OthBoard, OthDisc, Pt } from '../types';

export const SIZE = 8;
export const CELLS = SIZE * SIZE;

type Word = [number, number];

export interface OthPosition {
  /** 黑方棋子位 [lo, hi] */
  black: Word;
  /** 白方棋子位 [lo, hi] */
  white: Word;
  /** 轮走方 */
  side: OthDisc;
}

/* ── 单步移位 ── */

function shiftLeft(lo: number, hi: number): Word {
  // 先清掉 x=7 列（位 7/15/.../63）再左移：这些位左移会绕到下一行左端
  const a = (lo & 0x7f7f7f7f);
  const b = (hi & 0x7f7f7f7f);
  return [((a << 1) >>> 0), ((((a >>> 31) | (b << 1)) & 0xfefefefe) >>> 0)];
}
function shiftRight(lo: number, hi: number): Word {
  // 先清掉 x=0 列（位 0/8/.../56）再右移：这些位右移会绕到上一行右端
  const a = (hi & 0xfefefefe);
  const b = (lo & 0xfefefefe);
  return [(((b >>> 1) | ((a & 1) << 31)) >>> 0), ((a >>> 1) >>> 0)];
}
function shiftDown(lo: number, hi: number): Word {
  return [((lo << 8) >>> 0), (((hi << 8) | (lo >>> 24)) >>> 0)];
}
function shiftUp(lo: number, hi: number): Word {
  return [(((lo >>> 8) | (hi << 24)) >>> 0), ((hi >>> 8) >>> 0)];
}

/** 方向表：0=左 1=右 2=下 3=上 4=左下 5=右下 6=左上 7=右上 */
const SHIFT: ReadonlyArray<(lo: number, hi: number) => Word> = [
  shiftLeft, shiftRight, shiftDown, shiftUp,
  (lo, hi) => shiftLeft(...shiftDown(lo, hi)),
  (lo, hi) => shiftRight(...shiftDown(lo, hi)),
  (lo, hi) => shiftLeft(...shiftUp(lo, hi)),
  (lo, hi) => shiftRight(...shiftUp(lo, hi)),
];

/** 方向表的 (dx, dy)，供界面与候选排序使用 */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
];

/**
 * 格索引 ↔ 位：**同一个编号**，不做任何置换。
 *
 * 约定 index = y*8 + x，行 0 是棋盘顶部、x=0 是 a 列（a1 在棋盘左下角）。
 * 位棋盘里的 bit k 就代表格 k（k < 32 在 lo，k ≥ 32 在 hi），所以「内部索引」
 * 与「对外索引」是同一个东西——这一点非常关键：一旦再引入一次 63-i 之类的
 * 置换，就会出现「引擎以为在下 d3、界面显示 d5」这类镜像错位。
 * 界面上「行 0 在顶」还是「在底」是纯视觉问题，由 UI 层各自处理。
 */
export function bitOfIndex(i: number): Word {
  return i < 32 ? [(1 << i) >>> 0, 0] : [0, (1 << (i - 32)) >>> 0];
}

/** 一组格索引 → 两个 32 位字 */
export function bits(indices: readonly number[]): Word {
  let lo = 0, hi = 0;
  for (const i of indices) {
    if (i < 32) lo = (lo | (1 << i)) >>> 0;
    else hi = (hi | (1 << (i - 32))) >>> 0;
  }
  return [lo >>> 0, hi >>> 0];
}

function isEmpty(a: Word): boolean {
  return a[0] === 0 && a[1] === 0;
}

/** 单格位是否与集合有交（用于「这一格是我的子」） */
function hits(set: Word, bit: Word): boolean {
  return (((set[0] & bit[0]) | (set[1] & bit[1])) >>> 0) !== 0;
}

/** cur 的每一位是否都落在 set 里（夹击链推进必须用子集判定） */
function subset(set: Word, cur: Word): boolean {
  return (((cur[0] & ~set[0]) | (cur[1] & ~set[1])) >>> 0) === 0;
}

function union(a: Word, b: Word): Word {
  return [((a[0] | b[0]) >>> 0), ((a[1] | b[1]) >>> 0)];
}
function diff(a: Word, b: Word): Word {
  return [((a[0] & ~b[0]) >>> 0), ((a[1] & ~b[1]) >>> 0)];
}

/**
 * 开局中央四子（标准黑白棋起始局面，棋谱记谱）：
 *   白 d4(3,3→index 27) e5(4,4→index 36)
 *   黑 e4(4,3→index 28) d5(3,4→index 35)
 * 即 index = (rank-1)*8 + (file)，与记谱一一对应；黑先。
 */
export function initialPosition(): OthPosition {
  return { black: bits([28, 35]), white: bits([27, 36]), side: 1 };
}

/** 位棋盘 → 64 格数组（界面 / worker 传输用） */
export function toCells(pos: OthPosition): OthBoard {
  const out = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    const b = bitOfIndex(i);
    if (hits(pos.black, b)) out[i] = 1;
    else if (hits(pos.white, b)) out[i] = 2;
  }
  return out;
}

/** 64 格数组 → 位棋盘 */
export function fromCells(cells: OthBoard, side: OthDisc): OthPosition {
  const black: number[] = [];
  const white: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (cells[i] === 1) black.push(i);
    else if (cells[i] === 2) white.push(i);
  }
  return { black: bits(black), white: bits(white), side };
}

export const PASS_MOVE: Pt = { x: -1, y: -1 };

export function isPass(m: Pt | null | undefined): boolean {
  return !!m && (m.x < 0 || m.y < 0);
}

/** 掩码 → 格索引数组（升序） */
export function maskToIndices(mask: Word): number[] {
  const out: number[] = [];
  let lo = mask[0], hi = mask[1];
  while (lo) {
    const b = lo & -lo;
    out.push(31 - Math.clz32(b));
    lo = (lo ^ b) >>> 0;
  }
  while (hi) {
    const b = hi & -hi;
    out.push(32 + 31 - Math.clz32(b));
    hi = (hi ^ b) >>> 0;
  }
  return out;
}

/**
 * 从「落子后的自己」出发沿方向 d 收集被夹住的对方棋。
 * 成立条件：沿该方向先遇到 ≥1 枚对方棋，紧接着是一枚自己棋。
 */
function flipRay(bit: Word, own: Word, opp: Word, d: number): Word | null {
  const sh = SHIFT[d];
  // 起点必须是「落下的那一枚棋」朝该方向走一格：先整体移一格，再与对方棋求交。
  // （不能把整盘自己的棋一起平移——那是两个以上棋子的连锁位移，位置全错。）
  const step1 = sh(bit[0], bit[1]);
  let cur = andMask(step1, opp);
  let mask: Word = [0, 0];
  for (let step = 0; step < 6; step++) {
    if (isEmpty(cur)) break;
    // 整格（可能多位）都必须是对方的子
    if (!subset(opp, cur)) break;
    mask = union(mask, cur);
    cur = sh(cur[0], cur[1]);
    // 遇到自己的子 → 夹击闭合
    if (hits(own, cur)) return isEmpty(mask) ? null : mask;
  }
  return null;
}

function andMask(a: Word, b: Word): Word {
  return [((a[0] & b[0]) >>> 0), ((a[1] & b[1]) >>> 0)];
}

/** 某方全部合法落点位 */
export function legalMask(pos: OthPosition): Word {
  const own = pos.side === 1 ? pos.black : pos.white;
  const opp = pos.side === 1 ? pos.white : pos.black;
  const occupied = union(own, opp);
  let res: Word = [0, 0];
  for (let i = 0; i < CELLS; i++) {
    const bit = bitOfIndex(i);
    if (hits(occupied, bit)) continue;
    for (let d = 0; d < 8; d++) {
      if (flipRay(bit, own, opp, d)) {
        res = union(res, bit);
        break;
      }
    }
  }
  return res;
}

/** 合法落点索引列表（升序） */
export function legalMoves(pos: OthPosition): number[] {
  return maskToIndices(legalMask(pos));
}

export function hasLegal(pos: OthPosition): boolean {
  return !isEmpty(legalMask(pos));
}

export interface OthPlacement {
  pos: OthPosition;
  /** 这一手翻掉的棋子数 */
  flipped: number;
  /** 被翻掉的棋子位（界面翻转动画用） */
  flippedMask: Word;
}

/** 在 index 落子；非法（越界 / 占用 / 翻不到子）返回 null */
export function place(pos: OthPosition, index: number): OthPlacement | null {
  if (index < 0 || index >= CELLS) return null;
  const own = pos.side === 1 ? pos.black : pos.white;
  const opp = pos.side === 1 ? pos.white : pos.black;
  const bit = bitOfIndex(index);
  if (hits(union(own, opp), bit)) return null;

  const after = union(own, bit);
  let flips: Word = [0, 0];
  let any = false;
  for (let d = 0; d < 8; d++) {
    const m = flipRay(bit, own, opp, d);
    if (m) {
      flips = union(flips, m);
      any = true;
    }
  }
  if (!any) return null;

  // 新局面：自己 = 原自己 + 落点 + 被翻过来的子；对方 = 原对方 - 被翻的子
  const newOwn = union(after, flips);
  const newOpp = diff(opp, flips);
  const flipped = popcount(flips[0]) + popcount(flips[1]);
  const next: OthPosition = pos.side === 1
    ? { black: newOwn, white: newOpp, side: 2 }
    : { black: newOpp, white: newOwn, side: 1 };
  return { pos: next, flipped, flippedMask: flips };
}

export interface OthResult {
  over: boolean;
  /** 0 = 和棋 */
  winner: 0 | OthDisc;
  black: number;
  white: number;
}

/** 终局判定 + 数子：双方都无合法点时终局 */
export function result(pos: OthPosition): OthResult {
  const black = discCount(pos, 1);
  const white = discCount(pos, 2);
  const over = !hasLegal(pos) && !hasLegal({ ...pos, side: other(pos.side) });
  return {
    over,
    winner: black === white ? 0 : black > white ? 1 : 2,
    black,
    white,
  };
}

export function discCount(pos: OthPosition, side: OthDisc): number {
  const b = side === 1 ? pos.black : pos.white;
  return popcount(b[0]) + popcount(b[1]);
}

export function popcount(v: number): number {
  let x = v >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

export function other(side: OthDisc): OthDisc {
  return side === 1 ? 2 : 1;
}

export function indexOf(x: number, y: number): number {
  return y * 8 + x;
}
