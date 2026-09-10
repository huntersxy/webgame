/* ────────────────────────────────────────────────────────────
 *  junqi/rules.ts — 军棋（陆战棋）规则引擎
 *
 *  棋盘：12 行 × 5 列节点，双方各 6 行。
 *    • 行营（每方 5 个，以己方第 3 排中心为心的梅花形）：
 *      内有子不可被攻击，布阵时必须为空
 *    • 大本营（每方 2 个，底线）：军旗必须置于其一；
 *      任何棋子一旦驻入大本营，对局中不可再移动（仍可被吃）
 *    • 铁路：双方前线行 + 左右边列 + 三座桥，普通子直线滑行，
 *      工兵可在铁路网内任意拐弯
 *    • 公路：其余连线（含每方 16 条行营斜线），一步
 *    • 河流：仅第 1/3/5 列（两端铁路与中路）三座桥可渡
 *  兵种（每方 25 枚）：司令1 军长1 师长2 旅长2 团长2 营长2
 *    连长3 排长3 工兵3 炸弹2 地雷3 军旗1
 *  吃子：大吃小，同级同归于尽；炸弹与任何子互炸；
 *    地雷只有工兵能挖，其余撞雷自亡；触军旗即扛旗获胜。
 *  司令阵亡：该方军旗立即亮出（对双方可见）。
 *  胜负：扛旗 / 对方无子可动判胜；连续 DRAW_NO_CAPTURE 步无吃子
 *    或总计 MAX_MOVES 步判和。
 *  揭棋（暗棋）：hidden = 对对方暗置。己方棋子自己全程可见；
 *    静默移动不翻明；交战时主动方获胜则己方保持暗置（可继续藏身份），
 *    防守方子力翻明（若仍存活则明牌驻守）；主动方阵亡或双方同归时
 *    双方都翻明后再结算离场。走法按真实兵种生成
 *    （暗工兵拐弯即自曝身份，是揭棋的信息博弈之一）。
 * ──────────────────────────────────────────────────────────── */

export const COLS = 5;
export const ROWS = 12;
export type Side = 'r' | 'b';
export type PType = '司令' | '军长' | '师长' | '旅长' | '团长' | '营长' | '连长' | '排长' | '工兵' | '炸弹' | '地雷' | '军旗';

export interface Piece { id: number; side: Side; type: PType; /** 揭棋暗子：未翻明 */ hidden?: boolean }
export type Board = (Piece | null)[];

export const idx = (r: number, c: number): number => r * COLS + c;
export const rowOf = (i: number): number => (i / COLS) | 0;
export const colOf = (i: number): number => i % COLS;
export const other = (s: Side): Side => (s === 'r' ? 'b' : 'r');

/** 行营（每方 5 个，以己方第 3 排中心 (3,2)/(8,2) 为心的梅花形）/ 大本营 */
const CAMPS = new Set<number>([
  idx(2, 1), idx(2, 3), idx(3, 2), idx(4, 1), idx(4, 3),
  idx(9, 1), idx(9, 3), idx(8, 2), idx(7, 1), idx(7, 3),
]);
export const HQS: Record<Side, number[]> = {
  b: [idx(0, 1), idx(0, 3)],
  r: [idx(11, 1), idx(11, 3)],
};
export const isCamp = (i: number): boolean => CAMPS.has(i);
export const isHQ = (i: number): boolean => HQS.b.includes(i) || HQS.r.includes(i);
export const sideOfNode = (i: number): Side => (rowOf(i) <= 5 ? 'b' : 'r');
export const ownHalf = (i: number, s: Side): boolean => (s === 'b' ? rowOf(i) <= 5 : rowOf(i) >= 6);

/** 和棋判定：连续无吃子步数 / 总手数上限 */
export const DRAW_NO_CAPTURE = 120;
export const MAX_MOVES = 500;

