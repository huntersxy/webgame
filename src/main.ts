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
import { setupDemonAssets } from './ui/demon';

// ── Global status helper ──
const statusText = document.getElementById('global-status-text');
function setGlobalStatus(t: string): void {
  if (statusText) statusText.textContent = t;
}
(window as any).setGlobalStatus = setGlobalStatus;

// ── Hash router ──
type ViewName = 'home' | 'tornado' | 'gomoku' | 'campaign' | 'xiangqi' | 'junqi';
const routes = ['home', 'tornado', 'gomoku', 'campaign', 'xiangqi', 'junqi'] as const;

const views: Record<ViewName, HTMLElement | null> = {
  home: document.getElementById('view-home'),
  tornado: document.getElementById('view-tornado'),
  gomoku: document.getElementById('view-gomoku'),
  campaign: document.getElementById('view-campaign'),
  xiangqi: document.getElementById('view-xiangqi'),
  junqi: document.getElementById('view-junqi'),
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
  if (name === 'gomoku' && gomokuCtrl) gomokuCtrl.redraw();
  if (name === 'campaign' && campaignCtrl) campaignCtrl.redraw();
  if (name === 'xiangqi' && xiangqiCtrl) xiangqiCtrl.redraw();
  if (name === 'tornado' && tornadoCtrl) tornadoCtrl.redraw();
  if (name === 'junqi' && junqiCtrl) junqiCtrl.redraw();
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

let gomokuCtrl: GomokuController | null = null;
let xiangqiCtrl: XiangqiController | null = null;
let campaignCtrl: CampaignController | null = null;
let tornadoCtrl: TornadoController | null = null;
let junqiCtrl: JunqiController | null = null;

if (gomokuCanvas) gomokuCtrl = new GomokuController(gomokuCanvas, ai, audio);
if (xiangqiCanvas) xiangqiCtrl = new XiangqiController(xiangqiCanvas, ai, audio);
if (campaignCanvas) campaignCtrl = new CampaignController(campaignCanvas, audio);
if (tornadoCanvas) tornadoCtrl = new TornadoController(tornadoCanvas, audio);
if (junqiCanvas && ai && audio) junqiCtrl = new JunqiController(junqiCanvas, ai, audio);

// ── Demon assets (avatar) ──
setupDemonAssets();

// ── Stats + initial route ──
Stats.refresh();
applyView(routeFromHash());
