/* ────────────────────────────────────────────────────────────
 *  ai/backend-tuning.ts — TF.js 后端调优（围棋 / 象棋共用）
 *
 *  两个神经网络的计算量几乎全在卷积上——围棋 KataGo 小网络是 6 个残差块
 *  × 96 通道，象棋是 6 个残差块 × 128 滤波器，一次前向就是几百次 3×3 卷积。
 *  所以这里只调与卷积/矩阵乘相关的后端开关，其余一律保持上游默认值，避免
 *  引入难以定位的数值或性能回归。
 *
 *  时机很讲究，写错了会静默失效：tfjs 的 flag 由各后端模块在 import 时才
 *  注册，而 `env.set()` 对一个尚未注册的 flag 会**直接抛错**
 *  （"Cannot set flag X as it has not been registered"）。
 *  所以顺序必须是：动态 import 后端 → applyBackendTuning() → tf.setBackend()。
 * ──────────────────────────────────────────────────────────── */

import * as tf from '@tensorflow/tfjs-core';

/** 与各评估器的后端名一致；这里不 import 具体模块，避免循环依赖 */
type BackendName = string;

/**
 * 按后端写入调优开关。
 *
 * **必须在对应后端模块 import 之后、`tf.setBackend()` 之前调用。**
 * 早于 import 会因 flag 未注册而抛错（被这里吞掉，等于没调优）；
 * 晚于 setBackend 则后端已经用默认值初始化完毕，改了也不生效。
 *
 * 两个开关的依据：
 *
 *  · `WEBGPU_CONV_SEPARATE_IM2COL_SHADER`（上游默认 false）
 *    把 im2col 拆成独立 shader，卷积核与输入不再在同一个 kernel 里反复重排。
 *    上游默认关掉是因为它对 depthwise / 小卷积反而更慢；本项目用的是
 *    3×3、96~128 通道的标准卷积，正是它能吃到收益的形状。
 *
 *  · `WEBGL_USE_SHAPES_UNIFORMS`（上游默认 false）
 *    张量形状走统一缓冲而不是逐次绑定，减少每次 dispatch 的 uniform 开销
 *    与着色器重编译。层数多、算子碎（bn / add / concat 一大堆）的残差网络
 *    受益明显，而这恰好是本项目两个网络的形态。
 */
export function applyBackendTuning(backend: BackendName): void {
  const wanted: Array<[string, boolean]> = [];
  if (backend === 'webgpu') wanted.push(['WEBGPU_CONV_SEPARATE_IM2COL_SHADER', true]);
  if (backend === 'webgl') wanted.push(['WEBGL_USE_SHAPES_UNIFORMS', true]);
  if (wanted.length === 0) return;

  const env = tf.env();
  for (const [flag, value] of wanted) {
    try {
      env.set(flag, value);
    } catch (err) {
      // 上游改了 flag 名或该后端版本不含此开关：只是慢一点，绝不能让引擎起不来
      console.warn(`[ai] 后端调优 ${flag} 未生效（不影响功能）：`, err);
    }
  }
}

/**
 * 各后端的单批样本数上限。
 *
 * 批处理的收益来自摊薄固定开销：一次前向要提交命令、等 GPU、读回结果，
 * 这段开销与样本数无关，批太小 GPU 就在空转。所以 GPU 后端值得开大。
 *
 * WASM / CPU 没有这段固定开销可摊，批开大反而让内存带宽成为瓶颈，还抬高
 * 单次延迟（对局中表现为「一手棋想很久然后突然落子」），所以只给兜底值。
 *
 * 这个值是**上限**：调用方仍受自己的难度档配置约束，取两者较小者。
 */
export function preferredBatchSize(backend: BackendName | null): number {
  switch (backend) {
    case 'webgpu':
      return 32;
    case 'webgl':
      return 24;
    default:
      return 8;
  }
}

/** 是否值得为多种棋盘尺寸预热（着色器按张量形状编译，预热能省掉换尺寸时的卡顿） */
export function shouldWarmAllBoardSizes(backend: BackendName | null): boolean {
  return backend === 'webgpu' || backend === 'webgl';
}
