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
 *  更新策略：**新版本就绪即自动接管并刷新**。
 *
 *  早先是「右下角提示、玩家自己点」，理由是整页刷新会毁掉正在进行的一盘棋。
 *  实践中发现这个策略在纯静态站点上会自锁：入口 HTML 里那句
 *  `sw.js?v=<构建号>` 来自**被旧 SW 缓存**的 HTML，构建号永远不变，于是浏览器
 *  始终注册同一个旧脚本，新版本装好了也只会停在 waiting，访客怎么刷都是旧版。
 *  现在改为自动接管 + 刷新，并保留 reloadGuard 防止异常时刷成死循环。
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
 * 让等待中的新 SW 立刻接管，接管后自动刷新到新版本。
 *
 * 必须先挂 controllerchange 再发消息：新 SW 接管的那一刻才触发
 * controllerchange，此时刷新才真正落到新版本；顺序反过来（先刷新）刷完
 * 还是旧 SW 在控制页面，等于白刷。
 *
 * 为什么改成自动接管：静态站点的入口 HTML 里写着 `sw.js?v=<构建号>`，
 * 而这份 HTML 本身是**被旧 SW 缓存着**下发的。于是浏览器永远用旧构建号去
 * 注册、永远发现不了新 SW，新版本装好也只会停在 waiting —— 自锁。
 * 用户看到的是「怎么刷都是旧版」，只能靠手动清缓存。自动接管打破这个循环。
 *
 * 代价是刷新会打断正在进行的一局。这里的取舍是：**宁可能刷新到新版**。
 * 各游戏的状态都在内存里，刷新即丢；但相比「永远拿不到更新」，这是更小的损失。
 */
function activateWaiting(registration: ServiceWorkerRegistration): void {
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  // 生成的 sw.js 里有对应的 SKIP_WAITING 监听（skipWaiting: false 时 Workbox 会带上）
  registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
}

/** 本次会话的重载计数键，避免更新链路异常时把页面刷成死循环 */
const RELOAD_KEY = 'pwa-reload-guard';

function reloadGuardAllows(): boolean {
  try {
    const now = Date.now();
    const raw = sessionStorage.getItem(RELOAD_KEY);
    const prev = raw ? (JSON.parse(raw) as { at: number; n: number }) : { at: 0, n: 0 };
    // 30 秒内连续重载超过 2 次，判定为异常，停手
    const n = now - prev.at < 30_000 ? prev.n + 1 : 1;
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ at: now, n }));
    return n <= 2;
  } catch {
    return true;
  }
}

/**
 * 监听 SW 更新：新版本一就绪就自动接管 + 刷新。
 *
 * `updateViaCache: 'none'` 只保证不去读 HTTP 缓存里的 sw.js，但**不能**阻止
 * 当前页面用旧的构建号去注册。真正的兜底是下面这个 update()：它按 scope 去
 * 请求 sw.js，绕开入口 HTML 里那个写死的版本参数。
 */
function watchForUpdates(registration: ServiceWorkerRegistration): void {
  // 页面加载时就已处于 waiting（上次没刷新的场景），直接接管
  if (registration.waiting && navigator.serviceWorker.controller) {
    activateWaiting(registration);
    return;
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state !== 'installed') return;
      // 有 controller 才是「更新」；没有就是首次安装完成
      if (navigator.serviceWorker.controller) {
        if (reloadGuardAllows()) activateWaiting(registration);
      } else {
        showOfflineToast();
      }
    });
  });
}

/**
 * 拿到 SW 注册对象。
 *
 * 关键点：**先按 scope 注册一次不带版本参数的 sw.js**，再补一次带构建号的。
 *
 * 为什么要多这一步：入口 HTML 里写死的 `sw.js?v=<构建号>` 来自被旧 SW 缓存
 * 的那份 HTML，长期不变；拿它去 register 只会反复注册同一个旧脚本，新版本
 * 永远发现不了。先用无参 URL 注册一次，浏览器就会按默认规则去取最新的 sw.js
 * 并与已装版本比对，从而跳出这个循环。带构建号的那次仍保留，用来防中间层
 * 把旧 sw.js 塞回来。
 */
async function registerServiceWorker(): Promise<void> {
  const base = import.meta.env.BASE_URL || '/';
  try {
    // ① 无参注册：让浏览器自己发现新版本（打破旧构建号的自锁）
    const registration = await navigator.serviceWorker.register(`${base}sw.js`, {
      scope: base,
      updateViaCache: 'none',
    });

    // ② 带构建号再注册一次：缓存键随版本变化，无视 Cache-Control 的 CDN 拦不住
    await navigator.serviceWorker.register(`${base}sw.js?v=${__BUILD_ID__}`, {
      scope: base,
      updateViaCache: 'none',
    });

    watchForUpdates(registration);

    // ③ 主动查一次更新。页面可能是旧 SW 控制的，这一步能立刻发现并接上新版本。
    void registration.update().catch(() => {
      /* 离线或网络抖动时失败无妨，下次加载会再试 */
    });

    // ④ 页面重新可见时再查一次：标签页常年挂着也能等到新版本
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void registration.update().catch(() => {
          /* 同上，静默失败 */
        });
      }
    });
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
