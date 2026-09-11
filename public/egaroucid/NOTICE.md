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

## 坐标约定（已解决，勿再改动）

引擎的棋盘朝向与本项目坐标约定的对齐方式如下，均已实测确认：

- **棋盘输入**：`arr[file + row*8]`，`row = 0` 对应棋谱第 8 行，与本项目索引一致（恒等映射）
- **着法输出**：引擎打印的棋谱坐标（如 `searched policy c7 value 37`）按
  `index = (8 - rank) * 8 + file` 映射回本项目索引
- **验证**：用八种正交对称逐一比对 16 个随机局面，恒等变换 16/16 命中；
  经本项目完整链路复测 12 个随机局面，引擎着法 12/12 落在合法着法集合内
- **端到端**：AI 互搏整局 60 手无非法着法、无回退

引擎打印的选定着法是最可靠的来源：打包整数 `output_coord` 的反解在负分值下容易出错，
因此 worker 解析文本 `searched policy <坐标> value <分值>`（命中开局谱时为 `book <坐标> <分值>`），
并把原始坐标回传主线程统一换算。
