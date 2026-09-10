#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────
#  scripts/build-pikafish-wasm.sh
#
#  从官方源码构建 Pikafish 的 WebAssembly 版本，产物落在
#  public/pikafish/ 下，供象棋面板通过 engine-worker.js 加载。
#
#  为什么要自己编译：pikafish.org 只发布原生二进制，没有官方
#  prebuilt wasm；而 Pikafish 的 UCI 引擎没有 emscripten 专用
#  I/O 钩子（见 src/uci.cpp 的 getline(std::cin, ...)），必须
#  配合我们自己的 worker + 阻塞式 stdin 才能跑起来（见
#  public/pikafish/engine-worker.js 顶部注释）。
#
#  依赖：
#    · Emscripten SDK       → 默认 D:/toolchains/emsdk（可用 EMSDK 覆盖）
#    · Pikafish 源码        → 默认 D:/toolchains/Pikafish（可用 PIKAFISH_SRC 覆盖）
#    · pikafish.nnue 权重   → 放在源码 src/ 下（约 48MB，见 NET_URL）
#
#  许可：引擎 GPLv3；NNUE 权重为单独许可（非商用免费）。
#  本脚本产出的二进制若对外分发，必须同时提供对应源码（即本脚本
#  记录的上游 commit 与构建命令）。
# ────────────────────────────────────────────────────────────
set -euo pipefail

# 默认用 Windows 风格的盘符路径（D:/…）：Git Bash 两种都认，但 Windows 版的
# python.exe 不认 MSYS 的 /d/… —— 会把它当相对路径拼成 D:\d\toolchains\…。
EMSDK="${EMSDK:-D:/toolchains/emsdk}"
PIKAFISH_SRC="${PIKAFISH_SRC:-D:/toolchains/Pikafish/src}"
OUT_DIR="${OUT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/public/pikafish}"
NET_URL="https://github.com/official-pikafish/Networks/releases/download/master-net/pikafish.nnue"

# 走 em++.py 而不是 em++.exe：后者是 emsdk 的 shim，在 Git Bash 下会
# 抛 `ModuleNotFoundError: No module named 'tools'`（脚本目录没进 sys.path）。
EMXX_PY="$EMSDK/upstream/emscripten/em++.py"
if [ ! -f "$EMXX_PY" ]; then
  echo "找不到 $EMXX_PY。请先安装 emsdk：" >&2
  echo "  git clone https://github.com/emscripten-core/emsdk.git \"$EMSDK\"" >&2
  echo "  cd \"$EMSDK\" && ./emsdk install latest && ./emsdk activate latest" >&2
  exit 1
fi

# emsdk 自带的 python / node（emcc 需要 node 在 PATH 里）
EMPY="$EMSDK/python/$(ls "$EMSDK/python" | head -1)/python.exe"
[ -x "$EMPY" ] || EMPY="python"
export PATH="$EMSDK/node/$(ls "$EMSDK/node" | head -1):$PATH"
export EM_CONFIG="$EMSDK/.emscripten"
# 独立缓存目录：一是避免污染 emsdk 安装目录，二是当配置里的路径写法变化时
# emscripten 会想清空旧 cache（几千个文件），换个空目录就直接从零重建，不必做删除。
export EM_CACHE="${EM_CACHE:-D:/toolchains/emcache}"

cd "$PIKAFISH_SRC"

if [ ! -f pikafish.nnue ]; then
  echo "==> 下载 NNUE 权重（约 48MB）"
  curl -fL --max-time 600 -o pikafish.nnue "$NET_URL"
fi

echo "==> 编译 wasm32（SIMD，单线程；不使用 -pthread 以降低部署门槛）"
# 源文件清单必须与官方 Makefile 第 79 行一致：递归全部 .cpp 与 .S，
# 但排除 ./universal（那里的 entry_*.cpp 是「通用二进制」的 main 垫片，
# 普通构建绝不能编进来）与 ./temp_builds。
# 注意 nnue/ 与 external/（zstd）都是子目录——只取顶层 *.cpp 会在链接期
# 报 Stockfish::Eval::NNUE::Network::* 未定义。
SOURCES=$(find -L . \( -path './universal' -o -path './temp_builds' \) -prune \
  -o \( -name '*.cpp' -o -name '*.S' \) -print | sed 's|^\./||')

# 参数说明（与官方 Makefile 的 wasm32 目标对齐）：
#   -msimd128                     启用 wasm SIMD；emcc 的 x86 兼容层会把 SSE 内建映射过来
#   -DIS_64BIT                    必须！否则 misc.h 里 `u128 = unsigned __int128` 两个分支
#                                 都不命中（wasm32 非 64 位），types.h 的 `Bitboard = u128`
#                                 直接编译失败：unknown type name 'u128'。
#                                 （实测 wasm32 的 clang 是支持 __int128 的。）
#   -DUSE_SSE2/-DUSE_SSSE3/-DUSE_SSE41  官方 wasm32 也定义了，走 SIMD 加速路径。
#                                 注意：这几个宏必须配套 `-msse2 -mssse3 -msse4.1`，
#                                 否则 emscripten 的 compat 头（emmintrin.h 等）会
#                                 `#error "SSE2 instruction set not enabled"`。
#   -DUSE_POPCNT                  与官方一致
#   -sENVIRONMENT=web,worker      允许在 Web Worker 内加载
#   -sMODULARIZE=1                导出工厂函数，便于在 worker 里控制初始化时机
#   -sFORCE_FILESYSTEM=1          需要在虚拟 FS 里读到 pikafish.nnue
#   --preload-file ...@/...       把权重打进独立的 .data 包（可单独缓存 + 上报进度）
#   刻意不加 -pthread：多线程需要 pthread 池，而本项目用「JS 侧 SAB + Atomics.wait」
#   实现阻塞式 stdin，与引擎自身开不开线程无关，单线程构建部署门槛更低（Threads 固定 1）。
"$EMPY" "$EMXX_PY" -std=c++20 -O3 \
  -msimd128 -msse2 -mssse3 -msse4.1 \
  -DIS_64BIT -DUSE_POPCNT -DUSE_SSE2 -DUSE_SSSE3 -DUSE_SSE41 \
  -DNDEBUG -DARCH=wasm32 \
  -sWASM=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=3MB \
  -sENVIRONMENT=web,worker \
  -sMODULARIZE=1 -sEXPORT_NAME=createPikafishModule \
  -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 \
  --preload-file pikafish.nnue@/pikafish.nnue \
  -o pikafish.js \
  $SOURCES

echo "==> 复制产物到 $OUT_DIR"
mkdir -p "$OUT_DIR"
cp pikafish.js "$OUT_DIR/"
[ -f pikafish.wasm ] && cp pikafish.wasm "$OUT_DIR/"
# --preload-file 会把权重打进 pikafish.data（不再单独拷一份 pikafish.nnue，
# 否则仓库里会白白多出 48MB 的重复文件）。
[ -f pikafish.data ] && cp pikafish.data "$OUT_DIR/"

echo "==> 完成。记得同步 src/xiangqi/pikafish-assets.ts 里的 PIKAFISH_ASSET_VERSION（破坏缓存）"
ls -la "$OUT_DIR"
