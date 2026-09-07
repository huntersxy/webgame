# 智棋双绝 · 五子棋 & 象棋 AI

本地双棋 AI 对弈平台，TypeScript + Vite + Web Workers，断网可玩、即开即下。

## 技术栈

- **TypeScript** — 全量类型安全，`strict` 模式
- **Vite 6** — ES 模块构建，HMR 热更新，生产优化
- **Web Workers** — AI 搜索在独立线程运算，UI 永不卡顿
- **Canvas 2D** — 木纹棋盘渲染，落子动画，思考可视化
- **Web Audio API** — 程序化合成音效，零音频文件依赖
- **😈 恶魔主题** — 恶魔模式下浮现「褚赢」AI 形象面板并播放专属 BGM

## 架构

```
chess-ai/
├── index.html                 入口 HTML
├── styles.css                 深色金质玻璃拟态 UI
├── vite.config.ts             Vite 配置
├── tsconfig.json              TypeScript 配置
├── package.json
└── src/
    ├── main.ts                应用入口：导航、共享服务、控制器装配
    ├── types.ts               全局类型定义
    ├── vite-env.d.ts          Vite 客户端类型 & 静态资源模块声明
    ├── assets/
    │   ├── demon-avatar.png   恶魔 AI 头像（褚赢）
    │   └── demon-bgm.m4a      恶魔模式 BGM
    ├── core/
    │   ├── zobrist.ts         Zobrist 哈希（通用棋盘）
    │   └── transposition.ts   深度感知置换表（TT）
    ├── gomoku/
    │   ├── rules.ts           规则：胜负判定、候选生成、即时杀
    │   ├── eval.ts            静态评估：四方向窗口扫描
    │   └── search.ts          Negamax Alpha-Beta + TT + 杀手着
    ├── xiangqi/
    │   ├── rules.ts           完整规则：马腿象眼炮架飞将将军
    │   ├── eval.ts            子力 + 位置价值表评估
    │   └── search.ts          Alpha-Beta + Quiescence + TT + 将军延伸
    ├── campaign/
    │   └── engine.ts          战役：风格化 AI（堡垒防守）+ minimax
    ├── ai/
    │   ├── worker.ts          Web Worker：离线 AI 搜索
    │   └── ai-bridge.ts       主线程 ↔ Worker Promise 桥
    ├── controllers/
    │   ├── gomoku-controller.ts   五子棋游戏控制器
    │   ├── xiangqi-controller.ts  象棋游戏控制器
    │   └── campaign-controller.ts 战役控制器
    └── ui/
        ├── audio.ts           Web Audio 音效引擎 + 恶魔 BGM 播放
        ├── demon.ts           恶魔形象（褚赢）面板 & 主题管理
        ├── format.ts          思考面板格式化工具
        ├── stats.ts           localStorage 战绩统计
        ├── gomoku-renderer.ts 五子棋 Canvas 渲染器
        └── xiangqi-renderer.ts 象棋 Canvas 渲染器
```

### 设计原则

- **规则 / AI / 渲染 / 控制器完全分离** — 每层可独立测试和替换
- **Web Worker 隔离 AI** — 恶魔级深度搜索不再冻结 UI
- **零代码重复** — gomoku 和 campaign 共享 `rules.ts`；核心算法抽取到 `core/`
- **类型安全** — `strict` 模式，所有跨模块通信有类型约束
- **Promise 化 Worker 通信** — `AIBridge` 封装异步搜索 API

## 运行

```bash
npm install
npm run dev        # 开发服务器 http://localhost:5173
npm run build      # 类型检查 + 生产构建 → dist/
npm run preview    # 预览生产构建
npm run typecheck  # 仅类型检查
```

## 玩法

### ⚫ 五子棋 15×15
- 人机 / 双人 / AI互搏，执黑 / 执白，四档难度（含 😈恶魔）
- 功能：新开、悔棋、AI 支招、音效、局势条、移动端触控适配
- AI：五连窗口评分 + Negamax Alpha-Beta + 置换表 + 杀手着 + 必胜/必堵优先
- 🧠 思考可视化：深度 / 宽度 / 节点数 / 用时 / 评估 / Top5 候选
- 😈 恶魔难度：对手即「褚赢」，附带专属头像与 BGM

### ♞ 象棋
- 完整规则：马腿、象眼、宫、河界、炮架、飞将、将军/绝杀/困毙判负
- 执红 / 执黑（执黑自动翻转），翻转棋盘，双人 / 人机，四档难度
- AI：子力 + 位置价值表 + MVV-LVA 排序 + Alpha-Beta + TT + 将军延伸 + Quiescence
- 🧠 思考可视化：深度 / 节点 / 用时 / 评估 / 主变PV / Top5 走法
- 😈 恶魔难度：对手即「褚赢」，附带专属头像与 BGM

### ⚔️ 战役
- 五子棋风格对决，每关 AI 风格不同，破防获胜解锁下一关
- 进度自动保存到 localStorage

祝棋运昌隆 ♞
