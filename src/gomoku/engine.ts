/* ────────────────────────────────────────────────────────────
 *  gomoku/engine.ts — Gomoku engine v3 (complete rewrite)
 *
 *  The strongest + fastest practical algorithm stack for free-style
 *  (no-renju-rules) 15x15 Gomoku, as used by top hobby engines:
 *
 *    • Flat Uint8Array board + 572 precomputed 5-cell windows.
 *      A move touches at most 20 windows → every update is O(1).
 *    • Incremental pattern evaluation: per-window shape values are
 *      maintained on make/unmake, so a leaf evaluation is a single
 *      subtraction instead of the old full-board rescan (~4 500 ops).
 *      Live k=4 windows are tracked as "five-cells" — the same data
 *      powers immediate-win detection, forced blocks and VCF.
 *    • Negamax + alpha-beta with PVS (null-window re-searches),
 *      iterative deepening under a wall-clock budget per level.
 *    • Zobrist incremental hashing + depth-preferred transposition
 *      table (move ordering + cutoffs across ID iterations).
 *    • Forced-move logic in O(1): own five-cell → win; opponent
 *      ≥2 five-cells → loss; exactly 1 → branch collapses to the
 *      single blocking move. This alone crushes the search tree in
 *      tactical positions.
 *    • Threat extensions on fours / open-three formations (budgeted).
 *    • History heuristic + killer moves.
 *    • Separate VCF (continuous-fours) threat-space search that
 *      proves forced wins far beyond the alpha-beta horizon.
 * ──────────────────────────────────────────────────────────── */

import { nowMs } from '../core/time';

const N = 15;
const CELLS = N * N;
export const MATE = 10_000_000;

/** Shape value per live 5-window holding k own stones (k = 0..5).
 *  Open vs sleeping shapes self-balance: an open three lives in ~3
 *  pure windows, a sleeping three in ~1; an open four spans 2 live
 *  k=4 windows, a closed four only 1. */
const TABLE = [0, 30, 420, 6200, 125_000, 5_000_000];
const DEF_W = 1.16; // leaf-eval defence bias

// ── Precomputation: windows, cell→windows, neighbours, zobrist ──
const DIRS5: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [1, 1], [1, -1]];

const WINDOWS: Int32Array = (() => {
  const out: number[] = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      for (const [dx, dy] of DIRS5) {
        const ex = x + dx * 4;
        const ey = y + dy * 4;
        if (ex < 0 || ex >= N || ey < 0 || ey >= N) continue;
        for (let k = 0; k < 5; k++) out.push((y + dy * k) * N + (x + dx * k));
      }
    }
  }
  return Int32Array.from(out);
})();
const NW = WINDOWS.length / 5; // 572

const CELL_WIN: number[][] = (() => {
  const arr: number[][] = Array.from({ length: CELLS }, () => []);
  for (let w = 0; w < NW; w++) {
    for (let k = 0; k < 5; k++) arr[WINDOWS[w * 5 + k]].push(w);
  }
  return arr;
})();

/** Cells within Chebyshev distance 2 (candidate neighbourhood). */
const NEIGH: number[][] = (() => {
  const arr: number[][] = Array.from({ length: CELLS }, () => []);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < N && ny >= 0 && ny < N) arr[y * N + x].push(ny * N + nx);
        }
      }
    }
  }
  return arr;
})();

const ZTABLE: Uint32Array = (() => {
  let s = 0x27d4eb2d;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  const t = new Uint32Array(CELLS * 2);
  for (let i = 0; i < t.length; i++) t[i] = rnd();
  return t;
})();
const SIDE_SALT = 0x55aa5a5a;

export function cellOf(x: number, y: number): number { return y * N + x; }
export function xOf(p: number): number { return p % N; }
export function yOf(p: number): number { return (p / N) | 0; }

// ── Transposition table (module-level, reused between ID iterations) ──
const TT_SIZE = 1 << 19;
const TT_MASK = TT_SIZE - 1;
const ttKeys = new Uint32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Uint8Array(TT_SIZE);   // 0 exact, 1 lower, 2 upper
const ttScore = new Float64Array(TT_SIZE);
const ttMove = new Int32Array(TT_SIZE);   // cell+1, 0 = none

