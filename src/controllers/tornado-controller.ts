/* ────────────────────────────────────────────────────────────
 *  tornado-controller.ts — 《龙卷风牧场》Flash 游戏宿主
 *
 *  这一页跑的是原作 Flash 游戏本体，由自托管的 Ruffle（编译成
 *  WebAssembly 的 Flash 播放器）解释执行，访客不需要安装任何插件，
 *  也不需要联网去第三方站点取资源。
 *
 *  运行时的装配方式：
 *    · Ruffle 的脚本与 .wasm 放在 public/ruffle/（见 scripts/copy-ruffle.mjs）。
 *      ruffle.js 在运行时按固定哈希名去 fetch 自己的 core 分块与 wasm，
 *      这些引用 bundler 看不见，所以必须原样放在 public/ 下。
 *    · 游戏本体是 public/games/tornado-ranch/game.swf（640×480、AS3）。
 *    · 脚本按需注入：只有真正进到这一页才开始下载，不拖慢首屏。
 *
 *  为什么不做「离开页面就卸载」：这一页的进度（关卡、存档）都在 SWF 内，
 *  卸载等于丢进度。Ruffle 实例常驻，切换标签页不会重开游戏。
 * ──────────────────────────────────────────────────────────── */

/** Ruffle 运行时的对外形态（只声明本模块用到的部分） */
interface RuffleApi {
  load(url: string, options?: { base?: string }): Promise<void>;
  exitFullscreen?(): Promise<void>;
}

interface RufflePlayerElement extends HTMLElement {
  ruffle(): RuffleApi;
  /** Ruffle 自带的只读全屏状态（进入全屏走原生 API，见下方说明） */
  isFullscreen?: boolean;
}

interface RuffleSource {
  createPlayer(): RufflePlayerElement;
}

interface RuffleGlobal {
  config?: Record<string, unknown>;
  newest?: () => RuffleSource;
}

declare global {
  interface Window {
    RufflePlayer?: RuffleGlobal;
  }
}

const BASE = import.meta.env.BASE_URL || '/';
const RUFFLE_DIR = `${BASE}ruffle/`;
const GAME_SWF = `${BASE}games/tornado-ranch/game.swf`;

/**
 * ── 让存档及时落盘 ──
 *
 * Ruffle 把 Flash 的 SharedObject 存进 localStorage（源码 web/src/storage.rs：
 * 直接用 SharedObject 的名字当键，值 base64），而 localStorage 本来就跨刷新
 * 保留——所以「刷新丢存档」的根子不在持久化，而在**落盘时机**：
 *
 *   Ruffle 只在两个时机 flush_shared_objects()：实例销毁与 window 的
 *   `pagehide`。而 `pagehide` 经常来不及跑（后台标签页被丢弃、进程被回收、
 *   页面被强制刷新），内存里的存档就跟着没了。
 *
 * 它没有暴露任何 flush 接口（公开 API 只有 load/reload/play/pause/全屏那几个），
 * 但 `pagehide` 处理本身就是它注册的普通监听器，所以这里主动派发一次
 * `pagehide`，借它自己的通路把存档刷下来。这是用它既有的机制，不是绕过它。
 */
const SOL_KEY = /\//;

/** 派发一次 pagehide，促使 Ruffle 把内存里的 SharedObject 刷进 localStorage */
function flushSaves(): void {
  syntheticPagehide = true;
  try {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  } catch {
    /* 极老浏览器没有 PageTransitionEvent：退化为普通事件，Ruffle 照样会收到 */
    window.dispatchEvent(new Event('pagehide'));
  } finally {
    syntheticPagehide = false;
  }
}

/**
 * 区分「真实的页面离开」与「我们自己派发的促刷事件」。
 *
 * 促刷就是靠派发 pagehide 实现的，而这里又要监听 pagehide 做收尾汇报——
 * 不加标记的话，自己派发的事件会被自己的监听器收到，每 3 秒刷一条
 * 「离开页面」，把控制台淹没（实测一次运行刷出几十条）。
 */
let syntheticPagehide = false;

/** 列出 localStorage 里 Ruffle 的存档键（键名形如 `<host>/<path>/<名称>`） */
function listSaveKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      // Ruffle 的键含斜杠；排除本站自己的键与杀软注入的键
      if (k && SOL_KEY.test(k) && !/^(workbox|pwa-|__imt|tornado\.)/.test(k)) keys.push(k);
    }
  } catch {
    /* 存储不可用 */
  }
  return keys;
}

/** 注入 ruffle.js 一次；重复调用共用同一个 Promise */
let ruffleScriptPromise: Promise<void> | null = null;

function loadRuffleScript(): Promise<void> {
  if (ruffleScriptPromise) return ruffleScriptPromise;
  ruffleScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-ruffle-runtime]');
    if (existing) {
      if (window.RufflePlayer?.newest) resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = `${RUFFLE_DIR}ruffle.js`;
    s.async = true;
    s.dataset.ruffleRuntime = '';
    s.addEventListener('load', () => resolve(), { once: true });
    s.addEventListener('error', () => reject(new Error(`无法加载 Flash 运行时（${s.src}）`)), { once: true });
    document.head.appendChild(s);
  });
  return ruffleScriptPromise;
}