/** 邻接表：rail=true 铁路 */
interface Edge { to: number; rail: boolean }
export const ADJ: Edge[][] = (() => {
  const g: Edge[][] = Array.from({ length: ROWS * COLS }, () => []);
  const add = (a: number, b: number, rail: boolean): void => {
    g[a].push({ to: b, rail });
    g[b].push({ to: a, rail });
  };
  // 横线：前线行 5/6 为铁路
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 1; c++) add(idx(r, c), idx(r, c + 1), r === 5 || r === 6);
  }
  // 竖线：边列 0/4 为铁路；5→6 河段只有第 1/3/5 列（两端铁路与中路）三座桥（铁路）
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS - 1; r++) {
      if (r === 5) { if (c === 0 || c === 2 || c === 4) add(idx(r, c), idx(r + 1, c), true); continue; }
      add(idx(r, c), idx(r + 1, c), c === 0 || c === 4);
    }
  }
  // 行营斜线（公路）：每方 16 条——四个角营各连 4 条对角线，
  // 中营连 4 个角营；边列节点 (3,0)/(3,4) 也经斜线通向相邻两营，
  // 为行营子力提供通往边路铁路的逃逸线。
  // 蓝方以 (3,2) 行营为中心的梅花链，红方以 (8,2) 为中心镜像
  add(idx(1, 0), idx(2, 1), false); add(idx(1, 2), idx(2, 1), false);
  add(idx(1, 2), idx(2, 3), false); add(idx(1, 4), idx(2, 3), false);
  add(idx(2, 1), idx(3, 2), false); add(idx(2, 3), idx(3, 2), false);
  add(idx(2, 1), idx(3, 0), false); add(idx(2, 3), idx(3, 4), false);
  add(idx(3, 0), idx(4, 1), false); add(idx(3, 4), idx(4, 3), false);
  add(idx(3, 2), idx(4, 1), false); add(idx(3, 2), idx(4, 3), false);
  add(idx(4, 1), idx(5, 0), false); add(idx(4, 1), idx(5, 2), false);
  add(idx(4, 3), idx(5, 2), false); add(idx(4, 3), idx(5, 4), false);
  add(idx(10, 0), idx(9, 1), false); add(idx(10, 2), idx(9, 1), false);
  add(idx(10, 2), idx(9, 3), false); add(idx(10, 4), idx(9, 3), false);
  add(idx(9, 1), idx(8, 2), false); add(idx(9, 3), idx(8, 2), false);
  add(idx(9, 1), idx(8, 0), false); add(idx(9, 3), idx(8, 4), false);
  add(idx(8, 0), idx(7, 1), false); add(idx(8, 4), idx(7, 3), false);
  add(idx(8, 2), idx(7, 1), false); add(idx(8, 2), idx(7, 3), false);
  add(idx(7, 1), idx(6, 0), false); add(idx(7, 1), idx(6, 2), false);
  add(idx(7, 3), idx(6, 2), false); add(idx(7, 3), idx(6, 4), false);
  return g;
})();

export const RANK: Record<PType, number> = {
  司令: 9, 军长: 8, 师长: 7, 旅长: 6, 团长: 5, 营长: 4,
  连长: 3, 排长: 2, 工兵: 1, 炸弹: 0, 地雷: 0, 军旗: 0,
};
const IMMOBILE = new Set<PType>(['地雷', '军旗']);
export const canMoveType = (t: PType): boolean => !IMMOBILE.has(t);

export const PIECE_COUNTS: Array<[PType, number]> = [
  ['司令', 1], ['军长', 1], ['师长', 2], ['旅长', 2], ['团长', 2], ['营长', 2],
  ['连长', 3], ['排长', 3], ['工兵', 3], ['炸弹', 2], ['地雷', 3], ['军旗', 1],
];

/** 战斗结算：返回双方是否阵亡 + 是否扛旗 */
export function resolve(att: Piece, def: Piece): { a: boolean; d: boolean; flag: boolean } {
  if (def.type === '军旗') return { a: false, d: true, flag: true };
  if (att.type === '炸弹' || def.type === '炸弹') return { a: true, d: true, flag: false };
  if (def.type === '地雷') {
    return att.type === '工兵'
      ? { a: false, d: true, flag: false }
      : { a: true, d: false, flag: false };
  }
  if (att.type === '地雷' || att.type === '军旗') return { a: true, d: false, flag: false }; // 不该发生
  const ra = RANK[att.type];
  const rd = RANK[def.type];
  if (ra === rd) return { a: true, d: true, flag: false };
  return ra > rd ? { a: false, d: true, flag: false } : { a: true, d: false, flag: false };
}

/** 落点合法性（空 / 敌子且不在行营） */
function destOk(board: Board, i: number, me: Side): boolean {
  const q = board[i];
  if (!q) return true;
  if (q.side === me) return false;
  if (isCamp(i)) return false;
  return true;
}

