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
 *  Every search is stateless from our side: the full game record (in move
 *  order — rapfi replays stones sequentially and aborts on parity
 *  violations, see buildYxBoardCmd) is sent through one YXBOARD command,
 *  while the engine instance itself persists to keep its transposition
 *  table warm.
 *
 *  worker 的起停与超时兜底在 core/worker-engine.ts；本文件只剩 Gomocup
 *  协议这件事（摆盘命令、stdout 解析、构建降级）。
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer, Difficulty, GameMode, SearchResult, GomokuMove, GomokuHistoryMove } from '../types';
import { nowMs as now } from '../core/time';
import { WorkerEngine, type EngineMessage } from '../core/worker-engine';
import { RAPFI_ASSET_VERSION } from './rapfi-assets';

/** Mate-scale used by the bundled engine & UI (fmtEval thresholds at 100000). */
const MATE_SCALE = 100_000;

/** Difficulty → rapfi strength (0~100) + per-turn think budget in ms. */
export const RAPFI_LEVELS: Record<Difficulty, { strength: number; turnMs: number }> = {
  1: { strength: 15, turnMs: 120 },
  2: { strength: 50, turnMs: 400 },
  3: { strength: 85, turnMs: 1200 },
  4: { strength: 100, turnMs: 2800 },
};

/** 版本号定义在 rapfi-assets.ts（主线程预取与 worker 必须用同一个）。 */
const ASSET_VERSION = RAPFI_ASSET_VERSION;

type RapfiMsg = EngineMessage & { loaded?: number; total?: number };

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

/**
 * Build the YXBOARD position-replay command from the ORDERED move list.
 *
 * Rapfi's getPosition()（Rapfi/command/gomocup.cpp）按【落子顺序】重摆棋盘：
 * 每颗子的类型（1=SELF 引擎方 / 2=OPPO 对方）必须与当时的行棋方一致；
 * 遇到一次类型失配会自动替缺棋的一方插一个 PASS，但「连续 PASS」被协议
 * 禁止——连续两次失配会让整个摆盘静默中止，棋盘停在半路上，引擎就看着
 * 一副残局下棋。
 *
 * 曾经这里用 y 优先【扫描序】整发 plain BOARD：玩家在同一行连下三颗子时，
 * 扫描序出现 3 个连续同类型子 → 需要连续两个 PASS → 摆盘中止 → 引擎只
 * 看到前一两个子。表现为「AI 不拦横线」「把子下在已有棋子上」（残局上
 * 空着的格子在真实棋盘上已被占）。aivai 当年没测出来，是因为双方贴着
 * 中心行棋，扫描序碰巧近似落子序。
 *
 * 一致性校验：重放 moves 必须与 board 完全一致、颜色严格交替、且轮到
 * `player` 行棋。任何不符都返回 null——调用方改走内置 JS 引擎，
 * 绝不把错误局面喂给引擎。
 */
export function buildYxBoardCmd(
  board: GomokuBoard,
  moves: GomokuHistoryMove[],
  player: GomokuPlayer,
): string | null {
  const b: number[][] = Array.from({ length: 15 }, () => new Array<number>(15).fill(0));
  let prev = 0;
  for (const m of moves) {
    if ((m.c !== 1 && m.c !== 2) || m.x < 0 || m.x > 14 || m.y < 0 || m.y > 14) return null;
    if (b[m.y][m.x] !== 0) return null; // 同一格落两子
    if (m.c === prev) return null; // 颜色必须严格交替（我方对局从不虚着）
    b[m.y][m.x] = m.c;
    prev = m.c;
  }
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      if (board[y][x] !== b[y][x]) return null; // 与 2D 棋盘不一致
    }
  }
  if (prev === player) return null; // 最后一手是 player 下的 → 还没轮到它
  let block = 'YXBOARD';
  for (const m of moves) block += ` ${m.x},${m.y},${m.c === player ? 1 : 2}`;
  return block + ' DONE';
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

export class RapfiEngine extends WorkerEngine<void, RapfiMsg> {
  protected readonly label = '[rapfi]';
  /** wasm + 10MB 权重包，弱网下一分多钟；超时按「多久没有进展」算（keepAlive） */
  protected readonly readyTimeoutMs = 120_000;
  protected readonly keepAliveOnMessage = true;

