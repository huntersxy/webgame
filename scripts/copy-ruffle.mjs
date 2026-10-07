/* ────────────────────────────────────────────────────────────
 *  scripts/copy-ruffle.mjs
 *
 *  把 @ruffle-rs/ruffle（自托管版 Flash 播放器）的运行时复制到 public/ruffle/。
 *
 *  为什么不走 Vite 的资源管线：ruffle.js 在运行时用 fetch 去取带内容哈希的
 *  core 分块与 .wasm，路径由脚本自身的 URL 推导，bundler 看不见这些引用，
 *  也就不会把它们产出到 dist。放进 public/ 后原样拷过去，哈希名保持不变，
 *  运行时按名取用即可。
 *
 *  只拷 SIMD 那一对（core.ruffle.<hash>.js + <hash>.wasm），不拷 vanilla
 *  兜底对：ruffle.js 的特性探测只覆盖基线提案（bulk-memory / reference-types /
 *  trunc_sat / sign-ext / SIMD），现代浏览器全部原生支持，vanilla 对在本站
 *  永远不会被取用——留着纯占约 23MB 部署体积。真有探测不过的环境，ruffle.js
 *  会自行打印「NOT available, falling back…」再报错，不会静默播放失败。
 *
 *  哪一对是 SIMD 版不写死：现场解析 ruffle.js 里「探测为真」那一支的分块号/
 *  模块号再对应到文件名，ruffle 升版（哈希变）自动跟随。解析不出来就退回
 *  全量拷贝（等于改前的行为）并告警，绝不让构建因此失败。
 *
 *  用法：node scripts/copy-ruffle.mjs（predev / prebuild 自动执行）
 * ──────────────────────────────────────────────────────────── */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(projectRoot, 'node_modules', '@ruffle-rs', 'ruffle');
const outDir = path.join(projectRoot, 'public', 'ruffle');

/** 必拷的入口文件 */
const REQUIRED = ['ruffle.js'];
/** 可拷的运行时文件（core 分块与 wasm，文件名内嵌内容哈希，由 ruffle.js 写死引用） */
const OPTIONAL = [
  /^core\.ruffle\.[0-9a-f]+\.js$/,
  /^[0-9a-f]{20}\.wasm$/,
];
/** 许可与说明，一并随站点分发 */
const LICENSES = ['LICENSE_MIT', 'LICENSE_APACHE'];

/**
 * 解析 ruffle.js，返回特性探测为真那一支（SIMD 版）的 { core, wasm } 文件名。
 * 任一环对不上返回 null —— 调用方退回全量拷贝。
 *
 * 源码形如（minified，具体变量名随版本变，正则不依赖变量名）：
 *   n ? a.e(655).then(...) : a.e(482).then(...)           // core 分块二选一
 *   a.u = e => "core.ruffle." + {482:"f000…",655:"c801…"}[e] + ".js"
 *   s = n ? new URL(a(797), a.b) : new URL(a(124), a.b)   // wasm 二选一
 *   797(e,n,a){ e.exports = a.p + "826b….wasm" }
 * 冒号前那一支就是 n（扩展全可用）为真时走的现代浏览器路径。
 */
