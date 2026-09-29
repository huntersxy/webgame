/* ────────────────────────────────────────────────────────────
 *  scripts/patch-tornado-swf.mjs — 给《龙卷风牧场》打存档修复补丁
 *
 *  背景：原作有一个缺陷——过关时会把进度写进 SharedObject：
 *
 *      myData.data.inflevel = levelReached;   // 写了
 *      myData.flush();
 *
 *  但每次回到主菜单时又把它硬编码重置：
 *
 *      myData = SharedObject.getLocal("userdata");
 *      levelReached = 1;                      // ← 存了却从不读回
 *
 *  于是刷新后关卡永远回到第 1 关。本脚本把那一行改成读存档，
 *  首次运行（无该字段）时仍从第 1 关开始。
 *
 *  做法：反编译 SWF → 改 AS3 源码 → 重新编译。
 *  为什么不能直接改 P-code：FFDec 的 -importScript 只接受 AS3 源码，
 *  P-code 传进去会被静默忽略（生成的 SWF 与原版逐字节相同）。
 *
 *  前置：
 *    · Java 运行时（FFDec 是 Java 程序）
 *    · FFDec（JPEXS Free Flash Decompiler），首次运行自动下载到 .tmp/ffdec/
 *
 *  用法：
 *    node scripts/patch-tornado-swf.mjs                     # 打补丁到 public/
 *    node scripts/patch-tornado-swf.mjs --check             # 只检查现有 SWF 是否已打补丁
 *    FFDec=/path/to/ffdec.jar node scripts/patch-tornado-swf.mjs
 *
 *  补丁是幂等的：已打过补丁的 SWF 会被识别并跳过。
 * ──────────────────────────────────────────────────────────── */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.tmp');
const GAME = join(ROOT, 'public', 'games', 'tornado-ranch', 'game.swf');
const FFDEC_DIR = join(TMP, 'ffdec');
const FFDEC_JAR = join(FFDEC_DIR, 'ffdec.jar');

const CHECK_ONLY = process.argv.includes('--check');
const FFDEC_URL =
  'https://github.com/jindrapetrik/jpexs-decompiler/releases/download/version26.3.0/ffdec_26.3.0.zip';

/** 补丁要改的那两行（原文与替换），以及必须一并修掉的反编译残留 */
const PATCHES = [
  {
    name: '存档修复：levelReached 从存档读回',
    from: [
      '         masuqBonus = myData.data.infmasuqBonus;',
      '         levelReached = 1;',
    ].join('\n'),
    to: [
      '         masuqBonus = myData.data.infmasuqBonus;',
      '         levelReached = myData.data.inflevel == undefined ? 1 : myData.data.inflevel;',
    ].join('\n'),
    /** 已打过补丁的判据 */
    indicator: 'myData.data.inflevel == undefined ? 1 : myData.data.inflevel',
  },
  {
    name: '反编译残留：navigateToURL（不改则整类无法编译）',
    from: [
      '            var _temp_2:* = \u00a7\u00a7findproperty(navigateToURL);',
      '            var _temp_1:* = request;',
      '            method;',
      '            _temp_1;',
      '            _temp_2;',
    ].join('\n'),
    to: '            navigateToURL(request, method);',
  },
  {
    name: '反编译残留：getURL（同上）',
    from: [
      '         var _temp_2:* = \u00a7\u00a7findproperty(getURL);',
      '         var _temp_1:* = "http://www.4399.com";',
      '         "_blank";',
      '         _temp_1;',
      '         _temp_2;',
    ].join('\n'),
    to: '         getURL("http://www.4399.com", "_blank");',
  },
];

