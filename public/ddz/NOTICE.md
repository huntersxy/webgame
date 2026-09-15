# DouZero WP (ONNX) + onnxruntime-web WASM 运行时

本目录是斗地主 AI 的运行资产，随站点分发，不参与应用外壳的预缓存。

## 模型（models/）

- 上游项目：https://github.com/kwai/DouZero（Apache-2.0）
- 模型来源：https://huggingface.co/palemoky/douzero-baselines（`models_onnx/douzero_WP/`）
- 许可证：**Apache-2.0**（完整条款见上游仓库 LICENSE）
- 内容：三个角色 Q 网络，输入为 DouZero 官方特征编码，输出为各合法走法的 Q 值，argmax 即选点

| 文件 | 角色 | x 维度 | 大小 |
| --- | --- | --- | --- |
| `landlord.onnx` | 地主 | 373 | 5,834,135 B |
| `landlord_up.onnx` | 地主上家（农民） | 484 | 6,061,463 B |
| `landlord_down.onnx` | 地主下家（农民） | 484 | 6,061,463 B |

- 牌值编码沿用上游：`3..10,J,Q,K,A = 3..14`，`2 = 17`，`小王 = 20`，`大王 = 30`
- 特征编码（`x` 约定 54×N 分段拼接 + `z` 最近 15 手重塑为 5×162）逐段对齐
  `douzero/env/env.py`；走法生成与牌型判定对齐 `move_generator.py` /
  `move_detector.py` / `move_selector.py`，由 `src/ddz/rules.ts` 移植
- 模型文件未做任何修改，仅从 PyTorch 转出的 ONNX 原样取用

## 推理运行时（onnxruntime-web）

- 上游项目：https://github.com/microsoft/onnxruntime（MIT）
- 来自 npm 包 `onnxruntime-web@1.30.0`，两个文件随包分发、未修改：
  - `ort-wasm-simd-threaded.wasm`（14,239,897 B）—— WASM 推理二进制
  - `ort-wasm-simd-threaded.mjs`（24,381 B）—— glue 模块（二进制的加载壳）
- 用途：在 Web Worker 内以前向推理执行上述 ONNX 模型；单线程模式运行
  （网络规模极小，多线程无收益，且不依赖 SharedArrayBuffer）
- 部署方式：两个文件都由 `src/ai/ddz-worker.ts` 以 `?url` 导入进 Vite 资源
  管线——构建后落在 `dist/assets/`（文件名带 hash），运行时通过
  `env.wasm.wasmPaths = { mjs, wasm }` 对象形式分别指向。
  若直接放在 `public/` 下，Vite dev 模式的转换中间件会拒绝把它们作为
  ES 模块导入（glue 必须是可导入的模块，不只是可下载的字节）。
  运行时缓存策略与引擎目录一致：CacheFirst、一年有效（按
  `/assets/ort-wasm-simd-threaded` 前缀匹配，见 vite.config.ts）。
