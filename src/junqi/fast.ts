/* ────────────────────────────────────────────────────────────
 *  junqi/fast.ts — 搜索用紧凑棋盘表示（规则镜像）
 *
 *  搜索热路径不复用 rules.ts 的对象棋盘：60 个节点压成 Uint8Array
 *  编码（0 = 空，其余 = 兵种序号×2 + 蓝方位），走法生成、战斗结算、
 *  make/undo 全在类型化数组上完成，避免字符串比较与逐节点对象分配。
 *
 *  本文件的规则语义必须与 rules.ts 完全一致——差分测试
 *  （tests/junqi.test.mts 的「紧凑表示」一节）在随机局面上逐项比对
 *  走法集合、战斗结算与 make/undo 还原，任何偏离都会被测试拦下。
 *
 *  走法编码：packed = (from << 6) | to，节点号 0..59 占 6 位。
 * ──────────────────────────────────────────────────────────── */

import {
  ADJ, COLS, PIECE_COUNTS, colOf, isCamp, isHQ, resolve, rowOf,
  type Board, type PType,
} from './rules';

export const N = 60;

/** 兵种序号：与 PIECE_COUNTS 同序 */
export const PTYPES: PType[] = PIECE_COUNTS.map(([t]) => t);
export const TI: Record<string, number> = {};
PTYPES.forEach((t, i) => { TI[t] = i; });

export const TI_司令 = TI['司令'];
export const TI_军长 = TI['军长'];
export const TI_工兵 = TI['工兵'];
export const TI_炸弹 = TI['炸弹'];
export const TI_地雷 = TI['地雷'];
export const TI_军旗 = TI['军旗'];

/** 编码 = 兵种序号×2 + 蓝方位 + 1（0 保留给空格） */
export const codeOf = (ti: number, isB: number): number => ti * 2 + isB + 1;
export const CODE_TI = new Uint8Array(26);
export const CODE_ISB = new Uint8Array(26);
for (let ti = 0; ti < PTYPES.length; ti++) {
  for (let s = 0; s < 2; s++) {
    CODE_TI[codeOf(ti, s)] = ti;
    CODE_ISB[codeOf(ti, s)] = s;
  }
}
/** 代码 1..25 的兵种可动性 / 序号，供走法生成直接索引 */
export const CODE_MOVABLE = new Uint8Array(26);
export const CODE_FLAG = new Uint8Array(26);
export const CODE_GB = new Uint8Array(26);
for (let c = 1; c < 26; c++) {
  CODE_MOVABLE[c] = PTYPES[CODE_TI[c]] === '地雷' || PTYPES[CODE_TI[c]] === '军旗' ? 0 : 1;
  CODE_FLAG[c] = CODE_TI[c] === TI_军旗 ? 1 : 0;
  CODE_GB[c] = CODE_TI[c] === TI_工兵 ? 1 : 0;
}
/** 各方军旗编码：索引 0 = 红, 1 = 蓝 */
export const FLAG_CODE = [codeOf(TI_军旗, 0), codeOf(TI_军旗, 1)];

/* ── 邻接 ───────────────────────────────────────────────────
 * 铁路边必为正交（横线 / 竖线 / 桥），用「节点×4方向」表直接索引，
 * 滑行时按方向一路 next 即可；公路边含行营斜线（8 个方向），
 * 用 CSR 邻接表存放，单步落点直接遍历。
 * ─────────────────────────────────────────────────────────── */