/** 全部合法落点 */
export function legalMoves(board: Board, from: number): number[] {
  const p = board[from];
  if (!p || !canMoveType(p.type)) return [];
  if (isHQ(from)) return []; // 驻入大本营的棋子不可再移动（仍可被吃）
  const out = new Set<number>();
  const fr = rowOf(from);
  const fc = colOf(from);

  for (const e of ADJ[from]) {
    if (!e.rail) {
      if (destOk(board, e.to, p.side)) out.add(e.to);
      continue;
    }
    if (p.type === '工兵') continue; // 工兵走 BFS
    // 铁路直线滑行
    const tr = rowOf(e.to);
    const tc = colOf(e.to);
    const dr = Math.sign(tr - fr);
    const dc = Math.sign(tc - fc);
    let cr = tr;
    let cc = tc;
    for (;;) {
      const ni = idx(cr, cc);
      const occ = board[ni];
      if (occ) { if (destOk(board, ni, p.side)) out.add(ni); break; }
      out.add(ni);
      const nr = cr + dr;
      const nc = cc + dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) break;
      const next = ADJ[ni].find((x) => x.to === idx(nr, nc) && x.rail);
      if (!next) break;
      cr = nr; cc = nc;
    }
  }

  if (p.type === '工兵') {
    // 铁路网 BFS，可拐弯；遇子停止扩展（可吃不可过）
    const seen = new Set<number>([from]);
    const queue = ADJ[from].filter((e) => e.rail).map((e) => e.to);
    for (const s of queue) seen.add(s);
    while (queue.length) {
      const n = queue.shift()!;
      const occ = board[n];
      if (occ) { if (destOk(board, n, p.side)) out.add(n); continue; }
      out.add(n);
      for (const e of ADJ[n]) {
        if (e.rail && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
      }
    }
  }
  out.delete(from);
  return [...out];
}

/** 某方是否还有可动棋子 */
export function hasAnyMove(board: Board, side: Side): boolean {
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p && p.side === side && canMoveType(p.type) && legalMoves(board, i).length > 0) return true;
  }
  return false;
}

/* ── 布阵：校验 / 补全 ─────────────────────────────────────── */

/** 校验某方布阵，返回错误文案；合法返回 null */
export function validateLayout(board: Board, side: Side): string | null {
  const front = side === 'b' ? 5 : 6;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p || p.side !== side) continue;
    if (!ownHalf(i, side)) return '棋子必须放在己方半场';
    if (isCamp(i)) return '行营内不能布子';
    if (p.type === '军旗' && !isHQ(i)) return '军旗必须放在大本营';
    if (p.type === '地雷') {
      const back = side === 'b' ? rowOf(i) <= 1 : rowOf(i) >= 10;
      if (!back) return '地雷只能放在后两排';
    }
    if (p.type === '炸弹' && rowOf(i) === front) return '炸弹不能放在第一排';
  }
  const counts: Partial<Record<PType, number>> = {};
  let total = 0;
  for (const p of board) {
    if (!p || p.side !== side) continue;
    total++;
    counts[p.type] = (counts[p.type] ?? 0) + 1;
  }
  for (const [t, n] of PIECE_COUNTS) {
    const have = counts[t] ?? 0;
    if (have > n) return `${t}超出编制（${have}/${n}）`;
  }
  if (total > 25) return '棋子总数超过 25 枚';
  return null;
}

/** 布阵是否完整（25 枚不多不少且合法） */
export function layoutComplete(board: Board, side: Side): boolean {
  const counts: Partial<Record<PType, number>> = {};
  let total = 0;
  for (const p of board) {
    if (!p || p.side !== side) continue;
    total++;
    counts[p.type] = (counts[p.type] ?? 0) + 1;
  }
  if (total !== 25) return false;
  for (const [t, n] of PIECE_COUNTS) if ((counts[t] ?? 0) !== n) return false;
  return validateLayout(board, side) === null;
}

