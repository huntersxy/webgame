# 实施方案：移除恶魔「败局记忆 / 学习」子系统

> 状态：**已实施**（2026-09-10）。计划内容保留在下方备查。
> 结论依据见《恶魔记忆机制评估》（本会话）：`learn.ts` 是「精确局面查表」，不是学习；
> 签名失配、错误归因、截断方向反了，实际效果等价于「复读检测器」。

---

## 实施结果

| 决策点 | 落地情况 |
| --- | --- |
| D1 保留必胜开局提醒 | ✅ 保留 |
| D2 `detectWinningOpening` 迁 `book.ts` | ✅ 迁入（与应对谱同源，同样 8 对称归一化） |
| D3 保留恶魔主题（头像/BGM/褚赢面板） | ✅ 未动 |
| D4 清理 localStorage 残留键 | ✅ 在 `GomokuController` 构造函数里一次性 `removeItem` |

额外一并处理：

- `.tag-warn`、`.memory-*`、`.demon-memory-btn` 样式删除；`.modal-*` 通用弹窗样式**保留**（现已无使用者，留作通用组件）。
- 顺带修掉「请神上身 / 求一着」的桥接层并发缺陷，见 `docs/`（本会话讨论）——`AIBridge` 由单槽
  resolver 改为按请求 id 配对，worker 回带 id；五子棋/象棋的提示加在途标志与局面版本号守卫。
  > 注：军棋侧原本就已用「`thinking` 独占 + `aiSeq` 守卫」的正确写法，五子棋/象棋才是例外。

验证：`typecheck` 通过 · `npm test` 27+62+18 全绿 · `npm run build` 通过。

---

## 0. 一句话目标

删掉「恶魔会记住你的败局并学习」这一整套机制与其对外文案，**保留**恶魔难度本身、
开局谱、恶魔主题（头像/BGM）。净效果：代码更少、文案不再承诺做不到的事。

---

## 1. 影响面（已核实）

| 项 | 结论 |
| --- | --- |
| `learn.ts` 的引用者 | 仅 `src/controllers/gomoku-controller.ts:16` + 两个测试文件 |
| 象棋 / 军棋 / 战役 | **无**任何记忆或学习代码，不涉及 |
| `src/types.ts` | 无 Lesson/Loss 类型，**不需改动** |
| 测试接入 | `tests/demon-*.mts` 本就**未**接入 `npm test`，删除无回归风险 |
| 工作区状态 | ⚠️ 已有未提交改动（`rapfi.ts` / `ai-bridge.ts` / `worker.ts` / `types.ts` 等）；本方案应在现有脏树上叠加，勿混提 |

---

## 2. 逐文件改动清单

### 2.1 删除（整块）

| 文件 | 位置 | 动作 |
| --- | --- | --- |
| `src/gomoku/learn.ts` | 整文件 | 删除（除下方 D2 决定要迁移的 `detectWinningOpening`） |
| `tests/demon-learn.mts` | 整文件 | 删除 |
| `tests/demon-play.mts` | 整文件 | 删除 |

### 2.2 `src/controllers/gomoku-controller.ts`

| 行 | 现状 | 动作 |
| --- | --- | --- |
| 16 | `import { checkLesson, detectWinningOpening, recordLoss, lessonCount, getLosses } from '../gomoku/learn';` | 按 D1/D2 改写或删除整行 |
| 46 | `private _openingWarned = false;` | D1 保留则留，否则删 |
| 112 | `this._openingWarned = false;`（newGame 重置） | 同上 |
| 147 | `this.checkWinningOpening();`（place） | 同上 |
| 171 | `const lesson = this.level === 4 ? checkLesson(cloneBoard(this.board)) : null;` | **删** |
| 181–189 | `if (lesson && m && m.x === lesson.x …)` 改走次优整块 | **删**（保留其后的 190–197 非法落点兜底） |
| 354–367 | `onGameEnd` 人类获胜分支：`detectWinningOpening` + `recordLoss` + 复盘日志/横幅 | **简化**为不涉及记忆的文案，保留 `this.audio.lose(); Stats.add(true);` |
| 374–381 | `checkWinningOpening()` 方法 | D1 保留则留，否则删 |
| 502 | `document.getElementById('g-demon-memory')?.addEventListener(...)` | **删** |
| 514–550 | `openDemonMemory()` 方法 | **删** |

### 2.3 `index.html`

| 行 | 内容 | 动作 |
| --- | --- | --- |
| 283 | `<button id="g-demon-memory" …>📋 恶魔败局档案</button>` | **删** |
| 522–531 | `#demon-memory-modal` 弹窗整块 | **删** |

