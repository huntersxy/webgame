/* ────────────────────────────────────────────────────────────
 *  go/rules.ts — 围棋规则引擎：落子 / 提子 / 打劫 / 点目
 *
 *  设计要点：
 *  · 棋盘用一维 Uint8Array（0 空 · 1 黑 · 2 白），邻接表按尺寸
 *    预生成并缓存，热路径里没有对象分配。
 *  · GoBoard 是可变局面对象，play() 把撤销信息压进内部快照栈，
 *    undo() 弹出——MCTS 每手要 play/undo 上万次，这里不能靠
 *    复制整个棋盘。
 *  · 提子缓冲是共享的 Int16Array + 栈顶指针，快照只记起点，
 *    避免每次提子都 new 一个数组。
 *  · 哈希只编码「石子配置」（不含轮走方），用于位置超级劫。
 * ──────────────────────────────────────────────────────────── */

import { Zobrist } from '../core/zobrist';

/** 空点 */
export const EMPTY = 0;
/** 黑棋 */
export const BLACK = 1;
/** 白棋 */
export const WHITE = 2;
/** 虚手（停一手）用 -1 表示，与棋盘索引区分开 */
export const PASS = -1;

/** 棋子颜色：1 黑 2 白 */
export type GoColor = 1 | 2;
/** 棋盘格：0 空 1 黑 2 白 */
export type GoCell = 0 | 1 | 2;

/** 规则集：chinese = 中国规则（数子，贴目 7.5）；japanese = 日本规则（数目，提子计入） */
export type GoRuleset = 'chinese' | 'japanese';

/** 对局配置 */
export interface GoConfig {
  /** 棋盘边长 9 / 13 / 19 */
  size: number;
  /** 贴目（白方补偿） */
  komi: number;
  /** 规则集 */
  ruleset: GoRuleset;
  /** 是否启用位置超级劫（对局层用；搜索内部只用简单劫以换速度） */
  superko: boolean;
}

export function opponent(c: GoColor): GoColor {
  return c === BLACK ? WHITE : BLACK;
}

/* ── 几何：邻接表按尺寸缓存 ── */
export interface GoGeometry {
  size: number;
  area: number;
  /** 每个点的邻居起点（长度 area+1） */
  neighborStart: Int32Array;
  /** 邻居索引（长度 <= area*4） */
  neighbors: Int16Array;
}

const geoCache = new Map<number, GoGeometry>();

export function geometryFor(size: number): GoGeometry {
  const cached = geoCache.get(size);
  if (cached) return cached;

  const area = size * size;
  const neighborStart = new Int32Array(area + 1);
  const list: number[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      neighborStart[p] = list.length;
      if (x > 0) list.push(p - 1);
      if (x < size - 1) list.push(p + 1);
      if (y > 0) list.push(p - size);
      if (y < size - 1) list.push(p + size);
    }
  }
  neighborStart[area] = list.length;
  const geo: GoGeometry = { size, area, neighborStart, neighbors: Int16Array.from(list) };
  geoCache.set(size, geo);
  return geo;
}

/* ── Zobrist 哈希（只编码石子，用于位置超级劫） ── */
const zobristCache = new Map<number, Zobrist>();

function zobristFor(size: number): Zobrist {
  let z = zobristCache.get(size);
  if (!z) {
    z = new Zobrist(size, size, 2, 0x1f123bb5 ^ (size * 2654435761));
    zobristCache.set(size, z);
  }
  return z;
}

/* ── 提子缓冲：所有局面共享，避免热路径分配 ── */
const CAPTURE_BUF_SIZE = 512;
const captureBuf = new Int16Array(CAPTURE_BUF_SIZE);
let captureTop = 0;

interface GoSnapshot {
  /** 落子点（PASS 记为 -1） */
  move: number;
  /** 落子方（回退时用来还原被提子的颜色） */
  mover: GoColor;
  koPoint: number;
  passes: number;
  moveNumber: number;
  hash: number;
  /** captures[0] = 黑方提子数，captures[1] = 白方提子数 */
  capBlack: number;
  capWhite: number;
  captureStart: number;
}

