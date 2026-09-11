/* ────────────────────────────────────────────────────────────
 *  go/area.ts — 区域归属（KataGo `Board::calculateArea` 口径）
 *
 *  这是 KataGo v7 输入平面 18/19 的来源，也是「盘面哪块地归谁」的
 *  判定。它比「被单色包围的空区就归该色」精细得多：
 *
 *   1. 把棋盘切成 region：region 里既有空点、也有**对方的棋子**
 *      （对方的入侵子属于我方模样的一部分，正是判断死活的关键）。
 *   2. 对每一方 pla：region 若「内部空点 ≤ 1」且不贴着被判死的棋块，
 *      整块（含对方死子）归 pla；否则退回「不含对方子且挨着我方棋子」
 *      的大模样规则，只把该 region 的空点算给 pla。
 *   3. 棋块先用 Benson 迭代判活：一个块要活，至少要有 ≥2 个
 *      「要害 region」——区域内每个空点都紧贴该块。少一个就判死，
 *      并把它接触的 region 标记为「贴死块」、相应递减相关块的计数，
 *      反复直到稳定。
 *   4. 最后仍未归属的点按棋子自身颜色计入（KataGo nonPassAliveStones）。
 *
 *  这套规则里「内部空点 ≤ 1」这一条是关键：一个单点眼虽然只有 1 个
 *  空点（因此按「≥2 气才算要害」的粗口径永远判不活），但它内部空点
 *  为 0，所以两只单点眼仍然算活棋——这正是 Benson 定理要表达的东西。
 *
 *  实现以 MIT 许可的 Sir-Teo/web-katrain（Browser KaTrain）为对照，
 *  与其在固定参数（safe/unsafe big territories、nonPassAliveStones
 *  全开）下的输出保持一致。
 * ──────────────────────────────────────────────────────────── */

import { BLACK, EMPTY, WHITE, floodGroup, geometryFor, type GoColor, type GoGeometry } from './rules';

/** 一方的区域判定结果写入 result；返回时只保证「已判定为 pla 的点」被写过 */
interface RegionInfo {
  /** region 头（代表点） */
  head: number;
  /** region 内的点（空点 + 对方棋子） */
  points: number[];
  /** 不含对方棋子 */
  containsOpp: boolean;
  /** 内部空点数（不与 pla 棋子相邻的空点），封顶 2 */
  internalSpaces: number;
  /** 对该 region 来说「要害」的己方棋块 id */
  vitalGroups: number[];
  /** 贴着一个已被判死的棋块 */
  bordersDead: boolean;
}

/**
 * 单方（pla）的区域判定，等价于参考实现里的 calculateAreaForPla，
 * 参数固定为 safeBigTerritories = unsafeBigTerritories = true。
 */