function ttIndex(key: number): number {
  let h = key >>> 0;
  h ^= h >>> 16; h = (h * 0x45d9f3b) >>> 0; h ^= h >>> 16;
  return h & TT_MASK;
}
function ttStore(key: number, depth: number, flag: number, score: number, cell: number): void {
  const i = ttIndex(key);
  if (ttKeys[i] !== (key >>> 0) || depth >= ttDepth[i] || ttMove[i] === 0 && cell !== 0) {
    ttKeys[i] = key >>> 0;
    ttDepth[i] = depth;
    ttFlag[i] = flag;
    ttScore[i] = score;
    ttMove[i] = cell + 1;
  }
}
function ttProbe(key: number): number {
  const i = ttIndex(key);
  return ttKeys[i] === (key >>> 0) ? i : -1;
}
export function ttClear(): void {
  ttKeys.fill(0);
  ttMove.fill(0);
}

export interface EngineMove {
  cell: number;
  s: number;
  v?: number;
}

const MAXW = 24;

export class GomokuEngine {
  readonly cells = new Uint8Array(CELLS);
  /** own-stone count per window, per colour index (0 = black, 1 = white) */
  private readonly cnt: Int8Array[] = [new Int8Array(NW), new Int8Array(NW)];
  /** maintained pattern total per colour */
  private readonly total: number[] = [0, 0];
  /** per-cell counter of live k=4 windows for which this cell is the fifth */
  private readonly wc: Int8Array[] = [new Int8Array(CELLS), new Int8Array(CELLS)];
  /** stacks of cells that are currently "five-completion" cells, per colour */
  private readonly wStack: Int32Array[] = [new Int32Array(CELLS), new Int32Array(CELLS)];
  private readonly wPos: Int32Array[] = [new Int32Array(CELLS), new Int32Array(CELLS)];
  private wCount: number[] = [0, 0];
  private readonly fiveCnt: number[] = [0, 0];
  /** stone-influence per cell (Chebyshev-2) + candidate stack */
  private readonly inf = new Uint8Array(CELLS);
  private readonly cStack = new Int32Array(CELLS);
  private readonly cPos = new Int32Array(CELLS);
  private cCount = 0;
  private hash = 0;
  stones = 0;

  // Search state
  nodes = 0;
  private abort = false;
  private deadline = 0;
  private baseWidth = 12;
  private readonly hist: Int32Array[] = [new Int32Array(CELLS), new Int32Array(CELLS)];
  private readonly killers = new Int32Array(128 * 2).fill(-1);

  // ── board stack helpers ──
  private pushWin(ci: number, p: number): void {
    this.wStack[ci][this.wCount[ci]] = p;
    this.wPos[ci][p] = ++this.wCount[ci];
  }
  private popWin(ci: number, p: number): void {
    const pos = this.wPos[ci][p];
    if (!pos) return;
    const i = pos - 1;
    const last = this.wStack[ci][--this.wCount[ci]];
    if (i !== this.wCount[ci]) { this.wStack[ci][i] = last; this.wPos[ci][last] = i + 1; }
    this.wPos[ci][p] = 0;
  }
  private addCand(p: number): void {
    if (this.cPos[p]) return;
    this.cStack[this.cCount] = p;
    this.cPos[p] = ++this.cCount;
  }
  private removeCand(p: number): void {
    const pos = this.cPos[p];
    if (!pos) return;
    const i = pos - 1;
    const last = this.cStack[--this.cCount];
    if (i !== this.cCount) { this.cStack[i] = last; this.cPos[last] = i + 1; }
    this.cPos[p] = 0;
  }

  private emptyCell(w: number): number {
    const b = w * 5;
    for (let k = 0; k < 5; k++) {
      const p = WINDOWS[b + k];
      if (this.cells[p] === 0) return p;
    }
    return -1;
  }

