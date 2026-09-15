/* ────────────────────────────────────────────────────────────
 *  scripts/copy-ort-wasm.mjs
 *
 *  把 onnxruntime-web 的 WASM 后端（glue + 二进制）复制到 public/ort/。
 *
 *  为什么不走 Vite 的 ?url 资源管线：那样会产出带 hash 的 /assets/*.mjs，
 *  而 .mjs 在不少静态主机（含本项目部署用的那台）没有被映射成 JavaScript
 *  MIME，返回 application/octet-stream。浏览器对动态 import() 做 MIME 检查，
 *  类型不对就直接拒绝——斗地主模型因此加载失败。改放 public/ 下用 .js 后缀，
 *  任何主机都会按 JavaScript 下发，问题消失。
 *
 *  用法：node scripts/copy-ort-wasm.mjs（predev / prebuild 自动执行）
 * ──────────────────────────────────────────────────────────── */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(projectRoot, 'node_modules', 'onnxruntime-web', 'dist');
const outDir = path.join(projectRoot, 'public', 'ort');

/** 源文件 → 目标文件名（glue 改成 .js，避开主机的 MIME 表） */
const FILES = [
  ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.js'],
  ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
];

async function main() {
  let copied = 0;
  let skipped = 0;
  await fs.mkdir(outDir, { recursive: true });
  for (const [from, to] of FILES) {
    const src = path.join(srcDir, from);
    const dst = path.join(outDir, to);
    let srcStat;
    try {
      srcStat = await fs.stat(src);
    } catch {
      console.warn(`[copy-ort-wasm] 没找到 ${src}（依赖未安装？），跳过`);
      continue;
    }
    const dstStat = await fs.stat(dst).catch(() => null);
    if (dstStat && dstStat.size === srcStat.size) {
      skipped += 1;
      continue;
    }
    await fs.copyFile(src, dst);
    copied += 1;
  }
  console.log(`[copy-ort-wasm] 完成：${copied} 个复制，${skipped} 个已是最新`);
}

await main();