function calculateAreaForColor(args: {
  stones: Uint8Array;
  geo: GoGeometry;
  pla: GoColor;
  /** true = 只算严格的死活区域（KataGo 的 rootSafeArea），不套大模样规则 */
  strict: boolean;
  result: Uint8Array;
}): void {
  const { stones, geo, pla, strict, result } = args;
  const area = geo.area;
  const opp: GoColor = pla === BLACK ? WHITE : BLACK;

  const hasPla = stones.some((v) => v === pla);
  if (!hasPla) return;

  /* ── 1. 己方棋块 ── */
  const groupIdByPos = new Int16Array(area).fill(-1);
  const groupStones: number[][] = [];
  const groupBuf = new Int16Array(area);
  const libBuf = new Int16Array(area);
  for (let p = 0; p < area; p++) {
    if (stones[p] !== pla || groupIdByPos[p] >= 0) continue;
    const info = floodGroup(stones, geo, p, groupBuf, libBuf);
    const id = groupStones.length;
    const cells: number[] = [];
    for (let k = 0; k < info.groupLen; k++) {
      groupIdByPos[groupBuf[k]] = id;
      cells.push(groupBuf[k]);
    }
    groupStones.push(cells);
  }

  /* ── 2. 区域：空点 + 对方棋子 ── */
  const regionIdByPos = new Int16Array(area).fill(-1);
  const regions: RegionInfo[] = [];
  for (let start = 0; start < area; start++) {
    if (regionIdByPos[start] >= 0) continue;
    const c = stones[start];
    if (c !== EMPTY && c !== opp) continue; // 己方棋子是区域边界

    const id = regions.length;
    const points: number[] = [];
    let containsOpp = false;
    let internalSpaces = 0;
    const stack = [start];
    regionIdByPos[start] = id;
    while (stack.length) {
      const p = stack.pop()!;
      points.push(p);
      if (stones[p] === opp) containsOpp = true;

      // 内部空点：空点且不挨任何己方棋子（封顶 2，够判定用）
      if (stones[p] === EMPTY && internalSpaces < 2) {
        let adjacentToPla = false;
        const ns0 = geo.neighborStart[p];
        const ne0 = geo.neighborStart[p + 1];
        for (let i = ns0; i < ne0; i++) {
          if (stones[geo.neighbors[i]] === pla) {
            adjacentToPla = true;
            break;
          }
        }
        if (!adjacentToPla) internalSpaces++;
      }

      const ns = geo.neighborStart[p];
      const ne = geo.neighborStart[p + 1];
      for (let i = ns; i < ne; i++) {
        const q = geo.neighbors[i];
        const cq = stones[q];
        if (cq !== EMPTY && cq !== opp) continue;
        if (regionIdByPos[q] >= 0) continue;
        regionIdByPos[q] = id;
        stack.push(q);
      }
    }

    // 该 region 的候选要块：相邻的己方棋块
    const candidates = new Set<number>();
    for (const p of points) {
      const ns = geo.neighborStart[p];
      const ne = geo.neighborStart[p + 1];
      for (let i = ns; i < ne; i++) {
        const g = groupIdByPos[geo.neighbors[i]];
        if (g >= 0) candidates.add(g);
      }
    }

    // 「要害」判定：区域内每个空点都必须紧贴该块
    const vital: number[] = [];
    for (const g of candidates) {
      let ok = true;
      for (const p of points) {
        if (stones[p] !== EMPTY) continue;
        let adjacent = false;
        const ns = geo.neighborStart[p];
        const ne = geo.neighborStart[p + 1];
        for (let i = ns; i < ne; i++) {
          if (groupIdByPos[geo.neighbors[i]] === g) {
            adjacent = true;
            break;
          }
        }
        if (!adjacent) {
          ok = false;
          break;
        }
      }
      if (ok) vital.push(g);
    }

    regions.push({ head: start, points, containsOpp, internalSpaces, vitalGroups: vital, bordersDead: false });
  }

  /* ── 3. Benson 迭代：要害 region 少于 2 的块判死 ── */
  const vitalCount = groupStones.map(() => 0);
  for (const r of regions) for (const g of r.vitalGroups) vitalCount[g]++;

  const killed = groupStones.map(() => false);
  for (;;) {
    let killedAny = false;
    for (let g = 0; g < groupStones.length; g++) {
      if (killed[g] || vitalCount[g] >= 2) continue;
      killed[g] = true;
      killedAny = true;
      // 该块接触的 region 都标记为「贴死块」，并递减这些 region 的要害计数
      for (const p of groupStones[g]) {
        const ns = geo.neighborStart[p];
        const ne = geo.neighborStart[p + 1];
        for (let i = ns; i < ne; i++) {
          const rid = regionIdByPos[geo.neighbors[i]];
          if (rid < 0) continue;
          const r = regions[rid];
          if (r.bordersDead) continue;
          r.bordersDead = true;
          for (const gg of r.vitalGroups) vitalCount[gg]--;
        }
      }
    }
    if (!killedAny) break;
  }

  /* ── 4. 写结果 ── */
  for (let g = 0; g < groupStones.length; g++) {
    if (killed[g]) continue;
    for (const p of groupStones[g]) result[p] = pla;
  }

  for (const r of regions) {
    // ① 眼/活棋围空（内部空点 ≤ 1 且不贴死块）：整块连其中的对方死子一起归 pla
    const eyeMark = r.internalSpaces <= 1 && !r.bordersDead;
    // ② 安全的大模样：不含对方子且不贴死块
    const safeBig = !r.containsOpp && !r.bordersDead;
    // ③ 不安全的大模样：只要不含对方子就算（KataGo unsafeBigTerritories）
    const unsafeBig = !r.containsOpp;
    if (eyeMark) {
      for (const p of r.points) result[p] = pla;
    } else if (!strict && (safeBig || unsafeBig)) {
      for (const p of r.points) if (result[p] === EMPTY) result[p] = pla;
    }
  }
}

/**
 * 计算区域归属（KataGo `Board::calculateArea`，对应 v7 输入平面 18/19）。
 * 返回长度 area 的数组：0 = 无归属（不属于任何一方），1 = 黑，2 = 白。
 */
export function computeAreaMap(stones: Uint8Array, size: number): Uint8Array {
  const geo = geometryFor(size);
  const area = geo.area;
  const out = new Uint8Array(area);

  calculateAreaForColor({ stones, geo, pla: BLACK, strict: false, result: out });
  calculateAreaForColor({ stones, geo, pla: WHITE, strict: false, result: out });

  // nonPassAliveStones = true：仍未归属的点按棋子自身颜色计入
  for (let p = 0; p < area; p++) {
    if (out[p] === EMPTY && stones[p] !== EMPTY) out[p] = stones[p];
  }
  return out;
}

/**
 * 严格口径的 pass-alive 区域（KataGo 的 rootSafeArea）：只算无条件活棋的
 * 棋块与其围空，不套大模样规则，也不算未活的棋子。
 */
export function computePassAliveArea(stones: Uint8Array, size: number): Uint8Array {
  const geo = geometryFor(size);
  const out = new Uint8Array(geo.area);
  calculateAreaForColor({ stones, geo, pla: BLACK, strict: true, result: out });
  calculateAreaForColor({ stones, geo, pla: WHITE, strict: true, result: out });
  return out;
}