/** 铁轨方向（0 上 1 下 2 左 3 右）上的下一跳，非铁路为 -1 */
export const RAIL_NB = new Int8Array(N * 4).fill(-1);
/** 公路邻居 CSR：PLAIN_TO[PLAIN_OFF[i] .. PLAIN_OFF[i+1]) */
export const PLAIN_OFF = new Int32Array(N + 1);
export const PLAIN_TO = new Int8Array(N * 4);
(() => {
  let m = 0;
  for (let i = 0; i < N; i++) {
    PLAIN_OFF[i] = m;
    for (const e of ADJ[i]) {
      const dr = rowOf(e.to) - rowOf(i);
      const dc = colOf(e.to) - colOf(i);
      if (e.rail) {
        const d = dr === -1 ? 0 : dr === 1 ? 1 : dc === -1 ? 2 : 3;
        RAIL_NB[i * 4 + d] = e.to;
      } else {
        PLAIN_TO[m++] = e.to;
      }
    }
  }
  PLAIN_OFF[N] = m;
})();

/** 曼哈顿距离表：DIST[a*N+b]，供评估里的旗区威胁统计使用 */
export const DIST = new Uint8Array(N * N);
for (let a = 0; a < N; a++) {
  for (let b = 0; b < N; b++) {
    DIST[a * N + b] = Math.abs(((a / COLS) | 0) - ((b / COLS) | 0)) + Math.abs((a % COLS) - (b % COLS));
  }
}

/** 全部邻居（公路 + 铁路）CSR，供评估里的旗区守备统计使用 */
export const ADJ_OFF = new Int32Array(N + 1);
export const ADJ_TO = new Int8Array(N * 4);
(() => {
  let m = 0;
  for (let i = 0; i < N; i++) {
    ADJ_OFF[i] = m;
    for (const e of ADJ[i]) ADJ_TO[m++] = e.to;
  }
  ADJ_OFF[N] = m;
})();

export const CAMP = new Uint8Array(N);
export const HQM = new Uint8Array(N);
for (let i = 0; i < N; i++) { CAMP[i] = isCamp(i) ? 1 : 0; HQM[i] = isHQ(i) ? 1 : 0; }

/* ── 战斗结算表：由 rules.resolve 生成，保证与规则引擎同源 ── */
export const A_OUT = 1;
export const D_OUT = 2;
export const WIN_FLAG = 4;
export const RES = new Uint8Array(26 * 26);
(() => {
  for (let a = 1; a < 26; a++) {
    for (let d = 1; d < 26; d++) {
      const r = resolve(
        { id: 0, side: CODE_ISB[a] ? 'b' : 'r', type: PTYPES[CODE_TI[a]] },
        { id: 0, side: CODE_ISB[d] ? 'b' : 'r', type: PTYPES[CODE_TI[d]] },
      );
      RES[a * 26 + d] = (r.a ? A_OUT : 0) | (r.d ? D_OUT : 0) | (r.flag ? WIN_FLAG : 0);
    }
  }
})();

/* ── 打包 / 解包 ──────────────────────────────────────────── */

export interface Packed {
  /** 节点 → 代码（0 = 空） */
  sq: Uint8Array;
  /** 节点 → 1 表示对对方暗置 */
  hid: Uint8Array;
}

export function packBoard(board: Board): Packed {
  const sq = new Uint8Array(N);
  const hid = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const p = board[i];
    if (!p) continue;
    sq[i] = codeOf(TI[p.type], p.side === 'b' ? 1 : 0);
    if (p.hidden) hid[i] = 1;
  }
  return { sq, hid };
}

export const mvFrom = (m: number): number => m >>> 6;
export const mvTo = (m: number): number => m & 63;
export const mkMv = (from: number, to: number): number => (from << 6) | to;

/* ── 落点合法性 ───────────────────────────────────────────── */

/** 空格可入；敌子须不在行营；己方子不可入 */
function destOk(occ: number, isB: number, node: number): boolean {
  if (occ === 0) return true;
  if (CODE_ISB[occ] === isB) return false;
  return CAMP[node] === 0;
}

const bfsStamp = new Int32Array(N);
const bfsQueue = new Int32Array(N);
let bfsGen = 0;
const scratch = new Int32Array(N * 4);

