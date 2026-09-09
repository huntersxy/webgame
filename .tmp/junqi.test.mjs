// src/junqi/rules.ts
var COLS = 5;
var ROWS = 12;
var idx = (r, c) => r * COLS + c;
var rowOf = (i) => i / COLS | 0;
var colOf = (i) => i % COLS;
var other = (s) => s === "r" ? "b" : "r";
var CAMPS = /* @__PURE__ */ new Set([
  idx(1, 1),
  idx(1, 3),
  idx(2, 2),
  idx(3, 1),
  idx(3, 3),
  idx(8, 1),
  idx(8, 3),
  idx(9, 2),
  idx(10, 1),
  idx(10, 3)
]);
var HQS = {
  b: [idx(0, 1), idx(0, 3)],
  r: [idx(11, 1), idx(11, 3)]
};
var isCamp = (i) => CAMPS.has(i);
var isHQ = (i) => HQS.b.includes(i) || HQS.r.includes(i);
var ownHalf = (i, s) => s === "b" ? rowOf(i) <= 5 : rowOf(i) >= 6;
var ADJ = (() => {
  const g = Array.from({ length: ROWS * COLS }, () => []);
  const add = (a, b, rail) => {
    g[a].push({ to: b, rail });
    g[b].push({ to: a, rail });
  };
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 1; c++) add(idx(r, c), idx(r, c + 1), r === 5 || r === 6);
  }
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS - 1; r++) {
      if (r === 5) {
        if (c >= 1 && c <= 3) add(idx(r, c), idx(r + 1, c), true);
        continue;
      }
      add(idx(r, c), idx(r + 1, c), c === 0 || c === 4);
    }
  }
  add(idx(2, 2), idx(1, 1), false);
  add(idx(2, 2), idx(1, 3), false);
  add(idx(2, 2), idx(3, 1), false);
  add(idx(2, 2), idx(3, 3), false);
  add(idx(9, 2), idx(8, 1), false);
  add(idx(9, 2), idx(8, 3), false);
  add(idx(9, 2), idx(10, 1), false);
  add(idx(9, 2), idx(10, 3), false);
  return g;
})();
var RANK = {
  \u53F8\u4EE4: 9,
  \u519B\u957F: 8,
  \u5E08\u957F: 7,
  \u65C5\u957F: 6,
  \u56E2\u957F: 5,
  \u8425\u957F: 4,
  \u8FDE\u957F: 3,
  \u6392\u957F: 2,
  \u5DE5\u5175: 1,
  \u70B8\u5F39: 0,
  \u5730\u96F7: 0,
  \u519B\u65D7: 0
};
var IMMOBILE = /* @__PURE__ */ new Set(["\u5730\u96F7", "\u519B\u65D7"]);
var canMoveType = (t) => !IMMOBILE.has(t);
var PIECE_COUNTS = [
  ["\u53F8\u4EE4", 1],
  ["\u519B\u957F", 1],
  ["\u5E08\u957F", 2],
  ["\u65C5\u957F", 2],
  ["\u56E2\u957F", 2],
  ["\u8425\u957F", 2],
  ["\u8FDE\u957F", 3],
  ["\u6392\u957F", 3],
  ["\u5DE5\u5175", 3],
  ["\u70B8\u5F39", 2],
  ["\u5730\u96F7", 3],
  ["\u519B\u65D7", 1]
];
function resolve(att, def) {
  if (def.type === "\u519B\u65D7") return { a: false, d: true, flag: true };
  if (att.type === "\u70B8\u5F39" || def.type === "\u70B8\u5F39") return { a: true, d: true, flag: false };
  if (def.type === "\u5730\u96F7") {
    return att.type === "\u5DE5\u5175" ? { a: false, d: true, flag: false } : { a: true, d: false, flag: false };
  }
  if (att.type === "\u5730\u96F7" || att.type === "\u519B\u65D7") return { a: true, d: false, flag: false };
  const ra = RANK[att.type];
  const rd = RANK[def.type];
  if (ra === rd) return { a: true, d: true, flag: false };
  return ra > rd ? { a: false, d: true, flag: false } : { a: true, d: false, flag: false };
}
function destOk(board, i, me) {
  const q = board[i];
  if (!q) return true;
  if (q.side === me) return false;
  if (isCamp(i)) return false;
  return true;
}
function legalMoves(board, from) {
  const p = board[from];
  if (!p || !canMoveType(p.type)) return [];
  const out = /* @__PURE__ */ new Set();
  const fr = rowOf(from);
  const fc = colOf(from);
  for (const e of ADJ[from]) {
    if (!e.rail) {
      if (destOk(board, e.to, p.side)) out.add(e.to);
      continue;
    }
    if (p.type === "\u5DE5\u5175") continue;
    const tr = rowOf(e.to);
    const tc = colOf(e.to);
    const dr = Math.sign(tr - fr);
    const dc = Math.sign(tc - fc);
    let cr = tr;
    let cc = tc;
    for (; ; ) {
      const ni = idx(cr, cc);
      const occ = board[ni];
      if (occ) {
        if (destOk(board, ni, p.side)) out.add(ni);
        break;
      }
      out.add(ni);
      const nr = cr + dr;
      const nc = cc + dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) break;
      const next = ADJ[ni].find((x) => x.to === idx(nr, nc) && x.rail);
      if (!next) break;
      cr = nr;
      cc = nc;
    }
  }
  if (p.type === "\u5DE5\u5175") {
    const seen = /* @__PURE__ */ new Set([from]);
    const queue = ADJ[from].filter((e) => e.rail).map((e) => e.to);
    for (const s of queue) seen.add(s);
    while (queue.length) {
      const n = queue.shift();
      const occ = board[n];
      if (occ) {
        if (destOk(board, n, p.side)) out.add(n);
        continue;
      }
      out.add(n);
      for (const e of ADJ[n]) {
        if (e.rail && !seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
  }
  out.delete(from);
  return [...out];
}
function hasAnyMove(board, side) {
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p && p.side === side && canMoveType(p.type) && legalMoves(board, i).length > 0) return true;
  }
  return false;
}
function validateLayout(board, side) {
  const front = side === "b" ? 5 : 6;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p || p.side !== side) continue;
    if (!ownHalf(i, side)) return "\u68CB\u5B50\u5FC5\u987B\u653E\u5728\u5DF1\u65B9\u534A\u573A";
    if (isCamp(i)) return "\u884C\u8425\u5185\u4E0D\u80FD\u5E03\u5B50";
    if (p.type === "\u519B\u65D7" && !isHQ(i)) return "\u519B\u65D7\u5FC5\u987B\u653E\u5728\u5927\u672C\u8425";
    if (p.type === "\u5730\u96F7") {
      const back = side === "b" ? rowOf(i) <= 1 : rowOf(i) >= 10;
      if (!back) return "\u5730\u96F7\u53EA\u80FD\u653E\u5728\u540E\u4E24\u6392";
    }
    if (p.type === "\u70B8\u5F39" && rowOf(i) === front) return "\u70B8\u5F39\u4E0D\u80FD\u653E\u5728\u7B2C\u4E00\u6392";
  }
  const counts = {};
  let total = 0;
  for (const p of board) {
    if (!p || p.side !== side) continue;
    total++;
    counts[p.type] = (counts[p.type] ?? 0) + 1;
  }
  for (const [t, n] of PIECE_COUNTS) {
    const have = counts[t] ?? 0;
    if (have > n) return `${t}\u8D85\u51FA\u7F16\u5236\uFF08${have}/${n}\uFF09`;
  }
  if (total > 25) return "\u68CB\u5B50\u603B\u6570\u8D85\u8FC7 25 \u679A";
  return null;
}
function layoutComplete(board, side) {
  const counts = {};
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
function autofillLayout(board, side) {
  const back2 = (i) => side === "b" ? rowOf(i) <= 1 : rowOf(i) >= 10;
  const front = side === "b" ? 5 : 6;
  const counts = {};
  for (const p of board) if (p && p.side === side) counts[p.type] = (counts[p.type] ?? 0) + 1;
  const need = [];
  for (const [t, n] of PIECE_COUNTS) {
    for (let k = counts[t] ?? 0; k < n; k++) need.push(t);
  }
  if (!need.length) return null;
  const constraint = (t) => t === "\u519B\u65D7" ? 0 : t === "\u5730\u96F7" ? 1 : t === "\u70B8\u5F39" ? 2 : 3;
  need.sort((a, b) => constraint(a) - constraint(b));
  const free = [];
  const rows = side === "b" ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11];
  for (const r of rows) for (let c = 0; c < COLS; c++) {
    const i = idx(r, c);
    if (!isCamp(i) && !board[i]) free.push(i);
  }
  const take = (pred) => {
    const k = free.findIndex(pred);
    if (k < 0) return -1;
    const n = free[k];
    free.splice(k, 1);
    return n;
  };
  const shuffleRest = () => {
    for (let k = free.length - 1; k > 0; k--) {
      const j = Math.random() * (k + 1) | 0;
      [free[k], free[j]] = [free[j], free[k]];
    }
  };
  shuffleRest();
  let id = 1e3 + (Math.random() * 9e3 | 0);
  for (const t of need) {
    let node = -1;
    if (t === "\u519B\u65D7") node = take((i) => isHQ(i));
    else if (t === "\u5730\u96F7") node = take((i) => back2(i));
    else if (t === "\u70B8\u5F39") node = take((i) => rowOf(i) !== front);
    else node = free.pop() ?? -1;
    if (node < 0) {
      if (t === "\u519B\u65D7") return "\u519B\u65D7\u65E0\u5904\u5B89\u653E\uFF1A\u8BF7\u5728\u5927\u672C\u8425\u7559\u51FA\u7A7A\u4F4D";
      if (t === "\u5730\u96F7") return "\u5730\u96F7\u65E0\u5904\u5B89\u653E\uFF1A\u8BF7\u5728\u540E\u4E24\u6392\u7559\u51FA\u7A7A\u4F4D";
      if (t === "\u70B8\u5F39") return "\u70B8\u5F39\u65E0\u5904\u5B89\u653E\uFF1A\u7B2C\u4E00\u6392\u4E0D\u80FD\u653E\u70B8\u5F39";
      return "\u7A7A\u4F4D\u4E0D\u8DB3\uFF0C\u65E0\u6CD5\u8865\u5168";
    }
    board[node] = { id: id++, side, type: t };
  }
  return null;
}
function randomLayout(side, startId) {
  const rows = side === "b" ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11];
  const back2 = side === "b" ? /* @__PURE__ */ new Set([0, 1]) : /* @__PURE__ */ new Set([10, 11]);
  const front = side === "b" ? 5 : 6;
  const nodes = [];
  for (const r of rows) for (let c = 0; c < COLS; c++) {
    const i = idx(r, c);
    if (!isCamp(i)) nodes.push(i);
  }
  const shuffle = (arr) => {
    for (let k = arr.length - 1; k > 0; k--) {
      const j = Math.random() * (k + 1) | 0;
      const tmp = arr[k];
      arr[k] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  };
  const used = /* @__PURE__ */ new Set();
  const take = (pool, n) => {
    const pick = shuffle(pool.filter((x) => !used.has(x)));
    const out = pick.slice(0, n);
    for (const x of out) used.add(x);
    return out;
  };
  const result = [];
  const hq = HQS[side][Math.random() * 2 | 0];
  result.push({ node: hq, type: "\u519B\u65D7" });
  used.add(hq);
  for (const n of take(nodes.filter((i) => back2.has(rowOf(i))), 3)) result.push({ node: n, type: "\u5730\u96F7" });
  for (const n of take(nodes.filter((i) => rowOf(i) !== front), 2)) result.push({ node: n, type: "\u70B8\u5F39" });
  const rest = [];
  for (const [t, cnt] of PIECE_COUNTS) {
    if (t === "\u519B\u65D7" || t === "\u5730\u96F7" || t === "\u70B8\u5F39") continue;
    for (let k = 0; k < cnt; k++) rest.push(t);
  }
  const free = shuffle(nodes.filter((i) => !used.has(i)));
  rest.forEach((t, k) => result.push({ node: free[k], type: t }));
  let id = startId;
  return result.map((x) => ({ node: x.node, piece: { id: id++, side, type: x.type } }));
}
function randomBoard() {
  const board = new Array(ROWS * COLS).fill(null);
  for (const { node, piece } of randomLayout("b", 1)) board[node] = piece;
  for (const { node, piece } of randomLayout("r", 100)) board[node] = piece;
  return board;
}
function makeJqMove(board, from, to) {
  const att = board[from];
  const def = board[to] ?? null;
  board[from] = null;
  const rec = { from, to, att, def, attOut: false, defOut: false, flag: false };
  if (!def) {
    board[to] = att;
    return rec;
  }
  const r = resolve(att, def);
  if (r.flag) {
    rec.flag = true;
    rec.defOut = true;
    board[to] = att;
    return rec;
  }
  if (r.a && r.d) {
    rec.attOut = true;
    rec.defOut = true;
    board[to] = null;
    return rec;
  }
  if (r.a) {
    rec.attOut = true;
    board[to] = def;
    return rec;
  }
  rec.defOut = true;
  board[to] = att;
  return rec;
}
function undoJqMove(board, rec) {
  board[rec.from] = rec.att;
  board[rec.to] = rec.def;
}
function allJqMoves(board, side) {
  const out = [];
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p || p.side !== side || !canMoveType(p.type)) continue;
    for (const to of legalMoves(board, i)) out.push({ from: i, to });
  }
  return out;
}

