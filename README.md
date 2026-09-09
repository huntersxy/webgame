<div align="center">

# 🎮 乐下 · 网页游戏平台

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
npm test           # 引擎自测：五子棋 16 项 + 军棋 30 项
```

## 🤖 引擎一览

### 五子棋引擎 v3（全新重写）

面向「最强 + 最快」的现代自由式五子棋算法栈：

- **O(1) 增量评估** — 572 个五连窗口 + 形状分值表，落子/撤销只更新受影响的 ≤20 个窗口；叶节点评估是一次减法，不再全盘扫描
- **强制着法逻辑** — 即时成五点集合 O(1) 维护：自己有成五点 → 立胜；对手双成五 → 必败；单成五 → 分支坍缩为唯一堵点
- **迭代加深 α-β + PVS** — 每档难度按真实时间预算加深（简单 150ms → 恶魔 2.8s）
- **Zobrist 增量哈希 + 深度优先置换表** · **威胁延伸** · **VCF 连续冲四独立战术引擎** · **杀手着 + 历史启发**
- 实测：普通档 ~450ms 达 depth5；恶魔档 2.8s 内中局 depth8+，nps ≈ 0.3M/s

### 中国象棋

子力 + 位置价值表 + MVV-LVA 排序 + Alpha-Beta + 置换表 + 将军延伸 + Quiescence；恶魔档带软时间预算与劣势自适应加深。

### 军棋 AI

子力 + 前进 + 旗位压力评估 + MVV 排序 + Alpha-Beta + 置换表 + 杀手着 + 静态搜索，恶魔档迭代加深（depth6 约 0.9s）；揭棋模式下对所有暗子使用期望子力评估，不依赖暗子身份做决策。

### 军棋 · 两种玩法

- **明棋**：全明对弈，支持自定义摆阵（军旗入大本营、地雷后两排、炸弹不进第一排、行营留空，实时校验）
- **揭棋（暗棋）**：双方棋子对对方暗置，自己始终可见己方；攻击对方暗子时守方翻明，攻方不翻明——吃子后继续潜伏，攻方阵亡则守方保持明牌

## 📦 部署（GitHub Actions → FTP）

推送 `master` 自动触发：**引擎自测 → 类型检查 + 构建 → FTP 上传 `dist/`**，也可在 [Actions](https://github.com/huntersxy/webgame/actions) 页面手动触发（`workflow_dispatch`）。

工作流复用 [xqecz](https://github.com/huntersxy/xqecz) 的部署方案（[SamKirkland/FTP-Deploy-Action](https://github.com/SamKirkland/FTP-Deploy-Action) 增量上传）。需在仓库 **Settings → Secrets and variables → Actions** 配置三个 Secret：

| Secret | 说明 |
| --- | --- |
| `FTP_SERVER` | FTP 服务器地址 |
| `FTP_USERNAME_FRONTEND` | FTP 账号（登录后落在站点根目录） |
| `FTP_PASSWORD` | FTP 密码 |

> 纯静态站点无需停启服务；默认上传到 FTP 根目录，如需子目录修改 [deploy.yml](.github/workflows/deploy.yml) 中的 `server-dir`（如 `/webgame/`）。

## 🧱 项目结构

```
webgame/
├── index.html                 平台外壳：首页 + 四个子页面
├── styles.css                 浅色清新 UI（白卡片 + 薄荷绿主色）
├── vite.config.ts / tsconfig.json / package.json
├── .github/workflows/deploy.yml   构建 + FTP 自动部署
├── tests/
│   ├── engine.test.mts        五子棋引擎测试（增量状态不变量 / 战术 / 速度 / 自对弈）
│   └── junqi.test.mts         军棋规则引擎测试（摆阵 / 铁路 / 战斗 / 可逆走子 / AI）
└── src/
    ├── main.ts                Hash 路由 + 共享服务 + 控制器装配
    ├── types.ts               全局类型定义
    ├── assets/                恶魔头像 / BGM
    ├── core/                  zobrist.ts · transposition.ts（各引擎共用）
    ├── gomoku/                rules · engine · search · eval · book · learn
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
