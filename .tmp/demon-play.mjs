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
var WIN_LENGTH = 5;
var DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1]
];
function other(player) {
  return player === 1 ? 2 : 1;
}
function inBounds(x, y) {
  return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}
function isBoardFull(b) {
  for (const row of b) {
    for (const v of row) {
      if (v === 0) return false;
    }
  }
  return true;
}
function checkWin(b, x, y) {
  const color = b[y][x];
  if (color === 0) return null;
  for (const [dx, dy] of DIRS) {
    const line = [{ x, y }];
    for (let k = 1; k < WIN_LENGTH; k++) {
      const nx = x + dx * k;
      const ny = y + dy * k;
      if (!inBounds(nx, ny) || b[ny][nx] !== color) break;
      line.push({ x: nx, y: ny });
    }
    for (let k = 1; k < WIN_LENGTH; k++) {
      const nx = x - dx * k;
      const ny = y - dy * k;
      if (!inBounds(nx, ny) || b[ny][nx] !== color) break;
      line.unshift({ x: nx, y: ny });
    }
    if (line.length >= WIN_LENGTH) {
      return line.slice(0, WIN_LENGTH);
    }
  }
  return null;
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

// src/gomoku/learn.ts
var KEY_LESSONS = "gomoku.demonLessons.v1";
var KEY_LOSSES = "gomoku.demonLosses.v1";
var MAX_LESSONS = 240;
var MAX_LOSSES = 30;
function load(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
  }
}
function boardSig(board) {
  const parts = [];
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const c = board[y][x];
      if (c) parts.push(`${x},${y}:${c}`);
    }
  }
  return parts.join(";");
}
function getLessons() {
  return load(KEY_LESSONS, []);
}
function setLessons(v) {
  save(KEY_LESSONS, v.slice(0, MAX_LESSONS));
}
function getLosses() {
  return load(KEY_LOSSES, []);
}
function recordLoss(moves, human, level, opening) {
  const losses2 = getLosses();
  losses2.unshift({ ts: Date.now(), human, level, moves, opening });
  save(KEY_LOSSES, losses2.slice(0, MAX_LOSSES));
  const board = createEmpty();
  const ai = human === 1 ? 2 : 1;
  const lessons = getLessons();
  let added = 0;
  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    if (mv.c === ai) {
      const sig = boardSig(board);
      const prev = lessons.find((l) => l.sig === sig && l.avoid.x === mv.x && l.avoid.y === mv.y);
      if (prev) prev.count++;
      else {
        lessons.push({ sig, avoid: { x: mv.x, y: mv.y }, at: i + 1, count: 1 });
        added++;
      }
    }
    board[mv.y][mv.x] = mv.c;
  }
  setLessons(lessons);
  return { losses: losses2.length, lessons: lessons.length };
}
function checkLesson(board) {
  const sig = boardSig(board);
  let best = null;
  for (const l of getLessons()) {
    if (l.sig === sig && (!best || l.count > best.count)) best = l;
  }
  return best ? { x: best.avoid.x, y: best.avoid.y, count: best.count } : null;
}
function lessonCount() {
  return getLessons().length;
}
var OPENING_TABLE = [
  // 直指 (黑3 直连) — canonical 黑3 = (0,1)
  ["\u82B1\u6708", { x: 0, y: 1 }, { x: 1, y: -1 }],
  ["\u6D66\u6708", { x: 0, y: 1 }, { x: -1, y: 0 }],
  ["\u4E18\u6708", { x: 0, y: 1 }, { x: -1, y: 1 }],
  ["\u5BD2\u661F", { x: 0, y: 1 }, { x: 1, y: 0 }],
  ["\u6EAA\u6708", { x: 0, y: 1 }, { x: 0, y: 2 }],
  ["\u758F\u661F", { x: 0, y: 1 }, { x: 2, y: 1 }],
  // 斜指 (黑3 斜连) — canonical 黑3 = (1,1)
  ["\u660E\u661F", { x: 1, y: 1 }, { x: 1, y: -1 }],
  ["\u659C\u6708", { x: 1, y: 1 }, { x: -1, y: 1 }],
  ["\u5C9A\u6708", { x: 1, y: 1 }, { x: 2, y: 0 }],
  ["\u94F6\u6708", { x: 1, y: 1 }, { x: 0, y: 2 }],
  ["\u91D1\u661F", { x: 1, y: 1 }, { x: 0, y: -1 }]
];
var SYMS = [
  (p) => ({ x: p.x, y: p.y }),
  (p) => ({ x: -p.x, y: p.y }),
  (p) => ({ x: p.x, y: -p.y }),
  (p) => ({ x: -p.x, y: -p.y }),
  (p) => ({ x: p.y, y: p.x }),
  (p) => ({ x: -p.y, y: p.x }),
  (p) => ({ x: p.y, y: -p.x }),
  (p) => ({ x: -p.y, y: -p.x })
];
var keyOf = (p) => `${p.x},${p.y}`;
function detectWinningOpening(moves, human) {
  if (human !== 1) return null;
  const blacks = moves.filter((m) => m.c === 1).slice(0, 3);
  if (blacks.length < 2) return null;
  const b1 = blacks[0];
  const p3 = { x: blacks[1].x - b1.x, y: blacks[1].y - b1.y };
  const straight = p3.x === 0 && Math.abs(p3.y) === 1 || p3.y === 0 && Math.abs(p3.x) === 1;
  const diag = Math.abs(p3.x) === 1 && Math.abs(p3.y) === 1;
  if (!straight && !diag) return null;
  const base = {
    name: straight ? "\u76F4\u6307\u578B\u9ED1\u68CB\u5FC5\u80DC\u5F00\u5C40" : "\u659C\u6307\u578B\u9ED1\u68CB\u5FC5\u80DC\u5F00\u5C40",
    exact: false
  };
  if (blacks.length < 3) return base;
  const p5 = { x: blacks[2].x - b1.x, y: blacks[2].y - b1.y };
  const target3 = straight ? { x: 0, y: 1 } : { x: 1, y: 1 };
  let best = null;
  for (const sym of SYMS) {
    const q3 = sym(p3);
    if (q3.x !== target3.x || q3.y !== target3.y) continue;
    const q5 = sym(p5);
    for (const [name, t3, t5] of OPENING_TABLE) {
      if (t3.x === target3.x && t3.y === target3.y && keyOf(t5) === keyOf(q5)) {
        best = { name, exact: true };
        break;
      }
    }
    if (best) break;
  }
  return best ?? base;
}
function createEmpty() {
  const b = [];
  for (let y = 0; y < 15; y++) {
    const row = [];
    for (let x = 0; x < 15; x++) row.push(0);
    b.push(row);
  }
  return b;
}