function parseSimdPair(ruffleSrc) {
  // ① core 分块三元：?X.e(真支分块号).then(...):Y.e(假支分块号)
  const coreTernary = /\?\s*[\w$]+\.e\((\d+)\)\s*\.then\(\s*(?:[^()]|\([^()]*\))*\)\s*:\s*[\w$]+\.e\((\d+)\)/.exec(ruffleSrc);
  // ② 分块号 → 内容哈希 表
  const hashMap = /core\.ruffle\."\+\{([^}]+)\}/.exec(ruffleSrc);
  // ③ wasm 模块三元：?new URL(模块号(真支),…).b):new URL(…
  const wasmTernary = /\?\s*new URL\(\s*[\w$]+\(\s*(\d+)\s*\)\s*,\s*[\w$]+\.b\s*\)\s*:\s*new URL\(/.exec(ruffleSrc);
  if (!coreTernary || !hashMap || !wasmTernary) return null;

  const hashes = {};
  for (const m of hashMap[1].matchAll(/(\d+):"([0-9a-f]+)"/g)) hashes[m[1]] = m[2];
  const coreHash = hashes[coreTernary[1]];
  if (!coreHash) return null;

  // ④ wasm 模块号 → 文件名（模块体里的 a.p + "hash.wasm"）
  const wasmFile = new RegExp(`${wasmTernary[1]}\\([^)]*\\)\\{[^}]*\\+"([0-9a-f]{20}\\.wasm)"`).exec(ruffleSrc);
  if (!wasmFile) return null;

  return { core: `core.ruffle.${coreHash}.js`, wasm: wasmFile[1] };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const entries = await fs.readdir(srcDir).catch(() => null);
  if (!entries) {
    console.warn(`[copy-ruffle] 没找到 ${srcDir}（依赖未安装？），跳过`);
    return;
  }

  const candidates = entries.filter((f) => REQUIRED.includes(f) || OPTIONAL.some((re) => re.test(f)) || LICENSES.includes(f));

  // 解析出 SIMD 对 → 只留这一对；解析失败 → 全量（改前的行为），告警但不失败
  const ruffleSrc = await fs.readFile(path.join(srcDir, 'ruffle.js'), 'utf8').catch(() => '');
  const pair = ruffleSrc ? parseSimdPair(ruffleSrc) : null;
  let wanted;
  if (pair) {
    wanted = candidates.filter((f) => f === 'ruffle.js' || f === pair.core || f === pair.wasm || LICENSES.includes(f));
    // 完整性：SIMD 对缺任何一个都说明包结构变了，不能悄悄上线残缺内核
    if (!wanted.includes('ruffle.js') || !wanted.includes(pair.core) || !wanted.includes(pair.wasm)) {
      console.error(
        `[copy-ruffle] 运行时文件不完整：ruffle.js=${wanted.includes('ruffle.js')} ` +
          `core=${pair.core}(${wanted.includes(pair.core)}) wasm=${pair.wasm}(${wanted.includes(pair.wasm)})。` +
          `@ruffle-rs/ruffle 的包结构可能已变，请核对 node_modules/@ruffle-rs/ruffle/。`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`[copy-ruffle] SIMD 内核：${pair.core} + ${pair.wasm}（vanilla 兜底对不拷，省约 23MB）`);
  } else {
    wanted = candidates;
    const chunks = wanted.filter((f) => /^core\.ruffle\./.test(f));
    const wasms = wanted.filter((f) => /\.wasm$/.test(f));
    if (!wanted.includes('ruffle.js') || chunks.length < 2 || wasms.length < 2) {
      console.error(
        `[copy-ruffle] ruffle.js 解析失败且全量拷贝也不完整：ruffle.js=${wanted.includes('ruffle.js')} ` +
          `core 分块=${chunks.length} wasm=${wasms.length}。包结构已变，请核对 node_modules/@ruffle-rs/ruffle/。`,
      );
      process.exitCode = 1;
      return;
    }
    console.warn('[copy-ruffle] 未能从 ruffle.js 解析出 SIMD 分支，退回全量拷贝（行为与旧版一致）');
  }

  let copied = 0;
  let skipped = 0;
  for (const f of wanted) {
    const src = path.join(srcDir, f);
    const dst = path.join(outDir, f);
    const srcStat = await fs.stat(src);
    const dstStat = await fs.stat(dst).catch(() => null);
    if (dstStat && dstStat.size === srcStat.size) {
      skipped += 1;
      continue;
    }
    await fs.copyFile(src, dst);
    copied += 1;
  }

  // 清掉上一次拷贝遗留、这次不再需要的文件：旧版本的 vanilla 兜底 wasm、
  // 升级 ruffle 后换了哈希的旧 core 分块，否则会在 public/ruffle/ 里越积越多。
  let pruned = 0;
  for (const f of await fs.readdir(outDir)) {
    if (!wanted.includes(f) && OPTIONAL.some((re) => re.test(f))) {
      await fs.rm(path.join(outDir, f), { force: true });
      pruned += 1;
      console.log(`[copy-ruffle]   - 移除遗留 ${f}`);
    }
  }

  console.log(`[copy-ruffle] 完成：${copied} 个复制，${skipped} 个已是最新，${pruned} 个遗留已清理`);
}

await main();
