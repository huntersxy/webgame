/* ────────────────────────────────────────────────────────────
 *  tests/rapfi.test.cjs — Node smoke test for the Rapfi WASM engine
 *  (public/rapfi/). No bundler needed: the emscripten glue is plain
 *  CommonJS-compatible UMD; we shim the browser-ish globals it probes.
 *
 *  Validates the exact integration contract used by src/gomoku/rapfi.ts:
 *  INFO settings, START 15, INFO TIME_LEFT, YXBOARD + YXNBEST, bare "x,y".
 * ──────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');

const RAPFI_DIR = path.join(__dirname, '..', 'public', 'rapfi');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail !== undefined ? `(${detail})` : ''); }
}

// ── browser-ish shims (must be installed before the glue is required) ──
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = { currentScript: null };
globalThis.location = { href: 'http://localhost/rapfi/t.html', pathname: '/rapfi/t.html' };
globalThis.XMLHttpRequest = function () {
  const st = { readyState: 0, status: 0, response: null, responseText: '', responseType: '' };
  st.open = (m, url) => { st._url = String(url); };
  st.setRequestHeader = () => {};
  st.overrideMimeType = () => {};
  st.getAllResponseHeaders = () => '';
  st.abort = () => {};
  st.send = () => {
    let buf;
    try { buf = fs.readFileSync(path.join(RAPFI_DIR, path.basename(st._url))); }
    catch { st.status = 404; if (st.onerror) st.onerror(); return; }
    st.status = 200; st.readyState = 4;
    if (st.responseType === 'arraybuffer') st.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    st.responseText = buf.toString('latin1');
    if (st.onload) st.onload();
  };
  return st;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MATE_SCALE = 100000;

function parseEval(tok) {
  const m = /^([+-]?)M(\d+)$/i.exec(String(tok).trim());
  if (m) { const v = MATE_SCALE - parseInt(m[2], 10); return m[1] === '-' ? -v : v; }
  const n = parseInt(tok, 10);
  return Number.isFinite(n) ? n : 0;
}

class Parser {
  constructor() { this.blocks = []; this.cur = null; this.move = null; }
  feed(raw) {
    const line = String(raw).trim();
    if (!line) return;
    if (/^\d+,\d+$/.test(line)) { const [x, y] = line.split(',').map(Number); this.move = { x, y }; return; }
    const m = /^INFO\s+(.+)$/.exec(line);
    if (!m) return;
    const parts = m[1].split(/\s+/);
    const head = parts[0], tail = parts.slice(1).join(' ');
    if (head === 'PV' && tail === 'DONE') {
      if (this.cur && this.cur.line.length) this.blocks.push(this.cur);
      this.cur = null;
    } else if (head === 'PV') {
      this.cur = { pv: parseInt(tail, 10) || 0, eval: this.cur ? this.cur.eval : 0, depth: 0, nodes: 0, line: [] };
    } else if (head === 'EVAL') {
      if (!this.cur) this.cur = { pv: 0, eval: 0, depth: 0, nodes: 0, line: [] };
      this.cur.eval = parseEval(tail);
    } else if (head === 'DEPTH' && this.cur) {
      this.cur.depth = Math.max(this.cur.depth, parseInt(tail, 10) || 0);
    } else if ((head === 'NODES' || head === 'TOTALNODES') && this.cur) {
      this.cur.nodes = parseInt(tail, 10) || 0;
    } else if (head === 'BESTLINE' && this.cur) {
      this.cur.line = tail.split(/\s+/).filter((s) => /^\d+,\d+$/.test(s));
    }
  }
}

async function loadEngine() {
  // The glue is UMD; package.json sets "type":"module" so require() of .js
  // would treat it as ESM. Load it as a classic script body instead (this
  // matches how importScripts() exposes `Rapfi` in the real worker).
  const src = fs.readFileSync(path.join(RAPFI_DIR, 'rapfi-single.js'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', src)(mod, mod.exports, require, __dirname);
  const Rapfi = mod.exports.default || mod.exports;
  const wasmBytes = fs.readFileSync(path.join(RAPFI_DIR, 'rapfi-single.wasm'));
  const lines = [];
  let move = null;
  let onLine = null;
  const engine = await Rapfi({
    locateFile: (f) => (/\.data$/.test(f) ? path.join(RAPFI_DIR, 'rapfi.data') : path.join(RAPFI_DIR, f)),
    instantiateWasm: (info, recv) => WebAssembly.instantiate(wasmBytes, info).then((r) => recv(r.instance)),
    onReceiveStdout: (o) => { const s = String(o).trim(); if (!s) return; if (/^(\d+),(\d+)$/.test(s)) { const [, a, b] = s.match(/^(\d+),(\d+)$/); move = { x: +a, y: +b }; return; } if (onLine) onLine(s); },
    onReceiveStderr: () => {},
    onExit: () => {},
    setStatus: () => {},
  });
  return { engine, lines, getMove: () => move, resetMove: () => { move = null; }, setOnLine: (f) => { onLine = f; } };
}

function setupCmds(engine, turnMs, strength) {
  engine.sendCommand('INFO RULE 0');
  engine.sendCommand('INFO THREAD_NUM 1');
  engine.sendCommand('INFO CAUTION_FACTOR 1');
  engine.sendCommand('INFO STRENGTH ' + strength);
  engine.sendCommand('INFO TIMEOUT_TURN ' + turnMs);
  engine.sendCommand('INFO TIMEOUT_MATCH 100000000');
  engine.sendCommand('INFO MAX_DEPTH 99');
  engine.sendCommand('INFO MAX_NODE 0');
  engine.sendCommand('INFO SHOW_DETAIL 3');
  engine.sendCommand('INFO PONDERING 0');
  engine.sendCommand('INFO SWAPABLE 0');
  engine.sendCommand('START 15');
  engine.sendCommand('INFO TIME_LEFT 100000000');
}

async function run() {
  console.log('▶ rapfi wasm smoke test');
  check('engine files exist', fs.existsSync(path.join(RAPFI_DIR, 'rapfi-single.js')) && fs.existsSync(path.join(RAPFI_DIR, 'rapfi.data')));

  const eng = await loadEngine();
  const cmd = (c) => eng.engine.sendCommand(c);

  // 1) empty board → center
  eng.resetMove();
  setupCmds(eng.engine, 500, 100);
  let t0 = Date.now();
  cmd('YXBOARD DONE');
  cmd('YXNBEST 1');
  while (!eng.getMove() && Date.now() - t0 < 5000) await sleep(10);
  const mv1 = eng.getMove();
  check('empty board returns 7,7', !!mv1 && mv1.x === 7 && mv1.y === 7, JSON.stringify(mv1));

  // 2) midgame position, engine as WHITE (first stone typed 2 = OPPO)
  //    stones: black (8,8),(6,8),(9,9) ; white (7,7),(7,9),(8,7) → white to move
  const parser = new Parser();
  eng.setOnLine((l) => parser.feed(l));
  eng.resetMove();
  setupCmds(eng.engine, 700, 100);
  t0 = Date.now();
  cmd('YXBOARD 8,8,2 7,7,2 6,8,2 7,9,1 8,7,1 9,9,1 DONE');
  cmd('YXNBEST 1');
  while (!eng.getMove() && Date.now() - t0 < 8000) await sleep(10);
  const mv2 = eng.getMove();
  check('midgame returns a move within budget', !!mv2 && Date.now() - t0 < 700 + 2500, JSON.stringify(mv2));
  check('move is on an empty cell', !!mv2 && ![8, 8, 7, 7, 6, 8, 7, 9, 8, 7, 9, 9].some((v, i, a) => i % 2 === 0 && a[i] === mv2.x && a[i + 1] === mv2.y));

  // 2b) quiet position must produce a NON-ZERO evaluation — guards against a
  //     broken data package (engine silently running a zero evaluator).
  {
    eng.resetMove();
    const pEval = new Parser();
    eng.setOnLine((l) => pEval.feed(l));
    setupCmds(eng.engine, 500, 100);
    t0 = Date.now();
    cmd('YXBOARD 7,7,1 8,8,1 3,11,2 12,3,2 DONE');
    cmd('YXNBEST 1');
    while (!eng.getMove() && Date.now() - t0 < 500 + 2500) await sleep(10);
    const last = pEval.blocks[pEval.blocks.length - 1];
    check('mix9svq evaluator active (non-zero eval)', !!last && last.eval !== 0, JSON.stringify(last && last.eval));
  }

  // 3) STRENGTH low → finishes fast (capped search)
  eng.resetMove();
  const p2 = new Parser();
  eng.setOnLine((l) => p2.feed(l));
  setupCmds(eng.engine, 300, 15);
  t0 = Date.now();
  cmd('YXBOARD 8,8,2 7,7,2 6,8,2 7,9,1 8,7,1 9,9,1 DONE');
  cmd('YXNBEST 1');
  while (!eng.getMove() && Date.now() - t0 < 4000) await sleep(10);
  const mv3 = eng.getMove();
  check('strength-limited move completes', !!mv3 && Date.now() - t0 < 4000, JSON.stringify(mv3));

  // 4) forced-win detection in same session (persistence across searches)
  //    black to move with an open three → engine should see a strong plan
  eng.resetMove();
  const p3 = new Parser();
  eng.setOnLine((l) => p3feed(l, p3));
  setupCmds(eng.engine, 900, 100);
  t0 = Date.now();
  // engine = black (even stones, first typed 1 = SELF)
  cmd('YXBOARD 7,7,1 8,8,2 7,9,1 8,6,2 6,8,1 9,7,2 DONE');
  cmd('YXNBEST 1');
  while (!eng.getMove() && Date.now() - t0 < 900 + 2500) await sleep(10);
  const mv4 = eng.getMove();
  const lastBlock = p3.blocks[p3.blocks.length - 1];
  check('session persists across searches', !!mv4, JSON.stringify(mv4));
  check('depth/nodes parsed from INFO', !!lastBlock && lastBlock.depth > 0 && lastBlock.nodes > 0, JSON.stringify(lastBlock));
  check('mate evals map to UI scale', !lastBlock || lastBlock.eval <= MATE_SCALE, JSON.stringify(lastBlock && lastBlock.eval));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function p3feed(line, parser) { parser.feed(line); }

run().catch((e) => { console.error('FAIL', e); process.exit(1); });
