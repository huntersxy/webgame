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
}

interface RufflePlayerElement extends HTMLElement {
  ruffle(): RuffleApi;
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

export class TornadoController {
  private readonly host: HTMLElement;
  private readonly status: HTMLElement;
  private player: RufflePlayerElement | null = null;
  private booted = false;
  private busy = false;

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

      this.setStatus('正在载入游戏…');
      const player = source.createPlayer();
      player.classList.add('ranch-player');
      this.host.appendChild(player);
      this.player = player;

      await player.ruffle().load(GAME_SWF);
      this.host.classList.add('ranch-ready');
      this.setStatus('');
    } catch (err) {
      this.fail(err);
    }
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