> 不动的：272（😈 恶魔难度按钮）、274–282（恶魔面板）、291–292（求一着 / 请神上身）。

### 2.4 `styles.css`

| 行 | 选择器 | 动作 |
| --- | --- | --- |
| 516 | `.demon-memory-btn` | 删 |
| 611–620 | `.memory-stats` / `.memory-list` / `.memory-empty` / `.memory-row` 系列 | 删 |
| 762 | `.tags span, .camp-tags span, .memory-stats .pill { … }` | 从组合选择器中**摘掉** `.memory-stats .pill`，勿动其余两支 |

### 2.5 `README.md`

| 行 | 现状 | 动作 |
| --- | --- | --- |
| 24 | `…四档难度；😈恶魔会存档你的败局并学习` | 改为不承诺学习的表述，如 `…四档难度；😈恶魔档满火力搜索` |

> 199 行的「恶魔主题（头像/BGM）」保留。

---

## 3. 待拍板的决策点

| 编号 | 决策 | 建议 |
| --- | --- | --- |
| **D1** | 「检测到黑棋必胜开局 → 提醒玩家」这个 UX 留不留？它目前寄生在 `detectWinningOpening`（`learn.ts`）上，但与"学习"无关 | **保留**——它是有用的对局信息，且不欠技术债 |
| **D2** | 若 D1 保留，`detectWinningOpening`（含 `OPENING_TABLE` 10 式 + 8 对称 `SYMS`）迁到哪 | **迁到 `src/gomoku/book.ts`**——与开局谱同源、语义一致，且 `book.ts` 已有 `ORIENT` 对称工具可对齐 |
| **D3** | 恶魔主题（头像 / BGM / 褚赢面板 / `ui/demon.ts`）留否 | **保留**，与本次无关 |
| **D4** | 老用户浏览器里的 `gomoku.demonLessons.v1` / `gomoku.demonLosses.v1` 残留 | 启动时**一次性** `removeItem` 清理（几行，可选）；不做也不算 bug，仅占几十 KB |

---

## 4. 实施步骤（低风险优先）

1. **D2/D1 预备**：把 `detectWinningOpening` 从 `learn.ts` 迁入 `book.ts`，controller 改 import 源。
2. **拆 controller 接线**：删 import 中的记忆 API、`lesson` 查询与改走、`openDemonMemory`、绑定。
3. **拆 onGameEnd**：重写人类获胜分支文案，去掉 `recordLoss` 与复盘日志。
4. **拆 UI**：删 `index.html` 按钮 + 弹窗，删 `styles.css` 相应选择器。
5. **删除 `learn.ts` + 两个 demon 测试文件**（此时应无编译错误）。
6. **改文案**：`README.md:24`。
7. **（可选，D4）** 清理 localStorage 残留键。
8. **验证**（见 §5）。

---

## 5. 验收标准

- [ ] `npm run typecheck` 通过（strict，零错误）
- [ ] `npm test` 全绿：五子棋引擎 16 项 + 军棋 62 项 + rapfi WASM 8 项
- [ ] `npm run build` 通过
- [ ] 全仓 grep 断言为 0：`checkLesson` / `recordLoss` / `lessonCount` / `getLosses` / `demon-memory` / `gomoku.demonLessons`
- [ ] 手工：恶魔档赢一局 → 横幅为普通获胜文案，控制台无异常，无档案入口
- [ ] 手工：`💡求一着` / `🙏请神上身` / 悔棋 / 换难度 / 重开仍正常
- [ ] 若 D1 保留：人类走花月/浦月时仍出现必胜开局提醒

---

## 6. 风险与回滚

| 风险 | 评估 |
| --- | --- |
| 恶魔失去"换招"能力 | 该能力实际近乎无效（见评估），**无实质损失** |
| 误删 D1 提醒 | 逐行清单已标注，勿删 `checkWinningOpening` 除非明确选择删除 |
| `styles.css` 组合选择器被剪错 | 只摘 `.memory-stats .pill` 一支，保留 `.tags` / `.camp-tags` |
| 回滚 | 建议**单个 commit**，`git revert` 一步还原 |

---

## 7. 明确不做（边界）

- 不改 `book.ts` 的开局谱算法与命中逻辑
- 不改 level 4 的棋力/时间预算（`LEVEL_CONFIG`、`rapfi.ts` 的 `INFO STRENGTH`）
- 不碰 Rapfi / WASM / 资源分发
- 不碰 `请神上身`、`求一着` —— 另案评估