/**
 * 生成 from 处棋子的全部落点，写入 out[off..]，返回个数。
 * 与 rules.legalMoves 等价：非铁路邻居单步；铁路按方向滑行；
 * 工兵在铁路网内 BFS 可拐弯（迎面之子可吃不可越）。
 */
export function genMoves(sq: Uint8Array, from: number, out: Int32Array, off: number): number {
  const code = sq[from];
  if (code === 0 || !CODE_MOVABLE[code]) return 0;
  if (HQM[from]) return 0; // 大本营驻子不可再移动
  const isB = CODE_ISB[code];
  let n = 0;
  const base = from * 4;
  const gb = CODE_GB[code] === 1;

  // 公路（含行营斜线）单步
  for (let k = PLAIN_OFF[from], ke = PLAIN_OFF[from + 1]; k < ke; k++) {
    const nb = PLAIN_TO[k];
    if (destOk(sq[nb], isB, nb)) out[off + n++] = nb;
  }

  // 铁路：普通子沿方向滑行，工兵走 BFS
  if (!gb) {
    for (let d = 0; d < 4; d++) {
      let cur = RAIL_NB[base + d];
      while (cur >= 0) {
        const occ = sq[cur];
        if (occ !== 0) {
          if (destOk(occ, isB, cur)) out[off + n++] = cur;
          break;
        }
        out[off + n++] = cur;
        cur = RAIL_NB[cur * 4 + d];
      }
    }
  }

  if (gb) {
    bfsGen++;
    let qt = 0;
    bfsStamp[from] = bfsGen;
    for (let d = 0; d < 4; d++) {
      const s = RAIL_NB[base + d];
      if (s >= 0 && bfsStamp[s] !== bfsGen) { bfsStamp[s] = bfsGen; bfsQueue[qt++] = s; }
    }
    for (let qh = 0; qh < qt; qh++) {
      const cur = bfsQueue[qh];
      const occ = sq[cur];
      if (occ !== 0) {
        if (destOk(occ, isB, cur)) out[off + n++] = cur;
        continue;
      }
      out[off + n++] = cur;
      const cb = cur * 4;
      for (let d = 0; d < 4; d++) {
        const s = RAIL_NB[cb + d];
        if (s >= 0 && bfsStamp[s] !== bfsGen) { bfsStamp[s] = bfsGen; bfsQueue[qt++] = s; }
      }
    }
  }
  return n;
}

/** 单子上限：铁轨全网约 24 节点，实测最大着法数 57（极限稀疏局面） */
export const MAX_MOVES = 192;

/**
 * 生成 isB 方全部走法（packed），写入 out[off..]，返回个数。
 * 超过 cap 时返回 -1（缓冲区不足，调用方按无着处理，不该发生）。
 */
export function genAll(sq: Uint8Array, isB: number, out: Int32Array, off = 0, cap = MAX_MOVES): number {
  let n = 0;
  for (let i = 0; i < N; i++) {
    const code = sq[i];
    if (code === 0 || CODE_ISB[code] !== isB) continue;
    const k = genMoves(sq, i, scratch, 0);
    if (n + k > cap) return -1;
    for (let j = 0; j < k; j++) out[off + n++] = (i << 6) | scratch[j];
  }
  return n;
}

/** 该方是否还有棋可走（提前退出，供终局判定） */
export function hasMove(sq: Uint8Array, isB: number): boolean {
  for (let i = 0; i < N; i++) {
    const code = sq[i];
    if (code === 0 || CODE_ISB[code] !== isB) continue;
    if (genMoves(sq, i, scratch, 0) > 0) return true;
  }
  return false;
}

/* ── 可逆走子 ─────────────────────────────────────────────── */

export const MAX_PLY = 128;
export const REC_N = 9;

/**
 * 走子记录栈：每个深度一层，避免搜索中逐节点分配对象。
 * 字段：0 from · 1 to · 2 att 码 · 3 def 码 · 4 结果位 · 5 att 暗
 *      6 def 暗 · 7/8 亮旗节点（-1 无；司令对司令同归于尽时两面都要亮）
 */
