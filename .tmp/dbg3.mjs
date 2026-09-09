// src/gomoku/engine.ts
var N = 15;
var CELLS = N * N;
var MATE = 1e7;
var TABLE = [0, 30, 420, 6200, 125e3, 5e6];
var DEF_W = 1.16;
var DIRS5 = [[1, 0], [0, 1], [1, 1], [1, -1]];
var WINDOWS = (() => {
  const out = [];
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
var NW = WINDOWS.length / 5;
var CELL_WIN = (() => {
  const arr = Array.from({ length: CELLS }, () => []);
  for (let w = 0; w < NW; w++) {
    for (let k = 0; k < 5; k++) arr[WINDOWS[w * 5 + k]].push(w);
  }
  return arr;
})();
var NEIGH = (() => {
  const arr = Array.from({ length: CELLS }, () => []);
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
var ZTABLE = (() => {
  let s = 668265261;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
  const t = new Uint32Array(CELLS * 2);
  for (let i = 0; i < t.length; i++) t[i] = rnd();
  return t;
})();
var SIDE_SALT = 1437227610;
function xOf(p) {
  return p % N;
}
function yOf(p) {
  return p / N | 0;
}
var TT_SIZE = 1 << 19;
var TT_MASK = TT_SIZE - 1;
var ttKeys = new Uint32Array(TT_SIZE);
var ttDepth = new Int8Array(TT_SIZE);
var ttFlag = new Uint8Array(TT_SIZE);
var ttScore = new Float64Array(TT_SIZE);
var ttMove = new Int32Array(TT_SIZE);
function ttIndex(key) {
  let h = key >>> 0;
  h ^= h >>> 16;
  h = h * 73244475 >>> 0;
  h ^= h >>> 16;
  return h & TT_MASK;
}
function ttStore(key, depth, flag, score, cell) {
  const i = ttIndex(key);
  if (ttKeys[i] !== key >>> 0 || depth >= ttDepth[i] || ttMove[i] === 0 && cell !== 0) {
    ttKeys[i] = key >>> 0;
    ttDepth[i] = depth;
    ttFlag[i] = flag;
    ttScore[i] = score;
    ttMove[i] = cell + 1;
  }
}
function ttProbe(key) {
  const i = ttIndex(key);
  return ttKeys[i] === key >>> 0 ? i : -1;
}
var MAXW = 24;
var GomokuEngine = class {
  cells = new Uint8Array(CELLS);
  /** own-stone count per window, per colour index (0 = black, 1 = white) */
  cnt = [new Int8Array(NW), new Int8Array(NW)];
  /** maintained pattern total per colour */
  total = [0, 0];
  /** per-cell counter of live k=4 windows for which this cell is the fifth */
  wc = [new Int8Array(CELLS), new Int8Array(CELLS)];
  /** stacks of cells that are currently "five-completion" cells, per colour */
  wStack = [new Int32Array(CELLS), new Int32Array(CELLS)];
  wPos = [new Int32Array(CELLS), new Int32Array(CELLS)];
  wCount = [0, 0];
  fiveCnt = [0, 0];
  /** stone-influence per cell (Chebyshev-2) + candidate stack */
  inf = new Uint8Array(CELLS);
  cStack = new Int32Array(CELLS);
  cPos = new Int32Array(CELLS);
  cCount = 0;
  hash = 0;
  stones = 0;
  // Search state
  nodes = 0;
  abort = false;
  deadline = 0;
  baseWidth = 12;
  hist = [new Int32Array(CELLS), new Int32Array(CELLS)];
  killers = new Int32Array(128 * 2).fill(-1);
  // ── board stack helpers ──
  pushWin(ci, p) {
    this.wStack[ci][this.wCount[ci]] = p;
    this.wPos[ci][p] = ++this.wCount[ci];
  }
  popWin(ci, p) {
    const pos = this.wPos[ci][p];
    if (!pos) return;
    const i = pos - 1;
    const last = this.wStack[ci][--this.wCount[ci]];
    if (i !== this.wCount[ci]) {
      this.wStack[ci][i] = last;
      this.wPos[ci][last] = i + 1;
    }
    this.wPos[ci][p] = 0;
  }
  addCand(p) {
    if (this.cPos[p]) return;
    this.cStack[this.cCount] = p;
    this.cPos[p] = ++this.cCount;
  }
  removeCand(p) {
    const pos = this.cPos[p];
    if (!pos) return;
    const i = pos - 1;
    const last = this.cStack[--this.cCount];
    if (i !== this.cCount) {
      this.cStack[i] = last;
      this.cPos[last] = i + 1;
    }
    this.cPos[p] = 0;
  }
  emptyCell(w) {
    const b = w * 5;
    for (let k = 0; k < 5; k++) {
      const p = WINDOWS[b + k];
      if (this.cells[p] === 0) return p;
    }
    return -1;
  }
  rm(ci, w) {
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
  add(ci, w) {
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
  makeCell(p, c) {
    const ci = c - 1;
    this.hash ^= ZTABLE[ci * CELLS + p];
    const nb = NEIGH[p];
    for (let i = 0; i < nb.length; i++) {
      const q = nb[i];
      if (this.inf[q]++ === 0) this.addCand(q);
    }
    const cw = CELL_WIN[p];
    for (let i = 0; i < cw.length; i++) {
      const w = cw[i];
      this.rm(0, w);
      this.rm(1, w);
    }
    const cn = this.cnt[ci];
    for (let i = 0; i < cw.length; i++) cn[cw[i]]++;
    this.cells[p] = c;
    for (let i = 0; i < cw.length; i++) {
      const w = cw[i];
      this.add(0, w);
      this.add(1, w);
    }
    this.stones++;
  }
  unmakeCell(p, c) {
    const ci = c - 1;
    this.hash ^= ZTABLE[ci * CELLS + p];
    const cw = CELL_WIN[p];
    for (let i = 0; i < cw.length; i++) {
      const w = cw[i];
      this.rm(0, w);
      this.rm(1, w);
    }
    const cn = this.cnt[ci];
    for (let i = 0; i < cw.length; i++) cn[cw[i]]--;
    this.cells[p] = 0;
    for (let i = 0; i < cw.length; i++) {
      const w = cw[i];
      this.add(0, w);
      this.add(1, w);
    }
    const nb = NEIGH[p];
    for (let i = 0; i < nb.length; i++) {
      const q = nb[i];
      if (--this.inf[q] === 0) this.removeCand(q);
    }
    this.stones--;
  }
  /** Load from a 2D board (row-major GomokuBoard). */
  load2D(board2) {
    this.abortSearch();
    this.hash = 0;
    this.stones = 0;
    this.total[0] = this.total[1] = 0;
    this.fiveCnt[0] = this.fiveCnt[1] = 0;
    this.cnt[0].fill(0);
    this.cnt[1].fill(0);
    this.wc[0].fill(0);
    this.wc[1].fill(0);
    this.wCount[0] = this.wCount[1] = 0;
    this.wPos[0].fill(0);
    this.wPos[1].fill(0);
    this.cells.fill(0);
    this.inf.fill(0);
    this.cCount = 0;
    this.cPos.fill(0);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const v = board2[y][x];
        if (v === 1 || v === 2) this.makeCell(y * N + x, v);
      }
    }
  }
  // ── queries ──
  winCellCount(ci) {
    return this.wCount[ci];
  }
  winCell(ci) {
    return this.wCount[ci] > 0 ? this.wStack[ci][this.wCount[ci] - 1] : -1;
  }
  hasFive(ci) {
    return this.fiveCnt[ci] > 0;
  }
  evalFor(ci) {
    return this.total[ci] - DEF_W * this.total[1 - ci];
  }
  /** Evaluation from the perspective of GomokuPlayer colour `c` (1|2). */
  evalForColor(c) {
    return this.evalFor(c - 1);
  }
  totalFor(ci) {
    return this.total[ci];
  }
  /** Pattern gain of placing colour ci's stone on empty cell p. */
  attackGain(ci, p) {
    let v = 0;
    const cn = this.cnt[ci], co = this.cnt[1 - ci];
    const cw = CELL_WIN[p];
    for (let i = 0; i < cw.length; i++) {
      const w = cw[i];
      if (co[w] === 0) {
        const k = cn[w];
        v += TABLE[k + 1] - TABLE[k];
      }
    }
    return v;
  }
  // ── move generation / ordering (zero-allocation, per-ply scratch) ──
  pCells = [];
  pVal = [];
  pAtk = [];
  rCells = new Int32Array(MAXW);
  rVal = new Float64Array(MAXW);
  rAtk = new Float64Array(MAXW);
  ensurePly(ply) {
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
  genMovesTo(ci, width, first, ply, cells, vals, atks) {
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
      let s = atk + def * 0.92 + this.inf[p] * 2 + (hist[p] + histO[p]) / 64;
      if (p === first) s += 1e15;
      else if (p === k1 || p === k2) s += 1e12;
      if (m === width && s <= vals[m - 1]) continue;
      let j = m === width ? m - 2 : m;
      while (j >= 0 && vals[j] < s) j--;
      j++;
      const end = m < width ? m : width - 1;
      for (let k = end; k > j; k--) {
        cells[k] = cells[k - 1];
        vals[k] = vals[k - 1];
        atks[k] = atks[k - 1];
      }
      cells[j] = p;
      vals[j] = s;
      atks[j] = atk;
      if (m < width) m++;
    }
    return m;
  }
  // ── time control ──
  startSearch(deadlineMs, maxNodes = 2e9) {
    this.nodes = 0;
    this.abort = false;
    this.deadline = deadlineMs;
    this.maxNodes = maxNodes;
    this.hist[0].fill(0);
    this.hist[1].fill(0);
    this.killers.fill(-1);
  }
  /** Set the wall-clock cut-off for a VCF probe (kept off the main search). */
  deadlineForVcf(ms) {
    this.deadline = ms;
  }
  vcfNodes() {
    return this.lastVcfNodes;
  }
  lastVcfNodes = 0;
  maxNodes = 2e9;
  abortSearch() {
    this.abort = true;
  }
  get aborted() {
    return this.abort;
  }
  tick() {
    this.nodes++;
    if ((this.nodes & 255) === 0) {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now > this.deadline || this.nodes > this.maxNodes) {
        this.abort = true;
        return true;
      }
    }
    return this.abort;
  }
  // ── negamax PVS with forced-move logic + threat extensions ──
  negamax(ci, depth, alpha, beta, ply, extBudget) {
    if (this.abort) return alpha;
    if (this.tick()) return alpha;
    const oi = 1 - ci;
    if (this.wCount[ci] > 0) return MATE - ply;
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
    if (owc === 1) {
      const w = this.wStack[oi][this.wCount[oi] - 1];
      this.makeCell(w, ci + 1);
      let v;
      if (this.hasFive(ci)) v = MATE - ply;
      else v = -this.negamax(oi, depth - 1, -beta, -alpha, ply + 1, extBudget);
      this.unmakeCell(w, ci + 1);
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
      this.makeCell(p, ci + 1);
      let v;
      if (this.hasFive(ci)) {
        v = MATE - ply;
      } else {
        let d2 = depth - 1;
        let e2 = extBudget;
        if (d2 > 0 && e2 > 0 && (this.wCount[ci] > 0 || atks[i] >= 11e3)) {
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
      this.unmakeCell(p, ci + 1);
      if (this.abort) break;
      if (v > best) {
        best = v;
        bestCell = p;
      }
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
  rootSearch(ci, depth, width) {
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
    const scored = [];
    for (let i = 0; i < count; i++) {
      const p = this.rCells[i];
      const atk = this.rAtk[i];
      this.makeCell(p, ci + 1);
      let v;
      if (this.hasFive(ci)) v = MATE - 1;
      else {
        let d2 = depth - 1;
        let e2 = 6;
        if (d2 > 0 && (this.wCount[ci] > 0 || atk >= 11e3)) {
          d2 += 1;
          e2 -= 1;
        }
        v = -this.negamax(oi, d2, -Infinity, Infinity, 1, e2);
      }
      this.unmakeCell(p, ci + 1);
      if (this.abort) break;
      scored.push({ cell: p, s: v });
      if (v > best) {
        best = v;
        bestCell = p;
      }
    }
    scored.sort((a, b) => b.s - a.s);
    return { best: bestCell, bestV: best, scored };
  }
  setBaseWidth(w) {
    this.baseWidth = w;
  }
  // ── VCF: continuous-fours forced-win search ──
  /**
   * Returns the first move of a forcing sequence of fours ending in a five
   * for colour index `ci`, or -1 if none is proven within budget.
   * The defender is assumed forced to block the single five-cell; a
   * defender counter-five cuts the branch. Sound but incomplete (as
   * VCF always is) — used as a sharpness pre-pass before alpha-beta.
   */
  vcfFind(ci, nodeBudget = 3e4, maxDepth = 28) {
    const eng2 = this;
    const oi = 1 - ci;
    const deadline = this.deadline;
    let used = 0;
    const win = { cell: -1 };
    function attack(movesLeft, rootMove) {
      if (movesLeft <= 0) return false;
      if (++used > nodeBudget) return false;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now > deadline) return false;
      if (eng2.wCount[ci] > 0) {
        const fiveCell = eng2.wStack[ci][eng2.wCount[ci] - 1];
        win.cell = rootMove === -1 ? fiveCell : rootMove;
        return true;
      }
      if (eng2.wCount[oi] > 0) return false;
      const fours = [];
      const cs = eng2.cStack;
      for (let i = 0; i < eng2.cCount; i++) {
        const p = cs[i];
        if (eng2.cells[p] !== 0) continue;
        const g = eng2.attackGain(ci, p);
        if (g >= 11e4) fours.push({ cell: p, s: g });
      }
      fours.sort((a, b) => b.s - a.s);
      for (const fm of fours) {
        if (++used > nodeBudget) return false;
        const root = rootMove === -1 ? fm.cell : rootMove;
        eng2.makeCell(fm.cell, ci + 1);
        if (eng2.fiveCnt[ci] > 0 || eng2.wCount[ci] >= 2) {
          eng2.unmakeCell(fm.cell, ci + 1);
          win.cell = root;
          return true;
        }
        if (eng2.wCount[ci] === 1) {
          const w = eng2.wStack[ci][eng2.wCount[ci] - 1];
          eng2.makeCell(w, oi + 1);
          const ok2 = eng2.fiveCnt[oi] === 0 && attack(movesLeft - 2, root);
          eng2.unmakeCell(w, oi + 1);
          if (ok2) {
            eng2.unmakeCell(fm.cell, ci + 1);
            return true;
          }
        }
        eng2.unmakeCell(fm.cell, ci + 1);
      }
      return false;
    }
    const ok = attack(maxDepth, -1);
    this.lastVcfNodes = used;
    return ok ? win.cell : -1;
  }
};

// .tmp/dbg3.mts
var eng = new GomokuEngine();
var N2 = 15;
var board = Array.from({ length: N2 }, () => new Array(N2).fill(0));
for (const [x, y, c] of [[7, 7, 1], [7, 8, 1], [7, 9, 1], [2, 2, 2], [2, 3, 2]]) board[y][x] = c;
eng.load2D(board);
var seen = /* @__PURE__ */ new Set();
var dups = [];
for (let i = 0; i < eng.cCount; i++) {
  const p = eng.cStack[i];
  if (seen.has(p)) dups.push(p);
  seen.add(p);
}
console.log("cCount", eng.cCount, "dups", dups.map((p) => [xOf(p), yOf(p)]));
console.log("empty cStack slots occupied?", dups.length);
for (const ci of [0, 1]) {
  const s = /* @__PURE__ */ new Set();
  const d2 = [];
  for (let i = 0; i < eng.wCount[ci]; i++) {
    const p = eng.wStack[ci][i];
    if (s.has(p)) d2.push(p);
    s.add(p);
  }
  console.log("win dup color", ci, d2);
}
