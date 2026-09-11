/* ────────────────────────────────────────────────────────────
 *  scripts/copy-tfjs-wasm.mjs
 *
 *  把 @tensorflow/tfjs-backend-wasm 的三个 .wasm 复制到 public/go/tfjs/。
 *  它们是「WebGPU 与 WebGL 都不可用」时的第三级后端；文件已入库，
 *  这个脚本只是保证依赖升级后不会忘了同步（predev / prebuild 自动跑）。
 *
 *  用法：node scripts/copy-tfjs-wasm.mjs
 * ──────────────────────────────────────────────────────────── */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(projectRoot, 'node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist');
const outDir = path.join(projectRoot, 'public', 'go', 'tfjs');

async function main() {
  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch {
    console.warn(`[copy-tfjs-wasm] 没找到 ${srcDir}（依赖未安装？），跳过`);
    return;
  }
  const wasmFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.wasm')).map((e) => e.name);
  if (wasmFiles.length === 0) {
    console.warn('[copy-tfjs-wasm] dist 下没有 .wasm，跳过');
    return;
  }
  await fs.mkdir(outDir, { recursive: true });

  let copied = 0;
  for (const name of wasmFiles) {
    const src = path.join(srcDir, name);
    const dst = path.join(outDir, name);
    const [srcStat, dstStat] = await Promise.all([fs.stat(src), fs.stat(dst).catch(() => null)]);
    if (dstStat && dstStat.size === srcStat.size) continue;
    await fs.copyFile(src, dst);
    copied++;
    console.log(`[copy-tfjs-wasm] 复制 ${name}（${(srcStat.size / 1048576).toFixed(2)} MB）`);
  }
  console.log(`[copy-tfjs-wasm] 完成：${wasmFiles.length} 个文件，实际更新 ${copied} 个`);
}

main().catch((err) => {
  console.error('[copy-tfjs-wasm] 失败：', err);
  process.exitCode = 1;
});
