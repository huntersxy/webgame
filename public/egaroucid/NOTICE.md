# Egaroucid Web (WASM)

- 上游项目：https://github.com/Nyanyan/Egaroucid
- 作者：Takuto Yamana
- 许可证：**GPL-3.0-or-later**（完整条款见上游仓库 LICENSE）
- 本地改动：仅重新编译，把 Emscripten 的 `INITIAL_MEMORY` 从 600MB（`-s TOTAL_MEMORY=629145600`）降到 64MB，
  其余编译参数与源码未改动；`ALLOW_MEMORY_GROWTH=1` 保留，运行时可按需增长到 2GB。
- 编译命令（emsdk / em++）：

```
em++ Egaroucid_for_Web.cpp -o egar.js -O3 -s WASM=1 -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web -s EXPORT_ES6=1 -s MODULARIZE=1 -s EXPORT_NAME=createEgaroucid \
  -s "EXPORTED_FUNCTIONS=[_init_ai,_ai_js,_calc_value,_stop,_resume,_malloc,_free]" \
  -s "EXPORTED_RUNTIME_METHODS=[HEAP32,HEAPU8]" \
  -s INITIAL_MEMORY=67108864 -s TOTAL_STACK=1048576
```

- 导出接口：`_init_ai(percentPtr)` / `_ai_js(boardPtr, level, aiPlayer)` / `_calc_value(...)` / `_stop` / `_resume`
- 棋盘输入：长度 64 的 int32 数组，`arr[file + rank0*8]`，`-1` 空、`0` 自己、`1` 对手（rank0 = 0 表示棋谱第 1 行）
- 引擎会向 stdout 打印棋盘与选中着法；建议集成时把 `print`/`printErr` 重定向到缓冲并解析 `searched policy <坐标>`

## 未解决的集成问题（重要）

**引擎的棋盘朝向与本项目坐标约定尚未对齐**，因此该引擎在本项目里标记为**实验性、默认关闭**
（面板「引擎」默认选中「内置 JS」）。

已确认的事实：

- 直连引擎（绕过本项目封装）时其输出可稳定映射到合法着法：用八种正交对称逐一比对 16 个随机局面，
  恒等变换 16/16 命中，其余 1~5/16
- 但经本项目链路（controller → AI worker → engine worker）时，引擎输出的着法常落在合法着法集合之外。
  例：标准开局我方合法点 `[19,26,37,44]`，引擎返回映射到索引 `34` 或 `43`
- 同一局面下控制器内部一致性正常（`fromCells`/`toCells` 往返后合法点不变），因此问题在朝向约定，
  而非规则实现

继续排查的切入点：在 `src/othello/egaroucid.ts` 的 `findMove` 里打印引擎原始返回与合法点集合，
用**同一局面**同时比对「直连 worker」与「经本项目链路」两侧的结果，定位朝向在哪一层被改写。
