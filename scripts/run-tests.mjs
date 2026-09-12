/* ────────────────────────────────────────────────────────────
 *  scripts/run-tests.mjs — 引擎自测统一入口
 *
 *  用法：
 *    npm test                      跑全部套件
 *    node scripts/run-tests.mjs othello   只跑名字里带 othello 的套件
 *    node scripts/run-tests.mjs --list    列出套件名
 *
 *  *.test.mts 用 esbuild 打成单文件放到 .tmp/ 再交给 node；
 *  tests/rapfi.test.cjs 是纯 CommonJS，直接在 node 里跑。
 *  各套件的差异（围棋用 cjs、象棋网络引擎外置 tfjs、黑白棋控制器要 png
 *  dataurl）写在 SUITES 表里，不再散落在 package.json 里。
 *  任一套件失败即以退出码 1 结束——CI（.github/workflows/deploy.yml）靠它拦部署。
 * ──────────────────────────────────────────────────────────── */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.tmp');

/** tfjs 在 node 下由运行时从 node_modules 解析，不进 bundle */
const TFJS = [
  '@tensorflow/tfjs-core',
  '@tensorflow/tfjs-backend-cpu',
  '@tensorflow/tfjs-backend-webgl',
  '@tensorflow/tfjs-backend-wasm',
  '@tensorflow/tfjs-backend-webgpu',
];

/** 一个套件 = 一组跑完一起判定的测试文件 */
const SUITES = [
  { name: 'engine', entries: ['tests/engine.test.mts'] },
  { name: 'junqi', entries: ['tests/junqi.test.mts'] },
  { name: 'rapfi', entries: ['tests/rapfi.test.cjs'], plain: true },
  { name: 'xqfen', entries: ['tests/xqfen.test.mts'] },
  { name: 'xqsearch', entries: ['tests/xqsearch.test.mts'] },
  { name: 'xqnn', entries: ['tests/xqnn.test.mts'], external: TFJS },
  { name: 'xqwlight', entries: ['tests/xqwlight.test.mts'] },
  { name: 'tornado', entries: ['tests/tornado.test.mts'] },
  { name: 'go', entries: ['tests/go.test.mts'], format: 'cjs' },
  {
    name: 'othello',
    entries: ['tests/othello.test.mts', 'tests/othello-controller.test.mts'],
    loader: { '.png': 'dataurl' },
  },
];

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const s of SUITES) console.log(s.name + '\t' + s.entries.join(' '));
  process.exit(0);
}

const selected = args.length ? SUITES.filter((s) => args.some((a) => s.name.includes(a))) : SUITES;
if (!selected.length) {
  console.error(`没有匹配的套件：${args.join(', ')}（可用：${SUITES.map((s) => s.name).join(', ')}）`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const failed = [];
for (const suite of selected) {
  console.log(`\n──── ${suite.name} ────`);
  for (const entry of suite.entries) {
    const entryPath = path.join(ROOT, entry);
    const stem = path.basename(entry).replace(/\.test\.[cm]?ts$/, '');
    const outfile = path.join(OUT_DIR, `${stem}.test.${suite.format === 'cjs' ? 'cjs' : 'mjs'}`);

    if (!suite.plain) {
      await build({
        entryPoints: [entryPath],
        outfile,
        bundle: true,
        platform: 'node',
        format: suite.format ?? 'esm',
        external: suite.external ?? [],
        loader: suite.loader ?? {},
        logLevel: 'warning',
      });
    }
    const run = spawnSync(process.execPath, [suite.plain ? entryPath : outfile], { stdio: 'inherit' });
    if (run.status !== 0) {
      failed.push(`${suite.name}/${stem}`);
      break;
    }
  }
}

if (failed.length) {
  console.error(`\n❌ 失败：${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\n✅ ${selected.length} 个套件全部通过`);
