#!/usr/bin/env node
/**
 * 端到端验证 userscripts/flash-free-ruffle.user.js。
 *
 * 为什么不直接开 4399 页面测：外网站点会变、依赖网络、结论不可重跑。这里把
 * 4399 播放页的结构原样复刻成本地 fixture（document.write 出 object+embed、
 * webServer + _strGamePath 两个变量），并用两个端口把「源」分开：
 *
 *   site 端口   页面本身 + /ruffle/*（本地 Ruffle，同源，不需要代理）
 *               + /__proxy（模拟 GM_xmlhttpRequest：扩展侧代发请求，不受页面同源策略约束）
 *   cdn  端口   只放 game.swf，Content-Type 与 4399 一致，**故意不写 ACAO 头**
 *
 * 于是 Ruffle 在页面里直连 SWF 必然被浏览器挡下（脚本会先断言这件事），
 * 只有脚本自带的 fetch 代理链路生效才拿得到字节 —— 代理坏了，后面的断言
 * 会整排失败，不会假通过。
 *
 * 用法：node scripts/ruffle-userscript-smoke.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { decodePng, imageStats, diffRatio } from './png.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const RUFFLE_DIR = join(ROOT, 'public', 'ruffle');
const SWF = join(ROOT, 'public', 'games', 'tornado-ranch', 'game.swf');
const USERSCRIPT = join(ROOT, 'userscripts', 'flash-free-ruffle.user.js');
const OUT = join(ROOT, '.tmp', 'rffp-smoke');
const BUDGET_MS = Number(process.env.RFFP_BUDGET || 70_000);
const CDP_PORT = Number(process.env.RFFP_CDP_PORT || 9542);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.swf': 'application/x-shockwave-flash',
  '.png': 'image/png',
};

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const results = [];
function check(name, ok, note = '') {
  ok ? pass++ : fail++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '   ' + note : ''}`);
  console.log(`${ok ? '✓' : '✗'} ${name}${note ? '   ' + note : ''}   [${since()}]`);
}

function findBrowser() {
  const cands = [
    process.env.EDGE_BIN,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error('找不到 Edge/Chrome，用 EDGE_BIN 指定');
}

const proxyHits = [];

/** site：fixture 页面 + 本地 ruffle 目录 + /__proxy（冒充扩展代发）。 */
function startSite(cdnBase) {
  return new Promise((resolve, reject) => {
    const s = createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const p = decodeURIComponent(u.pathname);
      if (p === '/__proxy') {
        const target = u.searchParams.get('u') || '';
        // 只允许测试自己的 cdn 端口，别让脚本顺手变成开放代理。
        if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(target)) {
          res.writeHead(400);
          return res.end('bad target');
        }
        try {
          const r = await fetch(target);
          const buf = Buffer.from(await r.arrayBuffer());
          proxyHits.push({ target, bytes: buf.length, status: r.status });
          res.writeHead(r.status, {
            'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(buf);
        } catch (e) {
          res.writeHead(502);
          res.end(String(e));
        }
        return;
      }
      if (p.startsWith('/ruffle/')) {
        try {
          const body = readFileSync(join(RUFFLE_DIR, p.slice('/ruffle/'.length)));
          res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end('404');
        }
        return;
      }
      if (p === '/a.html' || p === '/b.html') {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(p === '/a.html' ? fixtureA(cdnBase) : fixtureB(cdnBase));
        return;
      }
      res.writeHead(404);
      res.end('404');
    });
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/** cdn：只提供 .swf，不带任何 Access-Control-Allow-Origin。 */
function startCdn(dir) {
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      try {
        const body = readFileSync(join(dir, p.replace(/^\/+/, '')));
        res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('404');
      }
    });
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/** 复刻 4399 播放页：object + 内嵌 embed，变量名照抄。 */
function fixtureA(cdnBase) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>fixture A</title>
<style>body{margin:0;background:#222;color:#ccc;font:12px system-ui}#swfdiv{padding:6px}</style></head>
<body><div id="swfdiv"><div id="loadingdiv">加载中…</div><center id="game"></center></div>
<script>
var title='样例游戏', _w=750,_h=563;
var webServer = '${cdnBase}';
var _strGamePath = '/game.swf';
document.write("<OBJECT ID='flashgame' classid='clsid:D27CDB6E-AE6D-11cf-96B8-444553540000' width='750' height='563'>");
document.write("<PARAM NAME='allowScriptAccess' VALUE='never'>");
document.write("<PARAM NAME='movie' VALUE='" + webServer + _strGamePath + "'>");
document.write("<embed id='flashgame1' name='flashgame' src='" + webServer + _strGamePath +
  "' quality='high' type='application/x-shockwave-flash' width='750' height='563' allowScriptAccess='never'></embed>");
document.write("</OBJECT>");
</script></body></html>`;
}

/** 复刻「站方播放器脚本没跑起来 / 页面里根本没有 Flash 容器」：只有变量和空壳。 */
function fixtureB(cdnBase) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>fixture B</title>
<style>body{margin:0;background:#111}#swfdiv{padding:6px}</style></head>
<body><div id="swfdiv"><p id="tip">您的浏览器不支持 Flash，请下载插件后重试</p></div>
<script>
var _w = 700, _h = 520;
var webServer = '${cdnBase}/';   // 结尾多一个斜杠：拼接必须能收敛，否则会被当成协议相对地址
var _strGamePath = '/game.swf';
</script></body></html>`;
}

/** 在 userscript 之前注入，等价于 Tampermonkey 提供的 GM_* 环境。 */
const GM_SHIM = `(() => {
  const ORIGIN_FETCH = window.fetch ? window.fetch.bind(window) : null;
  window.__GM = { proxy: [], menu: [], errors: [] };
  const store = { ruffleBase: location.origin + '/ruffle/', flushSaves: !window.__NOFLUSH };
  window.GM_getValue = (k, d) => (k in store ? store[k] : d);
  window.GM_setValue = (k, v) => { store[k] = v; };
  window.GM_addStyle = (css) => { const s = document.createElement('style'); s.textContent = css; document.documentElement.appendChild(s); };
  window.GM_registerMenuCommand = (n) => window.__GM.menu.push(n);
  window.GM_xmlhttpRequest = (spec) => {
    ORIGIN_FETCH('/__proxy?u=' + encodeURIComponent(spec.url), { method: spec.method || 'GET' }).then(async (r) => {
      const buf = await r.arrayBuffer();
      window.__GM.proxy.push({ url: spec.url, bytes: buf.byteLength, status: r.status });
      const head = [...r.headers].map(([k, v]) => k + ': ' + v).join('\\r\\n');
      spec.onload && spec.onload({ status: r.status, statusText: r.statusText, response: buf, responseHeaders: head, finalUrl: spec.url });
    }).catch(() => spec.onerror && spec.onerror({}));
  };
  window.__ORIG_FETCH = ORIGIN_FETCH;
  window.addEventListener('error', (e) => window.__GM.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__GM.errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));
  window.addEventListener('pagehide', () => { window.__GM.pagehide = (window.__GM.pagehide || 0) + 1; });
})()`;

let id = 0;
function rpc(ws, method, params = {}, timeout = 8000) {
  return new Promise((res, rej) => {
    const mid = ++id;
    const onMsg = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== mid) return;
      ws.removeEventListener('message', onMsg);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => rej(new Error(`${method} timeout`)), timeout);
  });
}