  private rm(ci: number, w: number): void {
    const cn = this.cnt[ci];
    const k = cn[w];
    if (this.cnt[1 - ci][w] !== 0) return;
    this.total[ci] -= TABLE[k];
    if (k === 4) {
      const e = this.emptyCell(w);
      if (--this.wc[ci][e] === 0) this.popWin(ci, e);
    } else if (k === 5) {
      this.fiveCnt[ci]--;
    }
  }
  private add(ci: number, w: number): void {
    const cn = this.cnt[ci];
    const k = cn[w];
    if (this.cnt[1 - ci][w] !== 0) return;
    this.total[ci] += TABLE[k];
    if (k === 4) {
      const e = this.emptyCell(w);
      if (this.wc[ci][e]++ === 0) this.pushWin(ci, e);
    } else if (k === 5) {
      this.fiveCnt[ci]++;
    }
  }

  makeCell(p: number, c: 1 | 2): void {
    const ci = c - 1;
    this.hash ^= ZTABLE[ci * CELLS + p];
    const nb = NEIGH[p];
    for (let i = 0; i < nb.length; i++) { const q = nb[i]; if (this.inf[q]++ === 0) this.addCand(q); }
    const cw = CELL_WIN[p];
    for (let i = 0; i < cw.length; i++) { const w = cw[i]; this.rm(0, w); this.rm(1, w); }
    const cn = this.cnt[ci];
    for (let i = 0; i < cw.length; i++) cn[cw[i]]++;
    this.cells[p] = c;
    for (let i = 0; i < cw.length; i++) { const w = cw[i]; this.add(0, w); this.add(1, w); }
    this.stones++;
  }

  unmakeCell(p: number, c: 1 | 2): void {
    const ci = c - 1;
    this.hash ^= ZTABLE[ci * CELLS + p];
    const cw = CELL_WIN[p];
    for (let i = 0; i < cw.length; i++) { const w = cw[i]; this.rm(0, w); this.rm(1, w); }
    const cn = this.cnt[ci];
    for (let i = 0; i < cw.length; i++) cn[cw[i]]--;
    this.cells[p] = 0;
    for (let i = 0; i < cw.length; i++) { const w = cw[i]; this.add(0, w); this.add(1, w); }
    const nb = NEIGH[p];
    for (let i = 0; i < nb.length; i++) { const q = nb[i]; if (--this.inf[q] === 0) this.removeCand(q); }
    this.stones--;
  }

