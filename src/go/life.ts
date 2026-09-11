/* ────────────────────────────────────────────────────────────
 *  go/life.ts — 征子（ladder）特征
 *
 *  KataGo v7 输入平面 14/15/16/17 需要「哪些棋子会被征吃」「哪些点走上去
 *  能逃出征子」。KataGo 原版是一套带完整启发式的征子搜索；这里用有节点
 *  预算的等价简化搜索：
 *    · 只看「恰好两气」的己方棋块（一气即将被提，三气以上不会被征）
 *    · 攻方只紧气（走目标块的气），守方增气或反提紧贴的对方子
 *    · 攻方只要有一条路吃到即判「被征」，守方只要有一条逃路即判「不被征」
 *    · 单次搜索 1200 节点预算、每手最多 40 次搜索，超预算按「未被征」返回
 *  常见形状与 KataGo 判定一致，极端形状可能不同（README 已注明）。
 *
 *  区域归属（平面 18/19）在 area.ts。
 * ──────────────────────────────────────────────────────────── */

import { EMPTY, floodGroup, geometryFor, opponent, type GoColor, type GoGeometry } from './rules';

const groupBuf = new Int16Array(512);
const libBuf = new Int16Array(512);

/* ══════════════ 征子（ladder） ══════════════ */

/** 单次征子搜索的节点预算：超预算按「未被征吃」返回（保守，避免拖慢搜索） */
const LADDER_NODE_BUDGET = 1200;
/** 每手棋最多做多少次征子搜索（极端局面兜底） */
const LADDER_SEARCH_LIMIT = 40;
/** 征子最长手数上限 */
const LADDER_MAX_DEPTH = 40;

export interface LadderFeatures {
  /** 1 = 该点棋子（轮走方的子）若对方先走会被征吃 */
  laddered: Uint8Array;
  /** 1 = 轮走方走这里可以逃出征子 */
  workingMoves: Uint8Array;
}

interface MiniMove {
  index: number;
  color: GoColor;
  captured: number[];
  koPoint: number;
}

/**
 * 计算征子特征。
 * @param koPoint 当前劫禁着点（-1 表示无）
 * @param currentPlayer 轮走方
 */
export function computeLadderFeatures(
  stones: Uint8Array,
  size: number,
  koPoint: number,
  currentPlayer: GoColor,
): LadderFeatures {
  const geo = geometryFor(size);
  const area = geo.area;
  const laddered = new Uint8Array(area);
  const workingMoves = new Uint8Array(area);
  const scratch = new Uint8Array(area);
  const visited = new Uint8Array(area);
  let searches = 0;

  // 只有「恰好两气」的己方块可能被征：一气即将被提，三气以上逃得掉
  for (let p = 0; p < area; p++) {
    if (stones[p] !== currentPlayer || visited[p]) continue;
    const info = floodGroup(stones, geo, p, groupBuf, libBuf);
    const cells: number[] = [];
    for (let k = 0; k < info.groupLen; k++) {
      cells.push(groupBuf[k]);
      visited[groupBuf[k]] = 1;
    }
    if (info.libLen !== 2) continue;
    if (searches >= LADDER_SEARCH_LIMIT) break;
    searches++;

    const libs: number[] = [];
    for (let k = 0; k < info.libLen; k++) libs.push(libBuf[k]);

    scratch.set(stones);
    if (!isLadderCaptured(scratch, geo, p, koPoint, currentPlayer)) continue;
    for (const c of cells) laddered[c] = 1;

    // 逃出点：走上去之后不再是被征状态（增气成功或反提对方）
    for (const l of libs) {
      scratch.set(stones);
      const mv = miniPlay(scratch, geo, l, currentPlayer, koPoint);
      if (!mv) continue;
      if (!isLadderCaptured(scratch, geo, l, mv.koPoint, currentPlayer)) workingMoves[l] = 1;
    }
  }

  return { laddered, workingMoves };
}

/**
 * 判断 defenderColor 在 start 处的棋块，在攻击方先走的前提下是否
 * 会被征吃。攻方只紧气（走目标块的气），守方增气或反提。
 */
