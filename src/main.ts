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
import { setupDemonAssets } from './ui/demon';

// ── Global status helper ──
const statusText = document.getElementById('global-status-text');
function setGlobalStatus(t: string): void {
  if (statusText) statusText.textContent = t;
}
(window as any).setGlobalStatus = setGlobalStatus;

// ── Hash router ──
type ViewName = 'home' | 'tornado' | 'gomoku' | 'campaign' | 'xiangqi' | 'junqi' | 'go';
const routes = ['home', 'tornado', 'gomoku', 'campaign', 'xiangqi', 'junqi', 'go'] as const;

const views: Record<ViewName, HTMLElement | null> = {
  home: document.getElementById('view-home'),
  tornado: document.getElementById('view-tornado'),
  gomoku: document.getElementById('view-gomoku'),
  campaign: document.getElementById('view-campaign'),
  xiangqi: document.getElementById('view-xiangqi'),
  junqi: document.getElementById('view-junqi'),
  go: document.getElementById('view-go'),
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
  Object.entries(views).forEach(([k, el]) => el?.classList.toggle('active', k === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'gomoku' && gomokuCtrl) { gomokuCtrl.redraw(); gomokuCtrl.warmUp(); }
  if (name === 'campaign' && campaignCtrl) campaignCtrl.redraw();
  if (name === 'xiangqi' && xiangqiCtrl) { xiangqiCtrl.redraw(); xiangqiCtrl.warmUp(); }
  if (name === 'tornado' && tornadoCtrl) tornadoCtrl.redraw();
  if (name === 'junqi' && junqiCtrl) junqiCtrl.redraw();
  if (name === 'go' && goCtrl) { goCtrl.redraw(); goCtrl.warmUp(); }
}

function routeFromHash(): ViewName {
  const h = location.hash.replace(/^#\/?/, '');
  return isView(h) ? h : 'home';
}

window.addEventListener('hashchange', () => applyView(routeFromHash()));

// nav buttons
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => gotoView((t as HTMLElement).dataset.tab as ViewName)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => gotoView((b as HTMLElement).dataset.goto as ViewName)));

// ── Shared services ──
const audio = new AudioEngine();
const ai = new AIBridge();

// ── Controllers ──
const gomokuCanvas = document.getElementById('gomoku-canvas') as HTMLCanvasElement | null;
const xiangqiCanvas = document.getElementById('xiangqi-canvas') as HTMLCanvasElement | null;
const campaignCanvas = document.getElementById('camp-canvas') as HTMLCanvasElement | null;
const tornadoCanvas = document.getElementById('t-canvas') as HTMLCanvasElement | null;
const junqiCanvas = document.getElementById('jq-canvas') as HTMLCanvasElement | null;
const goCanvas = document.getElementById('go-canvas') as HTMLCanvasElement | null;

let gomokuCtrl: GomokuController | null = null;
let xiangqiCtrl: XiangqiController | null = null;
let campaignCtrl: CampaignController | null = null;
let tornadoCtrl: TornadoController | null = null;
let junqiCtrl: JunqiController | null = null;
let goCtrl: GoController | null = null;

if (gomokuCanvas) gomokuCtrl = new GomokuController(gomokuCanvas, ai, audio);
if (xiangqiCanvas) xiangqiCtrl = new XiangqiController(xiangqiCanvas, ai, audio);
if (campaignCanvas) campaignCtrl = new CampaignController(campaignCanvas, audio);
if (tornadoCanvas) tornadoCtrl = new TornadoController(tornadoCanvas, audio);
if (junqiCanvas && ai && audio) junqiCtrl = new JunqiController(junqiCanvas, ai, audio);
if (goCanvas && ai && audio) goCtrl = new GoController(goCanvas, ai, audio);

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
  gomokuCtrl?.warmUp();
}
if (routeFromHash() === 'home') setTimeout(prefetchGomokuEngine, 1200);

// ── Stats + initial route ──
Stats.refresh();
applyView(routeFromHash());
