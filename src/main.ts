/* ────────────────────────────────────────────────────────────
 *  main.ts — Application entry: hash router + shared services
 *  Routes: #/ home · #/gomoku · #/campaign · #/xiangqi
 * ──────────────────────────────────────────────────────────── */

import { AIBridge } from './ai/ai-bridge';
import { AudioEngine } from './ui/audio';
import { Stats } from './ui/stats';
import type { TornadoController } from './controllers/tornado-controller';
import { setupDemonAssets } from './ui/demon';
import { setupPWA, beginSession } from './pwa';
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
  // 视图切换的 UI 部分是同步的；控制器按需懒加载，进入动作异步执行——
  // 迟到的回调会先核对当前 hash，用户已切走就直接丢弃（见 activate）。
  void activate(name);
  // 龙卷风页占用一次「会话」：占用期间 PWA 的自动刷新会推迟，避免把
  // Ruffle 实例连同存档一起刷掉。离开该页即释放。
  syncTornadoSession(name === 'tornado');
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

// ── Controllers（按视图懒加载）────────────────────────────
// 每个棋类只在首次进入对应页面时才动态导入并构造：入口 JS 不再一次性打进
// 8 个控制器及其棋规/渲染代码（约 220KB 源码），只逛首页的访客不会下载、
// 解析它们。构造期抛错也只会终结这一次进入动作，不再能打断整个模块。
const gomokuCanvas = mustEl<HTMLCanvasElement>('gomoku-canvas');
const xiangqiCanvas = mustEl<HTMLCanvasElement>('xiangqi-canvas');
const campaignCanvas = mustEl<HTMLCanvasElement>('camp-canvas');
const junqiCanvas = mustEl<HTMLCanvasElement>('jq-canvas');
const goCanvas = mustEl<HTMLCanvasElement>('go-canvas');
const othelloCanvas = mustEl<HTMLCanvasElement>('othello-canvas');

// 构造完成前为 null。按钮只在该页可见，而页面显示时控制器已在构造中
// （动态导入毫秒级），实际点不到「看得见却还是 null」的窗口。
let tornadoCtrl: TornadoController | null = null;

const ctrlLoaders = {
  gomoku: () => import('./controllers/gomoku-controller').then((m) => new m.GomokuController(gomokuCanvas, ai, audio)),
  xiangqi: () => import('./controllers/xiangqi-controller').then((m) => new m.XiangqiController(xiangqiCanvas, ai, audio)),
  campaign: () => import('./controllers/campaign-controller').then((m) => new m.CampaignController(campaignCanvas, audio)),
  junqi: () => import('./controllers/junqi-controller').then((m) => new m.JunqiController(junqiCanvas, ai, audio)),
  go: () => import('./controllers/go-controller').then((m) => new m.GoController(goCanvas, ai, audio)),
  othello: () =>
    import('./controllers/othello-controller').then((m) => {
      const ctrl = new m.OthelloController(othelloCanvas, ai, audio);
      // 暴露给控制台/自动化冒烟使用（scripts/othello-smoke.mjs）
      (window as any).othelloCtrl = ctrl;
      return ctrl;
    }),
  ddz: () => import('./controllers/ddz-controller').then((m) => new m.DoudizhuController(audio)),
  // 龙卷风页跑的是原作 Flash 游戏本体，控制器只负责装配 Ruffle 运行时。
  tornado: () =>
    import('./controllers/tornado-controller').then((m) => {
      tornadoCtrl = new m.TornadoController(mustEl('t-stage'), mustEl('t-status'));
      return tornadoCtrl;
    }),
} as const;

type CtrlName = keyof typeof ctrlLoaders;
type CtrlOf<V extends CtrlName> = Awaited<ReturnType<(typeof ctrlLoaders)[V]>>;
const ctrlCache = new Map<CtrlName, Promise<unknown>>();

/** 首次进入某视图时动态导入并构造其控制器；失败即清缓存，下次进入重试。 */
function ensureCtrl<V extends CtrlName>(name: V): Promise<CtrlOf<V>> {
  const hit = ctrlCache.get(name);
  if (hit) return hit as Promise<CtrlOf<V>>;
  const loader = ctrlLoaders[name] as unknown as () => Promise<CtrlOf<V>>;
  const guarded = loader().catch((err: unknown) => {
    ctrlCache.delete(name);
    throw err;
  });
  ctrlCache.set(name, guarded);
  return guarded;
}

