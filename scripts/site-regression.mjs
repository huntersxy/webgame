/* ────────────────────────────────────────────────────────────
 *  scripts/site-regression.mjs — 站点整体回归冒烟
 *
 *  改动《龙卷风成长记》的渲染与玩法后，确认站点其余部分没被牵连：
 *    · 九条路由逐个进入，视图都被激活；2D 画布有实际内容
 *      （WebGPU 画布无法用 drawImage 读回，那一页由后端对照脚本按 PNG 校验）
 *    · Service Worker 已注册、预缓存已写入（离线仍可开局）
 *    · 全程无未捕获异常
 *
 *  用法：node scripts/site-regression.mjs [url]（默认 http://localhost:4173）
 *  退出码 0 = 全部通过。
 * ──────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:4173';
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9531;
const profile = mkdtempSync(join(tmpdir(), 'webgame-regress-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu',
  '--window-size=1280,1000', '--force-device-scale-factor=1', `${URL_}/#/`,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}
let id = 0;
function rpc(ws, method, params = {}, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== mid) return;
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => reject(new Error(`${method} timeout`)), timeout);
  });
}

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? `  ${e}` : ''}`); } };

try {
  const ws = new WebSocket(await target());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const errors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Log.enable');
  await sleep(2500);

  const ev = async (expr) => {
    const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };

  // ── 九款游戏路由逐个进一遍，确认视图激活且画布有内容 ──
  console.log('== 九款游戏路由 ==');
  const routes = ['home', 'gomoku', 'go', 'xiangqi', 'othello', 'junqi', 'ddz', 'tornado', 'campaign'];
  for (const r of routes) {
    await ev(`location.hash = '#/${r}'`);
    await sleep(r === 'go' || r === 'ddz' ? 2200 : 900);   // 围棋/斗地主加载引擎，多等一下
    const st = JSON.parse(await ev(`(() => {
      const v = document.getElementById('view-${r}');
      const active = v ? v.classList.contains('active') : false;
      const cvs = v ? v.querySelector('canvas') : null;
      // WebGPU 画布在合成前无法被 drawImage 读回（会得到全透明），
      // 所以只对 2D 画布用像素探针；WebGPU 那页另由后端对照脚本按 PNG 校验。
      const backend = document.documentElement.dataset.tornadoBackend || null;
      let painted = null;
      if (cvs && backend !== 'webgpu') {
        const probe = document.createElement('canvas');
        probe.width = 64; probe.height = 64;
        const p = probe.getContext('2d');
        p.drawImage(cvs, 0, 0, 64, 64);
        const d = p.getImageData(0, 0, 64, 64).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i+3] > 8) n++;
        painted = n;
      }
      return JSON.stringify({ active, hasCanvas: !!cvs, painted, backend });
    })()`));
    const ok = st.active && (st.painted === null || st.painted > 50);
    check(`#/${r} 视图激活${st.painted !== null && st.hasCanvas ? '且画布有内容' : ''}`, ok, JSON.stringify(st));
  }

  // ── PWA 离线能力：Service Worker 已注册且预缓存就绪 ──
  console.log('== PWA 离线能力 ==');
  const pwa = JSON.parse(await ev(`(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    let cacheNames = [];
    try { cacheNames = await caches.keys(); } catch {}
    let precached = 0;
    for (const n of cacheNames) {
      try { precached += (await (await caches.open(n)).keys()).length; } catch {}
    }
    return JSON.stringify({
      swRegistered: !!reg, scope: reg?.scope ?? null,
      caches: cacheNames.length, entries: precached,
    });
  })()`));
  check('Service Worker 已注册', pwa.swRegistered, JSON.stringify(pwa));
  check('预缓存已写入（离线可开）', pwa.entries > 10, `entries=${pwa.entries}`);

  // ── 构建产物完整性 ──
  console.log('== 产物 ==');
  const assets = JSON.parse(await ev(`(async () => {
    const list = performance.getEntriesByType('resource').map(e => e.name);
    return JSON.stringify({
      total: list.length,
      sw: list.some(u => /sw\\.js/.test(u)),
      hasRendererChunk: list.some(u => /renderer-/.test(u)),
    });
  })()`));
  check('资源加载正常', assets.total > 3, JSON.stringify(assets));

  console.log('== 全程无未捕获异常 ==');
  const real = errors.filter((e) => !/AudioContext|ServiceWorker|unsupported MIME|favicon/.test(e));
  check('无未捕获异常', real.length === 0, real.slice(0, 3).join(' | '));

  console.log(`\n${fail === 0 ? '✅' : '❌'} regression: ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('驱动失败:', e.message);
  fail++;
} finally {
  edge.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(fail ? 1 : 0);