export const REC = new Int32Array(MAX_PLY * REC_N);

export const REC_FROM = 0, REC_TO = 1, REC_ATT = 2, REC_DEF = 3, REC_FLAGS = 4;
export const REC_ATT_H = 5, REC_DEF_H = 6, REC_FLAGNODE = 7, REC_FLAGNODE2 = 8;

/**
 * 在紧凑棋盘上执行一步并写入第 ply 层记录，返回结果位
 * （WIN_FLAG 表示扛旗获胜）。
 * 揭棋翻明与司令亮旗在此统一处理，与 rules.makeJqMove 语义一致。
 */
export function makeFast(sq: Uint8Array, hid: Uint8Array, mv: number, ply: number): number {
  const from = mv >>> 6;
  const to = mv & 63;
  const att = sq[from];
  const def = sq[to];
  const o = ply * REC_N;
  REC[o + REC_FROM] = from;
  REC[o + REC_TO] = to;
  REC[o + REC_ATT] = att;
  REC[o + REC_DEF] = def;
  REC[o + REC_ATT_H] = hid[from];
  REC[o + REC_DEF_H] = def ? hid[to] : 0;
  REC[o + REC_FLAGNODE] = -1;
  REC[o + REC_FLAGNODE2] = -1;
  REC[o + REC_FLAGS] = 0;

  sq[from] = 0;
  hid[from] = 0;
  if (def === 0) { // 静默移动不翻明：暗置状态随子一起搬到落点
    sq[to] = att;
    hid[to] = REC[o + REC_ATT_H];
    return 0;
  }
  // 交战：双方同时翻明
  hid[to] = 0;
  const r = RES[att * 26 + def];
  if (r & WIN_FLAG) {
    sq[to] = att;
    REC[o + REC_FLAGS] = WIN_FLAG;
    return WIN_FLAG;
  }
  const aOut = r & A_OUT;
  const dOut = r & D_OUT;
  let flags: number;
  if (aOut && dOut) { sq[to] = 0; flags = A_OUT | D_OUT; }
  else if (aOut) { sq[to] = def; flags = A_OUT; }
  else { sq[to] = att; flags = D_OUT; }

  // 司令阵亡 → 该方军旗亮出。交战同步结算，司令对司令同归于尽时
  // 两面军旗都要亮，故按「阵亡司令所属方」收集，最多两个节点。
  const d1 = aOut && CODE_TI[att] === TI_司令 ? CODE_ISB[att] : -1;
  const d2 = dOut && CODE_TI[def] === TI_司令 ? CODE_ISB[def] : -1;
  if (d1 >= 0 || d2 >= 0) {
    for (let i = 0; i < N; i++) {
      if (!hid[i]) continue;
      const c = sq[i];
      if (c === 0 || CODE_TI[c] !== TI_军旗) continue;
      const sd = CODE_ISB[c];
      if (sd !== d1 && sd !== d2) continue;
      hid[i] = 0;
      if (REC[o + REC_FLAGNODE] < 0) REC[o + REC_FLAGNODE] = i;
      else REC[o + REC_FLAGNODE2] = i;
    }
  }
  REC[o + REC_FLAGS] = flags;
  return flags;
}

/** 撤销第 ply 层的走子 */
export function undoFast(sq: Uint8Array, hid: Uint8Array, ply: number): void {
  const o = ply * REC_N;
  const from = REC[o + REC_FROM];
  const to = REC[o + REC_TO];
  sq[from] = REC[o + REC_ATT];
  sq[to] = REC[o + REC_DEF];
  hid[from] = REC[o + REC_ATT_H];
  hid[to] = REC[o + REC_DEF_H];
  const fn = REC[o + REC_FLAGNODE];
  if (fn >= 0) hid[fn] = 1;
  const fn2 = REC[o + REC_FLAGNODE2];
  if (fn2 >= 0) hid[fn2] = 1;
}