  /** 'multi' | 'single' once the engine has booted */
  variant: 'multi' | 'single' | null = null;
  private threads = 1;
  /** 已经失败过的构建，重建时优先换另一个（多线程 → 单线程）*/
  private failedVariants = new Set<'multi' | 'single'>();
  /** 最近的引擎 stderr，失败时一并打印用于定位 */
  private stderrTail: string[] = [];
  /** serialization so concurrent requests never interleave stdout */
  private chain: Promise<unknown> = Promise.resolve();
  /** 上次初始化失败的时刻：45s 内不重试 */
  private lastInitFail = 0;

  /** 引擎侧上报的数据包下载进度（有预取时通常一闪而过） */
  onLoadProgress: ((loaded: number, total: number) => void) | null = null;
  private onLine: ((line: string) => void) | null = null;

  /** 本客户端不走一问一答：着法来自引擎 stdout，由 _search 自己解析 */
  protected emptyReply(): void {}

  protected workerUrl(): string {
    // public/rapfi/ 的文件按站点根目录原样分发。URL 用 BASE_URL 手拼而不是
    // `new URL(x, import.meta.url)`，Vite 才不会去打包这个 classic worker
    // （它的 importScripts 相对自己所在的 /rapfi/ 解析）。?v= 顶掉引擎更新后
    // 浏览器对旧文件的启发式缓存。
    const base = import.meta.env.BASE_URL || '/';
    return new URL(base + 'rapfi/engine-worker.js?v=' + ASSET_VERSION, self.location.href).href;
  }

  protected initMessage(extra?: unknown): { message: unknown; transfer?: Transferable[] } {
    const dataBuffer = extra as ArrayBuffer | undefined;
    return {
      // variant 让客户端能指定构建：多线程挂掉后重建时改传 'single'
      // dataBuffer：主线程已下完的权重，注入 getPreloadedPackage 后不再二次 fetch
      message: { type: 'init', version: ASSET_VERSION, variant: this.nextVariant(), dataBuffer },
      transfer: dataBuffer ? [dataBuffer] : [],
    };
  }

