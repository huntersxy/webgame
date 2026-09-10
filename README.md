<div align="center">

# 🐟 汐兮雨的小鱼池

**免注册 · 无广告 · 离线可玩** 的轻量网页游戏平台——棋类对决与休闲小游戏，AI 全部在浏览器本地计算。

[![Build & Deploy](https://github.com/huntersxy/webgame/actions/workflows/deploy.yml/badge.svg)](https://github.com/huntersxy/webgame/actions/workflows/deploy.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Node](https://img.shields.io/badge/Node-22-339933?logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-2ea44f)

<!-- 部署上线后，取消下一行注释并替换为你的站点地址，作为在线试玩入口 -->
<!-- [🔗 在线试玩](https://your-domain.example) -->

**五子棋** · **中国象棋** · **军棋（陆战棋）** · **龙卷风成长记** —— 不局限于棋类，休闲小游戏持续上新。

</div>

## 🕹️ 游戏列表

| 游戏 | 路由 | 玩法亮点 |
| --- | --- | --- |
| ⚫ 五子棋 | `#/gomoku` | 人机 / AI 互搏，四档难度；😈恶魔会存档你的败局并学习 |
| ♞ 中国象棋 | `#/xiangqi` | 完整规则（蹩马腿、塞象眼、飞将、困毙判负），四档难度，棋盘翻转 |
| ⚔️ 军棋 · 陆战棋 | `#/junqi` | **自定义摆阵** + **揭棋（暗棋）** + AI 互搏观战，人机四档难度 |
| 🌪️ 龙卷风成长记 | `#/tornado` | 大鱼吃小鱼式成长，六大量级从街道内一路卷到全地球 |
| 🏰 战役 | `#/campaign` | 五子棋风格化守关 AI，破防获胜解锁下一关 |

## ✨ 平台特性

- **完全本地** — 规则、AI、渲染全部跑在你的浏览器里，不上传、不限速、断网可玩
- **Web Worker 隔离 AI** — 深度搜索在独立线程运算，UI 永不卡顿
- **Canvas 2D 渲染** — 木纹棋盘、落子动画、思考可视化（深度 / 节点数 / 评估 / 主变）
- **程序化音效** — Web Audio 实时合成，零音频文件依赖（恶魔 BGM 除外）
- **移动端适配** — Pointer 事件统一鼠标与触控，手机也能开局

## 🚀 快速开始

```bash
git clone https://github.com/huntersxy/webgame.git
cd webgame
npm install

npm run dev        # 开发服务器 http://localhost:5173
npm run build      # 类型检查 + 生产构建 → dist/
npm run preview    # 预览生产构建
npm test           # 引擎自测：五子棋 JS 引擎 16 项 + 军棋 62 项 + rapfi WASM 8 项
```

## 🤖 引擎一览

### 五子棋 AI：Rapfi WASM 引擎

接入了 [Rapfi](https://github.com/dhbloo/rapfi)（Gomocup 顶级 C++ 引擎，GPL v3）的官方 WebAssembly 版本：

- **加载即战力** — 引擎文件（~12MB，`public/rapfi/`，含 mix9svq NNUE 评估权重）随站点静态分发，首次落子即完成实例化；引擎实例跨搜索常驻，置换表保温
- **多线程自适应** — 服务器返回 COOP/COEP 头时自动启用多线程构建（`rapfi-fb-multi`），否则降级单线程构建（`rapfi-fb-single`），纯静态托管开箱即用
- **难度 = 官方棋力档** — 通过引擎协议的 `INFO STRENGTH`（0~100）+ `INFO TIMEOUT_TURN` 时间预算映射四档难度（简单 120ms/棋力15 → 恶魔 2.8s/棋力100），AI 互搏附加以时间抖动保证每局不同
- **协议层全无状态** — 每手搜索用一条 `BOARD` 命令重放全盘，天然兼容悔棋/重开；引擎侧增量维护棋盘状态
- **三级降级链** — 多线程 WASM → 单线程 WASM → 内置 JS 引擎（`src/gomoku/`，迭代加深 α-β + PVS + VCF，同样的四档难度），wasm 加载失败自动兜底，永不无响应

### 中国象棋

子力 + 位置价值表 + MVV-LVA 排序 + Alpha-Beta + 置换表 + 将军延伸 + Quiescence；恶魔档带软时间预算与劣势自适应加深。

### 军棋 AI

搜索整体跑在紧凑棋盘表示（`src/junqi/fast.ts`）上：60 个节点编码进 `Uint8Array`，走法生成、战斗结算、撤销栈全部免分配，热路径里没有对象棋盘与字符串比较。配合后期着法缩减（LMR）、根节点 PVS、杀手着、跨手保留的置换表与静态搜索，全档位迭代加深（恶魔档 2.2~2.6s 预算内平均 depth 7~8）。

**信息模型（揭棋）**：轮走方始终知晓己方棋子，对对方只掌握交战翻明过的身份。评估因此分两层——子力按真值累加，位置项、旗区守备与威胁只统计轮走方确实已知的身份，对方暗子则按编制先验（3 工兵 / 2 炸弹 / 2 大子）折算期望威胁。注意子力项这样做是**精确**而非作弊：阵亡在交战翻明时即公开，双方剩余子力总和本就是公开信息，真实身份只在搜索树内部使用。

实测对照改前版本（同一批固定局面 · 恶魔档）：

| 模式 | 节点率 | 平均深度 |
| --- | --- | --- |
| 明棋 | 347k → 1271k 节点/秒（**3.66×**） | 6.08 → 8.00 |
| 揭棋 | 549k → 1230k 节点/秒（**2.24×**） | 6.08 → 7.79 |

等时间自对弈 30 局（旧引擎 vs 新引擎，交替先后手、同时间预算）：明棋 **22:6:2**、揭棋 **24:5:1**。

**为什么不做确定性采样（PIMC）**：揭棋的教科书解法是 PIMC——按公开信息（双方剩余编制、地雷必在后两排、军旗必在大本营）把对方暗子重排 K 次，每次当完全信息局面搜一遍再对根着法取平均。本仓库实现并实测过这条路径，结论是不采纳：固定预算切成 K 份后每份深度掉约 log(K) 层（K=8 只到 depth5，单世界能到 depth7），等时间自对弈 K=1 对 K=2 / K=4 / K=8 分别为 **20:0 / 20:0 / 19:1**，深度损失压倒了信息模型收益。故保持单世界搜索，把全部预算换成深度。

### 军棋 · 两种玩法

- **明棋**：全明对弈，支持自定义摆阵（军旗入大本营、地雷后两排、炸弹不进第一排、行营留空，实时校验）
- **揭棋（暗棋）**：双方棋子对对方暗置，自己始终可见己方；静默移动不翻明，**交战双方同时翻明**——胜者亮牌驻守，暗工兵拐弯走法会自曝身份
- 标准规则细节：大本营驻子不可再移动；司令阵亡即亮该方军旗（双方司令同归于尽则两面齐亮）；连续 120 步无吃子或总 500 手判和

## 📦 部署

推送 `master` 自动触发：**引擎自测 → 类型检查 + 构建 → FTP 上传 `dist/`**，也可在 [Actions](https://github.com/huntersxy/webgame/actions) 页面手动触发。部署方案见 [deploy.yml](.github/workflows/deploy.yml)。

### 多线程 WASM（可选，推荐）

五子棋 Rapfi 引擎的多线程变体需要页面处于 cross-origin isolated 状态。在 nginx 站点配置里加两个响应头即可启用（不配置也能玩，引擎自动降级单线程构建）：

```nginx
server {
    # ... 现有配置 ...
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;

    # 确认 .wasm 的 MIME（nginx ≥ 1.21 的 mime.types 已内置）：
    # curl -sI https://game.xiey.work/rapfi/rapfi-fb-single.wasm | grep -i content-type
    # 若不是 application/wasm，在 mime.types 里补：application/wasm wasm;
}
```

注意：COEP `require-corp` 会要求页面所有跨域子资源自带 CORP/CORS 头——本项目全部资源自包含，不受影响；若以后引入 CDN 字体/脚本，记得加 `crossorigin` 属性。配置后用 `curl -sI https://game.xiey.work/ | grep -i cross-origin` 验证响应头穿透 CDN。

## 🧱 项目结构

```
webgame/
├── index.html                 平台外壳：首页 + 四个子页面
├── styles.css                 浅色清新 UI（白卡片 + 薄荷绿主色）
├── vite.config.ts / tsconfig.json / package.json
├── .github/workflows/deploy.yml   构建 + FTP 自动部署
├── public/
│   └── rapfi/                 Rapfi WASM 引擎（multi/single 构建 + mix9svq 权重包 + classic worker 胶水）
├── tests/
│   ├── engine.test.mts        五子棋引擎测试（增量状态不变量 / 战术 / 速度 / 自对弈）
│   ├── junqi.test.mts         军棋规则引擎测试（摆阵 / 铁路 / 战斗 / 可逆走子 / AI）
│   └── rapfi.test.cjs         Rapfi WASM 冒烟测试（协议 / 时间预算 / 棋力档 / 会话持久）
└── src/
    ├── main.ts                Hash 路由 + 共享服务 + 控制器装配
    ├── types.ts               全局类型定义
    ├── assets/                恶魔头像 / BGM
    ├── core/                  zobrist.ts · transposition.ts（各引擎共用）
    ├── gomoku/                rules · engine · search · eval · book · learn · rapfi（WASM 客户端）
    ├── xiangqi/               rules.ts · eval.ts · search.ts
    ├── junqi/                 rules.ts（棋盘/铁路/战斗/摆阵/暗子）· ai.ts · render.ts
    ├── tornado/               game.ts：龙卷风成长记引擎（量级/物理/转场）
    ├── campaign/              engine.ts：风格化守关 AI
    ├── ai/                    worker.ts · ai-bridge.ts（主线程 ↔ Worker Promise 桥）
    ├── controllers/           gomoku · xiangqi · junqi · campaign · tornado 控制器
    └── ui/                    audio · demon · format · stats · 渲染器
```

### 设计原则

- **规则 / AI / 渲染 / 控制器完全分离** — 每层可独立测试和替换
- **引擎无副作用** — 搜索不改动传入棋盘，测试用随机走子对拍验证增量状态一致性
- **Promise 化 Worker 通信** — `AIBridge` 封装异步搜索 API

## 🛠️ 技术栈

- **TypeScript** — 全量类型安全，`strict` 模式
- **Vite 6** — ES 模块构建，HMR 热更新，生产优化
- **Web Workers** — AI 搜索独立线程
- **Canvas 2D / Web Audio** — 渲染与程序化音效
- **😈 恶魔主题** — 恶魔模式下浮现「褚赢」AI 形象面板并播放专属 BGM

## 📄 License

[MIT](LICENSE)
