/* ────────────────────────────────────────────────────────────
 *  scripts/tornado-smoke.mjs — 《龙卷风牧场》浏览器冒烟（30s 预算）
 *
 *  这一页跑的是原作 Flash 游戏本体，由自托管的 Ruffle 解释执行。
 *  本脚本确认「访客不需要装 Flash 也能玩」这件事真的成立：
 *    1. 播放器元素挂载、SWF 被载入并进入渲染
 *    2. ruffle.js / .wasm / .swf 都从本站取到（不是第三方 CDN）
 *    3. 舞台画面有实际内容（不是空白或纯色）
 *    4. 点击能推进画面（证明输入真的传进了游戏）
 *    5. 全程无未捕获异常
 *
 *  ── 为什么要自己起服务器 ──
 *  原先依赖外部的 `npm run preview`：忘了起就会在「等播放器」上白等 90 秒，
 *  表现成「脚本卡死」。现在脚本自己起一个只读静态服务器指向 dist/，
 *  跑完关掉，不依赖任何外部进程。
 *
 *  ── 为什么能在 30s 内跑完 ──
 *  ① 顶部硬看门狗：无论卡在哪一步，30s 必定收口并返回失败；
 *  ② 所有等待都是「有条件轮询 + 短间隔」，就绪即返回，
 *     不再是 sleep(1000)/sleep(4500) 这种固定空耗；
 *  ③ 每步上限之和 < 看门狗，最坏情况也是失败而不是挂起。
 *
 *  像素判定走截图解码（scripts/png.mjs），而不是在页面里 drawImage：
 *  Ruffle 的 canvas 是 WebGL2 且未开 preserveDrawingBuffer，绘制缓冲在合成后
 *  即失效，drawImage 读回来恒为全透明。
 *
 *  用法：node scripts/tornado-smoke.mjs [url]
 *        不带参数 = 自己起服务器（推荐）；带 url = 用你指定的地址
 *  退出码 0 = 全部通过。
 * ──────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, imageStats, diffRatio } from './png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.tmp', 'shots-tornado');
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9541;
const BUDGET_MS = 30_000;

/* ── 硬看门狗：整个脚本的预算是 30s，到点必收口 ──
   unref() 让定时器本身不拖住事件循环；正常跑完会 clearTimeout。 */
const watchdog = setTimeout(() => {
  console.error(`\nFAIL  超过 ${BUDGET_MS / 1000}s 预算，强制收口`);
  cleanup();
  process.exit(1);
}, BUDGET_MS);
watchdog.unref?.();

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

let pass = 0;
let fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; console.log(`  ok  ${n}   [${since()}]`); }
  else { fail++; console.log(`FAIL  ${n}${e ? `  ${e}` : ''}   [${since()}]`); }
};

/* ── 只读静态服务器（指向 dist/），带正确的 wasm MIME ── */
const MIME = {
  '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.swf': 'application/x-shockwave-flash',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
};
let server = null;
let edge = null;
let profile = null;

function cleanup() {
  try { server?.close(); } catch { /* 已关 */ }
  try { edge?.kill(); } catch { /* 已退 */ }
  try { if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 偶发占用 */ }
}