/** 并查/泛洪用的世代戳，避免每次清零 visited */
const stampBuf = new Int32Array(512);
const groupBuf = new Int16Array(512);
const libBuf = new Int16Array(512);
let stamp = 0;

/* ── 提子/自由的通用泛洪：作用于裸 stones 数组 ── */
export interface GroupInfo {
  /** 该块棋子数 */
  groupLen: number;
  /** 气数 */
  libLen: number;
}

/**
 * 以 start 所在棋块做泛洪填充。结果写入模块级缓冲（groupBuf / libBuf），
 * 调用方需立刻消费——不返回数组就是为了不在热路径上分配。
 */
export function floodGroup(stones: Uint8Array, geo: GoGeometry, start: number, group: Int16Array, libs: Int16Array): GroupInfo {
  const color = stones[start];
  if (color === EMPTY) return { groupLen: 0, libLen: 0 };

  stamp++;
  let groupLen = 0;
  let libLen = 0;
  let sp = 0;
  group[groupLen++] = start;
  stampBuf[start] = stamp; // 用 stampBuf 同时标记「已入块」与「已计气」

  while (sp < groupLen) {
    const p = group[sp++];
    const ns = geo.neighborStart[p];
    const ne = geo.neighborStart[p + 1];
    for (let i = ns; i < ne; i++) {
      const q = geo.neighbors[i];
      const c = stones[q];
      if (c === EMPTY) {
        if (stampBuf[q] !== stamp) {
          stampBuf[q] = stamp;
          libs[libLen++] = q;
        }
      } else if (c === color && stampBuf[q] !== stamp) {
        stampBuf[q] = stamp;
        group[groupLen++] = q;
      }
    }
  }
  return { groupLen, libLen };
}

/** start 所在棋块的气数（空点返回 0） */
export function libertyCountAt(stones: Uint8Array, geo: GoGeometry, start: number): number {
  if (stones[start] === EMPTY) return 0;
  return floodGroup(stones, geo, start, groupBuf, libBuf).libLen;
}

/** 裸落子（模拟用）记录的被提点，供 koPointAfterMove 之类的调用方读取 */
const rawCaptureBuf = new Int16Array(CAPTURE_BUF_SIZE);

/**
 * 计算「轮走方落子后」的劫点。给特征编码用（上一手/上上手的劫点）。
 * index < 0（虚手）时返回 -1。
 */
export function koPointAfterMove(stones: Uint8Array, geo: GoGeometry, index: number, color: GoColor): number {
  if (index < 0 || index >= geo.area) return -1;

  const copy = scratchStones(geo.area + 1);
  copy.set(stones);
  const captured = applyMoveRaw(copy, geo, index, color);
  if (captured !== 1) return -1;
  // 劫：提且仅提一子，且落子方这手棋自己成为「单子一气」
  const info = floodGroup(copy, geo, index, groupBuf, libBuf);
  return info.groupLen === 1 && info.libLen === 1 ? rawCaptureBuf[0] : -1;
}

let scratchPool: Uint8Array | null = null;
function scratchStones(n: number): Uint8Array {
  if (!scratchPool || scratchPool.length < n) scratchPool = new Uint8Array(Math.max(n, 512));
  return scratchPool;
}

/**
 * 落子并提子（不做合法性检查）。返回提子数，提掉的点写进共享提子缓冲
 * （rawCaptureBuf，只有 applyMoveRaw 写它）。这是「模拟用」的裸函数，
 * 供特征编码/死活判断复用。
 */
export function applyMoveRaw(stones: Uint8Array, geo: GoGeometry, index: number, color: GoColor): number {
  stones[index] = color;
  const opp = opponent(color);
  let captured = 0;

  const ns = geo.neighborStart[index];
  const ne = geo.neighborStart[index + 1];
  for (let i = ns; i < ne; i++) {
    const q = geo.neighbors[i];
    if (stones[q] !== opp) continue;
    const info = floodGroup(stones, geo, q, groupBuf, libBuf);
    if (info.libLen !== 0) continue;
    // 提掉整块
    for (let k = 0; k < info.groupLen; k++) {
      const gp = groupBuf[k];
      if (captured < CAPTURE_BUF_SIZE) rawCaptureBuf[captured] = gp;
      stones[gp] = EMPTY;
    }
    captured += info.groupLen;
  }
  return captured;
}

