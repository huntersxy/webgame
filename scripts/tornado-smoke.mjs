/* ────────────────────────────────────────────────────────────
 *  scripts/tornado-smoke.mjs — 《龙卷风牧场》浏览器冒烟
 *
 *  这一页跑的是原作 Flash 游戏本体，由自托管的 Ruffle 解释执行。
 *  本脚本确认「访客不需要装 Flash 也能玩」这件事真的成立：
 *    1. 播放器元素挂载、SWF 被载入并进入渲染
 *    2. ruffle.js / .wasm / .swf 都从本站取到（不是第三方 CDN）
 *    3. 舞台画面有实际内容（不是空白或纯色）
 *    4. 点击能推进画面（证明输入真的传进了游戏）
 *    5. 全程无未捕获异常
 *
 *  像素判定走截图解码（scripts/png.mjs），而不是在页面里 drawImage：
 *  Ruffle 的 canvas 是 WebGL2 且未开 preserveDrawingBuffer，绘制缓冲在合成后
 *  即失效，drawImage 读回来恒为全透明。
 *
 *  零依赖：直接起 headless Edge，用 CDP（Node 内置 WebSocket）驱动页面。
 *
 *  用法：node scripts/tornado-smoke.mjs [url]
 *        （默认 http://localhost:4173，即 npm run preview）
 *  退出码 0 = 全部通过。
 * ──────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, imageStats, diffRatio } from './png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.argv[2] || 'http://localhost:4173';
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9541;
const OUT = join(ROOT, '.tmp', 'shots-tornado');
mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'tornado-smoke-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,1000', '--force-device-scale-factor=1', `${URL_}/#/tornado`,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

let id = 0;
function rpc(ws, method, params = {}, timeout = 60000) {
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

let pass = 0;
let fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? `  ${e}` : ''}`); }
};

try {
  const ws = new WebSocket(await target());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  const errors = [];
  const requested = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    if (m.method === 'Network.responseReceived') requested.push({ url: m.params.response.url, status: m.params.response.status, type: m.params.type });
  });
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Log.enable');
  await rpc(ws, 'Network.enable');
  await rpc(ws, 'Page.enable');

  const ev = async (expr) => {
    const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  /** 截取舞台区域并解码成 RGBA（截图为设备像素，box 为 CSS 像素） */
  const stageShot = async (name, box) => {
    const s = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(s.data, 'base64');
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
  // 首次进入要下载约 3.8MB 的 SIMD 内核并初始化，给足时间
  let mounted = false;
  for (let i = 0; i < 90; i++) {
    mounted = await ev(`!!document.querySelector('#t-stage ruffle-player')`);
    if (mounted) break;
    await sleep(1000);
  }
  check('播放器元素已挂载到舞台', mounted);
  if (!mounted) throw new Error('播放器未挂载，后续检查无意义');

  // 等状态行清空（控制器在 SWF 载入完成后才清）
  let statusText = '（未清空）';
  for (let i = 0; i < 60; i++) {
    statusText = await ev(`(() => { const s = document.getElementById('t-status'); return s && !s.classList.contains('hidden') ? s.textContent : ''; })()`);
    if (!statusText) break;
    await sleep(1000);
  }
  check('加载状态已清空（游戏已就绪）', statusText === '', `status="${statusText}"`);

  const box = JSON.parse(await ev(`(() => {
    const r = document.querySelector('#t-stage ruffle-player').getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
  })()`));
  check('舞台按 4:3 呈现', Math.abs(box.w / box.h - 4 / 3) < 0.05, JSON.stringify(box));

  console.log('== 画面内容 ==');
  // 画面渐显需要几帧，轮询到有内容为止
  let stats = null;
  let title = null;
  for (let i = 0; i < 40; i++) {
    title = await stageShot(i === 0 ? '01-title' : null, box);
    stats = imageStats(title);
    if (stats.opaque > title.width * title.height * 0.5 && stats.distinct > 24) break;
    await sleep(700);
  }
  check('舞台画面非空白', stats.opaque > title.width * title.height * 0.5, `opaque=${stats.opaque}/${stats.total}`);
  check('画面有层次（不是纯色块）', stats.distinct > 24 && stats.dominantRatio < 0.9,
    `distinct=${stats.distinct} dominant=${(stats.dominantRatio * 100).toFixed(1)}% mean=${stats.mean.toFixed(1)}`);

  console.log('== 资源来自本站 ==');
  const ruffleJs = requested.filter((r) => /\/ruffle\/ruffle\.js/.test(r.url));
  const wasm = requested.filter((r) => /\/ruffle\/[0-9a-f]{20}\.wasm/.test(r.url));
  const swf = requested.filter((r) => /\/games\/tornado-ranch\/game\.swf/.test(r.url));
  const foreign = requested.filter((r) => r.type !== 'other' && !r.url.startsWith(URL_) && !/^data:|^blob:/.test(r.url));
  check('ruffle.js 已加载', ruffleJs.length > 0 && ruffleJs[0].status === 200, JSON.stringify(ruffleJs));
  check('Flash 内核 .wasm 已加载', wasm.length > 0 && wasm[0].status === 200, JSON.stringify(wasm));
  check('游戏本体 SWF 已加载', swf.length > 0 && swf[0].status === 200, JSON.stringify(swf));
  check('没有依赖第三方站点', foreign.length === 0, JSON.stringify(foreign.map((r) => r.url)));

  console.log('== 交互 ==');
  // 点舞台中央偏下（原作标题页「开始游戏」的位置），确认输入真的进了游戏
  const clickAt = async (fx, fy) => {
    const x = Math.round(box.x + box.w * fx);
    const y = Math.round(box.y + box.h * fy);
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  };
  await clickAt(0.5, 0.82);
  await sleep(4500);
  const after = await stageShot('02-after-click', box);
  const changed = diffRatio(title, after, 12);
  check('点击后画面发生变化（输入已进入游戏）', changed > 0.02, `changed=${(changed * 100).toFixed(1)}%`);

  console.log('== 控制台 ==');
  // 缺少设备字体（Arial）会让 Ruffle 打警告但不影响运行；只看真正的异常
  const fatal = errors.filter((e) => !/Failed to load resource: the server responded with a status of 404/.test(e));
  check('无未捕获异常', fatal.length === 0, fatal.slice(0, 3).join(' | '));
} catch (err) {
  fail++;
  console.log(`FAIL  冒烟脚本异常  ${err?.stack ?? err}`);
} finally {
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows 偶发占用 */ }
  edge.kill();
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