// tests/demon-play.mts
var store = /* @__PURE__ */ new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => {
    store.set(k, v);
  },
  removeItem: (k) => {
    store.delete(k);
  }
};
LEVEL_CONFIG[3].timeMs = 500;
var N2 = 15;
var empty = () => Array.from({ length: N2 }, () => new Array(N2).fill(0));
var clone = (b) => b.map((r) => [...r]);
var stones = (b) => b.reduce((n, row) => n + row.filter((v) => v).length, 0);
function humanMove(b, player) {
  const r = findBestMove(clone(b), player, 3, "ai", stones(b));
  return r.move;
}
function demonMove(b, player, g) {
  const lesson = checkLesson(clone(b));
  const res = findBestMove(clone(b), player, 4, "ai", stones(b));
  let m = res.move;
  const who = player === 1 ? "\u9ED1" : "\u767D";
  const tag = `d${res.depth} ${res.ms}ms nodes=${res.nodes} eval=${res.eval}${res.instant ? " \u26A1\u79D2\u65AD" : ""}${res.book ? " \u{1F4D6}\u5F00\u5C40\u5E93" : ""}`;
  if (res.instant) g.instants++;
  g.demonMs.push(res.ms);
  if (lesson && m && m.x === lesson.x && m.y === lesson.y) {
    const alt = (res.scores || []).find((s) => s.x !== lesson.x || s.y !== lesson.y);
    if (alt) {
      const line = `\u{1F4D6} \u6076\u9B54\u8BB0\u5FC6\u89E6\u53D1\uFF1A\u5C40\u9762\u7B2C${stones(b)}\u624B\uFF0C\u524D\u6B21\u8D70(${lesson.x},${lesson.y})\u843D\u8D25\xD7${lesson.count} \u2192 \u6539\u8D70(${alt.x},${alt.y})`;
      g.lessonFires.push(line);
      m = alt;
    }
  }
  const chk = new GomokuEngine();
  chk.load2D(b);
  const humanIdx = player === 1 ? 1 : 0;
  const threat = chk.winCellCount(humanIdx) === 1 ? chk.winCell(humanIdx) : -1;
  const ownCounter = chk.winCellCount(player - 1) > 0;
  const tx = threat % N2;
  const ty = Math.floor(threat / N2);
  if (threat >= 0 && !ownCounter && (m.x !== tx || m.y !== ty)) {
    g.blunders.push(`\u2620\uFE0F \u6F0F\u9632\uFF1A(${tx},${ty}) \u6709\u4EBA\u7C7B\u6210\u4E94\u70B9\u672A\u5835\uFF0C\u6076\u9B54\u8D70\u4E86(${m.x},${m.y}) [${who}]`);
  }
  g.demonLines.push(`  \u6076\u9B54${who} (${m.x},${m.y}) ${tag}${lesson ? ` [\u8BB0\u5FC6\xD7${lesson.count}]` : ""}`);
  return m;
}
function playGame(humanColor, scripted, label) {
  console.log(`
\u2550\u2550\u2550\u2550\u2550\u2550 ${label} \u2550\u2550\u2550\u2550\u2550\u2550`);
  const b = empty();
  const g = { winner: 0, moves: 0, humanMoves: [], fullMoves: [], demonLines: [], lessonFires: [], blunders: [], instants: 0, demonMs: [] };
  let turn = 1;
  let si = 0;
  while (g.moves < 120) {
    const isHuman = turn === humanColor;
    let m;
    if (isHuman) {
      const sp = scripted?.[si];
      if (sp && b[sp.y][sp.x] === 0) {
        m = sp;
        si++;
      } else m = humanMove(b, turn);
    } else {
      m = demonMove(b, turn, g);
    }
    b[m.y][m.x] = turn;
    g.moves++;
    g.fullMoves.push({ x: m.x, y: m.y, c: turn });
    if (isHuman) g.humanMoves.push({ x: m.x, y: m.y, c: turn });
    if (checkWin(b, m.x, m.y)) {
      g.winner = turn;
      break;
    }
    if (isBoardFull(b)) {
      g.winner = 0;
      break;
    }
    turn = other(turn);
  }
  for (const l of g.demonLines) console.log(l);
  for (const l of g.lessonFires) console.log(l);
  for (const l of g.blunders) console.log(l);
  const w = g.winner === 0 ? "\u548C\u68CB" : g.winner === humanColor ? "\u4EBA\u7C7B\u80DC \u{1F389}" : "\u6076\u9B54\u80DC \u{1F608}";
  const avg = g.demonMs.length ? Math.round(g.demonMs.reduce((a, x) => a + x, 0) / g.demonMs.length) : 0;
  const mx = g.demonMs.length ? Math.max(...g.demonMs) : 0;
  console.log(`\u7ED3\u679C: ${w} \xB7 \u5171${g.moves}\u624B \xB7 \u6076\u9B54\u5747\u8017\u65F6${avg}ms(\u5CF0\u503C${mx}ms) \xB7 \u79D2\u65AD${g.instants}\u6B21 \xB7 \u6F0F\u9632${g.blunders.length}\u6B21 \xB7 \u8BB0\u5FC6\u89E6\u53D1${g.lessonFires.length}\u6B21`);
  return g;
}
var g1 = playGame(1, null, "\u7B2C1\u5C40 \xB7 \u4EBA\u6267\u9ED1 vs \u6076\u9B54\u767D");
if (g1.winner === 1) {
  const op = detectWinningOpening(g1.fullMoves, 1);
  const r = recordLoss(g1.fullMoves, 1, 4, op?.name ?? null);
  console.log(`\u{1F4C9} \u6076\u9B54\u590D\u76D8\uFF1A\u8D25\u5C40#${r.losses} \u5DF2\u5F52\u6863${op ? `\uFF08\u5F00\u5C40\u300C${op.name}\u300D${op.exact ? "\u5FC5\u80DC\u5B9A\u5F0F" : "\u8D77\u624B\u5F0F"}\uFF09` : ""}\uFF0C\u6559\u8BAD\u5E93 ${r.lessons} \u6761`);
} else {
  console.log("\u7B2C1\u5C40\u6076\u9B54\u83B7\u80DC \u2014\u2014 \u65E0\u9700\u590D\u76D8");
}
var g2 = playGame(2, null, "\u7B2C2\u5C40 \xB7 \u6076\u9B54\u6267\u9ED1 vs \u4EBA\u767D");
var g3 = playGame(1, g1.humanMoves, "\u7B2C3\u5C40 \xB7 \u4EBA\u6267\u9ED1\u590D\u523B\u7B2C1\u5C40\u68CB\u8C31\uFF08\u590D\u76D8\u80FD\u529B\u9A8C\u8BC1\uFF09");
if (g3.winner === 1) {
  const op = detectWinningOpening(g3.fullMoves, 1);
  const r = recordLoss(g3.fullMoves, 1, 4, op?.name ?? null);
  console.log(`\u{1F4C9} \u6076\u9B54\u518D\u6B21\u590D\u76D8\uFF1A\u8D25\u5C40#${r.losses}\uFF0C\u6559\u8BAD\u5E93 ${r.lessons} \u6761`);
}
var g4 = playGame(1, g1.humanMoves, "\u7B2C4\u5C40 \xB7 \u540C\u4E00\u68CB\u8C31\u7B2C\u4E09\u6B21\u6311\u6218\uFF08\u8BB0\u5FC6\u6536\u655B\u89C2\u5BDF\uFF09");
console.log("\n\u2550\u2550\u2550\u2550\u2550\u2550 \u6076\u9B54\u8D25\u5C40\u6863\u6848\uFF08\u5F39\u7A97\u540C\u6B3E\u6570\u636E\uFF09 \u2550\u2550\u2550\u2550\u2550\u2550");
var losses = getLosses();
console.log(`\u603B\u8D25\u5C40: ${losses.length} \xB7 \u6559\u8BAD\u603B\u6570: ${lessonCount()}`);
for (const l of losses) {
  console.log(`  \u8D25\u5C40 ${new Date(l.ts).toLocaleTimeString()} \xB7 \u4EBA\u7C7B\u6267${l.human === 1 ? "\u9ED1" : "\u767D"} \xB7 ${l.moves.length}\u624B \xB7 \u5F00\u5C40: ${l.opening ?? "\u672A\u8BC6\u522B"}`);
}
