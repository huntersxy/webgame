/* ────────────────────────────────────────────────────────────
 *  engine-worker.js — 黑白棋可选引擎：Egaroucid（GPL-3.0）隔离 worker
 *
 *  形态与 public/rapfi/engine-worker.js、public/xqwlight/engine-worker.js 一致：
 *  上游 GPL 代码（egar.js / egar.wasm）原样放在 public/egaroucid/ 下，由这个
 *  独立 worker 加载，**不进本项目的 bundle**，避免 GPL 传染 MIT 主程序。
 *
 *  为什么必须是「模块 worker」：
 *  egar.js 是 Emscripten 的 ES module（`-s EXPORT_ES6=1`），内部用
 *  `import.meta.url` 推导 wasm 路径。动态 import 时 import.meta.url 指向本
 *  文件所在目录，所以 locateFile 能正确解析到同目录的 egar.wasm；
 *  在 classic worker 里 importScripts 它则会直接语法报错，在 Node 里
 *  require 也会失败（`-s ENVIRONMENT=web`），所以只有这一种正确形态。
 *
 *  协议
 *    入：{ type:'init' }                                  → { type:'ready' }
 *        { type:'go', id, board, aiPlayer, level }        → { type:'result', id, move, eval, ms, book }
 *        { type:'quit' }
 *    出：{ type:'ready' } | { type:'result', ... } | { type:'error', id?, data }
 *
 *  棋盘编码（与上游 input_board 对齐）
 *    arr[file + row*8]，row = 0 表示棋谱第 8 行（顶部），与上游位序一致；
 *    -1 = 空、0 = 自己（aiPlayer 一方）、1 = 对手。
 *
 *  着法解码
 *    `_ai_js` 的返回值把「着法 + 分值」打包成一个整数，负分时取模解码不可靠。
 *    因此这里解析引擎自己打印的 `searched policy <坐标> value <分值>`（引擎
 *    在 print 里会输出棋盘与选中着法），把 print/printErr 重定向到缓冲。
 * ──────────────────────────────────────────────────────────── */

/** print / printErr 的缓冲上限（只要够放下最近几条搜索日志） */
const OUT_CAP = 200;

let mod = null;
let initializing = null;
let outBuf = [];
let busy = false;

function post(msg) {
  self.postMessage(msg);
}

function pushOut(text) {
  outBuf.push(String(text));
  if (outBuf.length > OUT_CAP) outBuf.splice(0, outBuf.length - OUT_CAP);
}

/** 初始化引擎（幂等）。失败时把原因回给主线程。 */
function init() {
  if (mod) return Promise.resolve();
  if (initializing) return initializing;
  initializing = (async () => {
    const create = (await import('./egar.js')).default;
    // 把引擎的 stdout/stderr 收进缓冲：既能静音刷屏，又能解析它选定的着法
    const m = await create({ print: pushOut, printErr: pushOut });
    const pctPtr = m._malloc(4);
    const rc = m._init_ai(pctPtr);
    const pct = m.HEAP32[pctPtr >> 2];
    m._free(pctPtr);
    if (rc !== 0 || pct !== 100) throw new Error(`init_ai 返回 ${rc}，进度 ${pct}%`);
    mod = m;
    post({ type: 'ready', memMB: Math.round(m.HEAPU8.buffer.byteLength / 1048576) });
    return null;
  })().catch((err) => {
    initializing = null;
    mod = null;
    post({ type: 'error', data: String((err && err.message) || err) });
    throw err;
  });
  return initializing;
}

/**
 * 走一手。
 * @param {Uint8Array} cells 64 格棋盘（0 空 / 1 黑 / 2 白），index = row*8+x，row 0 = 顶行
 * @param {1|2} aiPlayer 引擎执哪一方
 * @param {number} level Egaroucid 搜索档位
 */
function go(cells, aiPlayer, level) {
  if (!mod) throw new Error('引擎未就绪');

  // ── 棋盘编码（行序与我们一致：row 0 = 棋谱第 8 行）──
  // 结论来自「真相矩阵」实验：8 种对称变换逐一比对 16 个随机局面，
  // 只有恒等变换 16/16 命中，所以这里不做任何镜像。
  const arr = new Int32Array(64).fill(-1);
  for (let i = 0; i < 64; i++) {
    const v = cells[i];
    if (!v) continue;
    const file = i & 7;
    const row = i >> 3;
    arr[file + row * 8] = (v === aiPlayer) ? 0 : 1;
  }

  const ptr = mod._malloc(64 * 4);
  mod.HEAP32.set(arr, ptr >> 2);
  outBuf = [];
  const t0 = Date.now();
  let res = 0;
  try {
    res = mod._ai_js(ptr, level, 0);
  } finally {
    mod._free(ptr);
  }
  const ms = Date.now() - t0;
  const text = outBuf.join(String.fromCharCode(10));

  // ── 着法解析 ──
  // 引擎自己会把选定着法打印成人类可读坐标（这是最稳的来源）：
  //   searched policy c7 value 37      ← 常规
  //   book c4 0                        ← 命中开局谱
  //   mainsearch depth 6 value 39 policy c3
  // 打包整数 output_coord 的反解容易在负分/边界上出错，因此以文本为准。
  let name = null;
  let score = 0;
  let m = text.match(/searched policy\s+([a-h][1-8])\s+value\s+(-?\d+)/i);
  if (!m) m = text.match(/book\s+([a-h][1-8])\s+(-?\d+)/i);
  if (!m) m = text.match(/mainsearch depth \d+ value (-?\d+) policy ([a-h][1-8])/i);
  if (m) {
    if (/^[a-h][1-8]$/i.test(m[1])) { name = m[1].toLowerCase(); score = Number(m[2]); }
    else { score = Number(m[1]); name = m[2].toLowerCase(); }
  }
  if (!name) {
    throw new Error(`无法从引擎输出解析着法：${text.slice(-240)}`);
  }
  const file = name.charCodeAt(0) - 97;      // a=0..h=7
  const rank = Number(name[1]);              // 1..8（引擎打印的棋谱行号）
  // 只回传坐标：坐标 → 我们的索引这一步由客户端按「真相矩阵」标定结果做。
  // （早期把反解写死在这里，正是坐标口径两次出错的地方。）
  const index = (8 - rank) * 8 + file;       // 缺省恒等映射；客户端可用 coord 覆盖
  const evaluation = Number.isFinite(score) ? score : 0;
  const book = text.split(String.fromCharCode(10)).some((line) => /^\s*book\s+[a-h][1-8]/i.test(line));
  return { move: index, coord: { file, rank }, eval: evaluation, ms, book };
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    init().catch(() => undefined);
    return;
  }
  if (msg.type === 'go') {
    // 串行化：Egaroucid 是同步搜索，并发调用会互相踩内存
    if (busy) {
      post({ type: 'error', id: msg.id, data: '引擎正忙（上一次搜索未结束）' });
      return;
    }
    busy = true;
    (async () => {
      try {
        await init();
        const r = go(msg.board, msg.aiPlayer, msg.level);
        post({ type: 'result', id: msg.id, ...r });
      } catch (err) {
        post({ type: 'error', id: msg.id, data: String((err && err.message) || err) });
      } finally {
        busy = false;
      }
    })();
    return;
  }
  if (msg.type === 'quit') {
    self.close();
  }
};