/* ── 提子计数工具（给对局层的提子统计复用） ── */

/* ── 点数（区域 / 领地） ── */
export interface GoScore {
  /** 黑方得点（数子：子 + 空；数目：地 + 提子） */
  black: number;
  /** 白方得点（含贴目） */
  white: number;
  winner: 0 | GoColor;
  /** 胜出目数（黑胜为正） */
  margin: number;
  blackStones: number;
  whiteStones: number;
  blackTerritory: number;
  whiteTerritory: number;
  /** 单官/双活空点 */
  neutral: number;
}

/**
 * 数目。
 * @param deadMask 可选的死子掩码（1 = 该点棋子已死，按提子处理）
 * 中国规则数子（area）：子 + 围空；日本规则数目（territory）：空 + 提子。
 * komi 只加给白方。
 */
export function scorePosition(
  stones: Uint8Array,
  size: number,
  komi: number,
  ruleset: GoRuleset,
  deadMask?: Uint8Array | null,
  captures?: [number, number] | null,
): GoScore {
  const geo = geometryFor(size);
  const area = geo.area;

  // 先把死子摘掉（视为被提走）
  let work = stones;
  let deadCount: [number, number] = [0, 0];
  if (deadMask) {
    let hasDead = false;
    for (let i = 0; i < area; i++) if (deadMask[i] && stones[i] !== EMPTY) { hasDead = true; break; }
    if (hasDead) {
      work = new Uint8Array(area);
      work.set(stones);
      for (let i = 0; i < area; i++) {
        if (!deadMask[i]) continue;
        const c = work[i];
        if (c === EMPTY) continue;
        deadCount[c - 1]++;
        work[i] = EMPTY;
      }
    }
  }

  let blackStones = 0;
  let whiteStones = 0;
  for (let i = 0; i < area; i++) {
    if (work[i] === BLACK) blackStones++;
    else if (work[i] === WHITE) whiteStones++;
  }

  // 空区归属：泛洪每一块相邻空点，若只接触一种颜色则归其所有
  const visited = new Uint8Array(area);
  let blackTerritory = 0;
  let whiteTerritory = 0;
  let neutral = 0;

  for (let start = 0; start < area; start++) {
    if (work[start] !== EMPTY || visited[start]) continue;
    // 广度优先收集整块空区
    let head = 0;
    let tail = 0;
    const queue = groupBuf;
    queue[tail++] = start;
    visited[start] = 1;
    let touchesBlack = false;
    let touchesWhite = false;
    while (head < tail) {
      const p = queue[head++];
      const ns = geo.neighborStart[p];
      const ne = geo.neighborStart[p + 1];
      for (let i = ns; i < ne; i++) {
        const q = geo.neighbors[i];
        const c = work[q];
        if (c === EMPTY) {
          if (!visited[q]) {
            visited[q] = 1;
            queue[tail++] = q;
          }
        } else if (c === BLACK) touchesBlack = true;
        else touchesWhite = true;
      }
    }
    if (touchesBlack && !touchesWhite) blackTerritory += tail;
    else if (touchesWhite && !touchesBlack) whiteTerritory += tail;
    else neutral += tail;
  }

  const capBlack = captures ? captures[0] : 0;
  const capWhite = captures ? captures[1] : 0;

  let black: number;
  let white: number;
  if (ruleset === 'chinese') {
    // 数子：盘上活子 + 围空（提子不影响数子结果，故不计）
    black = blackStones + blackTerritory;
    white = whiteStones + whiteTerritory + komi;
  } else {
    // 数目：地 + 提子（对方死子计入己方提子）
    black = blackTerritory + capBlack + deadCount[WHITE - 1];
    white = whiteTerritory + capWhite + deadCount[BLACK - 1] + komi;
  }

  const diff = black - white;
  const winner: 0 | GoColor = diff > 0 ? BLACK : diff < 0 ? WHITE : 0;
  return {
    black,
    white,
    winner,
    margin: Math.abs(diff),
    blackStones,
    whiteStones,
    blackTerritory,
    whiteTerritory,
    neutral,
  };
}