/** 把剩余棋子随机补全到空位（尊重军旗/地雷/炸弹约束）；失败返回错误文案 */
export function autofillLayout(board: Board, side: Side): string | null {
  const back2 = (i: number): boolean => (side === 'b' ? rowOf(i) <= 1 : rowOf(i) >= 10);
  const front = side === 'b' ? 5 : 6;
  const counts: Partial<Record<PType, number>> = {};
  for (const p of board) if (p && p.side === side) counts[p.type] = (counts[p.type] ?? 0) + 1;

  const need: PType[] = [];
  for (const [t, n] of PIECE_COUNTS) {
    for (let k = (counts[t] ?? 0); k < n; k++) need.push(t);
  }
  if (!need.length) return null;
  // 受约束的兵种先安置（军旗 → 大本营，地雷 → 后两排，炸弹 → 非前排），
  // 否则普通子会把受限区域占满导致补全失败
  const constraint = (t: PType): number => (t === '军旗' ? 0 : t === '地雷' ? 1 : t === '炸弹' ? 2 : 3);
  need.sort((a, b) => constraint(a) - constraint(b));

  const free: number[] = [];
  const rows = side === 'b' ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11];
  for (const r of rows) for (let c = 0; c < COLS; c++) {
    const i = idx(r, c);
    if (!isCamp(i) && !board[i]) free.push(i);
  }
  const take = (pred: (i: number) => boolean): number => {
    const k = free.findIndex(pred);
    if (k < 0) return -1;
    const n = free[k];
    free.splice(k, 1);
    return n;
  };
  const shuffleRest = (): void => {
    for (let k = free.length - 1; k > 0; k--) {
      const j = (Math.random() * (k + 1)) | 0;
      [free[k], free[j]] = [free[j], free[k]];
    }
  };
  shuffleRest();

  let id = 1000 + ((Math.random() * 9000) | 0);
  for (const t of need) {
    let node = -1;
    if (t === '军旗') node = take((i) => isHQ(i));
    else if (t === '地雷') node = take((i) => back2(i));
    else if (t === '炸弹') node = take((i) => rowOf(i) !== front);
    else node = free.pop() ?? -1;
    if (node < 0) {
      if (t === '军旗') return '军旗无处安放：请在大本营留出空位';
      if (t === '地雷') return '地雷无处安放：请在后两排留出空位';
      if (t === '炸弹') return '炸弹无处安放：第一排不能放炸弹';
      return '空位不足，无法补全';
    }
    board[node] = { id: id++, side, type: t };
  }
  return null;
}

/** 随机合法布阵：军旗入大本营、地雷后两行、炸弹不进前线 */
export function randomLayout(side: Side, startId: number): Array<{ node: number; piece: Piece }> {
  const rows = side === 'b' ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11];
  const back2 = side === 'b' ? new Set([0, 1]) : new Set([10, 11]);
  const front = side === 'b' ? 5 : 6;
  const nodes: number[] = [];
  for (const r of rows) for (let c = 0; c < COLS; c++) {
    const i = idx(r, c);
    if (!isCamp(i)) nodes.push(i);
  }
  const shuffle = <T,>(arr: T[]): T[] => {
    for (let k = arr.length - 1; k > 0; k--) {
      const j = (Math.random() * (k + 1)) | 0;
      const tmp = arr[k]; arr[k] = arr[j]; arr[j] = tmp;
    }
    return arr;
  };
  const used = new Set<number>();
  const take = (pool: number[], n: number): number[] => {
    const pick = shuffle(pool.filter((x) => !used.has(x)));
    const out = pick.slice(0, n);
    for (const x of out) used.add(x);
    return out;
  };
  const result: Array<{ node: number; type: PType }> = [];
  // 军旗 → 随机大本营
  const hq = HQS[side][(Math.random() * 2) | 0];
  result.push({ node: hq, type: '军旗' }); used.add(hq);
  // 地雷 → 后两行（3）
  for (const n of take(nodes.filter((i) => back2.has(rowOf(i))), 3)) result.push({ node: n, type: '地雷' });
  // 炸弹 → 非前线（2）
  for (const n of take(nodes.filter((i) => rowOf(i) !== front), 2)) result.push({ node: n, type: '炸弹' });
  // 其余 19 枚随机
  const rest: PType[] = [];
  for (const [t, cnt] of PIECE_COUNTS) {
    if (t === '军旗' || t === '地雷' || t === '炸弹') continue;
    for (let k = 0; k < cnt; k++) rest.push(t);
  }
  const free = shuffle(nodes.filter((i) => !used.has(i)));
  rest.forEach((t, k) => result.push({ node: free[k], type: t }));

  let id = startId;
  return result.map((x) => ({ node: x.node, piece: { id: id++, side, type: x.type } }));
}