/** ruffle.js 注入后还要等它把自己装配好，newest() 才是函数 */
async function waitForRuffle(timeoutMs = 20000): Promise<RuffleSource> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const player = window.RufflePlayer;
    // 注意必须作为方法调用：newest() 内部依赖 this（会读 this.sources），
    // 取出来单独调用会因 this 为 undefined 而抛错。
    if (player && typeof player.newest === 'function') {
      const source = player.newest();
      if (source && typeof source.createPlayer === 'function') return source;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error('Flash 运行时初始化超时');
}

/** 浏览器是否具备运行 Ruffle 的基本条件 */
function webAssemblyUsable(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function';
}

/**
 * 可加锁的方向接口。
 *
 * 不写成 `extends ScreenOrientation`：标准类型里 `lock` 与 `orientation`
 * 都是必有的，而这里要表达的是「可能不存在」——Safari 只有带前缀的实现，
 * 桌面浏览器则完全没有锁定能力，必须按可选处理。
 */
interface LockableOrientation {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
}

interface LockableScreen {
  orientation?: LockableOrientation;
  lockOrientation?: (orientation: string) => boolean;
  mozLockOrientation?: (orientation: string) => boolean;
}

export class TornadoController {
  private readonly host: HTMLElement;
  private readonly status: HTMLElement;
  private player: RufflePlayerElement | null = null;
  private booted = false;
  private busy = false;
  /** 存档落盘定时器；null = 未启动 */
  private flushTimer: number | null = null;
  /** 上次见到的存档键签名，用于只在变化时打日志 */
  private lastKeys = '';

  constructor(host: HTMLElement, status: HTMLElement) {
    this.host = host;
    this.status = status;
  }

  /** 视图首次激活时调用：注入运行时并载入游戏 */
  start(): void {
    if (this.booted) return;
    this.booted = true;
    void this.boot();
  }

  /** 「重新开始」：重新载入 SWF，等价于把游戏退回标题页 */
  async restart(): Promise<void> {
    if (!this.player || this.busy) return;
    this.busy = true;
    try {
      this.setStatus('正在重新开始…');
      await this.player.ruffle().load(GAME_SWF);
      this.setStatus('');
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy = false;
    }
  }

  /** 是否处于全屏（游戏内的全屏也计入） */
  isFullscreen(): boolean {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    return Boolean(document.fullscreenElement ?? doc.webkitFullscreenElement ?? this.player?.isFullscreen);
  }

  /**
   * 进入全屏并尽量转成横屏。
   *
   * 没有用 Ruffle 自带的全屏：它的入口在播放器右键菜单里，移动端没有右键；
   * 且其公开 API 只有 exitFullscreen / isFullscreen，没有 enterFullscreen。
   * 这里直接对舞台元素调用原生全屏，再把方向锁到横屏（不支持锁定的浏览器
   * 会忽略，用户手动横过手机即可）。
   */
  async enterFullscreen(): Promise<void> {
    const el = this.host.parentElement ?? this.host;
    const target = el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    try {
      if (target.requestFullscreen) await target.requestFullscreen({ navigationUI: 'hide' });
      else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen();
      else throw new Error('当前浏览器不支持全屏');
      // 方向锁定必须在全屏之后调用，否则会被拒绝
      await this.lockLandscape();
    } catch (err) {
      console.warn('[tornado] 进入全屏失败', err);
      this.setStatus('无法进入全屏，可直接横过手机游玩');
      window.setTimeout(() => this.setStatus(''), 2600);
    }
  }

