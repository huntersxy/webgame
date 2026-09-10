/* ────────────────────────────────────────────────────────────
 *  engine-worker.js — classic (non-module) worker that hosts the
 *  Rapfi WASM engine. Lives in public/rapfi/ next to the wasm
 *  files, loaded via importScripts (unavailable in module workers).
 *
 *  Messages in:  { type: 'init' }  { type: 'cmd', data: string }
 *  Messages out: { type: 'ready' } { type: 'stdout', data }
 *                { type: 'stderr', data } { type: 'error', data }
 *                { type: 'exit', data }
 *
 *  Engine protocol notes (single-thread build): every sendCommand()
 *  runs exactly one protocol command; when the stdin queue runs dry
 *  mid-read the engine exits — so multi-line payloads (BOARD blocks)
 *  must always be sent as ONE string.
 * ──────────────────────────────────────────────────────────── */

/* global Rapfi */
'use strict';

/*
 * TextDecoder 兼容补丁 —— 必须在本文件顶层、importScripts 之前装好，
 * 因为 emscripten 胶水随后就会用它把 HEAPU8 里的字节解成 JS 字符串。
 *
 * 背景：启用 COOP/COEP 后页面进入 cross-origin isolated，引擎走多线程构建，
 * 本文件的 init 分支会传一个 { shared: true, maximum: N } 的 WebAssembly.Memory
 * ——它的 buffer 是一个「可增长的 SharedArrayBuffer」。而 TextDecoder.decode()
 * 按规范拒绝可增长的底层缓冲，抛 TypeError:
 *   "Failed to execute 'decode' on 'TextDecoder': The provided ArrayBuffer value
 *    must not be resizable"
 * 后果极具迷惑性：引擎能启动（ready）、命令也能收，但每一条输出在解码时都抛错，
 * 客户端一个字都拿不到，最终表现为搜索超时 "rapfi produced no move"。
 * 单线程构建不带共享内存，所以只在配了 COOP/COEP 的站点上复现。
 *
 * 修法：遇到可增长/可调整大小的底层缓冲时，先拷一份普通缓冲再交给原实现。
 * 只在字符串转换这一层多一次小块拷贝，代价可忽略。
 */
(function () {
  if (typeof TextDecoder === 'undefined') return;
  var orig = TextDecoder.prototype.decode;
  function risky(buf) {
    return !!buf && (buf.resizable === true || buf.growable === true);
  }
  TextDecoder.prototype.decode = function (input, options) {
    if (input && typeof input === 'object') {
      var buf = ArrayBuffer.isView(input) ? input.buffer : input;
      if (risky(buf)) {
        var safe = ArrayBuffer.isView(input) ? new Uint8Array(input) : new Uint8Array(input.slice(0));
        return orig.call(this, safe, options);
      }
    }
    return orig.call(this, input, options);
  };
})();

let instance = null;
let exited = false;

