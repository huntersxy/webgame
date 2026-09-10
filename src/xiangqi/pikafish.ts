/* ────────────────────────────────────────────────────────────
 *  xiangqi/pikafish.ts — Pikafish WASM 引擎客户端（UCI 协议）
 *
 *  Pikafish（皮卡鱼）是象棋界棋力最强的开源引擎（Stockfish 衍生 +
 *  NNUE）。与五子棋用的 Rapfi 不同，它说 **UCI** 而不是 Gomocup：
 *
 *      uci                         → uciok
 *      setoption name X value Y
 *      position fen <FEN>
 *      go movetime <ms>
 *      info depth 12 score cp 34 nodes .. pv h2e2 b9c7 ..
 *      bestmove h2e2 ponder h0g2
 *
 *  所以这里多了两层转换（见 ./fen.ts）：XqBoard → FEN，UCI 走法 → XqMove。
 *
 *  ── 命令为什么走共享内存而不是 postMessage ──
 *  上游 UCI 循环是同步的 `getline(std::cin, cmd)`（src/uci.cpp）。wasm 里
 *  没有真实 stdin，engine-worker.js 用 Atomics.wait 把它做成阻塞式的；
 *  而 worker 一旦阻塞在 Atomics.wait 上，它自己的 onmessage 就不会再触发。
 *  因此命令必须由本线程写进 SharedArrayBuffer 把它唤醒——postMessage 会
 *  死锁。要求页面处于 cross-origin isolated（COOP/COEP），站点已配置；
 *  不满足则整条链路直接降级到内置 JS 引擎。
 *
 *  任何环节不可用（SAB 缺失 / wasm 失败 / 连续搜索失败）都会降级到
 *  src/xiangqi/search.ts，绝不把错误局面喂给引擎。
 * ──────────────────────────────────────────────────────────── */

import type { XqBoard, XqSide, XqMove, Difficulty, GameMode, SearchResult } from '../types';
import { boardToFen, uciToXqMove } from './fen';
import { PIKAFISH_ASSET_VERSION, pikafishDataUrl } from './pikafish-assets';

/** 难度 → 引擎配置。skill = UCI「Skill Level」(0~20)，turnMs = 每手思考预算。 */
export const PIKAFISH_LEVELS: Record<Difficulty, { skill: number; turnMs: number }> = {
  1: { skill: 1, turnMs: 120 },
  2: { skill: 6, turnMs: 400 },
  3: { skill: 14, turnMs: 1100 },
  4: { skill: 20, turnMs: 2600 },
};

/** 恶魔档取多候选（MultiPV），与 Rapfi 的 YXNBEST 5 对齐。 */
const DEMON_MULTIPV = 5;
/** 命令缓冲区：头部 8 字节控制块 + 文本区。一次最多一批命令，64KB 绰绰有余。 */
const SAB_BYTES = 64 * 1024;
const SAB_HEADER = 8;
const MATE_SCALE = 100_000;

type EngineMsg = {
  type: 'ready' | 'stdout' | 'stderr' | 'error' | 'exit' | 'load-progress';
  data?: unknown;
};

interface InfoBlock {
  multipv: number;
  depth: number;
  nodes: number;
  /** UI 标度的评分（mate 折算成大数） */
  eval: number;
  pv: string[];
}

/** 增量解析 UCI info 行。 */
class UciParser {
  /** 最近一轮迭代里各多候选（按 multipv 升序） */
  latest: InfoBlock[] = [];
  bestmove: string | null = null;
  ponder: string | null = null;