async function until(fn, deadlineMs, intervalMs = 150) {
  const end = Date.now() + deadlineMs;
  let val;
  for (;;) {
    val = await fn();
    if (val || Date.now() >= end) return val;
    await sleep(intervalMs);
  }
}

const consoleErrors = [];
let edge = null;
let profile = null;
let site = null;
let cdn = null;

try {
  mkdirSync(OUT, { recursive: true });
  for (const [what, p] of [
    ['userscript', USERSCRIPT],
    ['Ruffle 目录', join(RUFFLE_DIR, 'ruffle.js')],
    ['测试 SWF', SWF],
  ]) {
    if (!existsSync(p)) throw new Error(`${what}不存在：${p}`);
  }
  const userscript = readFileSync(USERSCRIPT, 'utf8');

  const cdnDir = join(OUT, 'cdn', '4399swf');
  mkdirSync(cdnDir, { recursive: true });
  copyFileSync(SWF, join(cdnDir, 'game.swf'));
  cdn = await startCdn(join(OUT, 'cdn'));
  const cdnBase = `http://127.0.0.1:${cdn.address().port}/4399swf`;
  site = await startSite(cdnBase);
  const SITE = `http://127.0.0.1:${site.address().port}`;
  console.log(`site=${SITE}\ncdn =${cdnBase}（无 ACAO 头）   [${since()}]`);

  profile = mkdtempSync(join(tmpdir(), 'rffp-smoke-'));
  edge = spawn(
    findBrowser(),
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--window-size=1200,900',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const wsUrl = await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl || null;
    } catch {
      return null;
    }
  }, 12000);
  if (!wsUrl) throw new Error('CDP 未就绪');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text);
  });
  await until(
    async () => {
      try {
        return (await rpc(ws, 'Runtime.evaluate', { expression: '1', returnByValue: true }, 1500))?.result?.value === 1;
      } catch {
        return false;
      }
    },
    12000,
    200,
  );
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Log.enable');
  await rpc(ws, 'Page.enable');
  // 顺序即执行顺序：先 GM 环境，再被测脚本，都在 document-start。
  await rpc(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: GM_SHIM });
  await rpc(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: userscript });

  const ev = async (expr) => {
    const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  const playerBox = () =>
    ev(`(() => {
    const p = document.querySelector('ruffle-player, ruffle-embed, ruffle-object');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return r.width > 20 && r.height > 20 ? JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }) : null;
  })()`).then((s) => (s ? JSON.parse(s) : null));

  async function capturePng() {
    let lastErr;
    for (let a = 0; a < 2; a++) {
      try {
        const s = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, 5000);
        return Buffer.from(s.data, 'base64');
      } catch (err) {
        lastErr = err;
        await sleep(250);
      }
    }
    throw lastErr;
  }
  async function crop(name, box) {
    const png = await capturePng();
    if (name) writeFileSync(join(OUT, `${name}.png`), png);
    const full = decodePng(png);
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.min(full.width - x, Math.round(box.w));
    const h = Math.min(full.height - y, Math.round(box.h));
    if (w <= 0 || h <= 0) throw new Error(`区域无效 ${JSON.stringify(box)} 整图=${full.width}x${full.height}`);
    const data = Buffer.alloc(w * h * 4);
    for (let row = 0; row < h; row++) {
      const src = ((y + row) * full.width + x) * 4;
      full.data.copy(data, row * w * 4, src, src + w * 4);
    }
    return { width: w, height: h, data };
  }
  const goto = async (path) => {
    await rpc(ws, 'Page.navigate', { url: SITE + path });
    await until(() => ev(`document.readyState !== 'loading'`), 8000);
  };
  const proxied = () => proxyHits.filter((h) => /game\.swf/.test(h.target));

  console.log('== 前提：这条 SWF 在页面里直连是取不到的 ==');
  await goto('/a.html');
  await sleep(500);
  // 用未被改写的原始 fetch 判定，代理生效后的 window.fetch 当然能取到。
  const direct = await ev(`__ORIG_FETCH('${cdnBase}/game.swf').then(r => 'ok:' + r.status).catch(e => 'blocked:' + e.message)`);
  check('页面直接 fetch SWF 被 CORS 挡住（代理才有意义）', /^blocked:/.test(String(direct)), String(direct));

  console.log('== fixture A：站点自己写了 object+embed（4399 的样子）==');
  const mountedA = await until(playerBox, 15000);
  check('Ruffle 播放器已挂载', !!mountedA, JSON.stringify(mountedA));
  if (!mountedA) {
    const diag = await ev(`JSON.stringify({
      badge: (document.getElementById('rffp-badge-msg') || {}).textContent,
      embed: document.querySelectorAll('embed').length,
      embedType: (document.querySelector('embed') || {}).type,
      embedSrc: (document.querySelector('embed') || {}).src,
      ruffle: !!window.RufflePlayer,
      gmProxy: (window.__GM || {}).proxy,
      gmErrors: (window.__GM || {}).errors,
      ns: !!window.__RFFP__,
      cfgBase: (window.__GM && GM_getValue('ruffleBase', '')) || '',
      badgeHtml: !!document.getElementById('rffp-badge'),
    })`);
    throw new Error('fixture A 未挂载，诊断：' + diag + '\n  控制台：' + consoleErrors.slice(0, 6).join(' | '));
  }
  check(
    'SWF 经脚本内置代理取回',
    (await until(() => proxied().length > 0, 8000)) === true,
    JSON.stringify(proxied().map((h) => ({ n: h.bytes, s: h.status }))),
  );
  check(
    '代理取回字节数与文件大小一致',
    proxied().some((h) => h.bytes === readFileSync(SWF).length),
    `期望 ${readFileSync(SWF).length}，实得 ${JSON.stringify(proxied().map((h) => h.bytes))}`,
  );
  check('站方「加载中」遮罩已收起', (await ev(`getComputedStyle(document.getElementById('loadingdiv')).display`)) === 'none');

  check('播放器有可见尺寸', mountedA.w > 200 && mountedA.h > 150, JSON.stringify(mountedA));
  let shot = await crop('A-title', mountedA);
  let stats = imageStats(shot);
  await until(async () => {
    shot = await crop(null, mountedA);
    stats = imageStats(shot);
    return stats.opaque > shot.width * shot.height * 0.5 && stats.distinct > 24;
  }, 8000);
  check(
    '画面已渲染（非空白）',
    stats.opaque > shot.width * shot.height * 0.5 && stats.distinct > 24,
    `distinct=${stats.distinct} dominant=${(stats.dominantRatio * 100).toFixed(1)}%`,
  );

  const instances = await ev(`document.querySelectorAll('ruffle-player, ruffle-embed, ruffle-object').length`);
  check('一个游戏只挂了一个播放器实例', instances === 1, `instances=${instances}`);
  // 站方工具条靠 document.embeds / getElementById('flashgame') 找播放器，
  // Ruffle 的 polyfill 会保留 id 并修补 document.embeds，这里验一下没被弄坏。
  const siteHooks = await ev(`JSON.stringify({
    byId: !!document.getElementById('flashgame'),
    embeds: document.embeds.length,
    id: (document.querySelector('ruffle-embed, ruffle-object, ruffle-player') || {}).id
  })`);
  check('站方脚本仍能寻址到播放器', (await ev(`!!document.getElementById('flashgame') && document.embeds.length > 0`)) === true, siteHooks);

  // 标题画面除按钮高亮外本身是静止的，所以不做「自动跑帧」断言，
  // 改成点击后必须换屏：这条同时验证输入确实经 Shadow DOM + 代理链路进了游戏。
  // 「开始游戏」按钮的确切位置随 Ruffle 的缩放方式浮动，先点最可能的位置，
  // 不中再在小范围网格里补点；每点一次都等画面变化，命中即停。
  const clickAt = async (x, y) => {
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  };
  const title = await crop(null, mountedA);
  const tryClick = async (x, y) => {
    await clickAt(x, y);
    return (
      until(async () => {
        const d = diffRatio(title, await crop(null, mountedA), 12);
        return d > 0.02 ? d : 0;
      }, 1500) || 0
    );
  };
  let changed = 0;
  let hitAt = null;
  const candidates = [
    [0.5, 0.82],
    [0.5, 0.86],
    [0.5, 0.78],
  ];
  for (let fx = 0.34; fx <= 0.68; fx += 0.08) for (const fy of [0.82, 0.86, 0.9]) candidates.push([fx, fy]);
  for (const [fx, fy] of candidates) {
    const x = Math.round(mountedA.x + mountedA.w * fx);
    const y = Math.round(mountedA.y + mountedA.h * fy);
    changed = await tryClick(x, y);
    if (changed > 0.02) {
      hitAt = [x, y];
      break;
    }
  }
  await crop('A-after-click', mountedA);
  // 失败时把输入链路的状态打出来，免得只看到一个百分比。
  const inputDiag =
    changed > 0.02
      ? ''
      : await ev(`(() => {
    const host = document.querySelector('ruffle-player, ruffle-embed, ruffle-object');
    const c = host.shadowRoot && host.shadowRoot.querySelector('canvas');
    const r = c ? c.getBoundingClientRect() : null;
    return JSON.stringify({
      host: host.tagName + '#' + host.id,
      canvas: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      isPlaying: host.isPlaying,
    });
  })()`);
  check(
    '点击后画面换屏（输入已进入游戏）',
    changed > 0.02,
    `changed=${(changed * 100).toFixed(1)}% 命中=${JSON.stringify(hitAt)}  ${inputDiag}`,
  );

  // 回归：代理合成的 Response 必须带上真实 url。
  // new Response() 的 url 是空串，而 Ruffle 用 response.url 判影片安全域，
  // 空串会让影片进错沙箱——画得出来、isPlaying 也为真，但鼠标点不动。
  const respUrl = await ev(`fetch(${JSON.stringify(cdnBase + '/game.swf')}).then(r => r.url)`);
  check('代理响应的 url 非空（否则影片进错沙箱）', respUrl === `${cdnBase}/game.swf`, String(respUrl));

  const hasCanvas = await ev(`(() => {
    const p = document.querySelector('ruffle-player, ruffle-embed, ruffle-object');
    return !!p && !!p.shadowRoot && !!p.shadowRoot.querySelector('canvas');
  })()`);
  check('Shadow DOM 里有 Ruffle 画布', hasCanvas === true);

  // 存档落盘机制：Ruffle 只在 pagehide 时把 SharedObject 写进 localStorage，
  // 脚本每 3 秒合成一次 pagehide。这里数事件，不去猜游戏会写哪些 key。
  const flushed = await until(async () => {
    const n = await ev(`(window.__GM && window.__GM.pagehide) || 0`);
    return n >= 1 ? n : 0;
  }, 9000);
  check('定时促发存档落盘（合成 pagehide）', Number(flushed) >= 1, `pagehide=${flushed}`);
  check('无「Sandbox did not flush saves」', !consoleErrors.some((e) => /did not flush saves/i.test(e)));

  console.log('== fixture B：页面里没有任何 embed，只有站点变量 ==');
  proxyHits.length = 0;
  await goto('/b.html');
  const mountedB = await until(playerBox, 12000);
  check('按站点变量自行挂载了播放器', !!mountedB, JSON.stringify(mountedB));
  check('同样通过代理取回 SWF', (await until(() => proxied().length > 0, 8000)) === true, JSON.stringify(proxied().map((h) => h.target)));
  if (mountedB) {
    let s2 = imageStats(await crop(null, mountedB));
    await until(async () => {
      s2 = imageStats(await crop('B-title', mountedB));
      return s2.distinct > 12;
    }, 8000);
    check(
      'fixture B 画面非空白',
      s2.opaque > mountedB.w * mountedB.h * 0.4 && s2.distinct > 12,
      `distinct=${s2.distinct} opaque=${s2.opaque}`,
    );
    check('尺寸取自 _w/_h 而非默认值', Math.abs(mountedB.w / mountedB.h - 700 / 520) < 0.12, JSON.stringify(mountedB));
  }

  console.log('== 控制台 ==');
  // 前提检查那条故意发出去的直连请求必然留一条 CORS 错误，属于预期。
  const IGNORE = /CORS|Failed to load resource|Access to fetch|blocked|net::ERR_|did not flush saves/i;
  const fatal = consoleErrors.filter((e) => !IGNORE.test(e));
  check('无未捕获异常', fatal.length === 0, fatal.slice(0, 3).join(' | '));
  const pageErrs = JSON.parse((await ev(`JSON.stringify((window.__GM||{}).errors||[])`)) || '[]');
  check('页面内脚本无报错', pageErrs.filter((e) => !IGNORE.test(e)).length === 0, JSON.stringify(pageErrs.slice(0, 3)));

  ws.close();
} catch (err) {
  fail++;
  results.push(`FAIL  冒烟脚本异常   ${err?.stack ?? err}`);
  console.error(`✗ 冒烟脚本异常  ${err?.stack ?? err}   [${since()}]`);
} finally {
  try {
    edge?.kill();
  } catch {}
  try {
    site?.close();
    cdn?.close();
  } catch {}
  if (profile)
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    }, 500);
}

const watchdog = setTimeout(() => {
  console.error('看门狗超时，强杀退出');
  writeFileSync(join(OUT, 'result.txt'), results.concat(`FAIL  看门狗超时 ${BUDGET_MS}ms`).join('\n'));
  try {
    edge?.kill();
  } catch {}
  process.exit(1);
}, BUDGET_MS);
watchdog.unref();

writeFileSync(join(OUT, 'result.txt'), results.join('\n'));
console.log(`\n${pass} 通过 / ${fail} 失败   用时 ${since()}   截图与结果在 ${OUT}`);
process.exit(fail === 0 ? 0 : 1);
