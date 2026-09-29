/* ────────────────────────────────────────────────────────────
 *  scripts/sol-monitor.mjs — 监控《龙卷风牧场》的存档写入
 *
 *  用途：打开真实浏览器，把 Ruffle/游戏对 localStorage 的每一次读写
 *  都打到控制台，并定期汇总。玩家玩到某个节点（过关、点清除记录、
 *  回菜单）后，把控制台输出整段复制回来即可定位存档时机。
 *
 *  为什么需要它：这个游戏的存档不是「随便玩一会儿就写」，而是绑在
 *  4399 站点对接流程上。靠盲玩猜时机效率太低，直接把写入时刻抓出来。
 *
 *  它监控什么：
 *    · CDP DOMStorage 域：localStorage 的新增/更新/删除/清空（最底层，
 *      任何来源的写入都逃不掉，包括 WASM 里的 Ruffle）
 *    · IndexedDB 的库与对象仓变化
 *    · 页面 console 里 Ruffle 的存档相关日志
 *
 *  用法：
 *    node scripts/sol-monitor.mjs            # 无头，自动打开游戏页
 *    node scripts/sol-monitor.mjs --show     # 带窗口（可见），自己玩
 *    node scripts/sol-monitor.mjs --show 90  # 带窗口，90 秒后自动收尾
 *
 *  退出时会打印一段可直接复制的汇总。
 * ──────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.tmp', 'sol-monitor');
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP = 9620;

const args = process.argv.slice(2);
const SHOW = args.includes('--show');
const LIMIT_S = Number(args.find((a) => /^\d+$/.test(a)) || 0);

mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.swf': 'application/x-shockwave-flash',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  try {
    const body = await readFile(join(DIST, normalize(p).replace(/^(\.\.[/\\])+/, '')));
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('404'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ── 日志收集 ── */
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const events = [];      // 结构化事件
const consoleLines = []; // 页面 console

function log(kind, detail) {
  const line = `[${stamp()}] ${kind}  ${detail}`;
  console.log(line);
  events.push({ at: stamp(), kind, detail });
}

console.log('════════════════════════════════════════════════════');
console.log(' 龙卷风牧场 · 存档写入监控');
console.log('════════════════════════════════════════════════════');
console.log(` 站点: ${base}`);
if (SHOW) console.log(' 模式: 带窗口 —— 请在弹出的浏览器里正常游玩');
else console.log(' 模式: 无头 —— 需要你自己看日志');
if (LIMIT_S) console.log(` 时长: ${LIMIT_S} 秒后自动收尾`);
console.log(' 提示: 请重点尝试  打完一关 / 点选关页「清除记录」/ ESC 回菜单');
console.log('════════════════════════════════════════════════════\n');

const profile = mkdtempSync(join(tmpdir(), 'sol-monitor-'));
const edgeArgs = [
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1100,900',
  `${base}/#/tornado`,
];
if (!SHOW) edgeArgs.unshift('--headless=new');
edgeArgs.unshift(EDGE);
// 保留一份可见窗口的尺寸与位置，方便玩家操作
if (SHOW) { edgeArgs.splice(1, 0, '--window-position=80,60'); }

const edge = spawn(edgeArgs[0], edgeArgs.slice(1), { stdio: SHOW ? 'inherit' : 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

let id = 0;
const rpc = (ws, method, params = {}, timeout = 20000) => new Promise((res, rej) => {
  const mid = ++id;
  const on = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== mid) return;
    ws.removeEventListener('message', on);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id: mid, method, params }));
  setTimeout(() => rej(new Error(`${method} timeout`)), timeout);
});

const ws = new WebSocket(await cdpUrl());
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