function post(msg) {
  self.postMessage(msg);
}

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      // SharedArrayBuffer only exists in cross-origin-isolated contexts;
      // the multi build needs it, otherwise fall back to single build.
      const sabOk =
        typeof SharedArrayBuffer !== 'undefined' &&
        typeof self.crossOriginIsolated !== 'undefined' &&
        self.crossOriginIsolated;
      // 客户端可以强制指定构建。用途：某个构建运行中挂掉后，重建时改传
      // 另一个构建再试一次，而不是直接掉到内置 JS 引擎。
      const want = msg.variant === 'single' || msg.variant === 'multi' ? msg.variant : 'auto';
      const canThread = want === 'multi' ? sabOk : want === 'single' ? false : sabOk;

      // Cache-bust suffix propagated from the client (matches its ASSET_VERSION)
      const ver = typeof msg.version === 'string' && msg.version ? '?v=' + msg.version : '';

      const variant = canThread ? 'rapfi-multi.js' : 'rapfi-single.js';
      self.importScripts(variant + ver);
      self.__rapfiVariant = variant;

      // ── 修正 pthread 工作线程的脚本地址 ──
      // 本文件是我们自己的 classic worker 包装层，只 importScripts 了 emscripten
      // glue。而 glue 起 pthread 时用的是 `_scriptName`：它在普通页面取
      // document.currentScript.src，在 worker 里退化成 self.location.href——
      // 也就是「本文件」。于是 pthread 会去加载本文件而不是 glue，协议对不上，
      // 线程永远起不来；多线程引擎就卡在等线程上：能 ready、却搜不出任何着法，
      // 而且 stderr 为空（没有报错可看），最终表现为 "rapfi produced no move"。
      // 这个 emscripten 版本没有 mainScriptUrlOrBlob 可用，只能在这里把
      // name === 'em-pthread' 的那次 Worker 构造改指向真正的 glue 地址。
      // 仅在本 worker 内生效，也只影响 Rapfi 自己起的线程。
      if (canThread) {
        const glueUrl = new URL(variant + ver, self.location.href).href;
        const NativeWorker = self.Worker;
        const PatchedWorker = function (url, opts) {
          if (opts && opts.name === 'em-pthread') return new NativeWorker(glueUrl, opts);
          return new NativeWorker(url, opts);
        };
        PatchedWorker.prototype = NativeWorker.prototype;
        try {
          self.Worker = PatchedWorker;
        } catch (err) {
          post({ type: 'stderr', data: 'pthread worker url patch failed: ' + err });
        }
      }

      let wasmMemory;
      if (canThread) {
        // Find the largest shared memory the browser will grant (2GB → 512MB)
        let maxMb = 2048;
        for (;;) {
          try {
            wasmMemory = new WebAssembly.Memory({
              initial: (64 * 1024 * 1024) / 65536,
              maximum: (maxMb * 1024 * 1024) / 65536,
              shared: true,
            });
            wasmMemory.grow(1);
            break;
          } catch (err) {
            maxMb /= 2;
            if (maxMb < 512) { wasmMemory = undefined; break; }
          }
        }
      }

      // emscripten 的文件包加载器会逐块回调 setStatus（形如
      // "Downloading data... (1234/10131512)"），原先传的是空函数、进度全丢了。
      // 这里解析出字节数发回主线程。解析失败就退回去读 Module.dataFileDownloads；
      // 两者都拿不到时只是没有进度条，不影响加载。
      let lastProgressAt = 0;
      const rapfiCfg = {
        locateFile: (url) => {
          // Every build requests its own '<name>.data'; all variants share
          // the single package 'rapfi.data' in this directory (config.toml
          // + mix9svq NNUE weights + classical model tables).
          if (/\.data$/.test(url)) url = 'rapfi.data';
          return url + ver; // resolved against this worker's URL (same dir)
        },
        wasmMemory: wasmMemory,
        onReceiveStdout: (o) => post({ type: 'stdout', data: o }),
        onReceiveStderr: (o) => post({ type: 'stderr', data: o }),
        onExit: (code) => { exited = true; post({ type: 'exit', data: code }); },
        setStatus: (msg) => {
          let loaded = 0, total = 0;
          const m = /\((\d+)\s*\/\s*(\d+)\)/.exec(String(msg || ''));
          if (m) {
            loaded = Number(m[1]); total = Number(m[2]);
          } else {
            const dl = rapfiCfg.dataFileDownloads;
            if (dl) for (const k in dl) { loaded += dl[k].loaded || 0; total += dl[k].total || 0; }
          }
          if (!total) return;
          const now = Date.now();
          if (loaded < total && now - lastProgressAt < 120) return; // 节流，完成时立刻发
          lastProgressAt = now;
          post({ type: 'load-progress', data: { loaded, total } });
        },
      };
      self.Rapfi(rapfiCfg).then(
        (inst) => {
          instance = inst;
          post({ type: 'ready', data: variant });
        },
        (err) => post({ type: 'error', data: String((err && err.message) || err) })
      );
    } catch (err) {
      post({ type: 'error', data: String((err && err.message) || err) });
    }
    return;
  }

  if (exited) { post({ type: 'error', data: 'engine exited' }); return; }
  if (msg.type === 'cmd') {
    if (!instance) { post({ type: 'error', data: 'engine not ready' }); return; }
    try {
      instance.sendCommand(msg.data);
    } catch (err) {
      post({ type: 'error', data: String((err && err.message) || err) });
    }
  }
};
