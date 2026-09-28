/* ────────────────────────────────────────────────────────────
 *  scripts/tornado-backend-compare.mjs — 双后端对照
 *
 *  把《龙卷风成长记》驱动到**同一条确定性世界**（固定种子覆盖随机生成的
 *  物体与地形位置），分别用 WebGPU 与 Canvas 2D 渲染，再比较两件事：
 *
 *    ① 玩法指纹：同一份确定性输入（240 帧固定方向移动）下，
 *       两个后端的 分数/吞噬数/半径/坐标/量级/状态/连击/目标 必须逐项相同。
 *       相机倾斜只发生在渲染层，绝不该影响任何判定。
 *    ② 画面各自成立：两个后端都要铺满画面、都有色彩层次。
 *
 *  为什么不逐像素比对：立体化之后两条路径的画面**本来就不该相同**——
 *  Canvas 2D 不重刻光照、阴影、泛光与移轴景深，逐像素对照已失去意义。
 *  「移植忠实」现在由玩法指纹来证明。
 *
 *  两个坑：
 *    · 一张 canvas 的上下文类型不可逆——被 webgpu 占用后再也拿不到 2d，
 *      所以两种后端必须在各自的页面里渲染（本脚本分两次加载）。
 *    · WebGPU 画布在合成前无法用 drawImage 读回（会得到全透明），
 *      因此判定走 toDataURL 的 PNG、在 Node 侧用 pngjs 解码统计。
 *
 *  用法：node scripts/tornado-backend-compare.mjs [url]（默认 http://localhost:4173）
 *  退出码 0 = 玩法一致且两后端画面都成立。
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

  // 固定种子覆盖物体与地形位置：两次加载得到同一局面。
  // **半径也必须一起固定**——物体的尺寸原本由未播种的 Math.random 决定，
  // 只固定位置的话，两次加载吃到的物体大小不同，分数与成长必然对不上。
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const o of g.objects) {
    o.x = 120 + rnd() * (g.world - 240);
    o.y = 120 + rnd() * (g.world - 240);
    // 在「可食」区间内取半径：保证龙卷风开局有东西可吃
    o.r = Math.max(8, g.r * (0.35 + rnd() * 0.5));
  }
  for (const t of g.terrain) { t.x = 150 + rnd() * (g.world - 300); t.y = 150 + rnd() * (g.world - 300); }
  g.x = g.world * 0.5; g.y = g.world * 0.5;
  g.time = 3.0; g.shake = 0; g.combo = 0; g.comboT = 0;
  g.particles = []; g.rings = [];

  // 跑一段确定性模拟：两个后端必须得到相同的玩法结果。
  // 相机的倾斜只发生在渲染层，不该影响任何判定。
  //
  // 关键：页面自身的 rAF 循环也在调用 game.update，会和这里的步进交错执行，
  // 于是轨迹逐帧漂移。先把 update 换成空实现堵住那条路径，再用保存下来的
  // 真实现跑我们自己的确定性步进——两次加载才会走出完全相同的轨迹。
  const realUpdate = g.update.bind(g);
  g.update = () => {};

  // 让龙卷风朝最近的可食物体直线前进——否则只是撞墙，吞噬数恒为 0，
  // 玩法指纹就退化成一堆常量，证明不了任何事。
  const target = g.objects
    .filter(o => !o.dead && o.r < g.r)
    .sort((a, b) => Math.hypot(a.x - g.x, a.y - g.y) - Math.hypot(b.x - g.x, b.y - g.y))[0];
  for (let i = 0; i < 600; i++) {
    let kx = 1, ky = 0;
    if (target) {
      const dx = target.x - g.x, dy = target.y - g.y;
      const d = Math.hypot(dx, dy) || 1;
      kx = dx / d; ky = dy / d;
    }
    realUpdate(1 / 60, { kx, ky, tx: null, ty: null });
  }

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
    // ── 玩法指纹：两个后端必须逐项相同 ──
    play: {
      score: g.score,
      eaten: g.eaten,
      r: +g.r.toFixed(6),
      x: +g.x.toFixed(6),
      y: +g.y.toFixed(6),
      tier: g.tier,
      total: g.total,
      state: g.state,
      bestCombo: g.bestCombo,
      goalsHit: g.goalsHit,
    },
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

  // ── 判据一：玩法一致（这是「移植忠实」的真正含义）──
  // 立体化之后两个后端的**画面**本就不再相同（Canvas 2D 不重刻光影），
  // 但同一份确定性输入必须产生相同的玩法结果。
  //
  // 步进已经与页面自身的 rAF 隔离（见上方对 update 的处理），
  // 所以这里可以要求**全部 10 项完全相等**，包括浮点坐标。
  console.log('\n== 两后端对照（同一条确定性世界）==');
  console.log(`  后端判定     webgpu=${gpu.backend}  canvas2d=${c2d.backend}`);
  console.log(`  不透明占比   ${(gpuPx.opaqueRatio*100).toFixed(1)}%  vs  ${(c2dPx.opaqueRatio*100).toFixed(1)}%`);
  console.log(`  平均色       [${gpuPx.mean}]  vs  [${c2dPx.mean}]`);
  console.log(`  色彩层次     ${gpuPx.distinct}  vs  ${c2dPx.distinct}`);

  const playKeys = ['score', 'eaten', 'tier', 'total', 'state', 'bestCombo', 'goalsHit', 'r', 'x', 'y'];
  const diffs = [];
  for (const k of playKeys) {
    const a = gpu.play?.[k];
    const b = c2d.play?.[k];
    if (a !== b) diffs.push(`${k}: webgpu=${a} canvas2d=${b}`);
  }
  const playOk = diffs.length === 0;
  console.log('\n  玩法指纹（10 项，要求完全相等）：');
  for (const k of playKeys) console.log(`    ${k.padEnd(10)} ${gpu.play?.[k]} / ${c2d.play?.[k]}`);
  for (const d of diffs) console.log(`    ✗ ${d}`);

  // ── 判据二：两个后端都真的画出了东西（不是空白页）──
  const fillOk = gpuPx.opaqueRatio > 0.9 && c2dPx.opaqueRatio > 0.9;
  // ── 判据三：都有色彩层次，说明各自都渲染了完整场景而非纯色 ──
  const richOk = gpuPx.distinct > 12 && c2dPx.distinct > 12;
  // ── 判据四：后端判定正确（一个走 GPU，一个走 2D）──
  const backendOk = gpu.backend === 'webgpu' && c2d.backend === 'canvas2d';
  // ── 判据五：这一步确实吃到了东西，指纹不是一堆常量 ──
  const ateOk = gpu.play?.eaten > 0 && gpu.play?.score > 0;

  console.log(`\n  玩法一致（10 项完全相等）：${playOk ? '✅' : '❌'}`);
  console.log(`  两后端都铺满画面（>90%）：${fillOk ? '✅' : '❌'}`);
  console.log(`  两后端都有色彩层次（>12 色）：${richOk ? '✅' : '❌'}`);
  console.log(`  后端判定正确：${backendOk ? '✅' : '❌'}`);
  console.log(`  本局确有吞噬发生（指纹非常量）：${ateOk ? '✅' : '❌'}`);
  if (!(playOk && fillOk && richOk && backendOk && ateOk)) fail++;
  console.log(`\n${fail === 0 ? '✅ 两个后端玩法一致、画面各自成立' : '❌ 两后端不一致'}`);
} catch (e) {
  console.error('失败:', e.message);
  fail++;
}
process.exit(fail ? 1 : 0);