  /** Load from a 2D board (row-major GomokuBoard). */
  load2D(board: number[][]): void {
    this.abortSearch();
    this.hash = 0; this.stones = 0;
    this.total[0] = this.total[1] = 0;
    this.fiveCnt[0] = this.fiveCnt[1] = 0;
    this.cnt[0].fill(0); this.cnt[1].fill(0);
    this.wc[0].fill(0); this.wc[1].fill(0);
    this.wCount[0] = this.wCount[1] = 0;
    this.wPos[0].fill(0); this.wPos[1].fill(0);
    this.cells.fill(0); this.inf.fill(0);
    this.cCount = 0; this.cPos.fill(0);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const v = board[y][x];
        if (v === 1 || v === 2) this.makeCell(y * N + x, v);
      }
    }
  }

  // ── queries ──
  winCellCount(ci: number): number { return this.wCount[ci]; }
  winCell(ci: number): number { return this.wCount[ci] > 0 ? this.wStack[ci][this.wCount[ci] - 1] : -1; }
  hasFive(ci: number): boolean { return this.fiveCnt[ci] > 0; }
  evalFor(ci: number): number { return this.total[ci] - DEF_W * this.total[1 - ci]; }
  /** Evaluation from the perspective of GomokuPlayer colour `c` (1|2). */
  evalForColor(c: 1 | 2): number { return this.evalFor(c - 1); }
  totalFor(ci: number): number { return this.total[ci]; }

  /** Pattern gain of placing colour ci's stone on empty cell p. */
  attackGain(ci: number, p: number): number {
    let v = 0;
    const cn = this.cnt[ci], co = this.cnt[1 - ci];
    const cw = CELL_WIN[p];
    for (let i = 0; i < cw.length; i++) {
      const w = cw[i];
      if (co[w] === 0) { const k = cn[w]; v += TABLE[k + 1] - TABLE[k]; }
    }
    return v;
  }

  // ── move generation / ordering (zero-allocation, per-ply scratch) ──
  private readonly pCells: Int32Array[] = [];
  private readonly pVal: Float64Array[] = [];
  private readonly pAtk: Float64Array[] = [];
  private readonly rCells = new Int32Array(MAXW);
  private readonly rVal = new Float64Array(MAXW);
  private readonly rAtk = new Float64Array(MAXW);

  private ensurePly(ply: number): void {
    while (this.pCells.length <= ply) {
      this.pCells.push(new Int32Array(MAXW));
      this.pVal.push(new Float64Array(MAXW));
      this.pAtk.push(new Float64Array(MAXW));
    }
  }

  /**
   * Generate the top-`width` candidate moves via insertion-select
   * (no per-node allocation, no full sort). Returns the count written
   * into cells/vals/atks.
   */
  private genMovesTo(
    ci: number,
    width: number,
    first: number,
    ply: number,
    cells: Int32Array,
    vals: Float64Array,
    atks: Float64Array,
  ): number {
    const oi = 1 - ci;
    const cs = this.cStack, cn = this.cCount, st = this.cells;
    const hist = this.hist[ci], histO = this.hist[oi];
    const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1];
    let m = 0;
    for (let i = 0; i < cn; i++) {
      const p = cs[i];
      if (st[p] !== 0) continue;
      const atk = this.attackGain(ci, p);
      const def = this.attackGain(oi, p);
      const s = atk + def * 0.92 + this.inf[p] * 2 + (hist[p] + histO[p]) / 64
        + (p === first ? 1e15 : p === k1 || p === k2 ? 1e12 : 0);
      // insertion into a desc-sorted top list; only VALID entries (0..m-1)
      // are compared so stale tails can never create holes
      let j: number;
      if (m < width) {
        j = m;
        while (j > 0 && vals[j - 1] < s) j--;
        for (let k = m; k > j; k--) {
          cells[k] = cells[k - 1];
          vals[k] = vals[k - 1];
          atks[k] = atks[k - 1];
        }
        m++;
      } else {
        if (s <= vals[width - 1]) continue;
        j = width - 1;
        while (j > 0 && vals[j - 1] < s) j--;
        for (let k = width - 1; k > j; k--) {
          cells[k] = cells[k - 1];
          vals[k] = vals[k - 1];
          atks[k] = atks[k - 1];
        }
      }
      cells[j] = p;
      vals[j] = s;
      atks[j] = atk;
    }
    return m;
  }

  // ── time control ──
  startSearch(deadlineMs: number, maxNodes = 2e9): void {
    this.nodes = 0;
    this.abort = false;
    this.deadline = deadlineMs;
    this.maxNodes = maxNodes;
    this.hist[0].fill(0);
    this.hist[1].fill(0);
    this.killers.fill(-1);
  }
  /** Set the wall-clock cut-off for a VCF probe (kept off the main search). */
  deadlineForVcf(ms: number): void { this.deadline = ms; }
  vcfNodes(): number { return this.lastVcfNodes; }
  private lastVcfNodes = 0;
  private maxNodes = 2e9;
  abortSearch(): void { this.abort = true; }
  get aborted(): boolean { return this.abort; }

  private tick(): boolean {
    this.nodes++;
    if ((this.nodes & 255) === 0) {
      if (nowMs() > this.deadline || this.nodes > this.maxNodes) { this.abort = true; return true; }
    }
    return this.abort;
  }

  // ── negamax PVS with forced-move logic + threat extensions ──
  negamax(ci: number, depth: number, alpha: number, beta: number, ply: number, extBudget: number): number {
    if (this.abort) return alpha;
    if (this.tick()) return alpha;

    const oi = 1 - ci;
    // Immediate own five (our previous move made an unblocked four) → win.
    if (this.wCount[ci] > 0) return MATE - ply;
    // Opponent already threatens: double five = lost, single = forced block.
    const owc = this.wCount[oi];
    if (owc >= 2) return -(MATE - (ply + 1));

    const key = (this.hash ^ (ci === 1 ? SIDE_SALT : 0)) >>> 0;
    const tti = ttProbe(key);
    let ttBest = -1;
    if (tti >= 0) {
      ttBest = ttMove[tti] - 1;
      if (ttDepth[tti] >= depth && depth > 0) {
        const s = ttScore[tti];
        if (Math.abs(s) < MATE - 64) {
          const f = ttFlag[tti];
          if (f === 0) return s;
          if (f === 1 && s >= beta) return s;
          if (f === 2 && s <= alpha) return s;
        }
      }
    }

    if (depth <= 0) return this.evalFor(ci);

    // Forced single-block line: the whole node collapses to one move.
    if (owc === 1) {
      const w = this.wStack[oi][this.wCount[oi] - 1];
      this.makeCell(w, (ci + 1) as 1 | 2);
      let v: number;
      if (this.hasFive(ci)) v = MATE - ply;
      else v = -this.negamax(oi, depth - 1, -beta, -alpha, ply + 1, extBudget);
      this.unmakeCell(w, (ci + 1) as 1 | 2);
      if (!this.abort) ttStore(key, depth, 0, v, w);
      return v;
    }

    const width = depth >= 7 ? 7 : depth >= 5 ? 9 : this.baseWidth;
    this.ensurePly(ply);
    const cells = this.pCells[ply];
    const vals = this.pVal[ply];
    const atks = this.pAtk[ply];
    const count = this.genMovesTo(ci, width, ttBest, ply, cells, vals, atks);
    if (count === 0) return this.evalFor(ci);

    const kBase = ply * 2;
    const origAlpha = alpha;
    let best = -Infinity;
    let bestCell = cells[0];
    let first = true;

    for (let i = 0; i < count; i++) {
      const p = cells[i];
      const isKiller = p === this.killers[kBase] || p === this.killers[kBase + 1];
      this.makeCell(p, (ci + 1) as 1 | 2);
      let v: number;
      if (this.hasFive(ci)) {
        v = MATE - ply;
      } else {
        // threat extension: only on REAL threats — fours (checked post-make)
        // or open-three formations (pure attack gain ≥ two k=3 windows).
        let d2 = depth - 1;
        let e2 = extBudget;
        if (d2 > 0 && e2 > 0 && (this.wCount[ci] > 0 || atks[i] >= 11_000)) {
          d2 += 1;
          e2 -= 1;
        }
        if (first) {
          v = -this.negamax(oi, d2, -beta, -alpha, ply + 1, e2);
        } else {
          v = -this.negamax(oi, d2, -alpha - 1, -alpha, ply + 1, e2);
          if (!this.abort && v > alpha && v < beta) {
            v = -this.negamax(oi, d2, -beta, -alpha, ply + 1, e2);
          }
        }
      }
      this.unmakeCell(p, (ci + 1) as 1 | 2);
      if (this.abort) break;

      if (v > best) { best = v; bestCell = p; }
      if (v > alpha) alpha = v;
      if (alpha >= beta) {
        if (!isKiller) {
          this.killers[kBase + 1] = this.killers[kBase];
          this.killers[kBase] = p;
        }
        this.hist[ci][p] += depth * depth;
        ttStore(key, depth, 1, best, bestCell);
        return best;
      }
      first = false;
    }

    ttStore(key, depth, best <= origAlpha ? 2 : 0, best, bestCell);
    return best;
  }

  /** Root search at a fixed depth; returns full-window score per root move. */
  rootSearch(ci: number, depth: number, width: number): { best: number; bestV: number; scored: EngineMove[] } {
    this.baseWidth = Math.min(width, MAXW);
    const oi = 1 - ci;
    if (this.wCount[ci] > 0) {
      const w = this.wStack[ci][this.wCount[ci] - 1];
      return { best: w, bestV: MATE, scored: [{ cell: w, s: MATE }] };
    }
    const key = (this.hash ^ (ci === 1 ? SIDE_SALT : 0)) >>> 0;
    const tti = ttProbe(key);
    const first = tti >= 0 ? ttMove[tti] - 1 : -1;
    const count = this.genMovesTo(ci, Math.min(width, MAXW), first, 127, this.rCells, this.rVal, this.rAtk);
    let best = -Infinity;
    let bestCell = count > 0 ? this.rCells[0] : -1;
    const scored: EngineMove[] = [];
    for (let i = 0; i < count; i++) {
      const p = this.rCells[i];
      const atk = this.rAtk[i];
      this.makeCell(p, (ci + 1) as 1 | 2);
      let v: number;
      if (this.hasFive(ci)) v = MATE - 1;
      else {
        let d2 = depth - 1;
        let e2 = 6;
        if (d2 > 0 && (this.wCount[ci] > 0 || atk >= 11_000)) { d2 += 1; e2 -= 1; }
        v = -this.negamax(oi, d2, -Infinity, Infinity, 1, e2);
      }
      this.unmakeCell(p, (ci + 1) as 1 | 2);
      if (this.abort) break;
      scored.push({ cell: p, s: v });
      if (v > best) { best = v; bestCell = p; }
    }
    scored.sort((a, b) => b.s - a.s);
    return { best: bestCell, bestV: best, scored };
  }

  setBaseWidth(w: number): void { this.baseWidth = w; }

  // ── VCF: continuous-fours forced-win search ──
  /**
   * Returns the first move of a forcing sequence of fours ending in a five
   * for colour index `ci`, or -1 if none is proven within budget.
   * The defender is assumed forced to block the single five-cell; a
   * defender counter-five cuts the branch. Sound but incomplete (as
   * VCF always is) — used as a sharpness pre-pass before alpha-beta.
   */
  vcfFind(ci: number, nodeBudget = 30000, maxDepth = 28): number {
    const eng = this;
    const oi = 1 - ci;
    const deadline = this.deadline;
    let used = 0;
    const win = { cell: -1 };

    function attack(movesLeft: number, rootMove: number): boolean {
      if (movesLeft <= 0) return false;
      if (++used > nodeBudget) return false;
      if (nowMs() > deadline) return false;

      if (eng.wCount[ci] > 0) {
        const fiveCell = eng.wStack[ci][eng.wCount[ci] - 1];
        win.cell = rootMove === -1 ? fiveCell : rootMove;
        return true; // five threat survived: win
      }
      if (eng.wCount[oi] > 0) return false;                        // defender completes its own five

      // Enumerate attacker four-moves (a move that makes ≥1 five-cell or a five)
      const fours: EngineMove[] = [];
      const cs = eng.cStack;
      for (let i = 0; i < eng.cCount; i++) {
        const p = cs[i];
        if (eng.cells[p] !== 0) continue;
        const g = eng.attackGain(ci, p);
        if (g >= 110_000) fours.push({ cell: p, s: g });
      }
      fours.sort((a, b) => b.s - a.s);

      for (const fm of fours) {
        if (++used > nodeBudget) return false;
        const root = rootMove === -1 ? fm.cell : rootMove;
        eng.makeCell(fm.cell, (ci + 1) as 1 | 2);
        if (eng.fiveCnt[ci] > 0 || eng.wCount[ci] >= 2) {
          eng.unmakeCell(fm.cell, (ci + 1) as 1 | 2);
          win.cell = root;
          return true; // straight five / double four — unanswerable
        }
        if (eng.wCount[ci] === 1) {
          const w = eng.wStack[ci][eng.wCount[ci] - 1];
          eng.makeCell(w, (oi + 1) as 1 | 2);
          const ok = eng.fiveCnt[oi] === 0 && attack(movesLeft - 2, root);
          eng.unmakeCell(w, (oi + 1) as 1 | 2);
          if (ok) { eng.unmakeCell(fm.cell, (ci + 1) as 1 | 2); return true; }
        }
        eng.unmakeCell(fm.cell, (ci + 1) as 1 | 2);
      }
      return false;
    }

    const ok = attack(maxDepth, -1);
    this.lastVcfNodes = used;
    return ok ? win.cell : -1;
  }
}

export { N as BOARD };
