/* ────────────────────────────────────────────────────────────
 *  go/heuristic.ts — 无神经网络时的兜底围棋 AI
 *
 *  权重没下完 / 后端不可用 / 玩家选了「内置简单」时用它顶上，
 *  保证棋盘上永远有人应手。思路是最朴素的常识棋：
 *    ① 能吃对方子就吃（但不自杀）
 *    ② 自己被打吃就逃（或反提）
 *    ③ 打吃对方
 *    ④ 占据大场：靠近已有棋子的扩展点 / 星位 / 中腹
 *    ⑤ 不填自己的眼
 *  这不是棋力担当，只是「网络没就绪时也不会卡住」的保险。
 * ──────────────────────────────────────────────────────────── */

import { GoBoard, opponent, type GoColor } from './rules';

/** 随机数（可注入种子便于测试） */
export interface Rng {
  next(): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

interface ScoredMove {
  index: number;
  score: number;
}

/**
 * 给出一个兜底着法（-1 表示虚手）。
 * 只在「盘面已经没什么可下」时才虚手，避免一上来就 pass。
 */
export function heuristicMove(board: GoBoard, rng: Rng = mulberry32(12345)): number {
  const size = board.size;
  const area = board.area;
  const myColor = board.toMove;
  const opp = opponent(myColor);

  const candidates: ScoredMove[] = [];
  const ownAtariPoints: number[] = [];
  const eyeLike = new Uint8Array(area);

  // 自己被打吃的棋块 → 记下气点（用来逃）
  for (let p = 0; p < area; p++) {
    if (board.stones[p] !== myColor) continue;
    const libs = collectLibertyPoints(board, p);
    if (libs.length === 1) ownAtariPoints.push(libs[0]);
  }

  for (let p = 0; p < area; p++) {
    if (board.stones[p] !== 0) continue;
    if (!board.isLegal(p)) continue;

    const work = board.clone();
    work.play(p);
    // 落子后自己是否自杀式送死（提子后仍只有一气）
    const myLibs = collectLibertyPoints(work, p);
    if (myLibs.length === 1) continue; // 自己送吃，直接不选
    if (isOwnEye(board, p, myColor)) {
      eyeLike[p] = 1;
      continue; // 不填自己的眼
    }

    let score = 0;

    // ① 提子
    const captured = board.captures[0] + board.captures[1];
    const capturedNow = work.captures[0] + work.captures[1] - captured;
    score += capturedNow * 40;

    // ② 救自己被打吃的棋
    for (const lib of ownAtariPoints) {
      if (p === lib) score += 30;
    }

    // ③ 打吃对方
    for (let q = 0; q < area; q++) {
      if (work.stones[q] !== opp) continue;
      const oppLibs = collectLibertyPoints(work, q);
      if (oppLibs.length === 1) score += 12;
      break;
    }

    // ④ 靠近已有棋子（大场感）与中腹
    let neighbors = 0;
    let stonesNear = 0;
    const ns = board.geo.neighborStart[p];
    const ne = board.geo.neighborStart[p + 1];
    for (let i = ns; i < ne; i++) {
      const q = board.geo.neighbors[i];
      if (board.stones[q] !== 0) {
        neighbors++;
        if (board.stones[q] === myColor) stonesNear++;
      }
    }
    score += stonesNear * 3 + neighbors * 2;
    const x = p % size;
    const y = (p / size) | 0;
    const centerDist = Math.abs(x - (size - 1) / 2) + Math.abs(y - (size - 1) / 2);
    score += Math.max(0, 6 - centerDist * 0.7); // 略微偏中腹

    // ⑤ 星位加成（开局有模有样）
    if (isStarPoint(size, x, y) && board.stoneCount() < size * 2) score += 6;

    score += rng.next() * 4; // 加一点随机，避免每盘一样
    candidates.push({ index: p, score });
  }

  if (candidates.length === 0) {
    // 只剩自己的眼位可下 → 虚手
    return -1;
  }

  candidates.sort((a, b) => b.score - a.score);
  // 在前几名里随机取一个，免得每局都一模一样
  const topN = Math.min(3, candidates.length);
  const pick = Math.floor(rng.next() * topN);
  return candidates[pick].index;
}

/** 该点所在棋块的所有气（空点索引） */
function collectLibertyPoints(board: GoBoard, start: number): number[] {
  const geo = board.geo;
  const color = board.stones[start];
  if (color === 0) return [];
  const seen = new Set<number>();
  const libs = new Set<number>();
  const stack = [start];
  seen.add(start);
  while (stack.length) {
    const p = stack.pop()!;
    const ns = geo.neighborStart[p];
    const ne = geo.neighborStart[p + 1];
    for (let i = ns; i < ne; i++) {
      const q = geo.neighbors[i];
      const c = board.stones[q];
      if (c === 0) libs.add(q);
      else if (c === color && !seen.has(q)) {
        seen.add(q);
        stack.push(q);
      }
    }
  }
  return Array.from(libs);
}

/** 是否是自己的「眼」：四邻皆己方或边界，且对角基本为己方 */
function isOwnEye(board: GoBoard, p: number, color: GoColor): boolean {
  const size = board.size;
  const x = p % size;
  const y = (p / size) | 0;
  const at = (xx: number, yy: number): number => {
    if (xx < 0 || yy < 0 || xx >= size || yy >= size) return color; // 边界视作己方
    return board.stones[yy * size + xx];
  };
  if (at(x - 1, y) !== color || at(x + 1, y) !== color || at(x, y - 1) !== color || at(x, y + 1) !== color) return false;
  // 对角：至少 3 个是己方（假眼判定用简化条件）
  let own = 0;
  if (at(x - 1, y - 1) === color) own++;
  if (at(x + 1, y - 1) === color) own++;
  if (at(x - 1, y + 1) === color) own++;
  if (at(x + 1, y + 1) === color) own++;
  return own >= 3;
}

function isStarPoint(size: number, x: number, y: number): boolean {
  const line = size >= 13 ? 3 : 2;
  const mid = (size - 1) / 2;
  if (size === 9 || size === 13) {
    return (x === line || x === size - 1 - line || x === mid) && (y === line || y === size - 1 - line || y === mid);
  }
  const pts = [3, mid, size - 4];
  const near = (v: number): boolean => pts.some((q) => Math.abs(v - q) <= 1);
  return near(x) && near(y);
}
