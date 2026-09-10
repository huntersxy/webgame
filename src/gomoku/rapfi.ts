/* ────────────────────────────────────────────────────────────
 *  gomoku/rapfi.ts — Client for the Rapfi WASM engine (Gomocup
 *  protocol over a nested classic worker). Runs inside ai/worker.ts.
 *
 *  Rapfi is the gomocup-level C++ engine (github.com/dhbloo/rapfi),
 *  compiled to WebAssembly. The engine files live in public/rapfi/
 *  (rapfi-{multi,single}.{js,wasm} + rapfi.data with mix9svq NNUE
 *  weights) and are loaded by public/rapfi/engine-worker.js. The multi build needs
 *  SharedArrayBuffer (nginx must send COOP/COEP headers); without
 *  it we transparently use the single-thread build, and if the
 *  wasm fails to load entirely the caller falls back to the
 *  bundled JS engine in gomoku/search.ts.
 *
 *  Every search is stateless from our side: the full stone list is
 *  replayed through one BOARD command (rapfi rebuilds its board via
 *  board->newGame() in the BOARD handler), while the engine instance
 *  itself persists to keep its transposition table warm.
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer, Difficulty, GameMode, SearchResult, GomokuMove } from '../types';

/** Mate-scale used by the bundled engine & UI (fmtEval thresholds at 100000). */
const MATE_SCALE = 100_000;

/** Difficulty → rapfi strength (0~100) + per-turn think budget in ms. */
export const RAPFI_LEVELS: Record<Difficulty, { strength: number; turnMs: number }> = {
  1: { strength: 15, turnMs: 120 },
  2: { strength: 50, turnMs: 400 },
  3: { strength: 85, turnMs: 1200 },
  4: { strength: 100, turnMs: 2800 },
};

type EngineMsg = { type: 'ready' | 'stdout' | 'stderr' | 'error' | 'exit'; data?: unknown };

/** Bump when any file under public/rapfi/ changes to defeat browser caches. */
const ASSET_VERSION = '20260910d';

/** Parse an rapfi EVAL token ("+M5", "-M3", plain integer) to UI scale. */
function parseEval(tok: string): number {
  const m = /^([+-]?)M(\d+)$/i.exec(tok.trim());
  if (m) {
    const v = MATE_SCALE - parseInt(m[2], 10);
    return m[1] === '-' ? -v : v;
  }
  const n = parseInt(tok, 10);
  return Number.isFinite(n) ? n : 0;
}

interface PvBlock {
  pv: number;
  eval: number;
  depth: number;
  nodes: number;
  line: string[];
}

/** Incremental parser for rapfi INFO output. */
class OutputParser {
  private cur: PvBlock | null = null;
  /** completed blocks, in arrival order (latest iteration last) */
  blocks: PvBlock[] = [];
  move: { x: number; y: number } | null = null;

  feed(raw: string): void {
    const line = raw.trim();
    if (!line) return;

    if (/^\d+,\d+$/.test(line)) {
      const [x, y] = line.split(',').map(Number);
      this.move = { x, y };
      return;
    }

    const info = /^INFO\s+(.+)$/.exec(line);
    if (info) {
      const [head, ...rest] = info[1].split(/\s+/);
      const tail = rest.join(' ');
      switch (head) {
        case 'PV': {
          if (tail === 'DONE') this.flush();
          else this.cur = { pv: parseInt(tail, 10) || 0, eval: this.cur?.eval ?? 0, depth: 0, nodes: 0, line: [] };
          break;
        }
        case 'EVAL': {
          if (!this.cur) this.cur = { pv: 0, eval: 0, depth: 0, nodes: 0, line: [] };
          this.cur.eval = parseEval(tail);
          break;
        }
        case 'DEPTH': {
          if (this.cur) this.cur.depth = Math.max(this.cur.depth, parseInt(tail, 10) || 0);
          break;
        }
        case 'NODES':
        case 'TOTALNODES': {
          if (this.cur) this.cur.nodes = parseInt(tail, 10) || 0;
          break;
        }
        case 'BESTLINE': {
          if (this.cur) this.cur.line = tail.split(/\s+/).filter((s) => /^\d+,\d+$/.test(s));
          break;
        }
        default:
          break;
      }
      return;
    }

    // MESSAGE lines (thinking commentary) are ignored.
  }

  private flush(): void {
    if (this.cur && this.cur.line.length) this.blocks.push(this.cur);
    this.cur = null;
  }
}

