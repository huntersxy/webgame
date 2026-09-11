<div align="center">

# 🐟 汐兮雨的小鱼池

免注册、无广告、可离线运行的轻量网页游戏平台。棋类 AI 与休闲小游戏全部在浏览器本地计算，不需要服务器参与。

[![Build & Deploy](https://github.com/huntersxy/webgame/actions/workflows/deploy.yml/badge.svg)](https://github.com/huntersxy/webgame/actions/workflows/deploy.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Node](https://img.shields.io/badge/Node-22-339933?logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-2ea44f)

**五子棋** · **围棋** · **中国象棋** · **军棋（陆战棋）** · **龙卷风成长记** · **战役**

</div>

## 游戏

| 游戏 | 路由 | 玩法与技术要点 |
| --- | --- | --- |
| ⚫ 五子棋 | `#/gomoku` | 15×15，人机 / 双人 / AI 互搏，四档难度，求一着与「请神上身」；Rapfi WASM 引擎（含 NNUE 权重） |
| ⚪ 围棋 | `#/go` | 9 / 13 / 19 路，中国规则数子；KataGo 官方最小网络在浏览器内推理，四档难度，候选点、形势判断、AI 互搏 |
| ♞ 中国象棋 | `#/xiangqi` | 完整规则（蹩马腿、塞象眼、飞将、困毙判负）；神经网络与经典引擎二选一，四档难度，棋盘可翻转 |
| ⚫⚪ 黑白棋 | `#/othello` | 8×8 翻转棋（奥赛罗）；位置权重 + 行动力评估、迭代加深 α-β、终局精确求解，四档难度，支持停手自动处理 |
| ⚔️ 军棋 · 陆战棋 | `#/junqi` | 明棋（自定义摆阵）/ 揭棋（暗棋）两种玩法，人机四档难度，AI 互搏观战 |
| 🌪️ 龙卷风成长记 | `#/tornado` | 大鱼吃小鱼式成长，六个量级从街道一路卷到全地球 |
| 🏰 战役 | `#/campaign` | 五子棋风格化守关 AI，破防获胜解锁下一关 |

## 特性

- **完全本地** — 规则、AI、渲染均在浏览器内完成，不联网也能开局
- **Web Worker 隔离搜索** — 深度计算在独立线程，界面不卡顿
- **Canvas 2D 渲染** — 木纹棋盘、落子动画、思考过程可视化（深度 / 节点 / 评估 / 主变 / 访问量）
- **程序化音效** — Web Audio 实时合成，除恶魔主题 BGM 外无音频文件依赖
- **触控与鼠标统一** — Pointer 事件一套代码，手机可直接开局
- **模型随站点分发** — 推理权重均为静态资源，无外部服务调用

## 快速开始

```bash
git clone https://github.com/huntersxy/webgame.git
cd webgame
npm install

npm run dev        # 开发服务器 http://localhost:5173
npm run build      # 类型检查 + 生产构建 → dist/
npm run preview    # 预览生产构建
npm test           # 8 套引擎自测，共 308 项
```

测试分布：五子棋 27 · 军棋 66 · Rapfi 18 · 象棋 FEN 16 · 象棋神经网络 32 · XQWLight 22 · 龙卷风 32 · 黑白棋 27 · 黑白棋控制器 9 · 围棋 95。

## AI 引擎

### 围棋

- **网络**：KataGo 官方最小的正式网络 `g170-b6c96`（3.8MB，6 个残差块 × 96 通道，约 103 万参数），由 TensorFlow.js 在浏览器内前向推理
- **推理后端**：WebGPU → WebGL → WASM → CPU 依次降级；后端能力不足时自动下调访问量，并在界面上标注实际使用的引擎
- **权重加载**：`.bin.gz` 用浏览器原生 `DecompressionStream` 解压，权重为 fp32；约 3.8MB，仅在进入围棋页时获取
- **输入编码**：KataGo v7 输入（22 个空间平面 + 19 个全局通道），棋盘按实际路数推理；征子与区域归属分别由有预算的征子搜索和 KataGo `calculateArea` 口径计算
- **搜索**：PUCT，策略先验 + 胜率/目差价值，批量叶子评估、虚拟损失、FPU、根节点策略温度与噪声；四档难度由访问量与时间预算决定
- **规则**：中国规则数子，禁止自杀与全局同形，双方连续虚手终局；9/13 路贴目 7 目，19 路 7.5 目；终局按网络归属判定死子，可「继续下棋」复核
- **兜底**：权重未就绪或加载失败时，由内置常识棋应手，对局不会中断
- **验证**：与参考实现 [web-katrain](https://github.com/Sir-Teo/web-katrain) 对拍 6 个局面（9/13/19 路，含提子与中盘），策略 logits、胜率、目差、归属一致

### 中国象棋

面板「引擎」一行可在两套引擎间切换，二者都在本地运行：

**神经网络（默认）**

- 权重 `public/xqnn/chess_model.onnx`，8.7MB；AlphaZero 风格 ResNet（128 滤波器 × 6 残差块，策略 + 价值双头），上游 [yingwang/chinese_chess](https://github.com/yingwang/chinese_chess)（MIT）
- 不引入 ONNX Runtime：改用项目内的 TensorFlow.js 复刻前向，ONNX 由自写的极简 protobuf 解析器读取
- 与 onnxruntime 对拍 7 个局面：策略 logits 最大偏差 1.1e-5，价值最大偏差 8.9e-7，top-8 着法一致
- 融合方式为「α-β 负责战术，网络提供先验」：策略 logit 作为根着法先验，价值头作小幅修正，修正幅度按难度设限（恶魔 / 困难 ±8 / ±25，普通 / 简单 ±140 / ±300），高难度档不会因网络判断而放弃战术上更好的着法

**XQWLight 小巫师（经典）**

- 上游 [xqbase/xqwlight](https://github.com/xqbase/xqwlight) 的现成 JavaScript 引擎（GPL-2.0+，约 366KB），自带开局库，含迭代加深、PVS、空步剪枝、静态搜索与置换表
- 由独立 classic worker 加载，GPL 代码与主程序隔离；无需 SharedArrayBuffer 或跨源隔离

**兜底**：所选引擎未就绪或出错时，由内置 α-β 引擎应手（子力 + 位置价值表 + MVV-LVA + 置换表 + 将军延伸 + 静态搜索），面板与思考日志会标注当前引擎。

**思考时间**：恶魔档硬上限 10s、软目标 6s——逐层迭代加深，每层跑完后按上一层耗时预估下一层是否值得再开，未跑完的层一律丢弃（不采用被截断的结果）；局面简单时 2~4s 就收手，复杂局面才接近上限。「求一着」提示走 3s 短预算。

### 五子棋

- [Rapfi](https://github.com/dhbloo/rapfi)（Gomocup 顶级引擎，GPL-3.0）的官方 WebAssembly 版本，含 mix9svq NNUE 评估权重，共约 12MB，随站点分发
- 服务器返回 COOP/COEP 响应头时自动启用多线程构建，否则使用单线程构建
- 四档难度映射到引擎协议的棋力档与每手时间预算；协议层无状态，每手重放棋盘，兼容悔棋与重开
- 兜底：内置 JS 引擎（`src/gomoku/`，迭代加深 α-β + PVS + VCF）
- 恶魔档固定使用 Rapfi，引擎未就绪时该档位不可选

### 黑白棋

- **规则**：8×8 棋盘，开局中央四子（黑 e4/d5、白 d4/e5），黑先。落子须沿横、竖、斜任一方向夹住对方棋子，被夹住的棋子全部翻转。某方无合法落点时自动停一手，双方都无法落子时终局按子数判胜负。
- **棋盘表示**：两个 32 位整数的位棋盘（不用 BigInt，深搜里无对象分配），方向移位用 `!(k&7)` 掩码清除绕行位；合法着法与夹击链均以位运算实现。
- **评估**：位置权重（角 500 / 边 40 / 角旁格 −120 / 中心 −18）与行动力差为主要指标，子数差只有极小权重——中盘多子在黑白棋里通常是劣势；进入终局区间后切换为「子数差 + 稳定子」口径。
- **搜索**：迭代加深 α-β + PVS 零窗口试探 + 置换表（Zobrist 式哈希 + 下界/上界标记）+ 静态走法排序；剩余空格 ≤ 14 时改为完全搜索（精确求解），单次搜索有节点硬上限与手数上限保护。
- **四档难度**：预算 60 / 400 / 1600 / 5200 毫秒，深度上限 1 / 4 / 9 / 13；简单档会以一定概率选择次优着法，保证新手也有胜机。
- **交互**：求一着（绿色虚线圈，1800 毫秒预算）与请神上身（紫色「神」标记，每手自动重算）复用恶魔档配置；悔棋为落子前棋盘快照回滚，可撤销停手。
- **验证**：位棋盘实现与朴素 2D 参考实现 200 局逐手对拍零分歧；开局 perft(1..5) = 4 / 12 / 56 / 244 / 1396，与公开数值一致。

### 军棋

- 搜索运行在紧凑棋盘表示上（60 个节点编码进 `Uint8Array`），走法生成、战斗结算与撤销栈均免分配
- 配合后期着法缩减、根节点 PVS、杀手着、跨手保留置换表与静态搜索，各档位迭代加深
- 揭棋信息模型：己方棋子始终可见，对方仅知已暴露的身份；位置、旗区守备与威胁只统计已知信息，暗子按编制先验折算期望威胁
- 明棋支持自定义摆阵并实时校验（军旗入大本营、地雷限后两排、炸弹不进第一排、行营留空）

## 部署

推送 `master` 会自动触发 **引擎自测 → 类型检查与构建 → FTP 上传 `dist/`**，也可在 [Actions](https://github.com/huntersxy/webgame/actions) 手动触发。工作流见 [deploy.yml](.github/workflows/deploy.yml)。

### 推荐的 nginx 配置

```nginx
server {
    # 跨源隔离：启用后可让 Rapfi 使用多线程构建（不配置也能玩，自动降级单线程）
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;

    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types application/wasm application/javascript text/css application/json image/svg+xml;

    # 引擎资源与围棋权重：URL 带 ?v=<版本号>，可长期缓存
    # 注意：location 内出现 add_header 后，server 级的 add_header 不再继承，需重复声明
    location ~* ^/(rapfi|go|xqnn|xqwlight)/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }

    # 构建产物文件名带内容哈希，同样可长期缓存
    location ~* ^/assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }

    # 入口 HTML 需要每次校验，避免指向已删除的旧哈希文件
    location = /index.html {
        add_header Cache-Control "no-cache" always;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }
}
```

资源版本号纪律：更换 `public/` 下任何引擎资源后，同步递增对应的版本常量，否则长期缓存会让访客继续使用旧文件 —— Rapfi 见 `src/gomoku/rapfi-assets.ts` 的 `RAPFI_ASSET_VERSION`，围棋见 `src/go/model-assets.ts` 的 `GO_ASSET_VERSION`，象棋神经网络见 `src/xqnn/model-assets.ts` 的 `XQNN_ASSET_VERSION`，XQWLight 见 `src/xiangqi/xqwlight.ts` 的 `XQWLIGHT_ASSET_VERSION`。

COEP `require-corp` 要求页面的跨域子资源自带 CORP/CORS 响应头；本项目资源全部自包含，无此问题。若后续引入 CDN 资源，需补 `crossorigin` 属性。

## 项目结构

```
webgame/
├── index.html                 平台外壳：首页与各游戏页面
├── styles.css                 浅色 UI 样式
├── vite.config.ts / tsconfig.json / package.json
├── .github/workflows/deploy.yml   构建 + FTP 自动部署
├── scripts/
│   └── copy-tfjs-wasm.mjs     复制 TF.js WASM 后端到 public/go/tfjs/（predev / prebuild 自动执行）
├── public/                    随站点分发的引擎与权重
│   ├── rapfi/                 Rapfi WASM（多线程 / 单线程构建 + NNUE 权重 + worker 胶水）
│   ├── go/                    围棋：KataGo 最小网络权重、TF.js WASM 后端、NOTICE.md
│   ├── xqnn/                  象棋神经网络权重 chess_model.onnx
│   └── xqwlight/              XQWLight 引擎与 worker 胶水、NOTICE.md
├── tests/                     引擎自测（见上方测试分布）
│   └── fixtures/              与上游实现对齐用的黄金输出
└── src/
    ├── main.ts                Hash 路由 + 共享服务 + 控制器装配
    ├── types.ts               全局类型定义
    ├── assets/                恶魔主题头像与 BGM
    ├── core/                  zobrist.ts · transposition.ts（各引擎共用）
    ├── gomoku/                五子棋：规则 · 搜索 · 评估 · 开局库 · Rapfi 客户端
    ├── go/                    围棋：rules（规则）· area / life（区域与征子）· features（输入编码）
    │                          model / tf-model（权重解析与前向）· evaluate（后端降级）· mcts（PUCT）
    │                          engine（难度与兜底）· heuristic（常识棋）· model-assets（权重与预取）
    ├── xqnn/                  象棋神经网络：onnx（解析）· model（前向）· encoding（特征与走法表）
    │                          evaluate · search（与 α-β 融合）· engine · model-assets
    ├── xiangqi/               象棋：rules · eval · search（内置 α-β）· fen · xqwlight（经典引擎客户端）
    ├── junqi/                 军棋：rules（棋盘 / 铁路 / 战斗 / 摆阵 / 暗子）· ai · render
    ├── tornado/               龙卷风成长记引擎
    ├── campaign/              战役模式守关 AI
    ├── ai/                    worker.ts · ai-bridge.ts（主线程与 Worker 的 Promise 桥）
    ├── controllers/           各游戏控制器（棋盘状态、AI 调度、面板与日志）
    └── ui/                    渲染器（五子棋 / 象棋 / 围棋）· 音频 · 主题 · 格式化
```

## 开发约定

- **分层**：规则、AI、渲染、控制器各自独立，可单独测试与替换
- **引擎无副作用**：搜索不改动传入棋盘；增量状态一致性由随机走子对拍测试覆盖
- **通信 Promise 化**：`AIBridge` 封装 Worker 请求，按 id 匹配应答
- **降级链**：每个引擎都有可用的兜底路径，AI 不可用时对局不会中断

## 技术栈

- **TypeScript**（strict）· **Vite 6**
- **Web Workers** — 搜索与推理独立线程
- **TensorFlow.js** — 围棋与象棋神经网络推理，后端按需动态加载
- **Canvas 2D / Web Audio** — 渲染与程序化音效

## 许可与致谢

本项目代码以 [MIT](LICENSE) 许可发布。内置的第三方引擎与模型：

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [Rapfi](https://github.com/dhbloo/rapfi) | GPL-3.0 | 五子棋 WASM 引擎与 NNUE 权重，作为独立资源分发 |
| [XQWLight](https://github.com/xqbase/xqwlight) | GPL-2.0+ | 象棋经典引擎，由独立 worker 加载 |
| [KataGo 神经网络](https://katagotraining.org/network_license/) | KataGo Neural Network License | 围棋权重，声明见 `public/go/NOTICE.md` |
| [yingwang/chinese_chess](https://github.com/yingwang/chinese_chess) | MIT | 象棋神经网络权重 |
| [TensorFlow.js](https://github.com/tensorflow/tfjs) | Apache-2.0 | 推理运行时 |

实现过程中参考过的开源项目（不包含其代码）：[web-katrain](https://github.com/Sir-Teo/web-katrain)（围棋管线对照与回归基准）、[lightvector/KataGo](https://github.com/lightvector/KataGo)（网络结构与输入定义）。
