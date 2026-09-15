/* ───────────────────────────────────────────────────────────────
 *  src/ddz/douzero.ts — DouZero WP 推理桥（主线程侧）
 *
 *  AI = DouZero WP（ICML 2021 官方开源斗地主 AI）的三个 ONNX 网络：
 *    · landlord.onnx      地主视角 Q 网络（x 维 373）
 *    · landlord_up.onnx   地主上家（农民）视角（x 维 484）
 *    · landlord_down.onnx 地主下家（农民）视角（x 维 484）
 *  模型各约 6MB（均 <10MB），推理在独立 Web Worker 内由
 *  onnxruntime-web（WASM 后端）执行，主线程只做预取与转发。
 *
 *  首次进入预取三个模型（共约 17.1MB）并显示进度；加载完成前
 *  AI 先用内置启发式兜底，加载后自动切换——与围棋 KataGo 同款体验。
 * ─────────────────────────────────────────────────────────────── */

import type { DdzState } from './game';

/** 模型资产版本：升级模型文件时改它，让浏览器重新下载 */
export const DDZ_ASSET_VERSION = '1';

export const DDZ_MODEL_BYTES = {
  landlord: 5_834_135,
  landlord_up: 6_061_463,
  landlord_down: 6_061_463,
} as const;

export const DDZ_TOTAL_BYTES =
  DDZ_MODEL_BYTES.landlord + DDZ_MODEL_BYTES.landlord_up + DDZ_MODEL_BYTES.landlord_down;

export type DdzRole = 'landlord' | 'landlord_up' | 'landlord_down';

function modelUrl(role: DdzRole): string {
  return `/ddz/models/${role}.onnx?v=${DDZ_ASSET_VERSION}`;
}

/** Worker → 主线程消息 */
export type DdzWorkerResponse =
  | { type: 'load-progress'; label: string; loaded: number; total: number }
  | { type: 'warmup-done'; ok: boolean; error?: string }
  | { type: 'move-result'; id: number; move: number[]; q: number; ms: number }
  | { type: 'move-error'; id: number; error: string };

/** 主线程 → Worker 消息 */
type DdzWorkerRequest =
  | {
      type: 'ddz-warmup';
      models: { landlord: ArrayBuffer; landlord_up: ArrayBuffer; landlord_down: ArrayBuffer };
    }
  | { type: 'ddz-move'; id: number; state: DdzState; seat: number };

export interface DdzDecideResult {
  move: number[];
  q: number;
}

/**
 * DouZero 引擎句柄：懒建 Worker、预取模型、查询走法。
 * ready() 为 false 时调用方应使用启发式兜底。
 */
export class DouzeroEngine {
  private worker: Worker | null = null;
  private readyFlag = false;
  private failure: string | null = null;
  private warming: Promise<boolean> | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: DdzDecideResult) => void; reject: (e: Error) => void }
  >();

  ready(): boolean {
    return this.readyFlag;
  }

  error(): string | null {
    return this.failure;
  }

  /** 预取模型 + 建 Worker + 建会话；重复调用共享同一 Promise */
  warmUp(onProgress?: (loaded: number, total: number, label: string) => void): Promise<boolean> {
    if (this.warming) return this.warming;
    this.warming = this.doWarmUp(onProgress);
    return this.warming;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../ai/ddz-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DdzWorkerResponse>) => this.onMessage(e.data);
    w.onerror = (e) => {
      this.failure = `AI Worker 故障：${e.message ?? '未知错误'}`;
      for (const [, p] of this.pending) p.reject(new Error(this.failure));
      this.pending.clear();
    };
    this.worker = w;
    return w;
  }

  private onMessage(msg: DdzWorkerResponse): void {
    switch (msg.type) {
      case 'load-progress':
        this.progressCb?.(msg.loaded, msg.total, msg.label);
        break;
      case 'warmup-done':
        this.readyFlag = msg.ok;
        if (!msg.ok) this.failure = msg.error ?? '模型初始化失败';
        this.resolveWarm?.(msg.ok);
        break;
      case 'move-result': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve({ move: msg.move, q: msg.q });
        }
        break;
      }
      case 'move-error': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.reject(new Error(msg.error));
        }
        break;
      }
    }
  }

  private progressCb: ((loaded: number, total: number, label: string) => void) | null = null;
  private resolveWarm: ((ok: boolean) => void) | null = null;

  private async doWarmUp(
    onProgress?: (loaded: number, total: number, label: string) => void,
  ): Promise<boolean> {
    this.progressCb = onProgress ?? null;
    try {
      // 主线程预取三个模型（走运行时 CacheFirst 缓存），带字节进度
      const roles: DdzRole[] = ['landlord', 'landlord_up', 'landlord_down'];
      const buffers = {} as Record<DdzRole, ArrayBuffer>;
      let loaded = 0;
      const total = DDZ_TOTAL_BYTES;

      for (const role of roles) {
        const resp = await fetch(modelUrl(role));
        if (!resp.ok) throw new Error(`模型下载失败（HTTP ${resp.status}）：${role}`);
        const len = Number(resp.headers.get('content-length')) || DDZ_MODEL_BYTES[role];
        const reader = resp.body?.getReader();
        if (!reader) {
          buffers[role] = await resp.arrayBuffer();
          loaded += len;
          onProgress?.(loaded, total, `下载 ${role}.onnx`);
          continue;
        }
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.byteLength;
          onProgress?.(Math.min(loaded, total), total, `下载 ${role}.onnx`);
        }
        const buf = new Uint8Array(
          chunks.reduce((s, c) => s + c.byteLength, 0),
        );
        let off = 0;
        for (const c of chunks) {
          buf.set(c, off);
          off += c.byteLength;
        }
        buffers[role] = buf.buffer;
      }

      // 建 Worker，转移所有权递送模型（零拷贝），等待会话就绪
      const w = this.ensureWorker();
      const done = new Promise<boolean>((resolve) => {
        this.resolveWarm = resolve;
      });
      w.postMessage(
        {
          type: 'ddz-warmup',
          models: {
            landlord: buffers.landlord,
            landlord_up: buffers.landlord_up,
            landlord_down: buffers.landlord_down,
          },
        } satisfies DdzWorkerRequest,
        [
          buffers.landlord,
          buffers.landlord_up,
          buffers.landlord_down,
        ] as Transferable[],
      );
      return await done;
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
      this.readyFlag = false;
      return false;
    }
  }

  /** 查询某座位的最佳走法（牌值数组；[] = 不出）。仅在 ready 后可用 */
  decide(state: DdzState, seat: number): Promise<DdzDecideResult> {
    if (!this.readyFlag || !this.worker) {
      return Promise.reject(new Error(this.failure ?? '引擎未就绪'));
    }
    const id = this.nextId++;
    return new Promise<DdzDecideResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker?.postMessage({ type: 'ddz-move', id, state, seat } satisfies DdzWorkerRequest);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.readyFlag = false;
    this.warming = null;
    for (const [, p] of this.pending) p.reject(new Error('引擎已释放'));
    this.pending.clear();
  }
}