  feed(raw: string): void {
    const line = raw.trim();
    if (!line) return;

    if (line.startsWith('bestmove')) {
      const t = line.split(/\s+/);
      this.bestmove = t[1] && t[1] !== '(none)' ? t[1] : null;
      this.ponder = t[3] && t[3] !== '(none)' ? t[3] : null;
      return;
    }
    if (!line.startsWith('info ')) return;
    // 只处理带 pv 的 info 行（深度迭代的最终行）
    const pvIdx = line.indexOf(' pv ');
    if (pvIdx < 0) return;

    const toks = line.split(/\s+/);
    const blk: InfoBlock = { multipv: 1, depth: 0, nodes: 0, eval: 0, pv: [] };
    for (let i = 0; i < toks.length; i++) {
      switch (toks[i]) {
        case 'multipv': blk.multipv = parseInt(toks[i + 1], 10) || 1; break;
        case 'depth': blk.depth = parseInt(toks[i + 1], 10) || 0; break;
        case 'nodes': blk.nodes = parseInt(toks[i + 1], 10) || 0; break;
        case 'score': {
          const kind = toks[i + 1];
          const v = parseInt(toks[i + 2], 10) || 0;
          // 引擎视角是「行棋方为正」；mate 折算到 UI 的绝杀标度
          if (kind === 'mate') blk.eval = v > 0 ? MATE_SCALE - v : -MATE_SCALE - v;
          else if (kind === 'cp') blk.eval = v;
          break;
        }
      }
    }
    blk.pv = toks.slice(pvIdx + 1).filter((s) => /^[a-i][0-9][a-i][0-9]$/.test(s));
    if (!blk.pv.length) return;

    // 新的一轮迭代会重新从 multipv 1 开始 → 覆盖旧的
    if (blk.multipv === 1) this.latest = [];
    const at = this.latest.findIndex((b) => b.multipv === blk.multipv);
    if (at >= 0) this.latest[at] = blk;
    else this.latest.push(blk);
  }
}

export class PikafishEngine {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private onLine: ((line: string) => void) | null = null;
  /** 引擎已握手完成（net 已载入）——UI 据此决定「恶魔档」能否开 */
  ready = false;
  /** 同一局里连续失败后不再重试，直接走内置 JS 引擎 */
  private disabled = false;
  private searchFailures = 0;
  private lastInitFail = 0;
  private stderrTail: string[] = [];
  /** 串行化：并发请求绝不交错 stdout */
  private chain: Promise<unknown> = Promise.resolve();
  /** 引擎侧上报的权重下载进度 */
  onLoadProgress: ((loaded: number, total: number) => void) | null = null;

  /** 命令缓冲区（与 engine-worker.js 共享） */
  private ctrl: Int32Array | null = null;
  private cmdBytes: Uint8Array | null = null;
  private readonly enc = new TextEncoder();

  /** 页面是否具备驱动引擎的先决条件。 */
  static isSupported(): boolean {
    return (
      typeof SharedArrayBuffer !== 'undefined' &&
      typeof self !== 'undefined' &&
      self.crossOriginIsolated === true
    );
  }

