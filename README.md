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

**五子棋** · **围棋** · **中国象棋** · **军棋（陆战棋）** · **龙卷风成长记** —— 不局限于棋类，休闲小游戏持续上新。

</div>

## 🕹️ 游戏列表

| 游戏 | 路由 | 玩法亮点 |
| --- | --- | --- |
| ⚫ 五子棋 | `#/gomoku` | 人机 / AI 互搏，四档难度；😈恶魔档满火力搜索（可「请神上身」每手悬停最佳点） |
| ⚪ 围棋 | `#/go` | **KataGo 小网络在浏览器内推理**（3.8MB 权重），9/13/19 路、四档难度、候选点、形势判断、AI 互搏 |
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
npm test           # 引擎自测：五子棋 27 + 军棋 66 + rapfi WASM 18 + 象棋 FEN 16 + 象棋神经网络 32 + XQWLight 22 + 龙卷风 32 + 围棋 95 项
```

## 🤖 引擎一览

### 五子棋 AI：Rapfi WASM 引擎

接入了 [Rapfi](https://github.com/dhbloo/rapfi)（Gomocup 顶级 C++ 引擎，GPL v3）的官方 WebAssembly 版本：

- **加载即战力** — 引擎文件（~12MB，`public/rapfi/`，含 mix9svq NNUE 评估权重）随站点静态分发，首次落子即完成实例化；引擎实例跨搜索常驻，置换表保温
- **多线程自适应** — 服务器返回 COOP/COEP 头时自动启用多线程构建（`rapfi-fb-multi`），否则降级单线程构建（`rapfi-fb-single`），纯静态托管开箱即用
- **难度 = 官方棋力档** — 通过引擎协议的 `INFO STRENGTH`（0~100）+ `INFO TIMEOUT_TURN` 时间预算映射四档难度（简单 120ms/棋力15 → 恶魔 2.8s/棋力100），AI 互搏附加以时间抖动保证每局不同
- **协议层全无状态** — 每手搜索用一条 `BOARD` 命令重放全盘，天然兼容悔棋/重开；引擎侧增量维护棋盘状态
- **三级降级链** — 多线程 WASM → 单线程 WASM → 内置 JS 引擎（`src/gomoku/`，迭代加深 α-β + PVS + VCF，同样的四档难度），wasm 加载失败自动兜底，永不无响应
- **引擎可选** — 面板「引擎」一行可选「自动 / 内置 JS」：想和本地 JS 引擎下就直接切内置（连 Rapfi 的加载与排队都不进）。恶魔档固定 Rapfi，WASM 没就绪时**恶魔选项自动禁用**，不会偷偷降级开赛

### 围棋 AI：KataGo 小网络 + PUCT，全部跑在浏览器里

接入 KataGo 官方最小的正式网络 **`g170-b6c96-s175395328-d26788732`**（约 3.8MB，约 103 万参数，6 残差块 × 96 通道），由 **TensorFlow.js** 在浏览器内前向：

- **模型远小于 10MB** —— 权重 `public/go/*.bin.gz` 3.8MB 随站点分发；`.bin.gz` 解压后用浏览器原生 `DecompressionStream` 读懂，权重是 fp32，精度不打折
- **后端降级链** —— WebGPU → WebGL → WASM(SIMD) → CPU，前两个由 TF.js 动态加载（各自独立 chunk，不进首屏）；WASM 的三个 `.wasm` 由 `scripts/copy-tfjs-wasm.mjs` 复制到 `public/go/tfjs/`，只在 GPU 后端都不可用时才去取。无 GPU 时代码自动把访问量压到 1/3~1/5 并如实标注，不会假装很快
- **原生分辨率推理** —— 9 路就把 9×9 张量喂给网络（KataGo 官方是补到 19 路），计算量按边长平方下降：9 路只要 19 路的约 22%，gpool/价值头的棋盘尺寸补偿因子改用真实边长
- **v7 输入平面一位不差** —— 22 个空间平面（在盘内 / 双方棋子 / 1·2·3 气的棋 / 劫点 / 最近五手 / 征子 4 面 / 区域归属 2 面）+ 19 个全局通道（贴目、劫规则、数子法、还棋头、贴目奇偶波…）。征子用有预算的等价简化搜索，区域归属按 KataGo `calculateArea` 口径（Benson 迭代 + 眼/大模样 + 对方死子计入）
- **PUCT 树搜索** —— 策略先验 + 胜率/目差价值，批量叶子评估（GPU 不能被单样本小批次拖死）、虚拟损失、FPU、根节点策略温度与噪声。四档难度 = 访问量 × 时间预算 × 噪声/温度组合（低档不是「算得更慢」，而是真的会走软手）
- **权重没就绪也能玩** —— 首次进入先下 3.8MB 权重，加载期间与加载失败时都由内置常识棋兜底（吃子 / 逃打吃 / 打吃 / 大场 / 不填自己的眼），棋盘上永远有人应手；面板与日志会如实标注当前是哪种引擎
- **对齐验证** —— 与 MIT 许可的 [web-katrain](https://github.com/Sir-Teo/web-katrain)（浏览器版 KaTrain）逐位对齐：6 个固定局面（9/13/19 路、含提子与中盘）的策略 logits、胜率、目差、归属完全一致（最大偏差 0.0），fixture 见 `tests/fixtures/go-golden.json`，回归测试在 `tests/go.test.mts`

规则用**中国规则（数子）**：禁止自杀、禁止全局同形（位置超级劫）、双方连续虚手终局；终局数子会顺带用网络归属判定死子，不认可可「继续下棋」。棋盘 9/13/19 路可切，贴目 9/13 路 7 目、19 路 7.5 目。

### 中国象棋 AI：神经网络（8.7MB）+ 经典引擎，双引擎可切

象棋面板「引擎」一行可以在两套引擎之间切换，两套都在浏览器本地运行、都没有外部服务依赖：

**① 🧠 神经网络（默认）** —— 权重就是你搜到的那类「小于 10MB 的现成象棋 AI」

- **模型 8.7MB，随站点分发** —— `public/xqnn/chess_model.onnx`，AlphaZero 风格 ResNet（128 滤波器 × 6 残差块，双头：策略 + 价值），用 4 万+ 大师棋谱预训练再做 20 轮自我对弈精炼（上游 [yingwang/chinese_chess](https://github.com/yingwang/chinese_chess)，MIT）
- **不引 ONNX Runtime** —— 官方 `onnxruntime-web` 最小的 wasm 运行时就有 13.3MB，比模型本身还大。这里用项目**已经装好的 TF.js** 复刻前向（图里只有 Conv/Relu/Add/Gemm/Tanh，BN 已被导出器折进 Conv 偏置），ONNX 由自写的极简 protobuf 解析器（`src/xqnn/onnx.ts`）读出来，权重按**形状**识别并逐条断言。后端沿用围棋那条降级链：WebGPU → WebGL → WASM → CPU
- **逐位对齐验证** —— 与官方 onnxruntime 对拍 7 个局面（开局/中局/双方行棋）：策略 logits 最大偏差 **1.1e-5**、价值最大偏差 **8.9e-7**、top-8 着法完全一致；fixture 见 `tests/fixtures/xqnn-golden.json`，回归测试在 `tests/xqnn.test.mts`
- **网络管先验，搜索管战术** —— 实测这个网络的**策略头很可靠、价值头很弱**（红方白多一个车时价值几乎不变）。所以不走「纯 PUCT」那条路（实测 0:6 全败给内置引擎），也不让网络给深搜的着法加分（8~10 局一档的对照实验：网络项清零 2:1:5 五五开，只留策略 0:7:1，只留价值 0:3:5，全开 0:5:3 —— 都是净损失）。最终形态是：α-β 负责算清战术（复用 `src/xiangqi/search.ts`，迭代加深 + PVS + 静态搜索 + 置换表），网络把策略 logit 作为根着法的先验、把价值头当小幅修正，并且**修正被夹在 ±window 之内**：
  - **😈 恶魔 / 困难**：窗口只有 8 / 25 分 —— 网络只能在「α-β 认为几乎等价」的着法之间表达偏好，绝不可能顶掉战术上更好的着法，强度与内置引擎持平
  - **简单 / 普通**：窗口放大到 300 / 140 分，改由网络（4 万+大师棋谱训练）主导选择，于是「像人但很弱」；开局就是它的主场（普通人机首手常见炮二平五）
- **一次求着两次前向** —— 根局面 1 次 + 后继局面 1 批（慢后端只给先验靠前的 16 个局面算价值头），浏览器里通常几十毫秒内完成，不拖慢落子

**② 🐘 XQWLight 小巫师（经典）** —— 零下载、零后端依赖

- 上游 [xqbase/xqwlight](https://github.com/xqbase/xqwlight) 的现成 JavaScript 引擎（GPL-2.0+，约 366KB），自带 96KB 开局库，迭代加深 + PVS + 空步剪枝 + 静态搜索 + 置换表
- 由**独立 classic worker**（`public/xqwlight/engine-worker.js`）`importScripts` 加载，GPL 代码原样留在资源目录、不进主包，也就不传染 MIT 主程序；它一问一答即可，不需要 SharedArrayBuffer/COOP-COEP

**降级链**：所选引擎未就绪或出错 → 内置 JS 引擎（`src/xiangqi/search.ts`，子力 + 位置价值表 + MVV-LVA + Alpha-Beta + 置换表 + 将军延伸 + Quiescence，恶魔档带软时间预算与劣势自适应加深）立刻应手，棋盘上永远有人走棋；面板与思考日志会如实标注当前用的是哪一个引擎。

### 军棋 AI

搜索整体跑在紧凑棋盘表示（`src/junqi/fast.ts`）上：60 个节点编码进 `Uint8Array`，走法生成、战斗结算、撤销栈全部免分配，热路径里没有对象棋盘与字符串比较。配合后期着法缩减（LMR）、根节点 PVS、杀手着、跨手保留的置换表与静态搜索，全档位迭代加深（恶魔档 2.2~2.6s 预算内平均 depth 7~8）。

**信息模型（揭棋）**：轮走方始终知晓己方棋子，对对方只掌握交战已暴露的身份（阵亡子、被攻方胜局亮出的守方等）。评估因此分两层——子力按真值累加，位置项、旗区守备与威胁只统计轮走方确实已知的身份，对方暗子则按编制先验（3 工兵 / 2 炸弹 / 2 大子）折算期望威胁。注意子力项这样做是**精确**而非作弊：阵亡是公开事件，双方剩余子力总和本就是公开信息，真实身份只在搜索树内部使用。

实测对照改前版本（同一批固定局面 · 恶魔档）：

| 模式 | 节点率 | 平均深度 |
| --- | --- | --- |
| 明棋 | 347k → 1271k 节点/秒（**3.66×**） | 6.08 → 8.00 |
| 揭棋 | 549k → 1230k 节点/秒（**2.24×**） | 6.08 → 7.79 |

等时间自对弈 30 局（旧引擎 vs 新引擎，交替先后手、同时间预算）：明棋 **22:6:2**、揭棋 **24:5:1**。

**为什么不做确定性采样（PIMC）**：揭棋的教科书解法是 PIMC——按公开信息（双方剩余编制、地雷必在后两排、军旗必在大本营）把对方暗子重排 K 次，每次当完全信息局面搜一遍再对根着法取平均。本仓库实现并实测过这条路径，结论是不采纳：固定预算切成 K 份后每份深度掉约 log(K) 层（K=8 只到 depth5，单世界能到 depth7），等时间自对弈 K=1 对 K=2 / K=4 / K=8 分别为 **20:0 / 20:0 / 19:1**，深度损失压倒了信息模型收益。故保持单世界搜索，把全部预算换成深度。

### 军棋 · 两种玩法

- **明棋**：全明对弈，支持自定义摆阵（军旗入大本营、地雷后两排、炸弹不进第一排、行营留空，实时校验）
- **揭棋（暗棋）**：双方棋子对对方暗置，自己始终可见己方；静默移动不翻明；交战时**攻方获胜则攻方不亮**、守方翻明，攻方阵亡则双方都翻明；暗工兵拐弯走法会自曝身份
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

### 缓存与压缩（首屏那 11MB 只下这一次）

先看实测：`rapfi.data` 10.13MB → gzip 后 9.68MB，**只有 4%**（里面 NNUE 权重本来就是 lz4 压过的，基本压不动）；两个 wasm 各 1.2MB → 约 0.36MB，**能省 70%**。所以**收益主要来自缓存，不是压缩**——不显式声明缓存时，`/rapfi/*.data` 与 `*.wasm` 没有任何 `Cache-Control`，浏览器和 CDN 都不缓存，每次访问都要重走那 11MB。

```nginx
    # 压缩：wasm 受益极大，data 几乎无收益（不必为它单独折腾）
    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types application/wasm application/javascript text/css application/json image/svg+xml;

    # 引擎资源 URL 带 ?v= 版本号（见 src/gomoku/rapfi.ts 的 ASSET_VERSION），
    # 可以放心长缓存。这是最关键的一条。
    # 注意：location 内一旦出现 add_header，server 级的 add_header 就不再继承，
    # 所以上面那两条 COOP/COEP 必须在这里重复一遍。
    location ~* ^/rapfi/ {
        # 不要同时写 expires：它会再产生一个 Cache-Control: max-age=...，
        # 两个 Cache-Control 头容易让 CDN/浏览器行为不一致，只留一条。
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }

    # 构建产物文件名带内容哈希（index-XXXXXXXX.js/css），同样可以长缓存
    location ~* ^/assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }

    # 入口 HTML 反过来必须不缓存：否则部署后它可能还指着已被删除的旧哈希文件，
    # 页面直接白屏。no-cache 是「每次校验」而不是「不缓存」。
    location = /index.html {
        add_header Cache-Control "no-cache" always;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }
```

改了 `public/rapfi/` 下任何文件后，记得同步把 `src/gomoku/rapfi.ts` 里的 `ASSET_VERSION` 加一版，否则长缓存会让老访客一直用旧引擎。

围棋的权重与 WASM 同理，加一条即可（`src/go/model-assets.ts` 的 `GO_ASSET_VERSION` 控制版本号，URL 形如 `/go/xxx.bin.gz?v=a1`，可以放心长缓存）：

```nginx
    location ~* ^/go/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }
```

围棋首屏增量：权重 3.8MB（`gzip` 后基本不变，因为里面本来就是压缩过的 fp32 权重）+ 若干按需加载的 TF.js chunk。**首屏 JS 不含 TF.js**——它是动态 `import()` 的独立 chunk，只有进入围棋页预热时才取。

注意：COEP `require-corp` 会要求页面所有跨域子资源自带 CORP/CORS 头——本项目全部资源自包含，不受影响；若以后引入 CDN 字体/脚本，记得加 `crossorigin` 属性。配置后用 `curl -sI https://game.xiey.work/ | grep -i cross-origin` 验证响应头穿透 CDN。

## 🧱 项目结构

```
webgame/
├── index.html                 平台外壳：首页 + 五个子页面
├── styles.css                 浅色清新 UI（白卡片 + 薄荷绿主色）
├── vite.config.ts / tsconfig.json / package.json
├── .github/workflows/deploy.yml   构建 + FTP 自动部署
├── scripts/
│   └── copy-tfjs-wasm.mjs     把 TF.js WASM 后端复制进 public/go/tfjs/（predev/prebuild 自动跑）
├── public/
│   ├── rapfi/                 Rapfi WASM 引擎（multi/single 构建 + mix9svq 权重包 + classic worker 胶水）
│   ├── go/                    围棋：KataGo 最小网络权重（3.8MB）+ tfjs WASM 后端 + NOTICE.md（许可与出处）
│   ├── xqnn/                  象棋神经网络权重 chess_model.onnx（8.7MB，MIT）
│   └── xqwlight/              XQWLight 小巫师引擎（position/search/book.js + classic worker 胶水 + NOTICE.md）
├── tests/
│   ├── engine.test.mts        五子棋引擎测试（增量状态不变量 / 战术 / 速度 / 自对弈）
│   ├── junqi.test.mts         军棋规则引擎测试（摆阵 / 铁路 / 战斗 / 可逆走子 / AI）
│   ├── rapfi.test.cjs         Rapfi WASM 冒烟测试（协议 / 时间预算 / 棋力档 / 会话持久）
│   ├── xqfen.test.mts         象棋 FEN / UCI 走法编解码测试（坐标映射 / 局面往返 / 非法输入）
│   ├── xqnn.test.mts          象棋神经网络测试（ONNX 解析 / 编码 / 与 onnxruntime 逐位对齐 / 搜索合法性）
│   ├── xqwlight.test.mts      XQWLight 测试（ICCS 编码 / 开局库 / 一步杀 / 随机中局合法性）
│   ├── go.test.mts            围棋测试（规则 / 死活与征子 / 输入编码 / 与参考逐位对齐 / 搜索）
│   └── fixtures/
│       ├── go-golden.json     参考实现（web-katrain，MIT）生成的黄金输出，用于回归对齐
│       └── xqnn-golden.json   onnxruntime 跑官方 .onnx 的参考输出，用于回归对齐
└── src/
    ├── main.ts                Hash 路由 + 共享服务 + 控制器装配
    ├── types.ts               全局类型定义
    ├── assets/                恶魔头像 / BGM
    ├── core/                  zobrist.ts · transposition.ts（各引擎共用）
    ├── gomoku/                rules · engine · search · eval · book · learn · rapfi（WASM 客户端）
    ├── go/                    rules.ts（提子/劫/数子）· area.ts（区域归属）· life.ts（征子）
    │                          features.ts（v7 输入平面）· model.ts（权重解析）· tf-model.ts（TF.js 前向）
    │                          evaluate.ts（后端降级与后处理）· mcts.ts（PUCT）· engine.ts（难度档/兜底）
    │                          heuristic.ts（常识棋兜底）· model-assets.ts（权重 URL 与预取）
    ├── xqnn/                  象棋神经网络：onnx.ts（极简 protobuf 解析）· model.ts（TF.js 前向）
    │                          encoding.ts（15 通道 + 2086 走法表）· evaluate.ts（后端降级）
    │                          search.ts（α-β × 网络融合）· engine.ts（worker 门面）· model-assets.ts（权重）
    ├── xiangqi/               rules.ts · eval.ts · search.ts（内置 α-β 引擎）· fen.ts · xqwlight.ts（经典引擎客户端）
    ├── junqi/                 rules.ts（棋盘/铁路/战斗/摆阵/暗子）· ai.ts · render.ts
    ├── tornado/               game.ts：龙卷风成长记引擎（量级/物理/转场）
    ├── campaign/              engine.ts：风格化守关 AI
    ├── ai/                    worker.ts · ai-bridge.ts（主线程 ↔ Worker Promise 桥）
    ├── controllers/           gomoku · go · xiangqi · junqi · campaign · tornado 控制器
    └── ui/                    audio · demon · format · stats · 渲染器（含 go-renderer）
```

### 设计原则

- **规则 / AI / 渲染 / 控制器完全分离** — 每层可独立测试和替换
- **引擎无副作用** — 搜索不改动传入棋盘，测试用随机走子对拍验证增量状态一致性
- **Promise 化 Worker 通信** — `AIBridge` 封装异步搜索 API
- **能跑才是硬道理** — 每个引擎都有降级链：围棋 = 神经网络（WebGPU/WebGL/WASM/CPU）→ 常识棋兜底；五子棋 = 多线程 WASM → 单线程 WASM → 内置 JS

## 🛠️ 技术栈

- **TypeScript** — 全量类型安全，`strict` 模式
- **Vite 6** — ES 模块构建，HMR 热更新，生产优化
- **Web Workers** — AI 搜索独立线程
- **TensorFlow.js** — 围棋神经网络推理（WebGPU / WebGL / WASM / CPU 后端按需动态加载）
- **Canvas 2D / Web Audio** — 渲染与程序化音效
- **😈 恶魔主题** — 恶魔模式下浮现「褚赢」AI 形象面板并播放专属 BGM

## 📄 License

[MIT](LICENSE)
