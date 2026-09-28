/* ────────────────────────────────────────────────────────────
 *  scripts/check-shaders.mjs — WGSL 着色器校验
 *
 *  把 src/tornado/gpu/ 下的 WGSL 源码抽出来，交给 vgpu CLI 做**设备级**
 *  校验（`vgpu check --require-validation`）。它能抓出浏览器里只会以
 *  「pipeline compilation failed」一笔带过的问题：
 *    · WGSL 保留字被当成标识符（如 target / filter）
 *    · 类型不匹配（数组下标必须是整型等）
 *    · 在非一致控制流里调用 textureSample
 *  本机没有 WebGPU 设备时会降级为「解析 + 反射」，并在 stderr 提示。
 *
 *  用法：node scripts/check-shaders.mjs
 *  退出码 0 = 全部通过。
 * ──────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp');
mkdirSync(TMP, { recursive: true });

/** 抽取以 `/* wgsl *\/` 标注的反引号字面量（支持 export const 与 const 两种声明） */
function extract(file, name) {
  const text = readFileSync(file, 'utf8');
  let start = text.indexOf(`export const ${name}`);
  if (start < 0) start = text.indexOf(`const ${name}`);
  if (start < 0) return null;
  const tickStart = text.indexOf('`', text.indexOf('/* wgsl */', start));
  const tickEnd = text.indexOf('`;', tickStart);
  if (tickStart < 0 || tickEnd < 0) return null;
  return text.slice(tickStart + 1, tickEnd);
}

const SHADERS = path.join(ROOT, 'src/tornado/gpu/shaders.ts');
const CG = path.join(ROOT, 'src/tornado/gpu/cg.ts');
const cgCommon = extract(CG, 'CG_COMMON') ?? '';

const targets = [
  { name: 'FLOOR_WGSL', file: SHADERS },
  { name: 'SPRITE_WGSL', file: SHADERS },
  { name: 'TORNADO_WGSL', file: SHADERS },
  { name: 'COMPOSITE_WGSL', file: SHADERS },
  { name: 'CG_INTRO_WGSL', file: CG, inject: cgCommon },
  { name: 'CG_FINALE_WGSL', file: CG, inject: cgCommon },
];

const written = [];
for (const t of targets) {
  let body = extract(t.file, t.name);
  if (body === null) { console.error(`未找到 ${t.name}（${t.file}）`); continue; }
  // 用正则 + 函数式替换：既是字面量匹配，也避免替换串里的 $& / $' 被当成
  // 特殊替换模式（CG 源码里出现 $ 时不会污染注入结果）。
  if (t.inject) body = body.replace(/\$\{CG_COMMON\}/g, () => t.inject);
  const out = path.join(TMP, `wgsl-${t.name}.wgsl`);
  writeFileSync(out, body);
  written.push({ ...t, out, lines: body.split('\n').length });
}

let failed = 0;
for (const t of written) {
  const r = spawnSync('npx', ['vgpu', 'check', t.out, '--require-validation'], {
    encoding: 'utf8', shell: true, cwd: ROOT,
  });
  let payload = null;
  try { payload = JSON.parse(r.stdout); } catch { /* 非 JSON 输出（解析失败等） */ }
  const diags = payload?.diagnostics ?? [];
  const ok = payload?.validation?.ok === true && diags.length === 0;
  if (ok) {
    console.log(`✓ ${t.name} (${t.lines} 行)`);
    continue;
  }
  failed++;
  console.log(`\n✗ ${t.name} (${t.lines} 行)`);
  for (const d of diags) console.log(`   ${d.severity} ${d.code} L${d.line}:${d.column} ${d.message}`);
  const ve = payload?.validation?.error;
  if (ve) console.log(`   [device] ${ve.code} L${ve.line ?? '?'} ${ve.message}`);
  if (!payload) console.log('   raw:', (r.stdout || r.stderr).slice(0, 800));
}

console.log(failed ? `\n❌ ${failed}/${written.length} 支着色器未通过` : `\n✅ ${written.length} 支着色器全部通过`);
process.exit(failed ? 1 : 0);