  /** 退出全屏（供全屏时的按钮与「返回键」路径使用） */
  async exitFullscreen(): Promise<void> {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
      else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
    } catch (err) {
      console.warn('[tornado] 退出全屏失败', err);
    }
    this.unlockOrientation();
  }

  private async lockLandscape(): Promise<void> {
    const s = screen as LockableScreen;
    try {
      if (s.orientation?.lock) await s.orientation.lock('landscape');
      else if (s.lockOrientation) s.lockOrientation('landscape');
      else if (s.mozLockOrientation) s.mozLockOrientation('landscape');
    } catch {
      // 桌面浏览器与部分移动端会拒绝方向锁定，属正常情况
    }
  }

  private unlockOrientation(): void {
    try {
      (screen as LockableScreen).orientation?.unlock?.();
    } catch {
      // 未加锁时 unlock 会抛错，忽略
    }
  }

  /**
   * 向游戏发送一次 ESC。
   *
   * 手机没有 ESC 键，而游戏用 ESC 暂停。Ruffle 会丢弃 isTrusted=false 的
   * 事件，所以不能直接 dispatch 到播放器元素上；实测唯一有效的可编程路径是
   * 派发到它 shadow root 内部的 #container。KeyboardEvent 构造器还会忽略
   * keyCode/which（只读属性），而 Flash 读的正是键码，故用 defineProperty 补上。
   */
  sendEscape(): void {
    const root = this.player?.shadowRoot;
    if (!root) return;
    const target = (root.querySelector('#container') as HTMLElement | null) ?? this.player;
    if (!target) return;
    target.focus({ preventScroll: true });
    // 实测（headless Edge，同一状态各试 3 次）：focus 之后立刻发（setTimeout 0
    // 或 rAF 两帧）只有 1~2 次生效，因为 Ruffle 的 has_focus 要等焦点变更走完
    // 一轮任务循环才更新；延迟 50ms 以上 3/3 全中。这里取 60ms 留出余量。
    window.setTimeout(() => {
      for (const type of ['keydown', 'keyup'] as const) {
        const e = new KeyboardEvent(type, {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        // 构造器不接收这两个字段（只读），而 Flash 读的正是键码，只能事后定义
        Object.defineProperty(e, 'keyCode', { get: () => 27 });
        Object.defineProperty(e, 'which', { get: () => 27 });
        target.dispatchEvent(e);
      }
    }, Number((window as unknown as { __escDelay?: number }).__escDelay ?? 60));
  }

  private async boot(): Promise<void> {
    if (!webAssemblyUsable()) {
      this.fail(new Error('当前浏览器不支持 WebAssembly，无法运行该游戏'));
      return;
    }
    try {
      this.setStatus('正在加载 Flash 运行环境…');
      window.RufflePlayer = window.RufflePlayer || {};
      // 游戏内有指向 4399 站点的外链，一律拦下，不让访客被带离本站。
      window.RufflePlayer.config = {
        ...(window.RufflePlayer.config || {}),
        publicPath: RUFFLE_DIR,
        autoplay: 'on',
        unmuteOverlay: 'hidden',
        letterbox: 'on',
        scale: 'showAll',
        quality: 'high',
        logLevel: 'error',
        openUrlMode: 'deny',
        allowScriptAccess: false,
        showSwfDownload: false,
        splashScreen: false,
        contextMenu: 'rightClickOnly',
        allowFullscreen: true,
        warnOnUnsupportedContent: false,
      };

      await loadRuffleScript();
      const source = await waitForRuffle();

      // 存档本体就在 localStorage，跨刷新天然保留，这里无需回灌；
      // 只报一下接手时已有的存档，便于对照刷新前后是否一致。
      const existing = listSaveKeys();
      if (existing.length > 0) console.info(`[tornado] 已载入既有存档：${existing.join(', ')}`);

      this.setStatus('正在载入游戏…');
      const player = source.createPlayer();
      player.classList.add('ranch-player');
      this.host.appendChild(player);
      this.player = player;

      await player.ruffle().load(GAME_SWF);
      this.host.classList.add('ranch-ready');
      this.setStatus('');
      this.startSaveFlusher();
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * 定期促使 Ruffle 把存档落盘，并在离开页面时再补一次。
   *
   * 为什么需要：Ruffle 只在实例销毁与 `pagehide` 两个时机
   * flush_shared_objects()，而这两者都可能来不及跑（标签页被丢弃、
   * 进程回收、刷新抢在前面）。它没有公开 flush 接口，所以这里按固定间隔
   * 派发一次 pagehide，借它自己的通路刷下来。间隔取 3s：一次 flush 只是
   * 把内存里的几 KB base64 写进 localStorage，开销可忽略，而间隔越短，
   * 意外丢失的进度越少。
   *
   * flush 之后打印键名，便于确认存档真的写下去了（只报「写了几项」
   * 不足以判断存的是什么）。
   */
  private startSaveFlusher(): void {
    if (this.flushTimer !== null) return;

    /** 刷一次并汇报；只打变化，避免控制台被刷屏 */
    const flushAndReport = (): void => {
      flushSaves();
      const keys = listSaveKeys();
      const sig = keys.join('|');
      if (sig !== this.lastKeys) {
        this.lastKeys = sig;
        console.info(`[tornado] 存档已落盘：${keys.join(', ') || '(尚未产生)'}`);
      }
    };

    this.flushTimer = window.setInterval(flushAndReport, 3000);

    // 真实离开页面时才汇报。必须忽略 syntheticPagehide——那是上面促刷派发的，
    // 否则每 3 秒就会打一条「离开页面」（实测一次运行刷出几十条）。
    window.addEventListener('pagehide', () => {
      if (syntheticPagehide) return;
      const keys = listSaveKeys();
      console.info(`[tornado] 离开页面，当前存档：${keys.join(', ') || '(无)'}`);
    });
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.status.classList.toggle('hidden', text === '');
  }

  private fail(err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[tornado] Flash 游戏启动失败', err);
    this.host.classList.add('ranch-failed');
    this.setStatus(`游戏启动失败：${detail}`);
  }
}
