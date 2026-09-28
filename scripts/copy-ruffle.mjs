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
 *  两个 wasm 都要拷：SIMD 版给现代浏览器，vanilla 版给缺少 WebAssembly
 *  扩展的环境兜底。ruffle.js 先做特性探测再决定取哪一个，缺任何一个都会
 *  让对应的浏览器直接报错。
 *
 *  用法：node scripts/copy-ruffle.mjs（predev / prebuild 自动执行）
 * ──────────────────────────────────────────────────────────── */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(projectRoot, 'node_modules', '@ruffle-rs', 'ruffle');
const outDir = path.join(projectRoot, 'public', 'ruffle');

/** 运行时文件（ruffle.js 会按固定哈希名去取 core 分块与 wasm） */
const REQUIRED = ['ruffle.js'];
const OPTIONAL = [
  // core 分块：SIMD 版 / vanilla 版，文件名内嵌内容哈希，由 ruffle.js 写死引用
  /^core\.ruffle\.[0-9a-f]+\.js$/,
  /^[0-9a-f]{20}\.wasm$/,
];
/** 许可与说明，一并随站点分发 */
const LICENSES = ['LICENSE_MIT', 'LICENSE_APACHE'];

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const entries = await fs.readdir(srcDir).catch(() => null);
  if (!entries) {
    console.warn(`[copy-ruffle] 没找到 ${srcDir}（依赖未安装？），跳过`);
    return;
  }

  const wanted = entries.filter((f) => REQUIRED.includes(f) || OPTIONAL.some((re) => re.test(f)) || LICENSES.includes(f));

  // 运行时完整性检查：core 分块与 wasm 各应有两个，缺了说明包结构变了
  const chunks = wanted.filter((f) => /^core\.ruffle\./.test(f));
  const wasms = wanted.filter((f) => /\.wasm$/.test(f));
  if (!wanted.includes('ruffle.js') || chunks.length < 2 || wasms.length < 2) {
    console.error(
      `[copy-ruffle] 运行时文件不完整：ruffle.js=${wanted.includes('ruffle.js')} ` +
        `core 分块=${chunks.length}（应为 2）wasm=${wasms.length}（应为 2）。` +
        `@ruffle-rs/ruffle 的包结构可能已变，请核对 node_modules/@ruffle-rs/ruffle/。`,
    );
    process.exitCode = 1;
    return;
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
  console.log(`[copy-ruffle] 完成：${copied} 个复制，${skipped} 个已是最新`);
}

await main();
