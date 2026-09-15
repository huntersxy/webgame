/* ────────────────────────────────────────────────────────────
 *  main.ts — Application entry: hash router + shared services
 *  Routes: #/ home · #/gomoku · #/campaign · #/xiangqi
 * ──────────────────────────────────────────────────────────── */

import { AIBridge } from './ai/ai-bridge';
import { AudioEngine } from './ui/audio';
import { Stats } from './ui/stats';
import { GomokuController } from './controllers/gomoku-controller';
import { XiangqiController } from './controllers/xiangqi-controller';
import { CampaignController } from './controllers/campaign-controller';
import { TornadoController } from './controllers/tornado-controller';
import { JunqiController } from './controllers/junqi-controller';
import { GoController } from './controllers/go-controller';
import { OthelloController } from './controllers/othello-controller';
import { DoudizhuController } from './controllers/ddz-controller';
import { setupDemonAssets } from './ui/demon';
import { setupPWA } from './pwa';
import { mustEl } from './ui/dom';

// ── Global status helper ──
const statusText = mustEl('global-status-text');
function setGlobalStatus(t: string): void {
  statusText.textContent = t;
}
(window as any).setGlobalStatus = setGlobalStatus;

// ── Hash router ──
type ViewName = 'home' | 'tornado' | 'gomoku' | 'campaign' | 'othello' | 'xiangqi' | 'junqi' | 'go' | 'ddz';
const routes = ['home', 'tornado', 'gomoku', 'campaign', 'othello', 'xiangqi', 'junqi', 'go', 'ddz'] as const;

const views: Record<ViewName, HTMLElement> = {
  home: mustEl('view-home'),
  tornado: mustEl('view-tornado'),
  gomoku: mustEl('view-gomoku'),
  campaign: mustEl('view-campaign'),
  othello: mustEl('view-othello'),
  xiangqi: mustEl('view-xiangqi'),
  junqi: mustEl('view-junqi'),
  go: mustEl('view-go'),
  ddz: mustEl('view-ddz'),
};

function isView(v: string): v is ViewName {
  return (routes as readonly string[]).includes(v);
}

function gotoView(name: ViewName): void {
  if (location.hash !== `#/${name}`) {
    location.hash = `#/${name}`;
    return; // hashchange handler will do the actual switch
  }
  applyView(name);
}

function applyView(name: ViewName): void {
  document.querySelectorAll('.tab').forEach((t) => {
    const tab = (t as HTMLElement).dataset.tab as ViewName | 'xiangqi';
    // campaign is a sub-view of gomoku → keep gomoku highlighted
    const active = tab === name || (name === 'campaign' && tab === 'gomoku');
    t.classList.toggle('active', active);
  });
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('active', k === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'gomoku') {
    gomokuCtrl.redraw();
    gomokuCtrl.warmUp();
  }
  if (name === 'campaign') campaignCtrl.redraw();
  if (name === 'othello') {
    othelloCtrl.redraw();
    othelloCtrl.warmUp();
  }
  if (name === 'xiangqi') {
    xiangqiCtrl.redraw();
    xiangqiCtrl.warmUp();
  }
  if (name === 'tornado') tornadoCtrl.redraw();
  if (name === 'junqi') junqiCtrl.redraw();
  if (name === 'go') {
    goCtrl.redraw();
    goCtrl.warmUp();
  }
  if (name === 'ddz') {
    ddzCtrl.redraw();
    ddzCtrl.warmUp();
  }
}

function routeFromHash(): ViewName {
  const h = location.hash.replace(/^#\/?/, '');
  return isView(h) ? h : 'home';
}

window.addEventListener('hashchange', () => applyView(routeFromHash()));

// nav buttons
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => gotoView((t as HTMLElement).dataset.tab as ViewName)));
document
  .querySelectorAll('[data-goto]')
  .forEach((b) => b.addEventListener('click', () => gotoView((b as HTMLElement).dataset.goto as ViewName)));

// ── Shared services ──
const audio = new AudioEngine();
const ai = new AIBridge();

// ── Controllers ──
const gomokuCanvas = mustEl<HTMLCanvasElement>('gomoku-canvas');
const xiangqiCanvas = mustEl<HTMLCanvasElement>('xiangqi-canvas');
const campaignCanvas = mustEl<HTMLCanvasElement>('camp-canvas');
const tornadoCanvas = mustEl<HTMLCanvasElement>('t-canvas');
const junqiCanvas = mustEl<HTMLCanvasElement>('jq-canvas');
const goCanvas = mustEl<HTMLCanvasElement>('go-canvas');
const othelloCanvas = mustEl<HTMLCanvasElement>('othello-canvas');

const gomokuCtrl = new GomokuController(gomokuCanvas, ai, audio);
const xiangqiCtrl = new XiangqiController(xiangqiCanvas, ai, audio);
const campaignCtrl = new CampaignController(campaignCanvas, audio);
const tornadoCtrl = new TornadoController(tornadoCanvas, audio);
const junqiCtrl = new JunqiController(junqiCanvas, ai, audio);
const goCtrl = new GoController(goCanvas, ai, audio);
const othelloCtrl = new OthelloController(othelloCanvas, ai, audio);
const ddzCtrl = new DoudizhuController(audio);
// 暴露给控制台/自动化冒烟使用（scripts/othello-smoke.mjs）
(window as any).othelloCtrl = othelloCtrl;

// ── Demon assets (avatar) ──
setupDemonAssets();

// ── Rapfi 引擎预取 ──
// 五子棋是站内主打，首次进对局要下载约 10MB 的 NNUE 权重包。
// 首页停留 1.2 秒后就在后台取好（顶栏会显示百分比），玩家点进对局时通常
// 已经下完或下到一半——把这段下载藏在“决定玩什么”的时间里。
// 开了省流量或走在 2G/慢速网络上则跳过，不替用户决定花这些流量。
function prefetchGomokuEngine(): void {
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData) return;
  if (conn?.effectiveType && /^(slow-)?2g$/.test(conn.effectiveType)) return;
  gomokuCtrl.warmUp();
}
if (routeFromHash() === 'home') setTimeout(prefetchGomokuEngine, 1200);

// ── Stats + initial route ──
Stats.refresh();
// 首屏应用路由：刷新时浏览器可能还没派发 hashchange，
// 若此时恰好有控制器在构造期抛错，整个模块会中断、页面停在首页。
// 这里包一层，保证「路由此刻决定」这件事本身不会因为某个游戏初始化失败而失效。
try {
  applyView(routeFromHash());
} catch (err) {
  console.error('[router] 首次应用路由失败，回退首页', err);
  applyView('home');
}
// 再补一次：模块执行完后浏览器才补发的 hashchange 会被上面的监听接住，
// 但若初始 hash 与默认首页相同则不会触发，这里显式对齐一次状态。
window.addEventListener('load', () => applyView(routeFromHash()));

// ── PWA：离线缓存与引擎权重的持久化存储 ──
setupPWA();