/** 进入动作：等控制器就绪后执行；期间用户可能切走，以当前 hash 核对，过期即丢弃。 */
async function activate(name: ViewName): Promise<void> {
  try {
    switch (name) {
      case 'home':
        return;
      case 'tornado': {
        const c = await ensureCtrl('tornado');
        if (routeFromHash() !== name) return;
        c.start();
        return;
      }
      case 'gomoku': {
        const c = await ensureCtrl('gomoku');
        if (routeFromHash() !== name) return;
        c.redraw();
        c.warmUp();
        return;
      }
      case 'campaign': {
        const c = await ensureCtrl('campaign');
        if (routeFromHash() !== name) return;
        c.redraw();
        return;
      }
      case 'othello': {
        const c = await ensureCtrl('othello');
        if (routeFromHash() !== name) return;
        c.redraw();
        c.warmUp();
        return;
      }
      case 'xiangqi': {
        const c = await ensureCtrl('xiangqi');
        if (routeFromHash() !== name) return;
        c.redraw();
        c.warmUp();
        return;
      }
      case 'junqi': {
        const c = await ensureCtrl('junqi');
        if (routeFromHash() !== name) return;
        c.redraw();
        return;
      }
      case 'go': {
        const c = await ensureCtrl('go');
        if (routeFromHash() !== name) return;
        c.redraw();
        c.warmUp();
        return;
      }
      case 'ddz': {
        const c = await ensureCtrl('ddz');
        if (routeFromHash() !== name) return;
        c.redraw();
        c.warmUp();
      }
    }
  } catch (err) {
    console.error(`[router] 「${name}」页面初始化失败`, err);
  }
}

// ── 龙卷风页按钮（控制器懒加载，回调时可能尚未构造，空值保护） ──
mustEl('t-restart').addEventListener('click', () => void tornadoCtrl?.restart());
// 全屏按钮在「进入全屏」与「退出全屏」之间切换：手机没有 ESC 也没有 F11，
// 必须给一个屏幕上的出口，否则用户会被困在全屏里。
const fsBtn = mustEl<HTMLButtonElement>('t-fullscreen');
const syncFullscreenBtn = (): void => {
  const on = tornadoCtrl?.isFullscreen() ?? false;
  fsBtn.textContent = on ? '⛶ 退出全屏' : '⛶ 全屏横屏';
  fsBtn.setAttribute('aria-label', on ? '退出全屏' : '全屏横屏游玩');
};
fsBtn.addEventListener('click', () => {
  if (tornadoCtrl) void (tornadoCtrl.isFullscreen() ? tornadoCtrl.exitFullscreen() : tornadoCtrl.enterFullscreen());
});
// 全屏状态可能由用户按 Esc / 系统返回键改变，以事件为准同步按钮文案
document.addEventListener('fullscreenchange', syncFullscreenBtn);
document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);
syncFullscreenBtn();
// 手机没有 ESC 键，而游戏用它暂停，单独给一个按钮
mustEl('t-esc').addEventListener('click', () => tornadoCtrl?.sendEscape());

// ── 龙卷风页：进入即声明「有会话在进行」 ──
// Flash 游戏的存档在 Ruffle 实例里，实例随页面刷新一起销毁。PWA 的自动更新
// 会整页刷新，跑着的存档就被抹掉——表现成「怎么玩都不存档」。所以进游戏页就
// 占用会话、离开就释放；占用期间 PWA 的自动接管会推迟到释放之后再做。
let releaseTornadoSession: (() => void) | null = null;
const syncTornadoSession = (active: boolean): void => {
  if (active && !releaseTornadoSession) releaseTornadoSession = beginSession();
  else if (!active && releaseTornadoSession) {
    releaseTornadoSession();
    releaseTornadoSession = null;
  }
};

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
  // 控制器现为懒加载：这里先拉块再预热，把导入开销也藏进这 1.2 秒里
  void ensureCtrl('gomoku')
    .then((c) => c.warmUp())
    .catch((err) => console.error('[prefetch] 五子棋引擎预取失败', err));
}
if (routeFromHash() === 'home') setTimeout(prefetchGomokuEngine, 1200);

// ── Stats + initial route ──
Stats.refresh();
// 首屏应用路由：刷新时浏览器可能还没派发 hashchange。控制器已是懒加载，
// 构造期错误落在 activate 的 catch 里、不会中断模块；这里包一层只兜住
// 同步的视图切换（tab/DOM 状态）本身，保证路由此刻必然被应用。
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