/* ── 局面对象 ── */
export class GoBoard {
  readonly size: number;
  readonly area: number;
  readonly geo: GoGeometry;
  readonly stones: Uint8Array;

  toMove: GoColor = BLACK;
  /** 简单劫禁着点（-1 无） */
  koPoint = -1;
  /** 连续虚手数 */
  passes = 0;
  /** captures[0] 黑方提子数；captures[1] 白方提子数 */
  readonly captures: [number, number] = [0, 0];
  moveNumber = 0;
  /** 石子配置哈希（不含轮走方，供位置超级劫） */
  hash = 0;

  private readonly zobrist: Zobrist;
  private readonly snapshots: GoSnapshot[] = [];
  private snapTop = 0;

  constructor(size: number) {
    this.size = size;
    this.geo = geometryFor(size);
    this.area = this.geo.area;
    this.stones = new Uint8Array(this.area);
    this.zobrist = zobristFor(size);
  }

  static from(size: number, stones: Uint8Array | number[], toMove: GoColor = BLACK): GoBoard {
    const b = new GoBoard(size);
    b.stones.set(stones as ArrayLike<number>);
    b.toMove = toMove;
    b.hash = b.computeHash();
    return b;
  }

  clone(): GoBoard {
    const b = new GoBoard(this.size);
    b.stones.set(this.stones);
    b.toMove = this.toMove;
    b.koPoint = this.koPoint;
    b.passes = this.passes;
    b.captures[0] = this.captures[0];
    b.captures[1] = this.captures[1];
    b.moveNumber = this.moveNumber;
    b.hash = this.hash;
    return b;
  }

  private computeHash(): number {
    let h = 0;
    for (let i = 0; i < this.area; i++) {
      const c = this.stones[i];
      if (c === EMPTY) continue;
      h ^= this.zobrist.key(i % this.size, (i / this.size) | 0, c - 1);
    }
    return h >>> 0;
  }

  private xorStone(index: number, color: GoCell): void {
    if (color === EMPTY) return;
    this.hash ^= this.zobrist.key(index % this.size, (index / this.size) | 0, color - 1);
  }

  /** 该点的棋子所属棋块的气数 */
  libertyCountAt(index: number): number {
    return libertyCountAt(this.stones, this.geo, index);
  }

  /** 索引是否在盘内 */
  inBoard(index: number): boolean {
    return index >= 0 && index < this.area;
  }

  /** 空点且落子合法（不含超级劫，超级劫由对局层用哈希判） */
  isLegal(index: number): boolean {
    if (index < 0 || index >= this.area) return false;
    if (this.stones[index] !== EMPTY) return false;
    if (index === this.koPoint) return false;

    const color = this.toMove;
    const opp = opponent(color);
    const geo = this.geo;
    const stones = this.stones;

    // 先看能否提掉相邻的对方死块（有提子则一定不是自杀）
    const ns = geo.neighborStart[index];
    const ne = geo.neighborStart[index + 1];
    let capturesSomething = false;
    for (let i = ns; i < ne; i++) {
      const q = geo.neighbors[i];
      if (stones[q] !== opp) continue;
      if (libertyCountAt(stones, geo, q) === 1) {
        capturesSomething = true;
        break;
      }
    }
    if (capturesSomething) return true;

    // 无提子：落子后自身棋块必须有气（禁止自杀，中国规则）
    for (let i = ns; i < ne; i++) {
      const q = geo.neighbors[i];
      if (stones[q] === EMPTY) return true;
      if (stones[q] === color && libertyCountAt(stones, geo, q) >= 2) return true;
    }
    return false;
  }