  protected onReadyMessage(msg: RapfiMsg): void {
    const variant = typeof msg.data === 'string' ? msg.data : '';
    this.variant = variant.includes('multi') ? 'multi' : 'single';
    this.threads = this.variant === 'multi'
      ? Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency || 2) - 1))
      : 1;
    console.info(`[rapfi] 引擎就绪：${this.variant} 构建 · 线程 ${this.threads}`);
  }

  protected onEngineMessage(msg: RapfiMsg): void {
    switch (msg.type) {
      case 'stdout':
        this.onLine?.(String(msg.data));
        break;
      case 'stderr':
        this.noteStderr(String(msg.data));
        break;
      case 'load-progress':
        if (msg.total) this.onLoadProgress?.(msg.loaded ?? 0, msg.total);
        break;
      default:
        break;
    }
  }

  /** 记住是哪个构建挂的，重建时优先换另一个；顺带把 stderr 末尾打出来定位 */
  protected onDead(_why: string): void {
    if (this.variant) this.failedVariants.add(this.variant);
    if (this.stderrTail.length) {
      console.warn('[rapfi] 引擎 stderr 末尾：\n' + this.stderrTail.join('\n'));
    }
  }

  protected stopNote(): string {
    return `（${this.variant ?? '未知'} 构建）`;
  }

  /** 记下最近的引擎 stderr，失败时一并打印，便于定位根因 */
  private noteStderr(line: string): void {
    if (!line.trim()) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > 8) this.stderrTail.shift();
  }

  /** 重建时用哪个构建：多线程挂过、单线程没挂过，就换单线程 */
  private nextVariant(): 'auto' | 'single' {
    if (this.failedVariants.has('multi') && !this.failedVariants.has('single')) return 'single';
    return 'auto';
  }

  /**
   * 预热：提前开始加载 wasm 与 NNUE 权重。dataBuffer 为主线程已下完的权重包。
   * 进入对局页面时调用，把首次加载挪到玩家思考首手的时间里。
   *
   * 失败后 45s 内不重试：CDN 冷边缘上 10MB 的数据包可能早失败，反复重试只会
   * 让每一手都白等；这期间照常走内置 JS 引擎。
   */
  warmUp(dataBuffer?: ArrayBuffer): Promise<void> {
    if (Date.now() - this.lastInitFail < 45_000) return Promise.reject(new Error('rapfi init cooldown'));
    return this.start(dataBuffer).catch((err) => {
      this.lastInitFail = Date.now();
      if (this.variant) this.failedVariants.add(this.variant);
      this.variant = null;
      throw err;
    });
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
   * `moves` 是按真实落子顺序的完整棋谱——Rapfi 靠它重摆棋盘（见 buildYxBoardCmd）。
   * Falls through the caller-provided fallback when rapfi is unavailable.
   */
  async findMove(
    board: GomokuBoard,
    player: GomokuPlayer,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
    moves: GomokuHistoryMove[],
    fallback: () => SearchResult<GomokuMove>,
  ): Promise<SearchResult<GomokuMove>> {
    // 并发请求（AI 落子与「请神」）串行化：stdout 只有一条，交错会串味
    const task = this.chain.then(
      () => this._search(board, player, difficulty, mode, historyLength, moves, fallback),
      () => this._search(board, player, difficulty, mode, historyLength, moves, fallback),
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
    moves: GomokuHistoryMove[],
    fallback: () => SearchResult<GomokuMove>,
  ): Promise<SearchResult<GomokuMove>> {
    // ── Opening shortcuts (instant, keeps aivai varied) ──
    // 开局两手是固定应手，与引擎无关，所以必须排在「等引擎」之前。
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

    // isReady 为真即「worker 已 boot 且 variant 已置位」，此后没有等待加载的必要：
    // 引擎中途死亡时 markDead() 会把 variant 清回 null，又落回这条分支。
    if (!this.isReady) {
      void this.warmUp().catch(() => undefined); // 幂等：确保加载已经启动
      return fallback();
    }

    const t0 = now();
    const cfg = RAPFI_LEVELS[difficulty];
    // Time jitter keeps aivai (deterministic engine vs itself) games varied.
    const jitter = mode === 'aivai' ? 0.88 + Math.random() * 0.24 : 1;
    const turnMs = Math.round(cfg.turnMs * jitter);
    const nbest = difficulty === 4 ? 5 : 1;

    // 摆盘命令先行构建+校验：moves 与棋盘不符时绝不喂引擎错局，
    // 直接降级内置 JS 引擎（它只看 2D 棋盘，不依赖棋谱顺序）。
    const block = buildYxBoardCmd(board, moves, player);
    if (!block) {
      console.warn('[rapfi] 落子序列与棋盘不一致（含奇偶校验失败），本手改用内置 JS 引擎');
      return fallback();
    }

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

      // YXBOARD 只按落子序摆盘、不触发思考；思考由 YXNBEST 触发并带上
      // multiPV。绝不能用 plain BOARD：它摆完盘立刻开始思考，thinking
      // 标志置位后后续命令全部被引擎丢弃——YXNBEST 5（恶魔档多候选）
      // 就这么被吞过，而且提前触发的思考用的是不带 multiPV 的配置。
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

      // YXNBEST>1 时 blocks 末尾是最后一轮的 pv1..pvN；评估/深度/节点数
      // 必须取「选中着法所在的块」，而不是最后一个块（那是 pvN 的评估）。
      const bestKey = `${best.x},${best.y}`;
      const bestBlock =
        finals.find((b) => b.line[0] === bestKey) ?? finals[0] ?? parser.blocks[parser.blocks.length - 1] ?? null;
      const mv: GomokuMove = { x: best.x, y: best.y, v: bestBlock?.eval ?? 0 };
      return {
        move: mv,
        depth: bestBlock?.depth || 0,
        nodes: bestBlock?.nodes || 0,
        ms: Math.round(now() - t0),
        eval: bestBlock?.eval ?? 0,
        scores,
        engine: this.engineTag(),
      };
    } catch (err) {
      console.warn(`[rapfi] 搜索失败（${this.variant ?? '未知'} 构建），回退内置引擎：`, err);
      // markDead 会把实例清掉（含 stderr 末尾），下一手重建或改用内置引擎
      this.markDead('搜索超时未产出着法');
      this.noteFailure();
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