// src/core/zobrist.ts
var Zobrist = class {
  table;
  sideKey;
  width;
  pieceCount;
  /**
   * @param width   Board width (positions per row)
   * @param height  Board height (rows)
   * @param pieceCount  Number of distinct piece types
   * @param seed    PRNG seed for deterministic keys
   */
  constructor(width, height, pieceCount, seed = 2654435769) {
    this.width = width;
    this.pieceCount = pieceCount;
    const total = width * height * pieceCount;
    this.table = new Uint32Array(total);
    const rnd = this.makeRng(seed);
    for (let i = 0; i < total; i++) {
      this.table[i] = rnd();
    }
    this.sideKey = rnd();
  }
  /** XOR the side-to-move key (use when turn matters) */
  get side() {
    return this.sideKey;
  }
  /** Hash key for a single (x, y, pieceIndex) */
  key(x, y, pieceIndex) {
    return this.table[(y * this.width + x) * this.pieceCount + pieceIndex];
  }
  makeRng(seed) {
    let s = seed >>> 0;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return s >>> 0;
    };
  }
};

// src/core/transposition.ts
var TranspositionTable = class {
  keys;
  depth;
  score;
  flag;
  move;
  cap;
  mask;
  constructor(maxEntries = 3e5) {
    let cap = 1;
    while (cap < maxEntries) cap <<= 1;
    this.cap = cap;
    this.mask = cap - 1;
    this.keys = new Uint32Array(cap);
    this.depth = new Int32Array(cap);
    this.score = new Int32Array(cap);
    this.flag = new Uint8Array(cap);
    this.move = new Array(cap).fill(null);
  }
  index(hash) {
    let h = hash >>> 0;
    h ^= h >>> 16;
    h = h * 73244475 >>> 0;
    h ^= h >>> 16;
    return h & this.mask;
  }
  get(hash) {
    const i = this.index(hash);
    if (this.keys[i] === hash >>> 0) {
      return { depth: this.depth[i], score: this.score[i], flag: this.flag[i], move: this.move[i] };
    }
    return void 0;
  }
  probe(hash, depth, alpha, beta) {
    const i = this.index(hash);
    if (this.keys[i] !== hash >>> 0) return null;
    const eDepth = this.depth[i];
    if (eDepth < depth) return null;
    const eFlag = this.flag[i];
    const eScore = this.score[i];
    if (eFlag === 0) return eScore;
    if (eFlag === 1 && eScore >= beta) return eScore;
    if (eFlag === 2 && eScore <= alpha) return eScore;
    return null;
  }
  store(hash, depth, score, alpha, beta, move) {
    const i = this.index(hash);
    let flag = 0;
    if (score <= alpha) flag = 2;
    else if (score >= beta) flag = 1;
    this.keys[i] = hash >>> 0;
    const bounded = Math.max(-3e6, Math.min(3e6, score));
    this.depth[i] = depth;
    this.score[i] = bounded;
    this.flag[i] = flag;
    this.move[i] = move;
  }
  clear() {
    this.keys.fill(0);
    this.depth.fill(0);
    this.score.fill(0);
    this.flag.fill(0);
    this.move.fill(null);
  }
  get size() {
    let n = 0;
    for (let i = 0; i < this.cap; i++) if (this.keys[i] !== 0) n++;
    return n;
  }
};

