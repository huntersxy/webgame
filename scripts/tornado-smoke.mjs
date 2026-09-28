/* ────────────────────────────────────────────────────────────
 *  scripts/tornado-smoke.mjs — 《龙卷风成长记》浏览器冒烟
 *
 *  零依赖：直接起 headless Edge，用 CDP（Node 内置 WebSocket）驱动页面。
 *  需要 WebGPU 才能走 vgpu 路径，故带上 --enable-unsafe-webgpu。
 *
 *  依次验证：
 *    1. WebGPU 后端真的接管了渲染（dataset.tornadoBackend === 'webgpu'）
 *    2. 连击：累计、倍率显示、徽标可见
 *    3. 冲刺：连击足够时按钮高亮、点击消耗连击并进入冷却
 *    4. 本关目标：进度显示、达成后标记样式
 *    5. 全程无控制台错误
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.argv[2] || 'http://localhost:4173';
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9501;
const OUT = join(ROOT, '.tmp', 'shots-tornado');
mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'tornado-smoke-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu',
  '--window-size=1280,1000', '--force-device-scale-factor=1', `${URL_}/#/tornado`,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up */ }
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

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); return; }
  fail++; console.log(`FAIL  ${name}${extra ? `  ${extra}` : ''}`);
}

/** 在页面里求值并返回结果 */
async function evaluate(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  return r.result?.value;
}

try {
  const ws = new WebSocket(await target());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Log.enable');
  await sleep(3000);

  // 跳过开场 CG，进入正常游玩
  await evaluate(ws, `localStorage.setItem('tornado.intro.seen.v1','1')`);
  await evaluate(ws, `location.reload()`);
  await sleep(3500);

  console.log('== 后端与基础状态 ==');
  const base = await evaluate(ws, `JSON.stringify({
    backend: document.documentElement.dataset.tornadoBackend || null,
    hasGame: !!window.__tornadoGame,
    state: window.__tornadoGame?.state,
    tier: window.__tornadoGame?.tier,
  })`);
  const b = JSON.parse(base);
  check('WebGPU 后端已接管', b.backend === 'webgpu', `backend=${b.backend}`);
  check('游戏对象可访问', b.hasGame);
  check('处于游玩状态', b.state === 'play', `state=${b.state}`);

  console.log('== 连击 HUD ==');
  // 制造连击：直接连吃两个
  const combo = await evaluate(ws, `(async () => {
    const g = window.__tornadoGame;
    g.reset();
    // 连吃 5 个：冲刺需要 4 层连击
    for (let i = 0; i < 5; i++) {
      const o = g.objects.find(x => !x.dead && x.r < g.r);
      if (!o) break;
      g.x = o.x; g.y = o.y;
      g.update(1/60, { kx:0, ky:0, tx:null, ty:null });
    }
    await new Promise(r => setTimeout(r, 260));
    const el = document.getElementById('t-combo');
    return JSON.stringify({ combo: g.combo, text: el?.textContent ?? '', hidden: el?.classList.contains('hidden') });
  })()`);
  const c = JSON.parse(combo);
  check('连击已累计', c.combo >= 2, `combo=${c.combo}`);
  check('连击徽标显示倍率', /×\d/.test(c.text), `text="${c.text}"`);
  check('连击徽标可见', c.hidden === false);

  console.log('== 冲刺按钮状态 ==');
  const dash1 = await evaluate(ws, `JSON.stringify({
    canDash: window.__tornadoGame.canDash,
    ready: document.getElementById('t-dash')?.classList.contains('ready'),
    text: document.getElementById('t-dash')?.textContent ?? '',
  })`);
  const d1 = JSON.parse(dash1);
  check('连击足够时按钮高亮', d1.canDash && d1.ready, JSON.stringify(d1));

  // 点击冲刺按钮 → 连击被消耗
  const dash2 = await evaluate(ws, `(async () => {
    const g = window.__tornadoGame;
    const before = g.combo;
    document.getElementById('t-dash').click();
    await new Promise(r => setTimeout(r, 200));
    return JSON.stringify({ before, after: g.combo, cd: g.dashCd > 0 });
  })()`);
  const d2 = JSON.parse(dash2);
  check('点击冲刺消耗连击', d2.after < d2.before, JSON.stringify(d2));
  check('冲刺后进入冷却', d2.cd);

  console.log('== 本关目标 HUD ==');
  const goal = await evaluate(ws, `JSON.stringify({
    text: document.getElementById('t-goal')?.textContent ?? '',
    done: document.getElementById('t-goal')?.classList.contains('done'),
  })`);
  const gl = JSON.parse(goal);
  check('目标进度已显示', /目标/.test(gl.text), `text="${gl.text}"`);

  console.log('== 达成目标后显示已完成 ==');
  const goal2 = await evaluate(ws, `(async () => {
    const g = window.__tornadoGame;
    g.tierGoalHit = false;
    g.score = 999999;
    const o = g.objects.find(x => !x.dead && x.r < g.r);
    if (o) { g.x = o.x; g.y = o.y; g.update(1/60, { kx:0, ky:0, tx:null, ty:null }); }
    await new Promise(r => setTimeout(r, 260));
    const el = document.getElementById('t-goal');
    return JSON.stringify({ hit: g.tierGoalHit, text: el?.textContent ?? '', done: el?.classList.contains('done') });
  })()`);
  const g2 = JSON.parse(goal2);
  check('达成标记已置位', g2.hit, JSON.stringify(g2));
  check('HUD 显示已达成的样式', g2.done && /达成/.test(g2.text), `text="${g2.text}"`);

  // 截图留档
  const shot = await evaluate(ws, `document.getElementById('t-canvas').toDataURL('image/png')`);
  if (shot) writeFileSync(join(OUT, 'gameplay.png'), Buffer.from(shot.replace(/^data:image\/png;base64,/, ''), 'base64'));

  console.log('== 全程无控制台错误 ==');
  check('无未捕获异常 / error 级日志', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n${fail === 0 ? '✅' : '❌'} gameplay: ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('驱动失败:', e.message);
  fail++;
} finally {
  edge.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
}
process.exit(fail ? 1 : 0);
