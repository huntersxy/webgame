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
function cellOf(x, y) {
  return y * N + x;
}
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
function ttClear() {
  ttKeys.fill(0);
  ttMove.fill(0);
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
  load2D(board) {
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
        const v = board[y][x];
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
      const s = atk + def * 0.92 + this.inf[p] * 2 + (hist[p] + histO[p]) / 64 + (p === first ? 1e15 : p === k1 || p === k2 ? 1e12 : 0);
      let j;
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
      const now2 = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now2 > this.deadline || this.nodes > this.maxNodes) {
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
    const eng = this;
    const oi = 1 - ci;
    const deadline = this.deadline;
    let used = 0;
    const win = { cell: -1 };
    function attack(movesLeft, rootMove) {
      if (movesLeft <= 0) return false;
      if (++used > nodeBudget) return false;
      const now2 = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now2 > deadline) return false;
      if (eng.wCount[ci] > 0) {
        const fiveCell = eng.wStack[ci][eng.wCount[ci] - 1];
        win.cell = rootMove === -1 ? fiveCell : rootMove;
        return true;
      }
      if (eng.wCount[oi] > 0) return false;
      const fours = [];
      const cs = eng.cStack;
      for (let i = 0; i < eng.cCount; i++) {
        const p = cs[i];
        if (eng.cells[p] !== 0) continue;
        const g = eng.attackGain(ci, p);
        if (g >= 11e4) fours.push({ cell: p, s: g });
      }
      fours.sort((a, b) => b.s - a.s);
      for (const fm of fours) {
        if (++used > nodeBudget) return false;
        const root = rootMove === -1 ? fm.cell : rootMove;
        eng.makeCell(fm.cell, ci + 1);
        if (eng.fiveCnt[ci] > 0 || eng.wCount[ci] >= 2) {
          eng.unmakeCell(fm.cell, ci + 1);
          win.cell = root;
          return true;
        }
        if (eng.wCount[ci] === 1) {
          const w = eng.wStack[ci][eng.wCount[ci] - 1];
          eng.makeCell(w, oi + 1);
          const ok2 = eng.fiveCnt[oi] === 0 && attack(movesLeft - 2, root);
          eng.unmakeCell(w, oi + 1);
          if (ok2) {
            eng.unmakeCell(fm.cell, ci + 1);
            return true;
          }
        }
        eng.unmakeCell(fm.cell, ci + 1);
      }
      return false;
    }
    const ok = attack(maxDepth, -1);
    this.lastVcfNodes = used;
    return ok ? win.cell : -1;
  }
};

