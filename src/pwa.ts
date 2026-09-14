/* ────────────────────────────────────────────────────────────
 *  pwa.ts — Service Worker 注册与存储持久化
 *
 *  两件事，都是为了把「离线可玩」从宣传语变成事实：
 *
 *  1) 注册 Service Worker。应用外壳（HTML / JS / CSS / 图标）在安装时预缓存，
 *     引擎资产（rapfi / go / xqnn / xqwlight / egaroucid，合计约 27MB）走运行时
 *     CacheFirst——玩家真正用过哪个引擎，哪个引擎才落盘。见 vite.config.ts。
 *
 *  2) 为引擎权重申请持久化存储。浏览器的 Cache Storage 在磁盘紧张时会被整体
 *     回收，一旦被回收，玩家下次开局要重新下几十 MB。`persist()` 只是「申请」，
 *     被拒绝也不影响游戏，所以这里不做任何 UI 打扰。
 *
 *  为什么不用 vite-plugin-pwa 的 `virtual:pwa-register`：它把脚本地址硬编码成
 *  `/sw.js`，没法带版本参数，而版本参数正是我们防中间层缓存的那道防线（见
 *  vite.config.ts 的 resolveBuildId 注释）。代价是要自己接 SW 生命周期，
 *  逻辑就是下面 watchForUpdates / activateWaiting 两个函数。
 *
 *  更新策略：故意不自动刷新。整页刷新会毁掉正在进行的一盘棋，所以新版本就绪
 *  时只在右下角提示，由玩家决定何时刷新。
 * ──────────────────────────────────────────────────────────── */

/** 引擎权重合计约 27MB，申请持久化以免被浏览器在磁盘紧张时回收 */
async function requestPersistentStorage(): Promise<void> {
  try {
    const storage = navigator.storage;
    if (!storage?.persist) return;
    if (await storage.persisted()) return;
    const granted = await storage.persist();
    if (!granted) console.info('[pwa] 未获得持久化存储授权，引擎缓存仍可能被回收');
  } catch {
    /* 不支持或被拒绝都不影响游戏，静默跳过 */
  }
}

/** 右下角提示条；点一下才刷新 */
function showUpdateToast(apply: () => void): void {
  if (document.querySelector('.sw-toast')) return;
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'sw-toast';
  el.textContent = '新版本已就绪，点击刷新';
  el.addEventListener('click', () => {
    el.remove();
    apply();
  });
  document.body.appendChild(el);
}

let offlineToastShown = false;

function showOfflineToast(): void {
  if (offlineToastShown) return;
  offlineToastShown = true;
  const el = document.createElement('div');
  el.className = 'sw-toast sw-toast-info';
  el.textContent = '已缓存到本地，断网也能开局';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/**
 * 让等待中的新 SW 立刻接管。
 *
 * 必须先挂 controllerchange 再发消息：新 SW 接管的那一刻才触发
 * controllerchange，此时刷新才真正落到新版本；顺序反过来（先刷新）刷完
 * 还是旧 SW 在控制页面，等于白刷。
 */
function activateWaiting(registration: ServiceWorkerRegistration): void {
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  // 生成的 sw.js 里有对应的 SKIP_WAITING 监听（skipWaiting: false 时 Workbox 会带上）
  registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
}

/** 区分「首次装好、可以离线玩」和「已有新版本、等你刷新」两种状态 */
function watchForUpdates(registration: ServiceWorkerRegistration): void {
  // 页面加载时就已经处于 waiting（比如上次没点刷新就关掉了标签页）
  if (registration.waiting && navigator.serviceWorker.controller) {
    showUpdateToast(() => activateWaiting(registration));
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state !== 'installed') return;
      // 有 controller 才是「更新」；没有就是首次安装完成
      if (navigator.serviceWorker.controller) showUpdateToast(() => activateWaiting(registration));
      else showOfflineToast();
    });
  });
}

async function registerServiceWorker(): Promise<void> {
  const base = import.meta.env.BASE_URL || '/';
  try {
    // 两重保险，防止任何中间层把旧 sw.js 塞回来：
    //   · URL 带构建版本 —— 缓存键不同，无视 Cache-Control 的 CDN 也拦不住
    //   · updateViaCache: 'none' —— 连 SW 脚本本身都不走 HTTP 缓存
    const registration = await navigator.serviceWorker.register(`${base}sw.js?v=${__BUILD_ID__}`, {
      scope: base,
      updateViaCache: 'none',
    });
    watchForUpdates(registration);
  } catch (err) {
    // 注册失败只是失去离线能力，在线游玩不受影响
    console.warn('[pwa] Service Worker 注册失败：', err);
  }
}

/** 由 main.ts 调用一次。开发环境不注册（插件 devOptions 已关）。 */
export function setupPWA(): void {
  void requestPersistentStorage();
  if (!('serviceWorker' in navigator)) return;
  // 等 load 之后再注册，别和首屏资源抢带宽
  if (document.readyState === 'complete') void registerServiceWorker();
  else window.addEventListener('load', () => void registerServiceWorker(), { once: true });
}