function isLadderCaptured(
  stones: Uint8Array,
  geo: GoGeometry,
  start: number,
  koPoint: number,
  defenderColor: GoColor,
): boolean {
  const attacker = opponent(defenderColor);
  const counter = { nodes: 0 };

  const search = (toPlay: GoColor, ko: number, depth: number): boolean => {
    if (++counter.nodes > LADDER_NODE_BUDGET) return false;
    if (stones[start] !== defenderColor) return true; // 目标块已被提掉
    const info = floodGroup(stones, geo, start, groupBuf, libBuf);
    if (info.libLen === 0) return true;
    if (info.libLen >= 3) return false; // 三气以上 = 逃出
    if (depth > LADDER_MAX_DEPTH) return false;

    const libs: number[] = [];
    for (let k = 0; k < info.libLen; k++) libs.push(libBuf[k]);

    if (toPlay === attacker) {
      // 攻方：只要有「一条」紧气到底的路线成立即是征子
      for (const m of libs) {
        const mv = miniPlay(stones, geo, m, attacker, ko);
        if (!mv) continue;
        const captured = search(defenderColor, mv.koPoint, depth + 1);
        miniUndo(stones, mv);
        if (captured) return true;
      }
      return false;
    }

    // 守方：只要有「一条」逃路（增气或反提）就不是征子
    const moves = libs.concat(defenderExtras(stones, geo, start, defenderColor));
    for (const m of moves) {
      const mv = miniPlay(stones, geo, m, defenderColor, ko);
      if (!mv) continue;
      const captured = search(attacker, mv.koPoint, depth + 1);
      miniUndo(stones, mv);
      if (!captured) return false;
    }
    return true;
  };

  return search(attacker, koPoint, 0);
}

/**
 * 守方额外候选点：紧贴目标块、且能提掉相邻对方棋块的点。
 * （提掉紧贴的对方子会给目标块多出气，是标准的「反打/滚打包收」逃法）
 */
function defenderExtras(stones: Uint8Array, geo: GoGeometry, start: number, defenderColor: GoColor): number[] {
  const attacker = opponent(defenderColor);
  const out: number[] = [];
  const info = floodGroup(stones, geo, start, groupBuf, libBuf);
  const groupCells: number[] = [];
  for (let k = 0; k < info.groupLen; k++) groupCells.push(groupBuf[k]);

  for (const s of groupCells) {
    const ns = geo.neighborStart[s];
    const ne = geo.neighborStart[s + 1];
    for (let i = ns; i < ne; i++) {
      const q = geo.neighbors[i];
      if (stones[q] !== attacker) continue;
      const gi = floodGroup(stones, geo, q, groupBuf, libBuf);
      if (gi.libLen !== 1) continue;
      const onlyLib = libBuf[0];
      if (stones[onlyLib] !== EMPTY) continue;
      if (!out.includes(onlyLib)) out.push(onlyLib);
    }
  }
  return out;
}

/** 在裸棋子上落子（含提子、禁自杀与简单劫）。返回 null 表示非法。 */
function miniPlay(
  stones: Uint8Array,
  geo: GoGeometry,
  index: number,
  color: GoColor,
  koPoint: number,
): MiniMove | null {
  if (index < 0 || index >= geo.area) return null;
  if (stones[index] !== EMPTY) return null;
  if (index === koPoint) return null;

  const opp = opponent(color);
  const ns = geo.neighborStart[index];
  const ne = geo.neighborStart[index + 1];

  // 能提子就不是自杀
  let canCapture = false;
  for (let i = ns; i < ne; i++) {
    const q = geo.neighbors[i];
    if (stones[q] === opp && floodGroup(stones, geo, q, groupBuf, libBuf).libLen === 1) {
      canCapture = true;
      break;
    }
  }
  if (!canCapture) {
    let hasLiberty = false;
    for (let i = ns; i < ne; i++) {
      const q = geo.neighbors[i];
      if (stones[q] === EMPTY) {
        hasLiberty = true;
        break;
      }
      if (stones[q] === color && floodGroup(stones, geo, q, groupBuf, libBuf).libLen >= 2) {
        hasLiberty = true;
        break;
      }
    }
    if (!hasLiberty) return null;
  }

  stones[index] = color;
  const captured: number[] = [];
  for (let i = ns; i < ne; i++) {
    const q = geo.neighbors[i];
    if (stones[q] !== opp) continue;
    const info = floodGroup(stones, geo, q, groupBuf, libBuf);
    if (info.libLen !== 0) continue;
    for (let k = 0; k < info.groupLen; k++) {
      captured.push(groupBuf[k]);
      stones[groupBuf[k]] = EMPTY;
    }
  }

  let ko = -1;
  if (captured.length === 1) {
    const own = floodGroup(stones, geo, index, groupBuf, libBuf);
    if (own.groupLen === 1 && own.libLen === 1) ko = captured[0];
  }
  return { index, color, captured, koPoint: ko };
}

/** 回退 miniPlay */
function miniUndo(stones: Uint8Array, move: MiniMove): void {
  stones[move.index] = EMPTY;
  const capturedColor = opponent(move.color);
  for (const p of move.captured) stones[p] = capturedColor;
}
