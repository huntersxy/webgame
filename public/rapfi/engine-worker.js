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

      self.Rapfi({
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
        setStatus: () => {},
      }).then(
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