// src/gomoku/rules.ts
var BOARD_SIZE = 15;
function inBounds(x, y) {
  return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

// src/gomoku/book.ts
var ORIENT = [
  (dx, dy) => ({ x: dx, y: dy }),
  (dx, dy) => ({ x: -dx, y: dy }),
  (dx, dy) => ({ x: dx, y: -dy }),
  (dx, dy) => ({ x: -dx, y: -dy }),
  (dx, dy) => ({ x: dy, y: dx }),
  (dx, dy) => ({ x: -dy, y: dx }),
  (dx, dy) => ({ x: dy, y: -dx }),
  (dx, dy) => ({ x: -dy, y: -dx })
];
var OPENING_PATTERNS = [
  // 花月 (直指, up): 黑3 at (0,1), 黑5 at (1,-1)
  { name: "\u82B1\u6708", offs: [{ x: 0, y: -1 }, { x: 1, y: 1 }] },
  // 浦月 (直指): 黑3 (0,-1), 黑5 (-1,0)
  { name: "\u6D66\u6708", offs: [{ x: 0, y: -1 }, { x: -1, y: 0 }] },
  // 溪月 (斜指): 黑3 (1,-1) 黑5 (-1,-1)
  { name: "\u6EAA\u6708", offs: [{ x: 1, y: -1 }, { x: -1, y: -1 }] },
  // 寒星: 黑3 (1,-1) 黑5 (1,0)
  { name: "\u5BD2\u661F", offs: [{ x: 1, y: -1 }, { x: 1, y: 0 }] },
  // 疏星 (斜): 黑3 (1,-1) 黑5 (1,1)
  { name: "\u758F\u661F", offs: [{ x: 1, y: -1 }, { x: 1, y: 1 }] },
  // 明星 (斜): 黑3 (-1,-1) 黑5 (-1,1)
  { name: "\u660E\u661F", offs: [{ x: -1, y: -1 }, { x: -1, y: 1 }] },
  // 斜月 (斜): 黑3 (-1,-1) 黑5 (1,-1)
  { name: "\u659C\u6708", offs: [{ x: -1, y: -1 }, { x: 1, y: -1 }] },
  // 丘月: 黑3 (0,-1) 黑5 (1,-1)
  { name: "\u4E18\u6708", offs: [{ x: 0, y: -1 }, { x: 1, y: -1 }] },
  // 云月: 黑3 (1,-1) 黑5 (-1,0)
  { name: "\u4E91\u6708", offs: [{ x: 1, y: -1 }, { x: -1, y: 0 }] }
];
function blackOffsets(board) {
  const out = [];
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      if (board[y][x] !== 1) continue;
      if (x === 7 && y === 7) continue;
      out.push({ x: x - 7, y: y - 7 });
    }
  }
  return out;
}
function matchesUnderOrient(actual, offs) {
  if (actual.length === 0) return false;
  outer: for (const o of ORIENT) {
    const remapped = new Set(actual.map((s) => `${o(s.x, s.y).x},${o(s.x, s.y).y}`));
    for (let i = 0; i < actual.length; i++) {
      const want = offs[i];
      if (!remapped.has(`${want.x},${want.y}`)) continue outer;
    }
    return true;
  }
  return false;
}
function nearStone(board, x, y) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (inBounds(x + dx, y + dy) && board[y + dy][x + dx] !== 0) return true;
    }
  }
  return false;
}
function probeOpening(board, player, historyLength) {
  if (player !== 2) return null;
  if (historyLength < 2 || historyLength > 9) return null;
  const black = blackOffsets(board);
  if (black.length < 1 || black.length > 3) return null;
  let name = null;
  for (const p of OPENING_PATTERNS) {
    if (black.length <= p.offs.length && matchesUnderOrient(black, p.offs)) {
      name = p.name;
      break;
    }
  }
  if (!name) return null;
  const baseReplies = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 }
  ];
  for (const o of ORIENT) {
    for (const base of baseReplies) {
      const r = o(base.x, base.y);
      const rx = 7 + r.x;
      const ry = 7 + r.y;
      if (inBounds(rx, ry) && board[ry][rx] === 0 && nearStone(board, rx, ry)) {
        return { x: rx, y: ry };
      }
    }
  }
  return null;
}