function log(msg) {
  console.log(`[patch-swf] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** 确保 FFDec 可用，必要时下载 */
function ensureFfdec() {
  const envJar = process.env.FFDec;
  if (envJar && existsSync(envJar)) return envJar;
  if (existsSync(FFDEC_JAR)) return FFDEC_JAR;

  if (CHECK_ONLY) {
    log('缺少 FFDec（--check 模式下不自动下载）。设 FFDec=<ffdec.jar 路径> 后重试。');
    process.exit(2);
  }

  log(`下载 FFDec → ${FFDEC_DIR}`);
  mkdirSync(FFDEC_DIR, { recursive: true });
  const zip = join(FFDEC_DIR, 'ffdec.zip');
  const dl = run('curl', ['-sL', '--max-time', '300', '-o', zip, FFDEC_URL]);
  if (dl.code !== 0 || !existsSync(zip)) {
    log('下载失败。可手动下载 FFDec 并设 FFDec=<ffdec.jar 路径>。');
    process.exit(2);
  }
  const un = run('python', ['-c', `import zipfile;zipfile.ZipFile(r"${zip}").extractall(r"${FFDEC_DIR}")`]);
  if (un.code !== 0 || !existsSync(FFDEC_JAR)) {
    log('解压失败：' + un.out.slice(0, 200));
    process.exit(2);
  }
  return FFDEC_JAR;
}

function javaOk() {
  return run('java', ['-version']).code === 0;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
}

function main() {
  if (!existsSync(GAME)) {
    log(`找不到 ${GAME}`);
    process.exit(1);
  }

  // ① 先看是否已打过补丁。
  //    SWF 里的字符串在常量池中以 UTF-8 明文存放，但 AS3 编译后
  //    三元表达式会被拆成多条指令，源文本不再存在。所以判据取
  //    「只可能来自补丁」的属性名 inflevel 是否**被读取**——
  //    反编译回来若出现 getproperty inflevel，就说明补丁已在。
  const raw = readFileSync(GAME);
  const alreadyPatched = () => {
    const probeSrc = join(TMP, 'swf-patch-probe');
    rmSync(probeSrc, { recursive: true, force: true });
    mkdirSync(probeSrc, { recursive: true });
    const ff = ensureFfdec();
    const r = run('java', ['-jar', ff, '-selectclass', 'TornadoRanch', '-format', 'script:pcode',
      '-export', 'script', probeSrc, GAME]);
    const f = join(probeSrc, 'scripts', 'TornadoRanch.pcode');
    if (r.code !== 0 || !existsSync(f)) return null; // 判定不了
    const pcode = readFileSync(f, 'utf8');
    return pcode.includes('getproperty Multiname("inflevel"');
  };

  if (!CHECK_ONLY) {
    // 完整流程里也要先判幂等，避免重复打补丁把文件搞坏
    const st = alreadyPatched();
    if (st === true) {
      log(`已打过补丁，跳过（sha256 ${sha256(GAME)}）`);
      return;
    }
  } else {
    if (!javaOk()) {
      log('缺少 Java 运行时，无法反编译核对。');
      process.exit(2);
    }
    const st = alreadyPatched();
    if (st === true) {
      log(`已打过补丁（sha256 ${sha256(GAME)}）`);
      return;
    }
    if (st === false) {
      log(`未打补丁（sha256 ${sha256(GAME)}）`);
      process.exit(1);
    }
    log('无法判定（反编译失败）');
    process.exit(2);
  }

  if (!javaOk()) {
    log('缺少 Java 运行时，FFDec 无法运行。');
    process.exit(2);
  }
  const ffdec = ensureFfdec();

  const work = join(TMP, 'swf-patch');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const srcDir = join(work, 'src');
  const outSwf = join(work, 'patched.swf');
  const original = join(work, 'original.swf');
  writeFileSync(original, raw);

  // ② 反编译
  log('反编译…');
  const ex = run('java', ['-jar', ffdec, '-export', 'script', srcDir, original]);
  const asFiles = existsSync(srcDir) ? readdirSync(join(srcDir, 'scripts')).filter((f) => f.endsWith('.as')) : [];
  if (ex.code !== 0 || asFiles.length === 0) {
    log('反编译失败：' + ex.out.slice(-400));
    process.exit(1);
  }
  log(`导出 ${asFiles.length} 个脚本`);

  // ③ 打补丁（只动主类）
  const mainAs = join(srcDir, 'scripts', 'TornadoRanch.as');
  if (!existsSync(mainAs)) {
    log('未找到 TornadoRanch.as');
    process.exit(1);
  }
  const CRLF = '\r\n';
  const rawAs = readFileSync(mainAs, 'utf8');
  const usesCrlf = rawAs.includes(CRLF);
  let s = usesCrlf ? rawAs.split(CRLF).join('\n') : rawAs;

  for (const p of PATCHES) {
    if (p.indicator && s.includes(p.indicator)) {
      log(`跳过（已应用）：${p.name}`);
      continue;
    }
    if (!s.includes(p.from)) {
      // 反编译残留类补丁：目标不存在说明这次反编译没产生该残留
      // （例如已经是修过的 SWF），跳过即可，不是错误。
      if (p.name.includes('反编译残留')) {
        log(`跳过（本次无此残留）：${p.name}`);
        continue;
      }
      log(`未找到目标代码，无法应用：${p.name}`);
      log('SWF 版本可能不同，请人工核对后再改。');
      process.exit(1);
    }
    s = s.replace(p.from, p.to);
    log(`已应用：${p.name}`);
  }

  const leftover = s.split('\n').filter((l) => l.includes('\u00a7\u00a7'));
  if (leftover.length) {
    log(`仍有反编译残留未处理：${leftover[0].trim()}`);
    process.exit(1);
  }
  writeFileSync(mainAs, usesCrlf ? s.split('\n').join(CRLF) : s, 'utf8');

  // ④ 重新编译
  log('重新编译…');
  const im = run('java', ['-jar', ffdec, '-importScript', original, outSwf, join(srcDir, 'scripts')]);
  const compileFailed = /SEVERE|Error:/i.test(im.out);
  if (im.code !== 0 || !existsSync(outSwf) || compileFailed) {
    log('编译失败：' + im.out.slice(-600));
    process.exit(1);
  }

  // ⑤ 校验产物：反编译回来必须能看到「读 inflevel」这条指令。
  //    不能搜源码文本——三元表达式编译后已被拆成多条指令，原文本不复存在。
  log('校验产物…');
  const checkDir = join(work, 'verify');
  const vc = run('java', ['-jar', ffdec, '-selectclass', 'TornadoRanch', '-format', 'script:pcode',
    '-export', 'script', checkDir, outSwf]);
  const vf = join(checkDir, 'scripts', 'TornadoRanch.pcode');
  if (vc.code !== 0 || !existsSync(vf)) {
    log('校验失败：无法反编译产物');
    process.exit(1);
  }
  const vp = readFileSync(vf, 'utf8');
  if (!vp.includes('getproperty Multiname("inflevel"')) {
    log('校验失败：产物里没有读取 inflevel 的指令，拒绝写入。');
    process.exit(1);
  }
  log('校验通过：产物包含读取 inflevel 的指令');

  writeFileSync(GAME, readFileSync(outSwf));
  log(`完成 → ${GAME}`);
  log(`  原 ${readFileSync(original).length} 字节 → 新 ${readFileSync(GAME).length} 字节`);
  log(`  sha256 ${sha256(GAME)}`);
  log('提示：若 dist/ 已存在，需重新构建或手动同步该文件。');
}

main();