  /**
   * 落子（含提子/劫/虚手）。返回 false 表示非法，局面不变。
   * 合法时把撤销信息压栈——undo() 弹栈回退。
   */
  play(index: number): boolean {
    const isPass = index === PASS;
    if (!isPass && !this.isLegal(index)) return false;

    // 压快照
    let snap = this.snapshots[this.snapTop];
    if (!snap) {
      snap = { move: PASS, mover: BLACK, koPoint: -1, passes: 0, moveNumber: 0, hash: 0, capBlack: 0, capWhite: 0, captureStart: 0 };
      this.snapshots[this.snapTop] = snap;
    }
    const color = this.toMove;
    const opp = opponent(color);

    snap.move = index;
    snap.mover = color;
    snap.koPoint = this.koPoint;
    snap.passes = this.passes;
    snap.moveNumber = this.moveNumber;
    snap.hash = this.hash;
    snap.capBlack = this.captures[0];
    snap.capWhite = this.captures[1];
    snap.captureStart = captureTop;
    this.snapTop++;

    if (isPass) {
      this.passes++;
      this.koPoint = -1;
    } else {
      this.passes = 0;
      this.stones[index] = color;
      this.xorStone(index, color);

      let captured = 0;
      const geo = this.geo;
      const ns = geo.neighborStart[index];
      const ne = geo.neighborStart[index + 1];
      for (let i = ns; i < ne; i++) {
        const q = geo.neighbors[i];
        if (this.stones[q] !== opp) continue;
        const info = floodGroup(this.stones, geo, q, groupBuf, libBuf);
        if (info.libLen !== 0) continue;
        for (let k = 0; k < info.groupLen; k++) {
          const gp = groupBuf[k];
          if (captureTop < CAPTURE_BUF_SIZE) captureBuf[captureTop++] = gp;
          this.xorStone(gp, this.stones[gp] as GoCell);
          this.stones[gp] = EMPTY;
        }
        captured += info.groupLen;
      }
      if (captured > 0) this.captures[color - 1] += captured;

      // 劫点：提且仅提一子，且自己成为单子一气
      if (captured === 1 && captureTop - snap.captureStart === 1) {
        const own = floodGroup(this.stones, geo, index, groupBuf, libBuf);
        this.koPoint = own.groupLen === 1 && own.libLen === 1 ? captureBuf[captureTop - 1] : -1;
      } else {
        this.koPoint = -1;
      }
    }

    this.moveNumber++;
    this.toMove = opp;
    return true;
  }

  /** 回退最后一手。返回 false 表示没有可回退的手。 */
  undo(): boolean {
    if (this.snapTop === 0) return false;
    const snap = this.snapshots[--this.snapTop];
    // 先把自己刚落的那颗子拿掉（虚手没有子）
    if (snap.move >= 0 && snap.move < this.area) this.stones[snap.move] = EMPTY;
    // 还原被提子：被提的一律是落子方的对方
    const capturedColor = opponent(snap.mover);
    while (captureTop > snap.captureStart) {
      const p = captureBuf[--captureTop];
      this.stones[p] = capturedColor;
    }
    this.koPoint = snap.koPoint;
    this.passes = snap.passes;
    this.moveNumber = snap.moveNumber;
    this.hash = snap.hash;
    this.captures[0] = snap.capBlack;
    this.captures[1] = snap.capWhite;
    this.toMove = snap.mover;
    return true;
  }

  /** 盘上棋子总数 */
  stoneCount(): number {
    let n = 0;
    for (let i = 0; i < this.area; i++) if (this.stones[i] !== EMPTY) n++;
    return n;
  }

  /** 当前合法着法掩码（1 = 合法），超级劫不在此判断 */
  legalMask(out?: Uint8Array): Uint8Array {
    const mask = out ?? new Uint8Array(this.area);
    mask.fill(0);
    for (let i = 0; i < this.area; i++) if (this.isLegal(i)) mask[i] = 1;
    return mask;
  }

  /** 数目（含贴目） */
  score(ruleset: GoRuleset, komi: number, deadMask?: Uint8Array | null): GoScore {
    return scorePosition(this.stones, this.size, komi, ruleset, deadMask, this.captures);
  }
}

/** 构造一个空局面 */
export function emptyBoard(size: number, toMove: GoColor = BLACK): GoBoard {
  return GoBoard.from(size, new Uint8Array(size * size), toMove);
}