/* ── 监听所有存储事件 ── */
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);

  // localStorage 事件（DOMStorage 域，底层，WASM 写入也能抓到）
  if (m.method === 'DOMStorage.domStorageItemAdded') {
    const p = m.params; log('LS 新增', `${p.key}  (${(p.newValue || '').length}B)`);
  }
  if (m.method === 'DOMStorage.domStorageItemUpdated') {
    const p = m.params; log('LS 更新', `${p.key}  (${(p.newValue || '').length}B)`);
  }
  if (m.method === 'DOMStorage.domStorageItemRemoved') {
    log('LS 删除', `${m.params.key}`);
  }
  if (m.method === 'DOMStorage.domStorageItemsCleared') {
    log('LS 清空', JSON.stringify(m.params.storageId || {}));
  }

  // IndexedDB（Ruffle 若走 IDB，这里会出现）
  if (m.method === 'IndexedDB.databaseCreated' || m.method === 'IndexedDB.databaseUpdated' || m.method === 'IndexedDB.databaseDeleted') {
    log('IDB', `${m.method.replace('IndexedDB.', '')}  ${m.params.databaseName}`);
  }

  // 导航 / 生命周期（对应 Ruffle 的 flush 时机）
  if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
    log('导航', m.params.frame.url);
  }
  if (m.method === 'Page.lifecycleEvent' && ['load', 'DOMContentLoaded', 'freeze'].includes(m.params.name)) {
    log('生命周期', m.params.name);
  }

  // 页面 console
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    consoleLines.push(`[${stamp()}] ${text}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const text = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text;
    consoleLines.push(`[${stamp()}] [异常] ${text}`);
    if (/storage|shared|sol|save/i.test(text)) log('异常', String(text).slice(0, 200));
  }
});

await rpc(ws, 'Runtime.enable');
await rpc(ws, 'Page.enable');
await rpc(ws, 'DOMStorage.enable').catch(() => log('提示', 'DOMStorage 域不可用，改用轮询'));

/* ── 轮询：每隔 2s 快照一次 localStorage（兜底，防止事件漏报）── */
const ev = async (x) => (await rpc(ws, 'Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;

const snapshot = async () => {
  try {
    const raw = await ev(`(()=>{const o=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);o.push(k+'|'+(localStorage.getItem(k)||'').length);}return JSON.stringify(o);})()`);
    return JSON.parse(raw || '[]');
  } catch { return null; }
};

let lastSnap = JSON.stringify(await snapshot() || []);
log('初始快照', lastSnap);
console.log('\n（保持这个窗口开着，去玩游戏；下面会持续打印变化）\n');

let pollCount = 0;
const poll = setInterval(async () => {
  pollCount++;
  const s = await snapshot();
  if (s === null) return;
  const str = JSON.stringify(s);
  if (str !== lastSnap) {
    const before = JSON.parse(lastSnap);
    const added = s.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !s.includes(x));
    if (added.length) log('轮询发现新增', JSON.stringify(added));
    if (removed.length) log('轮询发现消失', JSON.stringify(removed));
    lastSnap = str;
  }
  // 每 15 次（约 30s）打一次心跳，让你知道它还活着
  if (pollCount % 15 === 0) {
    console.log(`[${stamp()}] …监控中，当前 localStorage 共 ${s.length} 个键`);
  }
}, 2000);

/* ── 收尾 ── */
async function finish(reason) {
  clearInterval(poll);
  console.log(`\n════════════════════════════════════════════════════`);
  console.log(` 收尾（${reason}）`);
  console.log('════════════════════════════════════════════════════');

  const finalKeys = await snapshot().catch(() => null);
  const gameKeys = (finalKeys || []).filter((x) => !/^(workbox|pwa-|__imt)/.test(x));

  console.log('\n── 最终 localStorage ──');
  console.log(gameKeys.length ? gameKeys.join('\n') : '(无游戏存档键)');

  console.log('\n── 捕获到的存档相关事件 ──');
  const storage = events.filter((e) => /^(LS |轮询发现|IDB)/.test(e.kind));
  console.log(storage.length ? storage.map((e) => `[${e.at}] ${e.kind}  ${e.detail}`).join('\n') : '(无)');

  console.log('\n── Ruffle 存档相关 console ──');
  const relevant = consoleLines.filter((l) => /storage|shared|sol|save|不能|存档/i.test(l));
  console.log(relevant.length ? relevant.join('\n') : '(无)');

  console.log('\n── 全部 console（尾部 30 条）──');
  console.log(consoleLines.slice(-30).join('\n') || '(空)');

  const report = [
    `### 龙卷风牧场存档监控报告`,
    `站点: ${base}`,
    `时长: ${stamp()}`,
    ``,
    `#### 最终 localStorage 游戏键`,
    gameKeys.length ? gameKeys.join('\n') : '(无)',
    ``,
    `#### 存档相关事件（共 ${storage.length} 条）`,
    storage.length ? storage.map((e) => `[${e.at}] ${e.kind} ${e.detail}`).join('\n') : '(无)',
    ``,
    `#### 存档相关 console`,
    relevant.length ? relevant.join('\n') : '(无)',
    ``,
    `#### 全部 console 尾部 30 条`,
    consoleLines.slice(-30).join('\n') || '(空)',
  ].join('\n');
  writeFileSync(join(OUT, 'report.md'), report);
  console.log(`\n报告已写入: ${join(OUT, 'report.md')}`);
  console.log('（把上面整段复制发给我即可）');

  ws.close(); edge.kill(); server.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 占用 */ }
  process.exit(0);
}

// Ctrl+C 也能正常收尾
process.on('SIGINT', () => { void finish('手动中断'); });

if (LIMIT_S) {
  setTimeout(() => { void finish(`${LIMIT_S}s 到期`); }, LIMIT_S * 1000);
} else {
  // 无时间限制：靠 Ctrl+C 或关窗口收尾；同时监听页面关闭
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.frameDetached' || m.method === 'Inspector.detached') void finish('页面已关闭');
  });
  await rpc(ws, 'Inspector.enable').catch(() => {});
  console.log('按 Ctrl+C 结束监控并输出报告。\n');
}