/** 起服务器；dist 不存在则直接用 vite preview 也没意义，直接判失败 */
async function startServer() {
  if (!existsSync(DIST)) {
    console.error(`FAIL  dist/ 不存在，先跑 npm run build   [${since()}]`);
    process.exit(1);
  }
  server = createServer(async (req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    try {
      const body = await readFile(join(DIST, normalize(p).replace(/^(\.\.[/\\])+/, '')));
      res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('404');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

let id = 0;
function rpc(ws, method, params = {}, timeout = 8000) {   // 单个调用 8s 上限，卡住立刻暴露
  return new Promise((res, rej) => {
    const mid = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== mid) return;
      ws.removeEventListener('message', onMsg);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => rej(new Error(`${method} timeout`)), timeout);
  });
}

/** 轮询直到条件成立；间隔 150ms，到 deadline 仍未成立就返回最后一次值 */
async function until(fn, deadlineMs, intervalMs = 150) {
  const end = Date.now() + deadlineMs;
  let val;
  for (;;) {
    val = await fn();
    if (val) return val;
    if (Date.now() >= end) return val;
    await sleep(intervalMs);
  }
}

const requested = [];
const errors = [];

try {
  const base = process.argv[2] || (await startServer());
  console.log(`服务器 ${base}   [${since()}]`);

  profile = mkdtempSync(join(tmpdir(), 'tornado-smoke-'));
  edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,1000', '--force-device-scale-factor=1', `${base}/#/tornado`,
  ], { stdio: 'ignore' });

  const wsUrl = await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl || null;
    } catch { return null; }
  }, 8000);
  if (!wsUrl) throw new Error('CDP 未就绪');
  console.log(`CDP 就绪   [${since()}]`);

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    if (m.method === 'Network.responseReceived') requested.push({ url: m.params.response.url, status: m.params.response.status, type: m.params.type });
  });
  // 页面刚被 Edge 打开时可能还在导航，此时发 CDP 命令会得到
  // "Not attached to an active page"。先等页面进入可 attach 状态，
  // 再开各域；这是等待条件成立，不是把失败重试掉。
  await until(async () => {
    try {
      const r = await rpc(ws, 'Runtime.evaluate', { expression: '1', returnByValue: true }, 1500);
      return r?.result?.value === 1;
    } catch { return false; }
  }, 8000, 200);
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Log.enable');
  await rpc(ws, 'Network.enable');
  await rpc(ws, 'Page.enable');

  const ev = async (expr) => {
    const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  /**
   * 截取舞台区域并解码成 RGBA（截图为设备像素，box 为 CSS 像素）。
   *
   * Page.captureScreenshot 在 headless Chromium 下**偶发永久挂起**（Chromium
   * issue 40219957「screenshot hangs」、Puppeteer 同类报告），尤其在页面刚
   * 开始渲染 WebGL 画布的瞬间。这一次调用废掉之后重开通常就正常，所以这里
   * 给一个有界重试（2 次），而不是把超时放大——放大只会让失败更慢。
   */
  const capturePng = async () => {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const s = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, 4000);
        return Buffer.from(s.data, 'base64');
      } catch (err) {
        lastErr = err;
        await sleep(200);
      }
    }
    throw lastErr;
  };

  const stageShot = async (name, box) => {
    const png = await capturePng();
    if (name) writeFileSync(join(OUT, `${name}.png`), png);
    const full = decodePng(png);
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.min(full.width - x, Math.round(box.w));
    const h = Math.min(full.height - y, Math.round(box.h));
    if (w <= 0 || h <= 0) throw new Error(`舞台区域无效 ${JSON.stringify(box)} 截图=${full.width}x${full.height}`);
    const data = Buffer.alloc(w * h * 4);
    for (let row = 0; row < h; row++) {
      full.data.copy(data, row * w * 4, ((y + row) * full.width + x) * 4, ((y + row) * full.width + x + w) * 4);
    }
    return { width: w, height: h, data };
  };

  console.log('== Flash 播放器装配 ==');
  // 首次进入要取约 3.8MB 的 SIMD 内核并初始化；轮询到就绪即走，不等满
  const mounted = await until(() => ev(`!!document.querySelector('#t-stage ruffle-player')`), 9000);
  check('播放器元素已挂载到舞台', mounted);
  if (!mounted) throw new Error('播放器未挂载，后续检查无意义');

  // 状态行清空 = SWF 载入完成（控制器在载入后清）。
  // 注意 until 的语义是「直到返回真值」：这里要返回的「真」是「已经空了」，
  // 所以清空时返回 true，未清空时返回 false 继续等——反过来写会在第一次
  // 轮询（状态还是「正在载入游戏…」）时就当成满足条件而退出。
  let lastStatus = '';
  const cleared = await until(async () => {
    lastStatus = await ev(`(() => { const s = document.getElementById('t-status'); return s && !s.classList.contains('hidden') ? s.textContent : ''; })()`);
    return lastStatus === '';
  }, 8000);
  check('加载状态已清空（游戏已就绪）', cleared === true, `status="${lastStatus}"`);

  // 取舞台矩形本身也要轮询：状态行清空与元素在 DOM 里是两件独立的事，
  // 不能假定前者成立时后者一定就位（实测有一轮在 1.9s 读到 null）。
  let box = null;
  await until(async () => {
    box = await ev(`(() => {
      const p = document.querySelector('#t-stage ruffle-player');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return r.width > 0 ? JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }) : null;
    })()`).then((s) => (s ? JSON.parse(s) : null)).catch(() => null);
    return box !== null;
  }, 5000);
  if (!box) throw new Error('舞台元素始终未就位');
  check('舞台按 4:3 呈现', Math.abs(box.w / box.h - 4 / 3) < 0.05, JSON.stringify(box));

  console.log('== 画面内容 ==');
  // 画面渐显需要几帧，轮询到有内容即返回
  let title = await stageShot('01-title', box);
  let stats = imageStats(title);
  await until(async () => {
    title = await stageShot(null, box);
    stats = imageStats(title);
    return stats.opaque > title.width * title.height * 0.5 && stats.distinct > 24;
  }, 5000);
  check('舞台画面非空白', stats.opaque > title.width * title.height * 0.5, `opaque=${stats.opaque}/${stats.total}`);
  check('画面有层次（不是纯色块）', stats.distinct > 24 && stats.dominantRatio < 0.9,
    `distinct=${stats.distinct} dominant=${(stats.dominantRatio * 100).toFixed(1)}% mean=${stats.mean.toFixed(1)}`);

  console.log('== 资源来自本站 ==');
  // 三个关键资源各自等它的响应到达再判定。不能假定「画面出来了 ⇒ 所有请求都已
  // 记录」：ruffle.js 与画面渲染是并行的，先到先记，固定顺序读数组会偶发扑空
  // （实测同一脚本两次运行，一次 2.9s 抓到、一次 1.8s 读成空数组）。
  const seen = (re) => requested.filter((r) => re.test(r.url) && r.status === 200);
  const gotRuffleJs = await until(() => seen(/\/ruffle\/ruffle\.js/).length > 0, 3000);
  const ruffleJs = seen(/\/ruffle\/ruffle\.js/);
  const gotWasm = await until(() => seen(/\/ruffle\/[0-9a-f]{20}\.wasm/).length > 0, 3000);
  const wasm = seen(/\/ruffle\/[0-9a-f]{20}\.wasm/);
  const gotSwf = await until(() => seen(/\/games\/tornado-ranch\/game\.swf/).length > 0, 3000);
  const swf = seen(/\/games\/tornado-ranch\/game\.swf/);
  // 「第三方」= 不是本站、也不是浏览器/系统自身发起的请求。
  // 本机装有 Kaspersky 且开着「加密连接扫描」，它会往页面注入一条
  // *.kaspersky-labs.com 的探针请求；那是杀软的中间人行为，不是页面发起的，
  // 不排除掉会让这条检查在本机永远失败、在 CI 上却通过。
  const INJECTED = /kaspersky-labs\.com|kaspersky\.com/i;
  const foreign = requested.filter((r) =>
    r.type !== 'other' && !r.url.startsWith(base) && !/^data:|^blob:/.test(r.url) && !INJECTED.test(r.url));
  check('ruffle.js 已加载', gotRuffleJs === true, JSON.stringify(ruffleJs));
  check('Flash 内核 .wasm 已加载', gotWasm === true, JSON.stringify(wasm));
  check('游戏本体 SWF 已加载', gotSwf === true, JSON.stringify(swf));
  check('没有依赖第三方站点', foreign.length === 0, JSON.stringify(foreign.map((r) => r.url)));

  console.log('== 交互 ==');
  // 点舞台中央偏下（原作标题页「开始游戏」的位置），确认输入真的进了游戏
  const x = Math.round(box.x + box.w * 0.5);
  const y = Math.round(box.y + box.h * 0.82);
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  // 轮询到画面变化即算通过，不等固定 4.5s
  let changed = 0;
  await until(async () => {
    const after = await stageShot(null, box);
    changed = diffRatio(title, after, 12);
    return changed > 0.02;
  }, 6000);
  await stageShot('02-after-click', box);
  check('点击后画面发生变化（输入已进入游戏）', changed > 0.02, `changed=${(changed * 100).toFixed(1)}%`);

  console.log('== 控制台 ==');
  // 缺少设备字体（Arial）会让 Ruffle 打警告但不影响运行；只看真正的异常
  const fatal = errors.filter((e) => !/Failed to load resource: the server responded with a status of 404/.test(e));
  check('无未捕获异常', fatal.length === 0, fatal.slice(0, 3).join(' | '));

  ws.close();
} catch (err) {
  fail++;
  console.log(`FAIL  冒烟脚本异常  ${err?.stack ?? err}   [${since()}]`);
} finally {
  clearTimeout(watchdog);
  cleanup();
}

console.log(`\n${pass} 通过 / ${fail} 失败   用时 ${since()}`);
process.exit(fail === 0 ? 0 : 1);
