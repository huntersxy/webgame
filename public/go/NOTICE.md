# public/go/ — 围棋神经网络资源与许可

## 权重文件

`g170-b6c96-s175395328-d26788732.bin.gz`（约 3.8MB，解压后 4.12MB）

- 来源：KataGo 官方最小的正式网络，随 KataGo 源码仓库分发用于测试
  <https://github.com/lightvector/KataGo>（`cpp/tests/models/`）
- 结构：modelVersion 8 · 6 个残差块 · 96 通道 · 22 个输入平面 + 19 个全局通道 · 约 103 万参数
- 用途：本站围棋人机的策略/价值网络，在浏览器内由 TensorFlow.js 前向（**不联网、不上传**）

### 神经网络许可（KataGo Neural Network License）

Copyright 2026 David J Wu ("lightvector").

Permission is hereby granted, free of charge, to any person obtaining a copy of
the neural net files or training weight files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

许可原文：<https://katagotraining.org/network_license/>

## tfjs/ 目录

TensorFlow.js WASM 后端所需的三个 `.wasm` 文件，由
`scripts/copy-tfjs-wasm.mjs` 从 `node_modules/@tensorflow/tfjs-backend-wasm/dist/`
复制而来（Apache-2.0，见 <https://github.com/tensorflow/tfjs>）。
只有当 WebGPU 与 WebGL 都不可用时才会去取它们。

## 实现出处

围棋这一套推理管线（权重解析 → v7 输入平面 → 前向 → PUCT 搜索）由本项目
独立实现，但实现过程中以 MIT 许可的开源项目
[Sir-Teo/web-katrain](https://github.com/Sir-Teo/web-katrain)
（Browser KaTrain）作为对照，并用它的输出做了逐位对齐的回归测试
（见 `tests/fixtures/go-golden.json` 与 `tests/go.test.mts`）。
KataGo 本身的架构与输入定义见
[lightvector/KataGo](https://github.com/lightvector/KataGo)（MIT）。
