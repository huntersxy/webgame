/* ───────────────────────────────────────────────────────────────
 *  src/ai/ddz-worker.ts — 斗地主 DouZero 推理 Worker
 *
 *  独立于 src/ai/worker.ts（棋类引擎共用），只服务斗地主：
 *  模型 ArrayBuffer 由主线程转移进来（零拷贝），
 *  onnxruntime-web（WASM 后端）建三个会话；收到局面后
 *  编码 → 批量推理 → argmax Q → 返回牌值走法。
 * ─────────────────────────────────────────────────────────────── */

// 只取 wasm 后端构建：主入口会拖入 webgl/webgpu 与 28MB 的 jsep 运行时，这里用不到
import * as ort from 'onnxruntime-web/wasm';
// glue 与 14MB 的 .wasm 二进制放在 /public/ort/ 下，由 scripts/copy-ort-wasm.mjs
// 在 predev / prebuild 时从 node_modules 同步过去。
//
// 为什么不走 Vite 的 ?url：那样构建产物是带 hash 的 /assets/*.mjs，而 .mjs 在不少
// 静态主机上没有映射成 JavaScript MIME（返回 application/octet-stream），浏览器对
// 动态 import() 做 MIME 检查会直接拒绝，模型就加载不起来。改成 public/ 下的 .js
// 后缀后，任何主机都会按 JavaScript 下发。
import type { DdzState } from '../ddz/game';
import { getObs } from '../ddz/encoder';
import type { DdzWorkerResponse } from '../ddz/douzero';

function reply(msg: DdzWorkerResponse): void {
  self.postMessage(msg);
}

/** 角色 → 会话 */
const sessions: Partial<Record<'landlord' | 'landlord_up' | 'landlord_down', ort.InferenceSession>> = {};

function configureEnv(): void {
  // 固定路径：由 copy-ort-wasm.mjs 同步到 public/ort/，dev 与构建两态一致。
  ort.env.wasm.wasmPaths = {
    mjs: '/ort/ort-wasm-simd-threaded.js',
    wasm: '/ort/ort-wasm-simd-threaded.wasm',
  };
  // 单线程：网络极小（每层几百神经元），单线程已 <10ms，且不依赖 SAB
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
}

async function warmUp(models: { landlord: ArrayBuffer; landlord_up: ArrayBuffer; landlord_down: ArrayBuffer }): Promise<void> {
  configureEnv();
  const roles = ['landlord', 'landlord_up', 'landlord_down'] as const;
  let done = 0;
  for (const role of roles) {
    reply({ type: 'load-progress', label: `编译 ${role}.onnx`, loaded: done, total: 3 });
    try {
      sessions[role] = await ort.InferenceSession.create(models[role], {
        executionProviders: ['wasm'],
      });
    } catch (err) {
      reply({
        type: 'warmup-done',
        ok: false,
        error: `${role}.onnx 初始化失败：${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    done += 1;
  }
  reply({ type: 'load-progress', label: '就绪', loaded: 3, total: 3 });
  reply({ type: 'warmup-done', ok: true });
}

async function handleMove(id: number, state: DdzState, seat: number): Promise<void> {
  const t0 = performance.now();
  const role = positionRole(state, seat);
  const session = sessions[role];
  if (!session) throw new Error('模型尚未就绪');

  const obs = getObs(state, seat);
  const n = obs.legalActions.length;
  if (n === 0) {
    reply({ type: 'move-result', id, move: [], q: 0, ms: 0 });
    return;
  }

  const z = new ort.Tensor('float32', obs.zBatch, [n, 5, 162]);
  const x = new ort.Tensor('float32', obs.xBatch, [n, obs.xDim]);
  const inputNames = session.inputNames;
  const feeds: Record<string, ort.Tensor> = {};
  for (const name of inputNames) {
    feeds[name] = name === 'z' ? z : x;
  }

  const results = await session.run(feeds);
  const outKey = session.outputNames[0];
  const out = results[outKey];
  const data = out.data as Float32Array;

  // argmax Q
  let best = 0;
  let bestQ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    if (data[i] > bestQ) {
      bestQ = data[i];
      best = i;
    }
  }

  reply({
    type: 'move-result',
    id,
    move: obs.legalActions[best],
    q: bestQ,
    ms: performance.now() - t0,
  });
}

function positionRole(state: DdzState, seat: number): 'landlord' | 'landlord_up' | 'landlord_down' {
  if (seat === state.landlordSeat) return 'landlord';
  return (seat - state.landlordSeat + 3) % 3 === 1 ? 'landlord_down' : 'landlord_up';
}

self.onmessage = (e: MessageEvent) => {
  const data = e.data as
    | {
        type: 'ddz-warmup';
        models: { landlord: ArrayBuffer; landlord_up: ArrayBuffer; landlord_down: ArrayBuffer };
      }
    | { type: 'ddz-move'; id: number; state: DdzState; seat: number };

  if (data.type === 'ddz-warmup') {
    warmUp(data.models).catch((err) => {
      reply({
        type: 'warmup-done',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }

  if (data.type === 'ddz-move') {
    handleMove(data.id, data.state, data.seat).catch((err) => {
      reply({
        type: 'move-error',
        id: data.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
};