// src/junqi/ai.ts
var JQ_LEVEL_CONFIG = {
  1: { name: "\u7B80\u5355", depth: 1 },
  2: { name: "\u666E\u901A", depth: 2 },
  3: { name: "\u56F0\u96BE", depth: 3 },
  4: { name: "\u{1F608}\u6076\u9B54", depth: 6 }
};
var JQ_MATE = 1e6;
var VALUE = {
  \u53F8\u4EE4: 600,
  \u519B\u957F: 520,
  \u5E08\u957F: 440,
  \u65C5\u957F: 360,
  \u56E2\u957F: 300,
  \u8425\u957F: 250,
  \u8FDE\u957F: 200,
  \u6392\u957F: 150,
  \u5DE5\u5175: 230,
  \u70B8\u5F39: 330,
  \u5730\u96F7: 260,
  \u519B\u65D7: 0
};
var HIDDEN_VAL = (() => {
  let sum = 0;
  for (const [t, n] of PIECE_COUNTS) sum += VALUE[t] * n;
  return sum / 25;
})();
var PTYPES = PIECE_COUNTS.map(([t]) => t);
var TYPE_IDX = {};
PTYPES.forEach((t, i) => {
  TYPE_IDX[t] = i;
});
var zobrist = new Zobrist(COLS, ROWS, 24, 2084236561);
var tt = new TranspositionTable(3e5);
var killers = new Array(256).fill(null);
function zkey(i, type, hidden) {
  return zobrist.key(colOf(i), rowOf(i), TYPE_IDX[type] + (hidden ? 12 : 0));
}
function boardHash(board, turn) {
  let h = 0;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p) h ^= zkey(i, p.type, !!p.hidden);
  }
  if (turn === "r") h ^= zobrist.side;
  return h >>> 0;
}
function deltaHash(h, rec) {
  let nh = h;
  nh ^= zkey(rec.from, rec.att.type, !!rec.att.hidden);
  if (!rec.attOut) nh ^= zkey(rec.to, rec.att.type, false);
  if (rec.def) {
    const dOld = zkey(rec.to, rec.def.type, !!rec.def.hidden);
    nh ^= dOld;
    if (!rec.defOut) nh ^= zkey(rec.to, rec.def.type, false);
  }
  return nh >>> 0;
}
function dist(a, b) {
  return Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b));
}
function evaluate(board, flip) {
  let score = 0;
  let rFlag = -1;
  let bFlag = -1;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p) continue;
    let v = p.hidden ? HIDDEN_VAL : VALUE[p.type];
    if (!p.hidden && canMoveType(p.type)) {
      const adv = p.side === "r" ? rowOf(i) - 6 : 5 - rowOf(i);
      v += adv * 3;
      if (isCamp(i)) v += 6;
    }
    score += p.side === "r" ? v : -v;
    if (p.type === "\u519B\u65D7") {
      if (p.side === "r") rFlag = i;
      else bFlag = i;
    }
  }
  const threat = (flag, enemy) => {
    if (flag < 0) return 0;
    let t = 0;
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (!p || p.side !== enemy || p.hidden) continue;
      const d = dist(i, flag);
      if (p.type === "\u5DE5\u5175") t += Math.max(0, 42 - d * 7);
      else if (p.type === "\u70B8\u5F39") t += Math.max(0, 24 - d * 5);
    }
    return t;
  };
  score -= threat(rFlag, "b");
  score += threat(bFlag, "r");
  return score;
}
function orderScore(board, m) {
  const def = board[m.to];
  const att = board[m.from];
  if (def) {
    if (def.type === "\u519B\u65D7") return 1e6;
    const dv = def.hidden ? HIDDEN_VAL : VALUE[def.type];
    if (def.type === "\u5730\u96F7" && !def.hidden && att.type !== "\u5DE5\u5175") return -8e3;
    return 8e3 + dv * 10 - VALUE[att.type];
  }
  const adv = att.side === "r" ? rowOf(m.to) - rowOf(m.from) : rowOf(m.from) - rowOf(m.to);
  let s = adv * 8;
  if (att.type === "\u5DE5\u5175") s += 6;
  return s;
}
function orderMoves(board, moves) {
  for (const m of moves) m.ord = orderScore(board, m) + Math.random();
  moves.sort((a, b) => b.ord - a.ord);
  return moves;
}
function sameMove(a, b) {
  return a.from === b.from && a.to === b.to;
}
function quiesce(board, alpha, beta, turn, qd, ply, ctx, hash) {
  ctx.nodes++;
  const nodeCap = ctx.level === 4 ? 12e5 : 15e4;
  if (ctx.nodes > nodeCap) return (turn === "r" ? 1 : -1) * evaluate(board, ctx.flip);
  if (ctx.deadline && typeof performance !== "undefined" && performance.now() > ctx.deadline) {
    ctx.hitDeadline = true;
    return (turn === "r" ? 1 : -1) * evaluate(board, ctx.flip);
  }
  const stand = (turn === "r" ? 1 : -1) * evaluate(board, ctx.flip);
  if (qd <= 0 || ply >= 96) return stand;
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;
  const caps = orderMoves(board, allJqMoves(board, turn).filter((m) => !!board[m.to]));
  for (const m of caps) {
    const rec = makeJqMove(board, m.from, m.to);
    let v;
    if (rec.flag) v = JQ_MATE - ply;
    else v = -quiesce(board, -beta, -alpha, other(turn), qd - 1, ply + 1, ctx, deltaHash(hash, rec));
    undoJqMove(board, rec);
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}
function alphaBeta(board, depth, alpha, beta, turn, ply, pv, ctx, hash) {
  ctx.nodes++;
  const nodeCap = ctx.level === 4 ? 14e5 : 15e4;
  if (ctx.nodes > nodeCap) return (turn === "r" ? 1 : -1) * evaluate(board, ctx.flip);
  if (ctx.deadline && typeof performance !== "undefined" && performance.now() > ctx.deadline) {
    ctx.hitDeadline = true;
    return (turn === "r" ? 1 : -1) * evaluate(board, ctx.flip);
  }
  if (depth <= 0 || ply >= 96) return quiesce(board, alpha, beta, turn, 4, ply, ctx, hash);
  const key = (hash ^ (turn === "r" ? zobrist.side : 0)) >>> 0;
  const ttScore = tt.probe(key, depth, alpha, beta);
  if (ttScore !== null) return ttScore;
  const tte = tt.get(key);
  const moves = orderMoves(board, allJqMoves(board, turn));
  if (moves.length === 0) return -JQ_MATE + ply;
  if (tte?.move) {
    const i = moves.findIndex((m) => sameMove(m, tte.move));
    if (i > 0) moves.unshift(moves.splice(i, 1)[0]);
  }
  for (const k of [killers[ply * 2], killers[ply * 2 + 1]]) {
    if (!k) continue;
    const i = moves.findIndex((m) => sameMove(m, k));
    if (i > 0) moves.unshift(moves.splice(i, 1)[0]);
  }
  let list = moves;
  const width = ctx.level === 4 ? 44 : 34;
  if (depth >= 2 && moves.length > width) list = moves.slice(0, width);
  let best = -Infinity;
  let bestM = list[0];
  const origAlpha = alpha;
  for (const m of list) {
    const rec = makeJqMove(board, m.from, m.to);
    const childPV = [];
    let v;
    if (rec.flag) v = JQ_MATE - ply;
    else v = -alphaBeta(board, depth - 1, -beta, -alpha, other(turn), ply + 1, childPV, ctx, deltaHash(hash, rec));
    undoJqMove(board, rec);
    if (v > best) {
      best = v;
      bestM = m;
      if (pv) {
        pv.length = 0;
        pv.push(m, ...childPV);
      }
    }
    if (v > alpha) alpha = v;
    if (alpha >= beta) {
      killers[ply * 2 + 1] = killers[ply * 2];
      killers[ply * 2] = m;
      break;
    }
  }
  tt.store(key, depth, best, origAlpha, beta, bestM);
  return best;
}
function findBestMove(board, side, difficulty, mode, flip, historyLength, persist = true) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const cfg = JQ_LEVEL_CONFIG[difficulty];
  const demon = difficulty === 4;
  tt.clear();
  killers.fill(null);
  const TIME_BUDGET_MS = demon ? mode === "aivai" ? 2400 : 2800 : 0;
  const ctx = {
    nodes: 0,
    level: difficulty,
    mode,
    flip,
    deadline: TIME_BUDGET_MS ? typeof performance !== "undefined" ? performance.now() + TIME_BUDGET_MS : 0 : void 0
  };
  const allMoves = orderMoves(board, allJqMoves(board, side));
  if (allMoves.length === 0) {
    return { move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] };
  }
  const rootHash = boardHash(board, side);
  const runAtDepth = (depth) => {
    let best = allMoves[0];
    let bestV = -Infinity;
    const bestPV = [];
    const scored = [];
    for (const m of allMoves) {
      const rec = makeJqMove(board, m.from, m.to);
      const pv = [];
      let v;
      if (rec.flag) v = JQ_MATE;
      else v = -alphaBeta(board, depth - 1, -Infinity, Infinity, other(side), 1, pv, ctx, deltaHash(rootHash, rec));
      undoJqMove(board, rec);
      if (!demon) v += Math.random() * (difficulty === 1 ? 140 : difficulty === 2 ? 40 : 10);
      scored.push({ ...m, v });
      if (v > bestV) {
        bestV = v;
        best = m;
        bestPV.length = 0;
        bestPV.push(m, ...pv);
      }
    }
    scored.sort((a, b) => b.v - a.v);
    return { best, bestV, bestPV, scored };
  };
  const pastDeadline = () => !!ctx.deadline && typeof performance !== "undefined" && performance.now() > ctx.deadline;
  if (!demon && historyLength < 2 && Math.random() < 0.35 && allMoves.length > 5) {
    const r = allMoves[Math.random() * 5 | 0];
    return { move: r, depth: cfg.depth, nodes: 5, ms: 1, eval: 0, scores: [{ ...r, v: 0 }], opening: true };
  }
  let res;
  let searchDepth = cfg.depth;
  if (demon) {
    res = runAtDepth(2);
    searchDepth = 2;
    for (let d = 3; d <= cfg.depth; d++) {
      if (pastDeadline()) break;
      ctx.hitDeadline = false;
      const r = runAtDepth(d);
      if (ctx.hitDeadline) break;
      res = r;
      searchDepth = d;
    }
  } else {
    res = runAtDepth(searchDepth);
  }
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    move: res.best,
    depth: searchDepth,
    nodes: ctx.nodes,
    ms: Math.round(t1 - t0),
    eval: Math.round(res.bestV),
    scores: res.scored.slice(0, 6),
    pv: res.bestPV.slice(0, 6),
    qd: 4
  };
}