  private startWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!PikafishEngine.isSupported()) {
        reject(new Error('缺少 cross-origin isolation / SharedArrayBuffer'));
        return;
      }
      let w: Worker;
      let sab: SharedArrayBuffer;
      try {
        sab = new SharedArrayBuffer(SAB_BYTES);
        this.ctrl = new Int32Array(sab, 0, 2);
        this.cmdBytes = new Uint8Array(sab, SAB_HEADER);
        // public/pikafish/ 下的文件按原样从站点根提供。用 BASE_URL 拼 URL，
        // 避免 Vite 把这个 classic worker 打进 bundle（它靠 importScripts
        // 加载同目录的胶水脚本）。?v= 用于引擎更新后破缓存。
        const base = import.meta.env.BASE_URL || '/';
        w = new Worker(
          new URL(base + 'pikafish/engine-worker.js?v=' + PIKAFISH_ASSET_VERSION, self.location.href).href,
        );
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let settled = false;
      // 超时语义是「多久没有进展」，不是总时长：权重有 48MB，弱网要下很久。
      let timer: ReturnType<typeof setTimeout>;
      const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error('pikafish init timeout (无进展)')), 180_000);
      };
      arm();
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      w.onmessage = (e: MessageEvent<EngineMsg>) => {
        // 换过 worker 后的迟到消息必须丢弃（terminate 不能清空事件队列）
        if (this.worker !== w) return;
        const msg = e.data;
        switch (msg.type) {
          case 'ready':
            finish();
            break;
          case 'stdout':
            arm();
            this.onLine?.(String(msg.data));
            break;
          case 'stderr':
            arm();
            this.noteStderr(String(msg.data));
            break;
          case 'load-progress': {
            arm();
            const d = msg.data as { loaded?: number; total?: number } | undefined;
            if (d && d.total) this.onLoadProgress?.(d.loaded ?? 0, d.total);
            break;
          }
          case 'error':
            if (!settled) finish(new Error(String(msg.data)));
            else this.markDead('引擎报错：' + String(msg.data));
            break;
          case 'exit':
            if (!settled) finish(new Error('引擎在初始化阶段退出'));
            else this.markDead('引擎中途退出');
            break;
        }
      };
      w.onerror = (e) => {
        if (this.worker !== w) return;
        const err = new Error('pikafish worker error: ' + (e.message || 'unknown'));
        if (!settled) finish(err);
        else this.markDead(err.message);
      };

      this.worker = w;
      // 权重包可能托管在外部 OSS/CDN（VITE_PIKAFISH_DATA_BASE）——把解析好的
      // 完整 URL 交给 worker，让它的 locateFile 对 .data 用同一条 URL，
      // 这样我们的预取与引擎自己那次取包才能命中同一缓存条目。
      w.postMessage({
        type: 'init',
        sab,
        version: PIKAFISH_ASSET_VERSION,
        dataUrl: pikafishDataUrl(),
      });
    });
  }

  /** 把一批命令写进共享缓冲区并唤醒引擎（见文件头「命令为什么走共享内存」）。 */
  private writeCmd(text: string): void {
    const ctrl = this.ctrl;
    const buf = this.cmdBytes;
    if (!ctrl || !buf) return;
    const bytes = this.enc.encode(text);
    if (bytes.length > buf.length) {
      console.warn('[pikafish] 命令过长，已丢弃：', text.slice(0, 60));
      return;
    }
    // 等上一次被读走。正常时序下这里不会等待（发一批→等一条输出）。
    for (let i = 0; i < 200 && Atomics.load(ctrl, 0) !== 0; i++) {
      Atomics.wait(ctrl, 0, Atomics.load(ctrl, 0), 25);
    }
    buf.set(bytes, 0);
    Atomics.store(ctrl, 0, bytes.length);
    Atomics.notify(ctrl, 0);
  }

  /** 发一条命令（自动补行尾）。 */
  private cmd(c: string): void {
    this.writeCmd(c + '\n');
  }

  /** 等某条特定输出出现，出现前先发命令。 */
  private waitFor(token: string, send: () => void, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        this.onLine = null;
        reject(new Error('pikafish 等待超时：' + token));
      }, timeoutMs);
      this.onLine = (line) => {
        if (done) return;
        if (line.trim().startsWith(token)) {
          done = true;
          clearTimeout(timer);
          this.onLine = null;
          resolve();
        }
      };
      send();
    });
  }

  /**
   * UCI 握手。注意 `isready → readyok` 这一步才是权重真正载入的时刻
   * （Stockfish 家族在回应 readyok 前会把 EvalFile 读进来），所以只有
   * 走到这里才把 ready 置真——UI 的「恶魔档」也以它为准。
   */
  private async handshake(): Promise<void> {
    await this.waitFor('uciok', () => this.cmd('uci'), 20_000);
    this.cmd('setoption name Threads value 1'); // 构建未启用 pthread，线程必须为 1
    this.cmd('setoption name Hash value 32');
    await this.waitFor('readyok', () => this.cmd('isready'), 90_000);
    this.ready = true;
    console.info('[pikafish] 引擎就绪（权重已载入）');
  }

  private noteStderr(line: string): void {
    if (!line.trim()) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > 8) this.stderrTail.shift();
  }

  private markDead(why: string): void {
    if (!this.readyPromise && !this.worker) return;
    console.warn(`[pikafish] 引擎停止：${why}`);
    if (this.stderrTail.length) console.warn('[pikafish] 引擎 stderr 末尾：\n' + this.stderrTail.join('\n'));
    this.readyPromise = null;
    this.ready = false;
    this.worker?.terminate();
    this.worker = null;
    this.ctrl = null;
    this.cmdBytes = null;
  }

  private ensureReady(): Promise<void> {
    if (this.disabled) return Promise.reject(new Error('引擎已在本局停用'));
    if (this.readyPromise) return this.readyPromise;
    if (Date.now() - this.lastInitFail < 45_000) return Promise.reject(new Error('pikafish init cooldown'));
    this.readyPromise = this.startWorker()
      .then(() => this.handshake())
      .catch((err) => {
        this.readyPromise = null;
        this.lastInitFail = Date.now();
        this.worker?.terminate();
        this.worker = null;
        this.ctrl = null;
        this.cmdBytes = null;
        throw err;
      });
    return this.readyPromise;
  }

  /** 预热：进入对局页面即调用，把 wasm + 48MB 权重的加载藏进玩家思考时间。 */
  warmUp(): Promise<void> {
    return this.ensureReady();
  }

  get isReady(): boolean {
    return this.ready;
  }

  async findMove(
    board: XqBoard,
    side: XqSide,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
    fallback: () => SearchResult<XqMove>,
  ): Promise<SearchResult<XqMove>> {
    const run = (): Promise<SearchResult<XqMove>> =>
      this._search(board, side, difficulty, mode, historyLength, fallback);
    const task = this.chain.then(run, run);
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async _search(
    board: XqBoard,
    side: XqSide,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
    fallback: () => SearchResult<XqMove>,
  ): Promise<SearchResult<XqMove>> {
    void historyLength;
    // 加载中不要卡住这一手：先让内置 JS 立刻应手，加载在后台继续
    if (!this.isReady) {
      void this.warmUp().catch(() => undefined);
      return fallback();
    }
    try {
      await this.ensureReady();
    } catch {
      return fallback();
    }

    const t0 = now();
    const cfg = PIKAFISH_LEVELS[difficulty];
    // 每手在预算上抖一点，避免 AI 互搏每局一模一样
    const jitter = mode === 'aivai' ? 0.88 + Math.random() * 0.24 : 1;
    const turnMs = Math.round(cfg.turnMs * jitter);
    const multiPv = difficulty === 4 ? DEMON_MULTIPV : 1;

    const fen = boardToFen(board, side);
    const parser = new UciParser();
    this.onLine = (line) => parser.feed(line);

    try {
      // 一批发完：引擎会逐行 getline 消化
      this.cmd('setoption name MultiPV value ' + multiPv);
      this.cmd('setoption name Skill Level value ' + cfg.skill);
      this.cmd('position fen ' + fen);
      this.cmd('go movetime ' + turnMs);

      const deadline = now() + turnMs + 4000;
      while (!parser.bestmove && now() < deadline) await sleep(20);
      if (!parser.bestmove) throw new Error('pikafish produced no move');

      const mv = uciToXqMove(parser.bestmove, board);
      if (!mv) throw new Error('pikafish 返回了无法解析的着法: ' + parser.bestmove);

      // 候选列表：最后一轮 multipv 块，着法取自各自 pv 首步
      const scores: Array<XqMove & { v: number }> = [];
      for (const b of parser.latest.slice().sort((a, z) => a.multipv - z.multipv)) {
        const cand = uciToXqMove(b.pv[0], board);
        if (cand) scores.push({ ...cand, v: b.eval });
      }
      // 保证选中的着法在候选列表首位
      const bi = scores.findIndex((s) => s.fx === mv.fx && s.fy === mv.fy && s.tx === mv.tx && s.ty === mv.ty);
      if (bi > 0) scores.unshift(...scores.splice(bi, 1));
      if (!scores.length) scores.push({ ...mv, v: 0 });

      const best = parser.latest.find((b) => b.multipv === 1) ?? parser.latest[0];
      const pv = (best?.pv ?? []).map((s) => uciToXqMove(s, board)).filter((m): m is XqMove => !!m);

      return {
        move: mv,
        depth: best?.depth ?? 0,
        nodes: best?.nodes ?? 0,
        ms: Math.round(now() - t0),
        eval: best?.eval ?? 0,
        scores,
        pv,
        engine: this.engineTag(),
      };
    } catch (err) {
      this.searchFailures++;
      console.warn(`[pikafish] 搜索失败，回退内置引擎：`, err);
      if (this.stderrTail.length) console.warn('[pikafish] 引擎 stderr 末尾：\n' + this.stderrTail.join('\n'));
      this.markDead('搜索超时未产出着法');
      if (this.searchFailures >= 2) {
        this.disabled = true;
        console.warn('[pikafish] 引擎连续失败，本局改用内置 JS 引擎（刷新页面可重试）');
      }
      return fallback();
    } finally {
      this.onLine = null;
    }
  }

  private engineTag(): SearchResult<XqMove>['engine'] {
    return this.ready ? 'pikafish' : undefined;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
