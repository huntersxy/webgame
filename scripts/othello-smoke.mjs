/* ────────────────────────────────────────────────────────────
 *  scripts/othello-smoke.mjs — 黑白棋浏览器冒烟
 *
 *  零依赖：直接起 headless Edge，用 CDP（Node 22 内置 WebSocket）驱动页面，
 *  进入 #/othello 后依次验证：
 *    1. 视图可见、开局中央四子正确、合法点 4 个
 *    2. 人类落子后棋子与翻子数正确
 *    3. AI 会在预算内应手、思考遮罩关闭
 *    4. 悔棋能还原到人类回合、子数回到落子前
 *    5. 全程无控制台错误 / 页面异常
 *
 *  用法：node scripts/othello-smoke.mjs [url]（默认 http://localhost:5173）
 *  退出码 0 = 全部通过。
 * ──────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:5173';
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'oth-smoke-'));
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--disable-gpu',
  '--window-size=1280,900',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error('无法连接 headless Edge 的 CDP 端口');
}

let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`页面执行异常: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

const checks = [];
function check(name, ok, extra = '') {
  checks.push({ name, ok, extra });
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${extra && !ok ? '  ' + extra : ''}`);
}

const main = async () => {
  const wsUrl = await getTarget();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'unknown');
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${URL_}/#/othello` });
  await sleep(2500);
  // 默认引擎是 Egaroucid（1.4MB wasm + 初始化），等它就绪，最多 60 秒
  let engineReady = null;
  for (let i = 0; i < 60; i++) {
    engineReady = await evaluate('(() => { const c = window.othelloCtrl; return c ? c._egarReady : null; })()');
    if (engineReady !== null) break;
    await sleep(1000);
  }
  check('Egaroucid 引擎就绪', engineReady === true, String(engineReady));

  // 1) 视图与开局
  const boot = await evaluate(`(() => {
    const view = document.getElementById('view-othello');
    const ctrl = window.othelloCtrl;
    const board = ctrl ? Array.from(ctrl.board ?? []) : [];
    const counts = board.reduce((a, v) => { if (v === 1) a.b++; else if (v === 2) a.w++; return a; }, { b: 0, w: 0 });
    return {
      visible: !!view && view.classList.contains('active'),
      hasCtrl: !!ctrl,
      canvas: !!document.getElementById('othello-canvas'),
      turn: document.getElementById('othello-turn')?.textContent || '',
      counts,
      black: document.getElementById('o-black')?.textContent,
      white: document.getElementById('o-white')?.textContent,
    };
  })()`);
  check('黑白棋视图可见', !!boot.visible, JSON.stringify(boot));
  check('控制器与画布就绪', !!boot.hasCtrl && boot.canvas, JSON.stringify(boot));
  check('开局中央四子（黑 2 白 2）', boot.counts.b === 2 && boot.counts.w === 2, JSON.stringify(boot.counts));
  check('计分板显示 2 / 2', boot.black === '2' && boot.white === '2', `${boot.black}/${boot.white}`);
  check('顶栏轮到黑方', /黑方/.test(boot.turn), boot.turn);

  // 2) 人类落子（取一个合法点），验证翻子数与总子数
  const human = await evaluate(`(async () => {
    const ctrl = window.othelloCtrl;
    const legal = ctrl.legalIdx();
    const before = ctrl.board.reduce((a, v) => a + (v ? 1 : 0), 0);
    const idx = legal[0];
    const ok = ctrl.placeHuman(idx);
    // 注意：placeHuman 会立刻触发 AI 应手（异步 setTimeout + worker），
    // 所以必须在同一段同步代码内取快照，await 之后棋盘可能已经变了。
    // AI 应手是异步的：只在这一段同步代码里取快照
    const h = ctrl.history[ctrl.history.length - 1];
    const flipped = h?.flipped ?? -1;
    const snap = Array.from(ctrl.board);
    const placedIsSet = snap[idx] === h.side;   // 落点上就是刚落下的那一方
    // 被翻的棋子现在必须都是自己一方（翻面语义）
    const flippedNowOwn = ctrl.history[ctrl.history.length - 1].flippedCells
      .every((c) => snap[c] === h.side);
    return { legalCount: legal.length, idx, ok, flipped, placedIsSet, flippedNowOwn };
  })()`);
  check('开局有 4 个合法点', human.legalCount === 4, JSON.stringify(human));
  check('人类落子成功', human.ok === true, JSON.stringify(human));
  check('落点上确实是自己刚落下的子', human.placedIsSet === true, JSON.stringify(human));
  check('翻子数 ≥ 1（黑白棋落子必翻子）', human.flipped >= 1, JSON.stringify(human));
  check('被翻的棋子已变成自己一方', human.flippedNowOwn === true, JSON.stringify(human));

  // 2.5) 像素级校验：渲染器把「黑子/白子」画在了对应坐标上
  //      （防止再出现「引擎答案正确、界面画到镜像格」这类问题）
  const pix = await evaluate(`(() => {
    const c = document.getElementById('othello-canvas');
    const ctx = c.getContext('2d');
    const PAD = 40, GAP = (620 - 80) / 8;
    // 对外索引 idx → 画布坐标：画布行 = 7 - (idx>>3)（rank8 在最上）
    const at = (idx) => ctx.getImageData(PAD + (idx & 7) * GAP + GAP / 2, PAD + (7 - (idx >> 3)) * GAP + GAP / 2, 1, 1).data;
    const ctrl = window.othelloCtrl;
    const snap = Array.from(ctrl.board);
    // 取两个已知棋子格与一个空格：中心四子 d4=27 / e4=28
    const d4 = at(27), e4 = at(28), empty = at(0);
    const isBlack = (p) => p[0] < 90 && p[1] < 90 && p[2] < 90;
    const isWhite = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
    return {
      d4: [snap[27], isWhite(d4) ? 'white' : isBlack(d4) ? 'black' : 'other'],
      e4: [snap[28], isWhite(e4) ? 'white' : isBlack(e4) ? 'black' : 'other'],
      cornerEmpty: isBlack(empty) || isWhite(empty) ? 'disc' : 'empty',
    };
  })()`);
  const colorOk = (v) => (v[0] === 1 ? v[1] === 'black' : v[0] === 2 ? v[1] === 'white' : true);
  check('像素校验：d4 白子画在白格', colorOk(pix.d4), JSON.stringify(pix.d4));
  check('像素校验：e4 黑子画在黑格', colorOk(pix.e4), JSON.stringify(pix.e4));

  // 3) 等 AI 应手（普通档预算 400ms，给足余量）
  await sleep(6000);
  const ai = await evaluate(`(() => {
    const ctrl = window.othelloCtrl;
    const total = ctrl.board.reduce((a, v) => a + (v ? 1 : 0), 0);
    return {
      thinking: ctrl.thinking,
      total,
      turn: ctrl.turn,
      status: document.getElementById('o-status')?.textContent || '',
      overlayHidden: document.getElementById('othello-thinking')?.classList.contains('hidden'),
      log: document.getElementById('o-think-log')?.textContent || '',
    };
  })()`);
  check('AI 已应手（总子数 ≥ 5）', ai.total >= 5, JSON.stringify(ai));
  check('AI 思考状态已结束', ai.thinking === false && ai.overlayHidden === true, JSON.stringify(ai));
  check('思考日志记录了 depth/节点', /depth/.test(ai.log), ai.log.slice(0, 120));

  // 4) 悔棋
  const undo = await evaluate(`(() => {
    const ctrl = window.othelloCtrl;
    ctrl.undo();
    const total = ctrl.board.reduce((a, v) => a + (v ? 1 : 0), 0);
    return { total, turn: ctrl.turn, human: ctrl.human, thinking: ctrl.thinking };
  })()`);
  check('悔棋后回到人类回合', undo.turn === undo.human, JSON.stringify(undo));
  check('悔棋后子数减少', undo.total < ai.total, `${undo.total} vs ${ai.total}`);

  // 5) 请神上身（一次 hint 请求）
  const god = await evaluate(`(async () => {
    const ctrl = window.othelloCtrl;
    ctrl.toggleGod();
    await new Promise((r) => setTimeout(r, 6000));
    const has = !!ctrl.godMove;
    const btn = document.getElementById('o-god')?.textContent || '';
    ctrl.toggleGod();
    return { has, btn };
  })()`);
  check('请神上身能算出最佳点', god.has === true, JSON.stringify(god));

  await send('Page.navigate', { url: 'about:blank' });
  ws.close();
  edge.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }

  check('无控制台错误', consoleErrors.length === 0, consoleErrors.join(' | '));
  check('无页面异常', pageErrors.length === 0, pageErrors.join(' | '));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? '✅' : '❌'} 黑白棋冒烟：${checks.length - failed.length}/${checks.length} 通过`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((err) => {
  console.error('冒烟脚本异常：', err);
  try { edge.kill(); } catch { /* ignore */ }
  process.exit(1);
});