export function randomBoard(): Board {
  const board: Board = new Array(ROWS * COLS).fill(null);
  for (const { node, piece } of randomLayout('b', 1)) board[node] = piece;
  for (const { node, piece } of randomLayout('r', 100)) board[node] = piece;
  return board;
}

/* ── 可逆走子（搜索与对局共用，含揭棋翻明与司令亮旗） ─────── */

export interface JqMoveRec {
  from: number;
  to: number;
  att: Piece;
  def: Piece | null;
  attOut: boolean;
  defOut: boolean;
  flag: boolean;
  /** 翻明前/后的 hidden 状态（哈希与撤销都要用） */
  attHidden0: boolean;
  attHidden1: boolean;
  defHidden0: boolean;
  defHidden1: boolean;
  /** 司令阵亡导致的亮旗：被翻明的军旗与其节点（双方司令同归于尽时有两项） */
  revealedFlags: Piece[];
  flagNodes: number[];
}

/**
 * 在 board 上执行 from→to 并返回可撤销记录。
 * 揭棋翻明与司令亮旗都在此统一处理，保证搜索树与真实对局
 * 的信息状态完全一致。
 */
export function makeJqMove(board: Board, from: number, to: number): JqMoveRec {
  const att = board[from]!;
  const def = board[to] ?? null;
  board[from] = null;
  const rec: JqMoveRec = {
    from, to, att, def, attOut: false, defOut: false, flag: false,
    attHidden0: !!att.hidden, attHidden1: !!att.hidden,
    defHidden0: !!def?.hidden, defHidden1: !!def?.hidden,
    revealedFlags: [], flagNodes: [],
  };
  if (!def) { board[to] = att; return rec; } // 静默移动不翻明
  // 交战：先结算胜负，再决定翻明——主动方获胜则攻方不亮
  const r = resolve(att, def);
  if (r.flag) {
    // 扛旗：防守方军旗公开离场；攻方（主动胜）保持原明暗
    if (def.hidden) { def.hidden = false; rec.defHidden1 = false; }
    rec.flag = true; rec.defOut = true; board[to] = att; return rec;
  }
  if (r.a) {
    // 主动方阵亡：攻方翻明离场；守方若存活则明牌驻守
    if (att.hidden) { att.hidden = false; rec.attHidden1 = false; }
    if (def.hidden) { def.hidden = false; rec.defHidden1 = false; }
    if (r.d) { rec.attOut = true; rec.defOut = true; board[to] = null; }
    else { rec.attOut = true; board[to] = def; }
  } else {
    // 主动方获胜（resolve 下必为 r.d）：攻方不翻明；守方翻明离场
    if (def.hidden) { def.hidden = false; rec.defHidden1 = false; }
    rec.defOut = true; board[to] = att;
  }
  // 司令阵亡 → 该方军旗亮出。交战双方同时结算，司令对司令同归于尽时
  // 两面军旗都要亮，因此这里逐个收集而不是只取一枚。
  const deadCmd: Piece[] = [];
  if (rec.attOut && att.type === '司令') deadCmd.push(att);
  if (rec.defOut && def.type === '司令') deadCmd.push(def);
  for (const d of deadCmd) {
    const fn = board.findIndex((q) => q && q.side === d.side && q.type === '军旗');
    if (fn >= 0 && board[fn]!.hidden) {
      board[fn]!.hidden = false;
      rec.revealedFlags.push(board[fn]!);
      rec.flagNodes.push(fn);
    }
  }
  return rec;
}

/** 撤销 makeJqMove（含翻明/亮旗回滚） */
export function undoJqMove(board: Board, rec: JqMoveRec): void {
  board[rec.from] = rec.att;
  board[rec.to] = rec.def;
  rec.att.hidden = rec.attHidden0 ? true : undefined;
  if (rec.def) rec.def.hidden = rec.defHidden0 ? true : undefined;
  for (const f of rec.revealedFlags) f.hidden = true;
}

export interface JqMove { from: number; to: number }

/** 某方全部走法 */
export function allJqMoves(board: Board, side: Side): JqMove[] {
  const out: JqMove[] = [];
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p || p.side !== side || !canMoveType(p.type)) continue;
    for (const to of legalMoves(board, i)) out.push({ from: i, to });
  }
  return out;
}
