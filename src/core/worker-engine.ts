/* ────────────────────────────────────────────────────────────
 *  core/worker-engine.ts — 外部引擎客户端的公共骨架
 *
 *  Rapfi / XQWLight / Egaroucid 三个引擎的接入形状是同一个：真身跑在各自的
 *  worker 里，客户端只做「起 worker → 等 ready → 一问一答 → 超时兜底」。
 *  这里收掉这套骨架，各引擎只留协议差异（worker 地址、init 内容、消息字段、
 *  看门狗时长）。
 *
 *  降级语义：初始化失败或运行中死亡都把 worker 清掉，调用方随即改用内置引擎；
 *  同一局里连续失败到 maxFailures 次后整体停用，避免之后每一手都白等超时。
 * ──────────────────────────────────────────────────────────── */

import { asError, errText } from './errors';

export interface InitMessage {
  message: unknown;
  /** 需要 transfer 的大块（如已下好的权重包） */
  transfer?: Transferable[];
}

interface Waiter<Reply> {
  resolve: (r: Reply) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** worker 侧回来的消息：只有 ready / error / exit 是各引擎通用的，其余交给子类 */
export interface EngineMessage {
  type?: string;
  id?: number;
  data?: unknown;
}

/** Reply：一次搜索的结果类型；Msg：该引擎 worker 的消息协议 */
export abstract class WorkerEngine<Reply, Msg extends EngineMessage = EngineMessage> {
  protected worker: Worker | null = null;
  /** 引擎已 boot 完成（可接受搜索请求） */
  ready = false;

  private readyPromise: Promise<void> | null = null;
  private readonly pending = new Map<number, Waiter<Reply>>();
  private nextId = 0;
  private failures = 0;
  private disabled = false;

  /** 日志前缀，如 '[rapfi]' */
  protected abstract readonly label: string;
  /** 超时或引擎死亡时交给等待者的空回包 */
  protected abstract emptyReply(): Reply;
  protected abstract workerUrl(): string;
  /** init 消息；extra 由 start() 透传（如主线程已下好的权重包） */
  protected abstract initMessage(extra?: unknown): InitMessage;

  /** 初始化看门狗：这么久没有进展就判定起不来 */
  protected readyTimeoutMs = 20_000;
  /** 每收到一条消息都重置看门狗（弱网下 10MB 权重边下边报进度时不能被误杀） */
  protected keepAliveOnMessage = false;
  /** Egaroucid 的胶水是 ES module，必须按 module worker 起 */
  protected workerType: WorkerOptions['type'] | undefined = undefined;
  /** 连续失败达到该次数后整体停用 */
  protected maxFailures = 2;

  protected onReadyMessage(_msg: Msg): void {}
  /** 子类处理协议消息；回包用 settle() 落地 */
  protected onEngineMessage(_msg: Msg): void {}
  /** 引擎死亡时的额外记账（如记住挂掉的是哪个构建） */
  protected onDead(_why: string): void {}
  /** 追加到「引擎停止」日志后的补充说明 */
  protected stopNote(): string {
    return '';
  }

  static isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  /** 起 worker 并等 ready；已在初始化中则复用同一个 promise。 */
  protected start(extra?: unknown): Promise<void> {
    if (this.disabled) return Promise.reject(new Error(`${this.label} 引擎已停用`));
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      let w: Worker;
      try {
        w = this.workerType ? new Worker(this.workerUrl(), { type: this.workerType }) : new Worker(this.workerUrl());
      } catch (err) {
        reject(asError(err));
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!err) {
          resolve();
          return;
        }
        this.readyPromise = null;
        this.killWorker();
        reject(err);
      };
      const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(`${this.label} 初始化超时`)), this.readyTimeoutMs);
      };
      arm();

      w.onmessage = (e: MessageEvent<Msg>) => {
        // 换过 worker 之后，旧 worker 的迟到消息必须丢弃：terminate() 只挡后续投递，
        // 已经在事件队列里的消息仍会送达，否则会把新 worker 误判为死亡。
        if (this.worker !== w) return;
        if (this.keepAliveOnMessage) arm();

        const msg = e.data ?? ({} as Msg);
        switch (msg.type) {
          case 'ready':
            this.ready = true;
            this.onReadyMessage(msg);
            finish();
            return;
          case 'error': {
            const why = errText(msg.data);
            console.error(`${this.label} 引擎报错：${why}`);
            if (!this.ready) finish(new Error(why));
            else this.markDead(why);
            return;
          }
          case 'exit': {
            // stdin 队列读空或崩溃都会走到这里。启动阶段算失败，运行期必须立刻
            // 标记死亡，否则 readyPromise 仍是已完成状态，之后每一手都会把命令
            // 发给死引擎、白等满超时才回退。
            const why = '引擎退出（stdin 读空或崩溃）';
            if (!this.ready) finish(new Error(why));
            else this.markDead(why);
            return;
          }
          default:
            this.onEngineMessage(msg);
        }
      };
      w.onerror = (e) => {
        if (this.worker !== w) return;
        const why = `worker error: ${e.message || 'unknown'}`;
        if (!this.ready) finish(new Error(`${this.label} ${why}`));
        else this.markDead(why);
      };

      this.worker = w;
      const init = this.initMessage(extra);
      w.postMessage(init.message, init.transfer ?? []);
    });

    return this.readyPromise;
  }

  /** 发一条带 id 的请求；超时或引擎不在位时回空包，调用方据此走兜底。 */
  protected request(message: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    return new Promise<Reply>((resolve) => {
      if (!this.worker) {
        resolve(this.emptyReply());
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve(this.emptyReply());
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ ...message, id });
    });
  }

  /** 子类在 onEngineMessage 里按 id 把回包落地。 */
  protected settle(id: number | undefined, reply: Reply): void {
    if (id === undefined) return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(reply);
  }

  /** 记一次失败；连续失败到阈值即整体停用（返回 true 表示本局不再用该引擎）。 */
  protected noteFailure(): boolean {
    this.failures++;
    if (this.failures < this.maxFailures) return false;
    this.disabled = true;
    console.warn(`${this.label} 连续失败，本局改用内置引擎（刷新页面可重试）`);
    return true;
  }

  protected noteSuccess(): void {
    this.failures = 0;
  }

  /** 标记引擎不可用：清掉 readyPromise，下一次搜索会重建实例而不是发给死进程。 */
  protected markDead(why: string): void {
    if (!this.readyPromise && !this.worker) return; // 已经处理过
    console.warn(`${this.label} 引擎停止${this.stopNote()}：${why}`);
    this.onDead(why);
    this.readyPromise = null;
    this.ready = false;
    this.killWorker();
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.emptyReply());
    }
    this.pending.clear();
  }

  /** dispose 前要发的收尾命令（Egaroucid 会应答 quit） */
  protected quitMessage(): unknown | null {
    return null;
  }

  dispose(): void {
    const quit = this.quitMessage();
    if (quit) this.worker?.postMessage(quit);
    this.killWorker();
    this.ready = false;
    this.readyPromise = null;
  }

  private killWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
