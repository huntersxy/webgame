/* ────────────────────────────────────────────────────────────
 *  main.ts — Application entry point
 *  Wires up navigation, shared services, and all game controllers.
 * ──────────────────────────────────────────────────────────── */

import { AIBridge } from './ai/ai-bridge';
import { AudioEngine } from './ui/audio';
import { Stats } from './ui/stats';
import { GomokuController } from './controllers/gomoku-controller';
import { XiangqiController } from './controllers/xiangqi-controller';
import { CampaignController } from './controllers/campaign-controller';
import { setupDemonAssets } from './ui/demon';

// ── Global status helper ──
const statusText = document.getElementById('global-status-text');
function setGlobalStatus(t: string): void {
  if (statusText) statusText.textContent = t;
}
(window as any).setGlobalStatus = setGlobalStatus;

// ── Navigation ──
type ViewName = 'home' | 'gomoku' | 'campaign' | 'xiangqi';
const views: Record<ViewName, HTMLElement | null> = {
  home: document.getElementById('view-home'),
  gomoku: document.getElementById('view-gomoku'),
  campaign: document.getElementById('view-campaign'),
  xiangqi: document.getElementById('view-xiangqi'),
};

function gotoView(name: ViewName): void {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.tab === name));
  Object.entries(views).forEach(([k, el]) => el?.classList.toggle('active', k === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'gomoku' && gomokuCtrl) gomokuCtrl.redraw();
  if (name === 'campaign' && campaignCtrl) campaignCtrl.redraw();
  if (name === 'xiangqi' && xiangqiCtrl) xiangqiCtrl.redraw();
}
(window as any).gotoView = gotoView;

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => gotoView((t as HTMLElement).dataset.tab as ViewName)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => gotoView((b as HTMLElement).dataset.goto as ViewName)));

// ── Shared services ──
const audio = new AudioEngine();
const ai = new AIBridge();

// ── Controllers ──
const gomokuCanvas = document.getElementById('gomoku-canvas') as HTMLCanvasElement | null;
const xiangqiCanvas = document.getElementById('xiangqi-canvas') as HTMLCanvasElement | null;
const campaignCanvas = document.getElementById('camp-canvas') as HTMLCanvasElement | null;

let gomokuCtrl: GomokuController | null = null;
let xiangqiCtrl: XiangqiController | null = null;
let campaignCtrl: CampaignController | null = null;

if (gomokuCanvas) gomokuCtrl = new GomokuController(gomokuCanvas, ai, audio);
if (xiangqiCanvas) xiangqiCtrl = new XiangqiController(xiangqiCanvas, ai, audio);
if (campaignCanvas) campaignCtrl = new CampaignController(campaignCanvas, audio);

// ── Demon assets (logo + 褚赢 avatar) ──
setupDemonAssets();

// ── Stats ──
Stats.refresh();