// tests/junqi.test.mts
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
var mk = (side, type, id = 1) => ({ id, side, type });
var empty = () => new Array(60).fill(null);
console.log("== \u5E03\u9635 ==");
{
  let bad = 0;
  for (let k = 0; k < 300; k++) {
    const b = randomBoard();
    const counts = {};
    let rFlagInHQ = false, bFlagInHQ = false;
    let mineOk = true, campOccupied = false, total = 0;
    for (let i = 0; i < 60; i++) {
      const p = b[i];
      if (!p) continue;
      total++;
      counts[p.side + p.type] = (counts[p.side + p.type] || 0) + 1;
      if (isCamp(i)) campOccupied = true;
      if (p.type === "\u519B\u65D7") {
        if (!isHQ(i)) mineOk = false;
        if (p.side === "r") rFlagInHQ = true;
        else bFlagInHQ = true;
      }
      if (p.type === "\u5730\u96F7") {
        const r = rowOf(i);
        const back = p.side === "r" ? r >= 10 : r <= 1;
        if (!back) mineOk = false;
      }
    }
    const want = {
      \u53F8\u4EE4: 1,
      \u519B\u957F: 1,
      \u5E08\u957F: 2,
      \u65C5\u957F: 2,
      \u56E2\u957F: 2,
      \u8425\u957F: 2,
      \u8FDE\u957F: 3,
      \u6392\u957F: 3,
      \u5DE5\u5175: 3,
      \u70B8\u5F39: 2,
      \u5730\u96F7: 3,
      \u519B\u65D7: 1
    };
    let countsOk = total === 50;
    for (const s of ["r", "b"]) for (const t in want) if (counts[s + t] !== want[t]) countsOk = false;
    if (!countsOk || !mineOk || campOccupied || !rFlagInHQ || !bFlagInHQ) bad++;
  }
  check("300 \u6B21\u968F\u673A\u5E03\u9635\u5168\u90E8\u5408\u6CD5\uFF08\u6570\u91CF/\u519B\u65D7\u5165\u8425/\u5730\u96F7\u540E\u4E24\u884C/\u884C\u8425\u7A7A\uFF09", bad === 0, `bad=${bad}`);
}
console.log("== \u94C1\u8DEF ==");
{
  const b = empty();
  b[idx(0, 0)] = mk("r", "\u5E08\u957F");
  const mv = legalMoves(b, idx(0, 0));
  check("\u5E08\u957F\u6CBF\u8FB9\u5217\u94C1\u8DEF\u957F\u8DDD\u79BB\u6ED1\u884C", mv.includes(idx(3, 0)) && mv.includes(idx(5, 0)), JSON.stringify(mv.map((i) => [rowOf(i), colOf(i)])));
  check("\u94C1\u8DEF\u4E0D\u62D0\u5F2F\uFF08\u4E0D\u80FD\u6A2A\u5411\u76F4\u8FBE\u8FDC\u5904\uFF09", !mv.includes(idx(0, 3)) && mv.includes(idx(0, 1)), JSON.stringify(mv.map((i) => [rowOf(i), colOf(i)])));
}
{
  const b = empty();
  b[idx(5, 1)] = mk("r", "\u65C5\u957F");
  b[idx(5, 3)] = mk("r", "\u6392\u957F");
  const mv = legalMoves(b, idx(5, 1));
  check("\u524D\u7EBF\u94C1\u8DEF\u88AB\u5DF1\u65B9\u5B50\u963B\u6321", mv.includes(idx(5, 2)) && !mv.includes(idx(5, 4)), JSON.stringify(mv.map((i) => [rowOf(i), colOf(i)])));
}
console.log("== \u5DE5\u5175 ==");
{
  const b = empty();
  b[idx(0, 0)] = mk("r", "\u5DE5\u5175");
  const mv = legalMoves(b, idx(0, 0));
  check("\u5DE5\u5175\u94C1\u8DEF\u53EF\u62D0\u5F2F\u5230\u8FDC\u7AEF", mv.includes(idx(5, 4)) && mv.includes(idx(11, 0)), `${mv.length} \u843D\u70B9`);
}
console.log("== \u516C\u8DEF ==");
{
  const b = empty();
  b[idx(2, 2)] = mk("r", "\u8FDE\u957F");
  const mv = legalMoves(b, idx(2, 2));
  check("\u666E\u901A\u5B50\u516C\u8DEF\u53EA\u8D70\u4E00\u6B65", mv.every((i) => Math.abs(rowOf(i) - 2) + Math.abs(colOf(i) - 2) <= 2) && mv.length <= 8 && mv.length >= 4, JSON.stringify(mv.map((i) => [rowOf(i), colOf(i)])));
}
console.log("== \u884C\u8425 ==");
{
  const b = empty();
  b[idx(2, 2)] = mk("b", "\u6392\u957F");
  b[idx(3, 1)] = mk("r", "\u53F8\u4EE4");
  const mv = legalMoves(b, idx(3, 1));
  check("\u884C\u8425\u5185\u654C\u5B50\u4E0D\u53EF\u88AB\u653B\u51FB", !mv.includes(idx(2, 2)), JSON.stringify(mv.map((i) => [rowOf(i), colOf(i)])));
}
console.log("== \u6218\u6597 ==");
{
  check("\u5927\u5403\u5C0F", resolve(mk("r", "\u5E08\u957F"), mk("b", "\u65C5\u957F")).d === true);
  check("\u5C0F\u649E\u5927\u5403\u4EBA", resolve(mk("r", "\u65C5\u957F"), mk("b", "\u5E08\u957F")).a === true);
  check("\u540C\u7EA7\u540C\u5C3D", (() => {
    const r = resolve(mk("r", "\u56E2\u957F"), mk("b", "\u56E2\u957F"));
    return r.a && r.d;
  })());
  check("\u70B8\u5F39\u4E92\u70B8", (() => {
    const r = resolve(mk("r", "\u70B8\u5F39"), mk("b", "\u53F8\u4EE4"));
    return r.a && r.d;
  })());
  check("\u53F8\u4EE4\u649E\u70B8\u5F39\u540C\u5C3D", (() => {
    const r = resolve(mk("r", "\u53F8\u4EE4"), mk("b", "\u70B8\u5F39"));
    return r.a && r.d;
  })());
  check("\u5DE5\u5175\u6316\u96F7", (() => {
    const r = resolve(mk("r", "\u5DE5\u5175"), mk("b", "\u5730\u96F7"));
    return !r.a && r.d;
  })());
  check("\u975E\u5DE5\u5175\u649E\u96F7\u4EA1", (() => {
    const r = resolve(mk("r", "\u53F8\u4EE4"), mk("b", "\u5730\u96F7"));
    return r.a && !r.d;
  })());
  check("\u625B\u65D7", resolve(mk("r", "\u6392\u957F"), mk("b", "\u519B\u65D7")).flag === true);
}
{
  check("\u5730\u96F7/\u519B\u65D7\u4E0D\u53EF\u52A8", !canMoveType("\u5730\u96F7") && !canMoveType("\u519B\u65D7") && canMoveType("\u5DE5\u5175"));
}
console.log("== \u7EDD\u6740 ==");
{
  const b = empty();
  b[idx(11, 1)] = mk("r", "\u519B\u65D7");
  b[idx(11, 2)] = mk("r", "\u5730\u96F7");
  b[idx(0, 2)] = mk("b", "\u53F8\u4EE4");
  check("\u53EA\u5269\u65D7\u96F7\u5224\u65E0\u5B50\u53EF\u52A8", !hasAnyMove(b, "r") && hasAnyMove(b, "b"));
}
console.log("== \u6446\u9635\u6821\u9A8C ==");
{
  let okAll = true;
  for (let k = 0; k < 100; k++) {
    const b = randomBoard();
    for (const s of ["r", "b"]) {
      if (validateLayout(b, s) !== null || !layoutComplete(b, s)) okAll = false;
    }
  }
  check("\u968F\u673A\u5E03\u9635\u901A\u8FC7\u6821\u9A8C\u4E14\u5B8C\u6574", okAll);
  const b1 = randomBoard();
  const rFlag = b1.findIndex((p) => p?.side === "r" && p.type === "\u519B\u65D7");
  b1[rFlag] = null;
  b1[idx(6, 0)] = { id: 99, side: "r", type: "\u519B\u65D7" };
  check("\u519B\u65D7\u4E0D\u5728\u5927\u672C\u8425\u88AB\u62D2", validateLayout(b1, "r") !== null && !layoutComplete(b1, "r"));
  const b2 = randomBoard();
  const rMine = b2.findIndex((p) => p?.side === "r" && p.type === "\u5730\u96F7");
  const mineT = b2[rMine];
  b2[rMine] = null;
  b2[idx(6, 2)] = mineT;
  check("\u5730\u96F7\u51FA\u540E\u4E24\u6392\u88AB\u62D2", validateLayout(b2, "r") !== null);
  const b3 = randomBoard();
  const rBomb = b3.findIndex((p) => p?.side === "r" && p.type === "\u70B8\u5F39");
  const bombT = b3[rBomb];
  b3[rBomb] = null;
  b3[idx(6, 4)] = bombT;
  check("\u70B8\u5F39\u8FDB\u7B2C\u4E00\u6392\u88AB\u62D2", validateLayout(b3, "r") !== null);
  let fillOk = true;
  for (let k = 0; k < 100; k++) {
    const b = new Array(60).fill(null);
    const types = ["\u53F8\u4EE4", "\u519B\u957F", "\u5E08\u957F", "\u65C5\u957F", "\u56E2\u957F", "\u8425\u957F"];
    types.forEach((t, k2) => {
      b[idx(6 + k2 % 4, k2 % 5)] = { id: k2, side: "r", type: t };
    });
    const err = autofillLayout(b, "r");
    if (err !== null || !layoutComplete(b, "r")) fillOk = false;
  }
  check("\u90E8\u5206\u5E03\u9635\u8865\u5168 100 \u6B21\u5168\u90E8\u5408\u6CD5", fillOk);
  const b4 = new Array(60).fill(null);
  b4[idx(11, 1)] = { id: 1, side: "r", type: "\u53F8\u4EE4" };
  b4[idx(11, 3)] = { id: 2, side: "r", type: "\u519B\u957F" };
  check("\u5927\u672C\u8425\u88AB\u5360\u65F6\u8865\u5168\u62A5\u9519", autofillLayout(b4, "r") !== null);
}
console.log("== \u53EF\u9006\u8D70\u5B50 ==");
{
  let ok = true;
  for (let k = 0; k < 200; k++) {
    const b = randomBoard();
    for (let step = 0; step < 8; step++) {
      const side = step % 2 === 0 ? "b" : "r";
      const ms = allJqMoves(b, side);
      if (!ms.length) break;
      const m = ms[Math.random() * ms.length | 0];
      const before = b.map((p) => p ? { ...p } : null);
      const rec = makeJqMove(b, m.from, m.to);
      undoJqMove(b, rec);
      for (let i = 0; i < 60; i++) {
        const a = b[i], e = before[i];
        if (a && !e || !a && e || a && e && (a.type !== e.type || a.side !== e.side || !!a.hidden !== !!e.hidden)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      makeJqMove(b, m.from, m.to);
    }
    if (!ok) break;
  }
  check("200 \u5C40\u968F\u673A\u8D70\u5B50 make/undo \u5B8C\u5168\u8FD8\u539F", ok);
}
console.log("== \u63ED\u68CB ==");
{
  const b = empty();
  b[idx(0, 0)] = { ...mk("r", "\u5DE5\u5175"), hidden: true };
  const mv = legalMoves(b, idx(0, 0));
  check("\u63ED\u68CB\u6697\u7F6E\u5DE5\u5175\u8D70\u6CD5\u4E0D\u53D8\uFF08\u53EF\u62D0\u5F2F\uFF09", mv.includes(idx(5, 4)) && mv.includes(idx(11, 0)), `${mv.length} \u843D\u70B9`);
  const bh = empty();
  bh[idx(11, 1)] = { ...mk("r", "\u53F8\u4EE4"), hidden: true };
  bh[idx(0, 1)] = mk("b", "\u53F8\u4EE4");
  const bo = empty();
  bo[idx(11, 1)] = mk("r", "\u53F8\u4EE4");
  bo[idx(0, 1)] = mk("b", "\u53F8\u4EE4");
  const evHidden = evaluate(bh, true);
  const evOpen = evaluate(bo, false);
  const expHidden = HIDDEN_VAL - (600 + 15);
  check("\u63ED\u68CB\u6697\u5B50\u6309\u671F\u671B\u503C\u8BC4\u4F30", evOpen === 0 && Math.abs(evHidden - expHidden) < 0.01, `hidden=${evHidden} open=${evOpen} exp=${expHidden}`);
}
console.log("== AI ==");
{
  let legal = true;
  for (let k = 0; k < 8; k++) {
    const b3 = randomBoard();
    const res = findBestMove(b3, "r", 2, "ai", false, 0);
    if (!res.move) {
      legal = false;
      break;
    }
    if (!allJqMoves(b3, "r").some((m) => m.from === res.move.from && m.to === res.move.to)) legal = false;
  }
  check("AI \u8D70\u6CD5\u5168\u90E8\u5408\u6CD5\uFF088 \u5C40\u62BD\u67E5\uFF09", legal);
  const b = randomBoard();
  let turn = "r";
  let plies = 0;
  let ended = false;
  const t0 = Date.now();
  while (plies < 60) {
    if (!hasAnyMove(b, turn)) {
      ended = true;
      break;
    }
    const res = findBestMove(b, turn, 1, "aivai", false, plies);
    if (!res.move) {
      ended = true;
      break;
    }
    const ms = allJqMoves(b, turn);
    if (!ms.some((m) => m.from === res.move.from && m.to === res.move.to)) {
      legal = false;
      break;
    }
    makeJqMove(b, res.move.from, res.move.to);
    turn = turn === "r" ? "b" : "r";
    plies++;
  }
  const dt = Date.now() - t0;
  check("\u7B80\u5355 AI \u4E92\u640F 60 \u624B\u5168\u7A0B\u5408\u6CD5", legal && plies >= 60, `plies=${plies}`);
  check("\u7B80\u5355 AI \u5355\u6B65\u8017\u65F6 < 900ms\uFF0860 \u624B\u5171 " + dt + "ms\uFF09", dt < 54e3);
  const b2 = randomBoard();
  for (const p of b2) if (p) p.hidden = true;
  let t2 = "r";
  let ok2 = true;
  for (let i = 0; i < 20 && hasAnyMove(b2, t2); i++) {
    const res = findBestMove(b2, t2, 2, "ai", true, i);
    if (!res.move) break;
    makeJqMove(b2, res.move.from, res.move.to);
    t2 = t2 === "r" ? "b" : "r";
  }
  check("\u63ED\u68CB AI \u81EA\u5BF9\u5F08 20 \u624B\u4E0D\u5D29", ok2);
}
console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