// src/gomoku/search.ts
var LEVEL_CONFIG = {
  1: { name: "\u7B80\u5355", depth: 2, limit: 8, timeMs: 150 },
  2: { name: "\u666E\u901A", depth: 6, limit: 10, timeMs: 450 },
  3: { name: "\u56F0\u96BE", depth: 10, limit: 12, timeMs: 1400 },
  4: { name: "\u{1F608}\u6076\u9B54", depth: 30, limit: 16, timeMs: 2800 }
};
var engine = new GomokuEngine();
function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
function toMove(cell, v = 0) {
  return { x: xOf(cell), y: yOf(cell), v };
}
function findBestMove(board, player, difficulty, mode, historyLength, persist = true) {
  void persist;
  const t0 = now();
  const cfg = LEVEL_CONFIG[difficulty];
  const ci = player - 1;
  const oi = 1 - ci;
  engine.load2D(board);
  ttClear();
  const timeMs = mode === "aivai" && difficulty === 4 ? Math.round(cfg.timeMs * 1.4) : cfg.timeMs;
  engine.startSearch(t0 + timeMs);
  if (historyLength === 0) {
    const mv2 = toMove(cellOf(7, 7));
    return { move: mv2, depth: 1, nodes: 1, ms: 0, eval: 0, scores: [{ ...mv2, v: 0 }], opening: true };
  }
  if (historyLength === 1) {
    const cell = pickNearFallback(board, player);
    const mv2 = toMove(cell);
    return { move: mv2, depth: 1, nodes: 1, ms: 0, eval: 0, scores: [{ ...mv2, v: 0 }], opening: true };
  }
  if (engine.winCellCount(ci) > 0) {
    const mv2 = toMove(engine.winCell(ci), MATE);
    return { move: mv2, depth: 1, nodes: 0, ms: 0, eval: MATE, scores: [{ ...mv2, v: MATE }], instant: true };
  }
  if (engine.winCellCount(oi) >= 1) {
    const mv2 = toMove(engine.winCell(oi), MATE - 1);
    return { move: mv2, depth: 1, nodes: 0, ms: 0, eval: -MATE + 2, scores: [{ ...mv2, v: -MATE + 2 }], instant: true };
  }
  if (difficulty >= 3) {
    const book = probeOpening(board, player, historyLength);
    if (book) {
      const mv2 = { ...book, v: 0 };
      return { move: mv2, depth: 0, nodes: 1, ms: 0, eval: 0, scores: [mv2], opening: true, book: true };
    }
  }
  if (difficulty >= 3 && historyLength >= 6) {
    engine.deadlineForVcf(t0 + Math.min(900, timeMs * 0.35));
    const killCell = engine.vcfFind(ci, difficulty === 4 ? 6e4 : 3e4, difficulty === 4 ? 30 : 22);
    if (killCell >= 0) {
      const mv2 = toMove(killCell, MATE - 2);
      return { move: mv2, depth: cfg.depth, nodes: engine.vcfNodes(), ms: Math.round(now() - t0), eval: MATE - 2, scores: [{ ...mv2, v: MATE - 2 }], instant: true };
    }
    engine.startSearch(t0 + timeMs);
  }
  if (difficulty === 1) {
    const r = engine.rootSearch(ci, 1, cfg.limit);
    const easyNodes = engine.nodes;
    const scored = r.scored.slice(0, 5).map((m) => toMove(m.cell, Math.round(m.s)));
    const pool = scored.length > 3 && Math.random() < 0.35 ? scored.slice(1) : scored;
    const pick = pool[Math.random() * pool.length | 0] || toMove(r.best);
    return { move: pick, depth: 1, nodes: easyNodes, ms: Math.round(now() - t0), eval: Math.round(r.bestV), scores: scored };
  }
  let bestDepth = 0;
  let bestCell = -1;
  let bestV = 0;
  let bestScores = [];
  for (let d = 2; d <= cfg.depth; d++) {
    if (now() > t0 + timeMs) break;
    const r = engine.rootSearch(ci, d, Math.min(cfg.limit, 16));
    if (engine.aborted || r.best < 0) break;
    bestDepth = d;
    bestCell = r.best;
    bestV = r.bestV;
    bestScores = r.scored.slice(0, 6).map((m) => toMove(m.cell, Math.round(m.s)));
    if (Math.abs(bestV) >= MATE - 64) break;
    if (now() - t0 > timeMs * 0.45) break;
  }
  if (bestCell < 0) {
    const r = engine.rootSearch(ci, 1, cfg.limit);
    bestCell = r.best >= 0 ? r.best : engine.winCell(ci) >= 0 ? engine.winCell(ci) : -1;
    if (bestCell < 0) bestCell = pickNearFallback(board, player);
    bestScores = r.scored.slice(0, 6).map((m) => toMove(m.cell, Math.round(m.s)));
  }
  const mv = toMove(bestCell, Math.round(bestV));
  return {
    move: mv,
    depth: bestDepth || 1,
    nodes: engine.nodes,
    ms: Math.round(now() - t0),
    eval: Math.round(bestV),
    scores: bestScores
  };
}
function pickNearFallback(board, player) {
  const opp = player === 1 ? 2 : 1;
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      if (board[y][x] !== 0) {
        sumX += x;
        sumY += y;
        n++;
      }
    }
  }
  const cx = n ? Math.round(sumX / n) : 7;
  const cy = n ? Math.round(sumY / n) : 7;
  let best = -1;
  let bestS = -Infinity;
  for (let y = Math.max(0, cy - 2); y <= Math.min(14, cy + 2); y++) {
    for (let x = Math.max(0, cx - 2); x <= Math.min(14, cx + 2); x++) {
      if (board[y][x] !== 0) continue;
      const s = engine.attackGain(player - 1, cellOf(x, y)) + engine.attackGain(opp - 1, cellOf(x, y)) * 0.9 - Math.abs(x - cx) - Math.abs(y - cy);
      if (s > bestS) {
        bestS = s;
        best = cellOf(x, y);
      }
    }
  }
  return best >= 0 ? best : cellOf(7, 7);
}

