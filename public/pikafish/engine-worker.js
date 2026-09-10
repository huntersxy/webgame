/* ────────────────────────────────────────────────────────────
 *  engine-worker.js — classic（非 module）worker，托管 Pikafish WASM
 *
 *  与 public/rapfi/engine-worker.js 职责相同，但协议不同：Pikafish 说
 *  UCI，而且**没有** emscripten 专用 I/O 钩子——它的主循环就是
 *  `getline(std::cin, cmd)`（见上游 src/uci.cpp）。wasm 里没有真实
 *  stdin，所以这里必须自己把 stdin 做成「阻塞式」的。
 *
 *  ── 为什么要用共享内存 ──
 *  本 worker 的线程会在引擎等待输入时阻塞。如果命令用 postMessage 送，
 *  本线程阻塞期间 onmessage 根本不会触发 → 死锁。所以命令改走
 *  SharedArrayBuffer：由**模块 worker**（src/xiangqi/pikafish.ts）写入，
 *  本 worker 在 Atomics.wait 上被唤醒后读走。
 *
 *  SAB 布局（由创建方分配，大小 64KB）：
 *    Int32Array(sab, 0, 2)   ctrl[0] = 当前待读字节数（0 表示空槽）
 *    Uint8Array(sab, 8)      UTF-8 文本区
 *  单槽 + 严格「发一批命令 → 等一条输出」的时序即可，不会丢命令。
 *
 *  消息入： { type:'init', sab, version }
 *  消息出： { type:'ready' } { type:'stdout', data } { type:'stderr', data }
 *          { type:'error', data } { type:'load-progress', data:{loaded,total} }
 * ──────────────────────────────────────────────────────────── */

/* global createPikafishModule */
'use strict';

/*
 * TextDecoder 兼容补丁 —— 与 rapfi/engine-worker.js 同一原因：
 * emscripten 胶水用 TextDecoder 把 HEAPU8 解成字符串，而共享/可增长
 * 内存的底层缓冲会被 decode() 按规范拒绝，导致引擎所有输出解码抛错、
 * 表现为「搜不出着法」。遇到可增长/可调整大小的缓冲先拷一份普通缓冲。
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

let exited = false;
let slot = null;      // { ctrl: Int32Array, bytes: Uint8Array, dec: TextDecoder }

function post(msg) {
  self.postMessage(msg);
}

/** 阻塞式读一行（或一批）命令：等 ctrl[0] 变为非 0，读走并清空槽位。 */
function readStdin() {
  const { ctrl, bytes, dec } = slot;
  for (;;) {
    const n = Atomics.load(ctrl, 0);
    if (n > 0) {
      const text = dec.decode(bytes.subarray(0, n));
      Atomics.store(ctrl, 0, 0);
      Atomics.notify(ctrl, 0);
      return text;
    }
    if (exited) return null;          // 已退出 → 返回 null 触发 EOF
    Atomics.wait(ctrl, 0, 0, 250);    // 250ms 超时兜底，避免永久挂死
  }
}

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
        post({ type: 'error', data: '缺少 cross-origin isolation（COOP/COEP）或 SharedArrayBuffer' });
        return;
      }
      if (!(msg.sab instanceof SharedArrayBuffer)) {
        post({ type: 'error', data: 'init 缺少命令缓冲区' });
        return;
      }
      const ctrl = new Int32Array(msg.sab, 0, 2);
      if (ctrl[0] !== 0) ctrl[0] = 0;
      slot = { ctrl, bytes: new Uint8Array(msg.sab, 8), dec: new TextDecoder() };

      const ver = typeof msg.version === 'string' && msg.version ? '?v=' + msg.version : '';
      // 权重包可能托管在外部 OSS/CDN（见 src/xiangqi/pikafish-assets.ts）。
      // init 带上的是「已经解析好的完整 URL」，直接用它——必须与主线程预取
      // 用的那条 URL 完全一致，否则会白下两遍 48MB。
      const dataUrl = typeof msg.dataUrl === 'string' && msg.dataUrl ? msg.dataUrl : null;

      let lastProgressAt = 0;
      const cfg = {
        // .data 走外部 URL（没配就退回同目录）；.wasm 与胶水始终同目录，拼 ?v= 破缓存。
        locateFile: (url) => {
          if (/\.data$/.test(url)) return dataUrl || url + ver;
          return /\.wasm$/.test(url) ? url + ver : url;
        },
        print: (line) => post({ type: 'stdout', data: line }),
        printErr: (line) => post({ type: 'stderr', data: line }),
        // 阻塞式 stdin：引擎调 getline 时被拉取
        stdin: readStdin,
        onRuntimeInitialized: () => {
          // main() 尚未开始阻塞（它随后就会卡在读命令上），先报「就绪」。
          // 注意：因为 main 永不返回，工厂返回的 Promise 不会 resolve，
          // 就绪信号只能靠这里或 stdout 首行。
          post({ type: 'ready' });
        },
        onAbort: (what) => post({ type: 'error', data: 'abort: ' + (what || 'unknown') }),
        // emscripten 的文件包加载器会逐块回调 setStatus（形如
        // "Downloading data... (1234/50706378)"）；解析出字节数上报主线程。
        setStatus: (s) => {
          const m = /\((\d+)\s*\/\s*(\d+)\)/.exec(String(s || ''));
          if (!m) return;
          const loaded = Number(m[1]);
          const total = Number(m[2]);
          if (!total) return;
          const now = Date.now();
          if (loaded < total && now - lastProgressAt < 120) return; // 节流
          lastProgressAt = now;
          post({ type: 'load-progress', data: { loaded, total } });
        },
      };

      importScripts('pikafish.js' + ver);
      const factory = self.createPikafishModule;
      if (typeof factory !== 'function') {
        post({ type: 'error', data: '未找到 createPikafishModule（构建时是否漏了 -sMODULARIZE？）' });
        return;
      }
      factory(cfg).catch((err) => {
        // main 阻塞在 stdin 时这个 Promise 不会 settle；只有真正出错才会 reject。
        post({ type: 'error', data: String((err && err.message) || err) });
      });
    } catch (err) {
      post({ type: 'error', data: String((err && err.message) || err) });
    }
    return;
  }

  // 'cmd' 只在 SAB 不可用时的兜底路径使用（正常流程命令走共享内存）。
  if (msg.type === 'cmd' && slot) {
    const bytes = new TextEncoder().encode(String(msg.data));
    if (bytes.length <= slot.bytes.length) {
      slot.bytes.set(bytes, 0);
      Atomics.store(slot.ctrl, 0, bytes.length);
      Atomics.notify(slot.ctrl, 0);
    }
  }
};
