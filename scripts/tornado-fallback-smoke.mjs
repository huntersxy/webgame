/* ────────────────────────────────────────────────────────────
 *  scripts/tornado-fallback-smoke.mjs — Canvas 2D 回退路径冒烟
 *
 *  站点承诺「任何浏览器都能玩」，所以《龙卷风成长记》在没有 WebGPU 时
 *  必须自动退回 Canvas 2D，且玩法与画面都不能塌。这个脚本验证那条分支。
 *
 *  两条场景（真实浏览器，零依赖 headless Edge + CDP）：
 *    A. 完全没有 navigator.gpu —— 在页面脚本执行前注入把它抹掉。
 *       注意：新版 headless Edge 默认就暴露 navigator.gpu，光不加
 *       --enable-unsafe-webgpu 模拟不出这个现场。
 *    B. 有 navigator.gpu 但 requestAdapter 返回 null（无显卡 / 驱动被拦）
 *       —— 这比场景 A 更常见，走的是 initBackend 的 catch 分支。
 *  各自检查：后端判定为 canvas2d、画布有实际像素内容、玩法可用、CG 可播。
 *
 *  用法：node scripts/tornado-fallback-smoke.mjs [url]（默认 http://localhost:4173）
 *  退出码 0 = 全部通过。
 * ──────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.argv[2] || 'http://localhost:4173';
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9512;
const OUT = join(ROOT, '.tmp', 'shots-fallback');
mkdirSync(OUT, { recursive: true });

// 注意：这里**故意**不加 --enable-unsafe-webgpu
const profile = mkdtempSync(join(tmpdir(), 'tornado-fallback-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,1000', '--force-device-scale-factor=1', `${URL_}/#/tornado`,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 80; i++) {
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
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  ${extra}` : ''}`); }
};
async function ev(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  return r.result?.value;
}

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

  // 这个版本的 headless Edge 默认就暴露 navigator.gpu，光靠不加 --enable-unsafe-webgpu
  // 模拟不出「没有 WebGPU」的现场。改为在**任何页面脚本执行之前**注入，
  // 把 navigator.gpu 抹掉——这才是真正走回退分支的条件。
  await rpc(ws, 'Page.enable');
  // addScriptToEvaluateOnNewDocument 注册的脚本会累积、且每次导航都执行，
  // 所以换场景前必须把上一个撤掉（identifier 由调用返回）。
  const scriptA = await rpc(ws, 'Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });`,
  });
  await ev(ws, `location.reload()`);
  await sleep(3000);

  console.log('== 环境确认：本环境确实没有 WebGPU ==');
  const env = JSON.parse(await ev(ws, `JSON.stringify({ hasGpu: !!navigator.gpu, secure: isSecureContext })`));
  check('navigator.gpu 不可用（回退前提成立）', env.hasGpu === false, JSON.stringify(env));

  // 跳过开场 CG
  await ev(ws, `localStorage.setItem('tornado.intro.seen.v1','1')`);
  await ev(ws, `location.reload()`);
  await sleep(3500);

  // ── 场景 B：navigator.gpu 存在，但申请不到设备（无显卡 / 驱动被拦）──
  // 这是比「完全没 WebGPU」更常见的现场，走的是 initBackend 的 catch 分支。
  console.log('== 场景 B：有 navigator.gpu 但 requestAdapter 返回 null ==');
  await rpc(ws, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptA.identifier });
  await rpc(ws, 'Page.addScriptToEvaluateOnNewDocument', {
    source: `
      if (navigator.gpu) {
        Object.defineProperty(navigator.gpu.__proto__, 'requestAdapter',
          { value: async () => null, configurable: true, writable: true });
      }
    `,
  });
  await ev(ws, `location.reload()`);
  await sleep(3500);
  const stB = JSON.parse(await ev(ws, `JSON.stringify({
    hasGpu: !!navigator.gpu,
    backend: document.documentElement.dataset.tornadoBackend || null,
    state: window.__tornadoGame?.state,
  })`));
  check('navigator.gpu 仍存在（确认走的是申请失败分支）', stB.hasGpu === true, JSON.stringify(stB));
  check('申请不到设备时回退到 canvas2d', stB.backend === 'canvas2d', `backend=${stB.backend}`);
  const pxB = JSON.parse(await ev(ws, `(() => {
    const c = document.getElementById('t-canvas');
    const probe = document.createElement('canvas');
    probe.width = c.width; probe.height = c.height;
    const p = probe.getContext('2d');
    p.drawImage(c, 0, 0);
    const d = p.getImageData(0, 0, probe.width, probe.height).data;
    let opaque = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i+3] > 8) opaque++;
    return JSON.stringify({ opaque });
  })()`));
  check('回退后画面仍有内容', pxB.opaque > 409600 * 0.5, `opaque=${pxB.opaque}`);

  console.log('== 后端判定 ==');
  const st = JSON.parse(await ev(ws, `JSON.stringify({
    backend: document.documentElement.dataset.tornadoBackend || null,
    state: window.__tornadoGame?.state,
  })`));
  check('已回退到 canvas2d 后端', st.backend === 'canvas2d', `backend=${st.backend}`);
  check('玩法仍在运行', st.state === 'play', `state=${st.state}`);

  console.log('== 2D 路径确实画出了内容 ==');
  // 读回画布像素：全透明说明什么都没画
  const px = JSON.parse(await ev(ws, `(() => {
    const c = document.getElementById('t-canvas');
    const probe = document.createElement('canvas');
    probe.width = c.width; probe.height = c.height;
    const p = probe.getContext('2d');
    p.drawImage(c, 0, 0);
    const d = p.getImageData(0, 0, probe.width, probe.height).data;
    let opaque = 0, colors = new Set();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i+3] > 8) opaque++;
      if (colors.size < 64) colors.add((d[i]>>4)+','+(d[i+1]>>4)+','+(d[i+2]>>4));
    }
    return JSON.stringify({ w: probe.width, h: probe.height, opaque, distinctColors: colors.size });
  })()`));
  check('画布有实际像素内容', px.opaque > px.w * px.h * 0.5, `opaque=${px.opaque}/${px.w * px.h}`);
  check('画面有色彩层次（不是纯色块）', px.distinctColors > 8, `distinct=${px.distinctColors}`);

  console.log('== 玩法在 2D 路径下可用 ==');
  const play = JSON.parse(await ev(ws, `(async () => {
    const g = window.__tornadoGame;
    g.reset();
    const r0 = g.r, s0 = g.score;
    for (let i = 0; i < 4; i++) {
      const o = g.objects.find(x => !x.dead && x.r < g.r);
      if (!o) break;
      g.x = o.x; g.y = o.y;
      g.update(1/60, { kx:0, ky:0, tx:null, ty:null });
    }
    await new Promise(r => setTimeout(r, 260));
    return JSON.stringify({ grew: g.r > r0, scored: g.score > s0, combo: g.combo,
      comboBadge: !document.getElementById('t-combo').classList.contains('hidden') });
  })()`));
  check('吞噬带来成长', play.grew);
  check('吞噬带来得分', play.scored);
  check('连击机制在 2D 路径生效', play.combo >= 2 && play.comboBadge, JSON.stringify(play));

  console.log('== CG 在 2D 路径下可播 ==');
  const cg = JSON.parse(await ev(ws, `(async () => {
    localStorage.removeItem('tornado.intro.seen.v1');
    location.hash = '#/tornado';
    location.reload();
    return JSON.stringify({ reloaded: true });
  })()`));
  void cg;
  await sleep(2200);
  const intro = JSON.parse(await ev(ws, `(() => {
    const c = document.getElementById('t-canvas');
    const probe = document.createElement('canvas');
    probe.width = c.width; probe.height = c.height;
    const p = probe.getContext('2d');
    p.drawImage(c, 0, 0);
    const d = p.getImageData(0, 0, probe.width, probe.height).data;
    let nonWhite = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i+3] > 8 && (d[i] < 200 || d[i+1] < 200 || d[i+2] < 200)) nonWhite++;
    return JSON.stringify({ nonWhite, backend: document.documentElement.dataset.tornadoBackend });
  })()`));
  check('开场 CG 在 2D 路径画出了内容', intro.nonWhite > 1000, JSON.stringify(intro));

  const shot = await ev(ws, `document.getElementById('t-canvas').toDataURL('image/png')`);
  if (shot) writeFileSync(join(OUT, 'fallback-intro.png'), Buffer.from(shot.replace(/^data:image\/png;base64,/, ''), 'base64'));

  console.log('== 无控制台错误 ==');
  const realErrors = errors.filter((e) => !/AudioContext|ServiceWorker|unsupported MIME/.test(e));
  check('无渲染相关异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  console.log(`\n${fail === 0 ? '✅' : '❌'} fallback: ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('驱动失败:', e.message);
  fail++;
} finally {
  edge.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(fail ? 1 : 0);