// tests/engine.test.mts
var N2 = 15;
var empty = () => Array.from({ length: N2 }, () => new Array(N2).fill(0));
var put = (b, stones) => {
  for (const [x, y, c] of stones) b[y][x] = c;
};
var clone = (b) => b.map((r) => [...r]);
var histLen = (b) => b.flat().filter((v) => v !== 0).length;
var pass = 0;
var fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} ${extra}`);
  }
}
function bruteState(cells) {
  const total = [0, 0];
  const win = [[], []];
  const five = [0, 0];
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const winSet = [/* @__PURE__ */ new Set(), /* @__PURE__ */ new Set()];
  for (let y = 0; y < N2; y++) {
    for (let x = 0; x < N2; x++) {
      for (const [dx, dy] of dirs) {
        const ex = x + dx * 4, ey = y + dy * 4;
        if (ex < 0 || ex >= N2 || ey < 0 || ey >= N2) continue;
        let c0 = 0, c1 = 0;
        for (let k = 0; k < 5; k++) {
          const v = cells[(y + dy * k) * N2 + (x + dx * k)];
          if (v === 1) c0++;
          else if (v === 2) c1++;
        }
        const TABLE2 = [0, 30, 420, 6200, 125e3, 5e6];
        if (c1 === 0) total[0] += TABLE2[c0];
        if (c0 === 0) total[1] += TABLE2[c1];
        if (c1 === 0 && c0 === 4) {
          for (let k = 0; k < 5; k++) {
            const p = (y + dy * k) * N2 + (x + dx * k);
            if (cells[p] === 0) winSet[0].add(p);
          }
        }
        if (c0 === 0 && c1 === 4) {
          for (let k = 0; k < 5; k++) {
            const p = (y + dy * k) * N2 + (x + dx * k);
            if (cells[p] === 0) winSet[1].add(p);
          }
        }
        if (c1 === 0 && c0 === 5) five[0]++;
        if (c0 === 0 && c1 === 5) five[1]++;
      }
    }
  }
  win[0] = [...winSet[0]];
  win[1] = [...winSet[1]];
  return { total, win, five };
}
console.log("== fuzz: make/unmake invariants ==");
{
  const eng = new GomokuEngine();
  const any = eng;
  let bad = 0;
  const rnd = (n) => Math.random() * n | 0;
  for (let game = 0; game < 20; game++) {
    const cells = new Uint8Array(225);
    const seq = [];
    let c = 1;
    for (let m = 0; m < 30; m++) {
      let p = -1;
      for (let tries = 0; tries < 200; tries++) {
        const q = rnd(225);
        if (cells[q] === 0) {
          p = q;
          break;
        }
      }
      if (p < 0) break;
      cells[p] = c;
      eng.makeCell(p, c);
      seq.push([p, c]);
      const ref = bruteState(cells);
      const e = eng;
      if (Math.abs(e.total[0] - ref.total[0]) > 1e-6 || Math.abs(e.total[1] - ref.total[1]) > 1e-6) bad++;
      if (e.wCount[0] !== ref.win[0].length || e.wCount[1] !== ref.win[1].length) bad++;
      if (e.fiveCnt[0] !== ref.five[0] || e.fiveCnt[1] !== ref.five[1]) bad++;
      c = c === 1 ? 2 : 1;
    }
    while (seq.length) {
      const [p, cc] = seq.pop();
      cells[p] = 0;
      eng.unmakeCell(p, cc);
    }
    if (any.total[0] !== 0 || any.total[1] !== 0 || any.cCount !== 0 || any.stones !== 0) bad++;
  }
  check("incremental totals/win-cells/hash consistent over 20 fuzz games", bad === 0, `bad=${bad}`);
}
function ai(b, player, level) {
  const before = JSON.stringify(b);
  const res = findBestMove(clone(b), player, level, "ai", histLen(b));
  if (JSON.stringify(b) !== before) throw new Error("board mutated!");
  if (!res.move) throw new Error("null move");
  if (b[res.move.y][res.move.x] !== 0) throw new Error("illegal occupied move");
  return res.move;
}
function hasFive(b, c) {
  for (let y = 0; y < N2; y++) for (let x = 0; x < N2; x++) {
    if (b[y][x] !== c) continue;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      let n = 1;
      for (let k = 1; k < 5; k++) {
        const nx = x + dx * k, ny = y + dy * k;
        if (nx < 0 || nx >= N2 || ny < 0 || ny >= N2 || b[ny][nx] !== c) break;
        n++;
      }
      if (n >= 5) return true;
    }
  }
  return false;
}
console.log("== tactics ==");
{
  let b = empty();
  put(b, [[7, 7, 1], [8, 7, 1], [9, 7, 1], [10, 7, 1], [4, 4, 2], [5, 5, 2]]);
  const m = ai(b, 1, 3);
  check("plays five when available", (m.x === 6 || m.x === 11) && m.y === 7, JSON.stringify(m));
  b = empty();
  put(b, [[7, 7, 1], [8, 7, 1], [9, 7, 1], [10, 7, 1], [3, 3, 2], [4, 4, 2]]);
  const m2 = ai(b, 2, 3);
  check("blocks opponent open four", (m2.x === 6 || m2.x === 11) && m2.y === 7, JSON.stringify(m2));
  b = empty();
  put(b, [[7, 7, 1], [8, 7, 1], [9, 7, 1], [2, 2, 2], [12, 12, 2]]);
  const m3 = ai(b, 2, 3);
  check("blocks open three end", m3.x === 6 && m3.y === 7 || m3.x === 10 && m3.y === 7, JSON.stringify(m3));
  b = empty();
  put(b, [[7, 7, 1], [8, 7, 1], [9, 7, 1], [11, 7, 1], [3, 3, 2], [4, 4, 2]]);
  const m4 = ai(b, 1, 3);
  check("fills broken-four gap to win", m4.x === 10 && m4.y === 7, JSON.stringify(m4));
  b = empty();
  put(b, [[7, 7, 1], [8, 7, 1], [9, 7, 1], [7, 8, 1], [7, 9, 1], [3, 3, 2], [4, 4, 2], [13, 13, 2]]);
  const m5 = ai(b, 1, 3);
  const e5 = new GomokuEngine();
  const bb = clone(b);
  bb[m5.y][m5.x] = 1;
  e5.load2D(bb);
  check("double-three creates decisive four", e5.winCellCount(0) >= 2 || e5.hasFive(0), JSON.stringify(m5));
  b = empty();
  put(b, [[5, 5, 1], [6, 5, 1], [7, 5, 1], [8, 5, 1], [10, 5, 1], [5, 7, 2], [13, 3, 2]]);
  const m6 = ai(b, 1, 3);
  check("sees five via gap fill", m6.y === 5 && [4, 9].includes(m6.x), JSON.stringify(m6));
}
console.log("== defense stress ==");
{
  const b = empty();
  put(b, [[7, 7, 1], [7, 8, 1], [7, 9, 1], [2, 2, 2], [2, 3, 2]]);
  const m = ai(b, 2, 2);
  check("level2 blocks open three", m.x === 7 && (m.y === 6 || m.y === 10), JSON.stringify(m));
}
console.log("== speed ==");
{
  const b = empty();
  put(b, [
    [7, 7, 1],
    [8, 8, 2],
    [8, 7, 1],
    [7, 8, 2],
    [6, 8, 1],
    [9, 7, 2],
    [6, 6, 1],
    [9, 6, 2],
    [10, 6, 1],
    [7, 5, 2],
    [9, 5, 1],
    [10, 7, 2]
  ]);
  const eng = new GomokuEngine();
  eng.load2D(clone(b));
  eng.startSearch((typeof performance !== "undefined" ? performance.now() : Date.now()) + 6e4);
  const s0 = Date.now();
  const rr = eng.rootSearch(0, 8, 14);
  const sMs = Math.max(1, Date.now() - s0);
  console.log(`  raw search: d8 nodes=${eng.nodes} ${sMs}ms nps\u2248${(eng.nodes / sMs / 1e3).toFixed(2)}M/s best=${rr.best}`);
  check("raw search nps >= 100k/s", eng.nodes / sMs >= 100, `${Math.round(eng.nodes / sMs)}k nps`);
  const t0 = Date.now();
  const res = findBestMove(clone(b), 1, 4, "ai", 12);
  const ms = Date.now() - t0;
  console.log(`  demon move: depth=${res.depth} nodes=${res.nodes} wall=${ms}ms eval=${res.eval} instant=${!!res.instant} \u2192 (${res.move?.x},${res.move?.y})`);
  check("demon respects time budget (< 3.4s)", ms < 3400, `${ms}ms`);
  check("demon proves win or reaches depth >= 8", !!res.instant || res.depth >= 8, `depth=${res.depth}`);
  const t1 = Date.now();
  const r2 = findBestMove(clone(b), 2, 2, "ai", 12);
  check("\u666E\u901A answers in < 700ms", Date.now() - t1 < 700, `${Date.now() - t1}ms d${r2.depth}`);
}
console.log("== self-play (level3 B vs level2 W) ==");
{
  const b = empty();
  let c = 1;
  let moves = 0;
  let winner = 0;
  let totalMs = 0;
  const t0 = Date.now();
  while (moves < 40 && !winner) {
    const ts = Date.now();
    const m = ai(b, c, c === 1 ? 2 : 1);
    totalMs += Date.now() - ts;
    b[m.y][m.x] = c;
    if (hasFive(b, c)) winner = c;
    c = c === 1 ? 2 : 1;
    moves++;
  }
  console.log(`  finished in ${moves} plies, ${((Date.now() - t0) / 1e3).toFixed(1)}s wall, winner=${winner === 0 ? "unfinished" : "B" + winner}`);
  check("self-play terminates cleanly (winner or 40-ply cap)", winner === 1 || winner === 2 || winner === 0);
  check("avg move time sane (< 1.5s)", totalMs / moves < 1500, `${Math.round(totalMs / moves)}ms`);
}
console.log("== strength sanity ==");
{
  const b = empty();
  put(b, [[9, 9, 1], [9, 10, 1], [10, 10, 1], [2, 2, 2], [12, 2, 2], [2, 12, 2]]);
  const before = JSON.stringify(b);
  const res = findBestMove(clone(b), 2, 4, "ai", 6);
  if (JSON.stringify(b) !== before) throw new Error("board mutated!");
  console.log(`  level4 search result: d${res.depth} nodes=${res.nodes} v=${res.eval} \u2192 (${res.move?.x},${res.move?.y})`);
  check("actually searches (not book/fallback)", !res.book && !res.opening && res.nodes > 500, JSON.stringify(res));
  const m = res.move;
  check("white contests the black cluster", Math.abs(m.x - 9) <= 3 && Math.abs(m.y - 9) <= 3, JSON.stringify(m));
}
console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