export class RapfiEngine {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private onLine: ((line: string) => void) | null = null;
  /** 'multi' | 'single' once the engine has booted */
  variant: 'multi' | 'single' | null = null;
  private threads = 1;
  /** 同一局里引擎连续失败后不再重试，直接走内置 JS 引擎 */
  private disabled = false;
  private searchFailures = 0;
  /** 已经失败过的构建，重建时优先换另一个（多线程 → 单线程）*/
  private failedVariants = new Set<'multi' | 'single'>();
  /** 最近的引擎 stderr，失败时一并打印用于定位 */
  private stderrTail: string[] = [];
  /** serialization so concurrent requests never interleave stdout */
  private chain: Promise<unknown> = Promise.resolve();

  private startWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let w: Worker;
      try {
        // public/rapfi/ files are served verbatim from the site root. Build
        // the URL from BASE_URL instead of `new URL(x, import.meta.url)` so
        // Vite does NOT bundle this classic worker (its importScripts
        // resolves relative to its own /rapfi/ location). The ?v= busts
        // browser heuristically-cached copies after an engine update.
        const base = import.meta.env.BASE_URL || '/';
        w = new Worker(
          new URL(base + 'rapfi/engine-worker.js?v=' + ASSET_VERSION, self.location.href).href,
        );
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish(new Error('rapfi engine init timeout')), 60_000);
      function finish(err?: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      }
      w.onmessage = (e: MessageEvent<EngineMsg>) => {
        // 已经换过 worker 的迟到消息必须丢弃：terminate() 只能阻止后续投递，
        // 已在事件队列里的消息仍会送达。否则旧 worker 的 exit/error 会把刚建好的
        // 新 worker 误判为死亡并 terminate 掉。
        if (this.worker !== w) return;
        const msg = e.data;
        switch (msg.type) {
          case 'ready': {
            const variant = typeof msg.data === 'string' ? msg.data : '';
            this.variant = variant.includes('multi') ? 'multi' : 'single';
            this.threads = this.variant === 'multi'
              ? Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency || 2) - 1))
              : 1;
            console.info(`[rapfi] 引擎就绪：${this.variant} 构建 · 线程 ${this.threads}`);
            finish();
            break;
          }
          case 'stdout':
            this.onLine?.(String(msg.data));
            break;
          case 'stderr':
            this.noteStderr(String(msg.data));
            break;
          case 'error':
            if (!settled) finish(new Error(String(msg.data)));
            else this.markDead('引擎报错：' + String(msg.data));
            break;
          case 'exit':
            // stdin 队列读空或崩溃都会走到这里。启动阶段算失败；运行期必须
            // 立刻标记死亡——否则 readyPromise 仍是已完成状态，之后每一手都
            // 会把命令发给死引擎、白等满超时才回退到内置引擎。
            if (!settled) finish(new Error('引擎在初始化阶段退出'));
            else this.markDead('引擎中途退出（stdin 读空或崩溃）');
            break;
          default:
            break;
        }
      };
      w.onerror = (e) => {
        if (this.worker !== w) return;
        const err = new Error('rapfi worker error: ' + (e.message || 'unknown'));
        if (!settled) finish(err);
        else this.markDead(err.message);
      };
      // variant 让客户端能指定构建：多线程挂掉后重建时改传 'single'
      w.postMessage({ type: 'init', version: ASSET_VERSION, variant: this.nextVariant() });
      this.worker = w;
    });
  }

  /**
   * Lazy init. A failed attempt is retried at most once every 60s (a slow
   * 10MB data fetch on a cold CDN edge may fail early), otherwise falls
   * through to the JS engine for that search.
   */
  private lastInitFail = 0;

  /** 记下最近的引擎 stderr，失败时一并打印，便于定位根因 */
  private noteStderr(line: string): void {
    if (!line.trim()) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > 8) this.stderrTail.shift();
  }

  /**
   * 标记引擎已不可用：清掉 readyPromise，让下一次搜索重建实例而不是把
   * 命令继续发给死进程。同时记住是哪个构建挂的，重建时优先换另一个。
   */
  private markDead(why: string): void {
    if (!this.readyPromise && !this.worker) return; // 已经处理过
    const v = this.variant;
    if (v) this.failedVariants.add(v);
    console.warn(`[rapfi] 引擎停止（${v ?? '未知'} 构建）：${why}`);
    if (this.stderrTail.length) {
      console.warn('[rapfi] 引擎 stderr 末尾：\n' + this.stderrTail.join('\n'));
    }
    this.readyPromise = null;
    this.variant = null;
    this.worker?.terminate();
    this.worker = null;
  }

  /** 重建时用哪个构建：多线程挂过、单线程没挂过，就换单线程 */
  private nextVariant(): 'auto' | 'single' {
    if (this.failedVariants.has('multi') && !this.failedVariants.has('single')) return 'single';
    return 'auto';
  }

  private ensureReady(): Promise<void> {
    if (this.disabled) return Promise.reject(new Error('引擎已在本局停用'));
    if (this.readyPromise) return this.readyPromise;
    if (Date.now() - this.lastInitFail < 45_000) return Promise.reject(new Error('rapfi init cooldown'));
    this.readyPromise = this.startWorker().catch((err) => {
      this.readyPromise = null;
      this.lastInitFail = Date.now();
      if (this.variant) this.failedVariants.add(this.variant);
      this.variant = null;
      this.worker?.terminate();
      this.worker = null;
      throw err;
    });
    return this.readyPromise;
  }

  /**
   * 预热：提前开始加载 wasm 与 NNUE 权重（首次约 11MB）。
   * 进入对局页面时调用，把首次加载挪到玩家思考首手的时间里，
   * 之后所有搜索都会命中同一个已就绪的实例。
   */
  warmUp(): Promise<void> {
    return this.ensureReady();
  }

  /** 引擎是否已实例化完成（UI 可据此提示） */
  get isReady(): boolean {
    return this.variant !== null;
  }

  private cmd(c: string): void {
    this.worker?.postMessage({ type: 'cmd', data: c });
  }

  /**
   * Search the best move for `player` on `board`.
   * Falls through the caller-provided fallback when rapfi is unavailable.
   */
  async findMove(
    board: GomokuBoard,
    player: GomokuPlayer,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
    fallback: () => SearchResult<GomokuMove>,
  ): Promise<SearchResult<GomokuMove>> {
    const task = this.chain.then(
      () => this._search(board, player, difficulty, mode, historyLength, fallback),
      () => this._search(board, player, difficulty, mode, historyLength, fallback),
    );
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async _search(
    board: GomokuBoard,
    player: GomokuPlayer,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
    fallback: () => SearchResult<GomokuMove>,
  ): Promise<SearchResult<GomokuMove>> {
    // ── Opening shortcuts (instant, keeps aivai varied) ──
    // 开局两手是固定应手，与引擎无关，所以必须排在 ensureReady() 之前。
    // 否则玩家落下第一个子后，要等整个 wasm + NNUE 权重（约 11MB）下载并
    // 实例化完，才见到本可瞬间给出的应手——这正是「下第一个子加载很久」。
    // 引擎改由进入对局页面时的 warmUp() 提前加载，把这段时间藏进玩家思考里。
    if (historyLength === 0) {
      const mv = { x: 7, y: 7, v: 0 };
      return { move: mv, depth: 1, nodes: 1, ms: 0, eval: 0, scores: [mv], opening: true, engine: this.engineTag() };
    }
    if (historyLength === 1) {
      const mv = nearFirstReply(board, player);
      return { move: mv, depth: 1, nodes: 1, ms: 0, eval: 0, scores: [mv], opening: true, engine: this.engineTag() };
    }

    try {
      await this.ensureReady();
    } catch {
      return fallback();
    }

    const t0 = now();
    const cfg = RAPFI_LEVELS[difficulty];
    // Time jitter keeps aivai (deterministic engine vs itself) games varied.
    const jitter = mode === 'aivai' ? 0.88 + Math.random() * 0.24 : 1;
    const turnMs = Math.round(cfg.turnMs * jitter);
    const nbest = difficulty === 4 ? 5 : 1;

    const parser = new OutputParser();
    let settled = false;
    this.onLine = (line) => {
      if (settled) return;
      parser.feed(line);
      if (parser.move) settled = true;
    };

    try {
      this.cmd('INFO RULE 0'); // freestyle gomoku
      this.cmd('INFO THREAD_NUM ' + this.threads);
      this.cmd('INFO CAUTION_FACTOR 1');
      this.cmd('INFO STRENGTH ' + cfg.strength);
      this.cmd('INFO TIMEOUT_TURN ' + turnMs);
      this.cmd('INFO TIMEOUT_MATCH 100000000');
      this.cmd('INFO MAX_DEPTH 99');
      this.cmd('INFO MAX_NODE 0');
      this.cmd('INFO SHOW_DETAIL 3');
      this.cmd('INFO PONDERING 0');
      this.cmd('INFO SWAPABLE 0');
      this.cmd('START 15');
      this.cmd('INFO TIME_LEFT 100000000');

      // Replay the full position: SELF(1) = engine color stones, OPPO(2) = other.
      // rapfi assigns colors by type and fixes move parity with auto-PASS, so
      // scan order is irrelevant.
      let block = 'BOARD';
      for (let y = 0; y < 15; y++) {
        for (let x = 0; x < 15; x++) {
          const v = board[y][x];
          if (v !== 0) block += ` ${x},${y},${v === player ? 1 : 2}`;
        }
      }
      block += ' DONE';
      this.cmd(block);
      this.cmd('YXNBEST ' + nbest);

      // 引擎自己按 TIMEOUT_TURN 收手，这里只留一块有限余量兜底。
      // 余量给太大（原先 turnMs*4+4000）的代价是：引擎一旦已经死掉，
      // 每一手都要白等满这个时间才回退到内置引擎。
      const deadline = now() + turnMs + 4000;
      while (!parser.move && now() < deadline) await sleep(20);

      const best = parser.move;
      if (!best) throw new Error('rapfi produced no move');

      // Final multipv iteration blocks = top candidates.
      const finals = parser.blocks.slice(-nbest);
      const scores: Array<GomokuMove & { v: number }> = [];
      for (const b of finals) {
        const [cx, cy] = b.line[0].split(',').map(Number);
        if (Number.isFinite(cx) && Number.isFinite(cy)) scores.push({ x: cx, y: cy, v: b.eval });
      }
      // Ensure the chosen move is present & first in the candidate list.
      const bi = scores.findIndex((s) => s.x === best.x && s.y === best.y);
      if (bi > 0) scores.unshift(...scores.splice(bi, 1));
      if (!scores.length) scores.push({ x: best.x, y: best.y, v: 0 });

      const last = parser.blocks[parser.blocks.length - 1];
      const bestV = last?.eval ?? 0;
      const mv: GomokuMove = { x: best.x, y: best.y, v: bestV };
      return {
        move: mv,
        depth: last?.depth || 0,
        nodes: last?.nodes || 0,
        ms: Math.round(now() - t0),
        eval: last?.eval ?? 0,
        scores,
        engine: this.engineTag(),
      };
    } catch (err) {
      this.searchFailures++;
      console.warn(`[rapfi] 搜索失败（${this.variant ?? '未知'} 构建），回退内置引擎：`, err);
      if (this.stderrTail.length) {
        console.warn('[rapfi] 引擎 stderr 末尾：\n' + this.stderrTail.join('\n'));
      }
      this.markDead('搜索超时未产出着法');
      if (this.searchFailures >= 2) {
        this.disabled = true;
        console.warn('[rapfi] 引擎连续失败，本局改用内置 JS 引擎（刷新页面可重试）');
      }
      return fallback();
    } finally {
      this.onLine = null;
    }
  }

  /** Engine label for the UI ('rapfi-multi' | 'rapfi-single' | 'js'). */
  private engineTag(): SearchResult<GomokuMove>['engine'] {
    return this.variant === 'multi' ? 'rapfi-multi' : this.variant === 'single' ? 'rapfi-single' : undefined;
  }
}

/* ── helpers ── */

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reply next to black's lone first stone (used when AI answers move 2). */
function nearFirstReply(board: GomokuBoard, _player: GomokuPlayer): GomokuMove & { v: number } {
  let sx = 7, sy = 7;
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) if (board[y][x] !== 0) { sx = x; sy = y; }
  }
  // spiral-ish candidates around the stone, prefer slight diagonal
  const cands: Array<[number, number]> = [
    [1, 1], [-1, -1], [1, -1], [-1, 1], [1, 0], [0, 1], [-1, 0], [0, -1],
    [2, 2], [-2, -2], [2, -2], [-2, 2],
  ];
  for (const [dx, dy] of cands) {
    const x = sx + dx, y = sy + dy;
    if (x >= 0 && x < 15 && y >= 0 && y < 15 && board[y][x] === 0) return { x, y, v: 0 };
  }
  void _player;
  return { x: 7, y: 7, v: 0 };
}
