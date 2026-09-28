/* ────────────────────────────────────────────────────────────
 *  scripts/tornado-backend-compare.mjs — 双后端画面对照
 *
 *  把《龙卷风成长记》驱动到**同一条确定性世界**（固定种子覆盖随机生成的
 *  物体与地形位置），分别用 WebGPU 与 Canvas 2D 渲染，再比较解码后的像素。
 *  目的是证明移植是忠实的：两个后端画的是同一个世界，而不是「看着差不多」。
 *
 *  两个坑：
 *    · 一张 canvas 的上下文类型不可逆——被 webgpu 占用后再也拿不到 2d，
 *      所以两种后端必须在各自的页面里渲染（本脚本分两次加载）。
 *    · WebGPU 画布在合成前无法用 drawImage 读回（会得到全透明），
 *      因此判定走 toDataURL 的 PNG、在 Node 侧用 pngjs 解码统计。
 *
 *  用法：node scripts/tornado-backend-compare.mjs [url]（默认 http://localhost:4173）
 *  退出码 0 = 两后端一致。
 * ──────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.argv[2] || 'http://localhost:4173';
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9522;
const OUT = join(ROOT, '.tmp', 'shots-compare');
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里把世界固定成确定状态，并返回画布的像素统计 */
const DETERMINISTIC_STATS = `(async () => {
  const g = window.__tornadoGame;
  const c = document.getElementById('t-canvas');
  g.reset();

  // 固定种子覆盖物体与地形位置：两次加载得到同一局面
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const o of g.objects) { o.x = 120 + rnd() * (g.world - 240); o.y = 120 + rnd() * (g.world - 240); }
  for (const t of g.terrain) { t.x = 150 + rnd() * (g.world - 300); t.y = 150 + rnd() * (g.world - 300); }
  g.x = g.world * 0.5; g.y = g.world * 0.5;
  g.time = 3.0; g.shake = 0; g.combo = 0; g.comboT = 0;
  g.particles = []; g.rings = [];

  await new Promise(r => setTimeout(r, 460));   // 让当前后端出一帧

  const probe = document.createElement('canvas');
  probe.width = c.width; probe.height = c.height;
  const p = probe.getContext('2d', { willReadFrequently: true });
  p.drawImage(c, 0, 0);
  const d = p.getImageData(0, 0, probe.width, probe.height).data;

  let opaque = 0; const sum = [0,0,0]; const buckets = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i+3] > 8) {
      opaque++; sum[0]+=d[i]; sum[1]+=d[i+1]; sum[2]+=d[i+2];
      const k = (d[i]>>5)+','+(d[i+1]>>5)+','+(d[i+2]>>5);
      buckets.set(k, (buckets.get(k)||0)+1);
    }
  }
  const total = probe.width * probe.height;
  return JSON.stringify({
    backend: document.documentElement.dataset.tornadoBackend || null,
    opaqueRatio: opaque / total,
    mean: sum.map(v => Math.round(v / Math.max(1, opaque))),
    distinct: buckets.size,
    dataUrl: c.toDataURL('image/png'),
  });
})()`;

async function capture({ disableGpu, tag }) {
  const profile = mkdtempSync(join(tmpdir(), `tornado-${tag}-`));
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,1000',
    '--force-device-scale-factor=1',
    ...(disableGpu ? [] : ['--enable-unsafe-webgpu']),
    `${URL_}/#/tornado`,
  ], { stdio: 'ignore' });

  const findTarget = async () => {
    for (let i = 0; i < 90; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (p) return p.webSocketDebuggerUrl;
      } catch { /* not up */ }
      await sleep(250);
    }
    throw new Error('CDP 未就绪');
  };

  let id = 0;
  const rpc = (ws, method, params = {}, timeout = 60000) => new Promise((resolve, reject) => {
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

  const ws = new WebSocket(await findTarget());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Page.enable');
  if (disableGpu) {
    await rpc(ws, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });`,
    });
  }
  await sleep(2500);
  const evalIn = async (expr) => {
    const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    return r.result?.value;
  };
  await evalIn(`localStorage.setItem('tornado.intro.seen.v1','1')`);
  await evalIn(`location.reload()`);
  await sleep(3500);
  const out = JSON.parse(await evalIn(DETERMINISTIC_STATS));

  edge.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  return out;
}

/** 用 pngjs 解码截图，统计真实像素——不依赖页面内的 drawImage 探针
    （WebGPU 画布在合成前无法被 drawImage 读回，那会得出「全透明」的假象）。 */
async function statsOfPng(dataUrl) {
  const { PNG } = await import('pngjs');
  const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const png = PNG.sync.read(buf);
  let opaque = 0; const sum = [0, 0, 0]; const buckets = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    const a = png.data[i + 3];
    if (a > 8) {
      opaque++;
      sum[0] += png.data[i]; sum[1] += png.data[i + 1]; sum[2] += png.data[i + 2];
      buckets.add(`${png.data[i] >> 5},${png.data[i + 1] >> 5},${png.data[i + 2] >> 5}`);
    }
  }
  const total = png.width * png.height;
  return {
    w: png.width, h: png.height,
    opaqueRatio: opaque / total,
    mean: sum.map((v) => Math.round(v / Math.max(1, opaque))),
    distinct: buckets.size,
  };
}

let fail = 0;
try {
  console.log('捕获 WebGPU 后端…');
  const gpu = await capture({ disableGpu: false, tag: 'gpu' });
  console.log('捕获 Canvas 2D 后端…');
  const c2d = await capture({ disableGpu: true, tag: '2d' });

  for (const [tag, r] of [['webgpu', gpu], ['canvas2d', c2d]]) {
    if (r.dataUrl) {
      writeFileSync(join(OUT, `${tag}.png`), Buffer.from(r.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    }
  }

  // 用解码后的真实像素判定（页面内 drawImage 对 WebGPU 画布读不到内容）
  const gpuPx = await statsOfPng(gpu.dataUrl);
  const c2dPx = await statsOfPng(c2d.dataUrl);

  console.log('\n== 两后端对照（同一条确定性世界）==');
  console.log(`  后端判定     webgpu=${gpu.backend}  canvas2d=${c2d.backend}`);
  console.log(`  不透明占比   ${(gpuPx.opaqueRatio*100).toFixed(1)}%  vs  ${(c2dPx.opaqueRatio*100).toFixed(1)}%`);
  console.log(`  平均色       [${gpuPx.mean}]  vs  [${c2dPx.mean}]`);
  console.log(`  色彩层次     ${gpuPx.distinct}  vs  ${c2dPx.distinct}`);

  const dMean = gpuPx.mean.map((v, i) => Math.abs(v - c2dPx.mean[i]));
  const fillOk = gpuPx.opaqueRatio > 0.9 && Math.abs(gpuPx.opaqueRatio - c2dPx.opaqueRatio) < 0.10;
  const meanOk = Math.max(...dMean) < 40;
  const richOk = gpuPx.distinct > 12 && c2dPx.distinct > 12;

  console.log(`\n  画面覆盖一致（±10%）：${fillOk ? '✅' : '❌'}`);
  console.log(`  色调一致（每通道 Δ<40，最大 Δ=${Math.max(...dMean)}）：${meanOk ? '✅' : '❌'}`);
  console.log(`  两后端都有色彩层次：${richOk ? '✅' : '❌'}`);
  if (!(fillOk && meanOk && richOk)) fail++;
  console.log(`\n${fail === 0 ? '✅ 两个后端画的是同一个世界' : '❌ 两后端画面差异过大'}`);
} catch (e) {
  console.error('失败:', e.message);
  fail++;
}
process.exit(fail ? 1 : 0);
