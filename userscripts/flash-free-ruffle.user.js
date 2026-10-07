// ==UserScript==
// @name         Flash 免插件游玩（Ruffle 播放器）
// @name:en      Play Flash games without Flash (Ruffle)
// @namespace    https://blog.xiey.work
// @version      1.0.0
// @description  在 4399、7k7k 一类 Flash 小游戏站点用 Ruffle（WebAssembly 版 Flash 播放器）直接播放 SWF，不需要安装 Flash 插件。自带跨域代理，解决游戏 CDN 不返回 CORS 头导致 Ruffle 取不到 SWF 的问题；找不到 embed 的老页面会按站点变量自己挂载播放器。
// @author       汐兮雨
// @license      MIT
// @match        *://*.4399.com/*
// @match        *://*.4399.cn/*
// @match        *://*.3304399.net/*
// @match        *://*.i3839.com/*
// @match        *://*.7k7k.com/*
// @match        *://*.7k7kjs.cn/*
// @match        *://*.7k7kimg.cn/*
// @match        *://*.2144.com/*
// @match        *://*.17173.com/*
// @run-at       document-start
// @connect      unpkg.com
// @connect      cdn.jsdelivr.net
// @connect      fastly.jsdelivr.net
// @connect      testingcf.jsdelivr.net
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==
/* eslint-disable */
(function () {
  'use strict';

  /**
   * 结构分三段，顺序不能颠倒：
   *   1) 页面上下文桥（BRIDGE_SOURCE）：改写 window.fetch，把会被 CORS 挡住的
   *      请求转成 postMessage 交给扩展上下文；
   *   2) 扩展上下文：收到请求后用 GM_xmlhttpRequest 取字节，再回传；
   *   3) 挂载逻辑：发现 SWF 证据 → 装桥 → 注入 ruffle.js → 让 Ruffle 的
   *      polyfill 把 embed/object 换成 <ruffle-player>。
   *
   * 为什么非要代理：Ruffle 下载 SWF 走的是页面里的 fetch()（见 ruffle.js 的
   * downloadSwf 以及 wasm 胶水里的 __wbg_fetch），而 4399 的
   * https://s1.4399.com/4399swf/...swf 响应里没有 Access-Control-Allow-Origin。
   * 页面是 https://www.4399.com，CDN 是另一个源，浏览器直接拦掉，报
   * "Failed to fetch"。GM_xmlhttpRequest 由扩展代发，不受页面同源策略约束。
   * 代理保持原 URL 不变（而不是换成 blob:），SWF 内部的相对资源才能继续解析。
   */

  var PAGE = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
  var NS = '__RFFP__';
  var FLASH_MIME = [
    'application/x-shockwave-flash',
    'application/futuresplash',
    'application/x-shockwave-flash2-preview',
    'application/vnd.adobe.flash.movie',
  ];
  var FLASH_CLASSID = 'clsid:d27cdb6e-ae6d-11cf-96b8-444553540000';
  var SAVE_FLUSH_MS = 3000;

  // ---------------------------------------------------------------- 配置读写

  function conf() {
    var ver = GM_getValue('ruffleVersion', '0.6.0');
    var custom = GM_getValue('ruffleBase', '');
    var bases = [];
    if (custom) bases.push(/\/$/.test(custom) ? custom : custom + '/');
    bases.push(
      'https://unpkg.com/@ruffle-rs/ruffle@' + ver + '/',
      'https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@' + ver + '/',
      'https://fastly.jsdelivr.net/npm/@ruffle-rs/ruffle@' + ver + '/',
      'https://testingcf.jsdelivr.net/npm/@ruffle-rs/ruffle@' + ver + '/'
    );
    return {
      bases: bases,
      autoplay: GM_getValue('autoplay', 'on'),
      proxy: GM_getValue('proxy', true) && !isDisabled('proxy:' + location.hostname),
      enabled: !isDisabled('site:' + location.hostname),
      version: ver,
    };
  }

  function isDisabled(key) {
    var list = GM_getValue('disabled', []);
    return Array.isArray(list) && list.indexOf(key) >= 0;
  }

  function toggleDisabled(key) {
    var list = GM_getValue('disabled', []);
    if (!Array.isArray(list)) list = [];
    var i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1);
    else list.push(key);
    GM_setValue('disabled', list);
    return i < 0;
  }

  /**
   * 「放宽代理范围」决定脚本是否代发本站发起的**所有**跨域请求，
   * 而不只是游戏主机和同站主机。它能看到的流量大得多，所以默认关，
   * 必须在菜单里按站点主动打开。
   */
  function proxyAllOn() {
    var list = GM_getValue('proxyAll', []);
    return Array.isArray(list) && list.indexOf(location.hostname) >= 0;
  }

  function toggleProxyAll() {
    var list = GM_getValue('proxyAll', []);
    if (!Array.isArray(list)) list = [];
    var i = list.indexOf(location.hostname);
    if (i >= 0) list.splice(i, 1);
    else list.push(location.hostname);
    GM_setValue('proxyAll', list);
    return i < 0;
  }

  // ---------------------------------------------------------- 页面上下文桥

  /**
   * 这个函数以字符串形式注入页面（script 元素），运行在页面上下文，因此它能改到
   * Ruffle 真正使用的那个 window.fetch。占位符 __RFFP_TOKEN__ 在注入前被替换成
   * 本帧一次性随机串，两个方向的消息都带它，避免同页其它脚本冒充。
   */
  function bridgeSource() {
    var TOKEN = '__RFFP_TOKEN__';
    var NS = '__RFFP_NS__';
    if (window[NS]) return;

    var state = { active: false, hosts: {}, sameSite: true };
    var pending = {};
    var seq = 0;
    var ORIGIN = location.origin;
    var origFetch = window.fetch;

    function siteOf(host) {
      host = String(host || '').toLowerCase();
      // IP 或 localhost 没有「站点」概念，退化为主机名整体比较。
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost' || /^\[.*\]$/.test(host)) {
        return host;
      }
      var parts = host.split('.');
      return parts.length <= 2 ? host : parts.slice(-2).join('.');
    }
    var PAGE_SITE = siteOf(location.hostname);

    function needProxy(raw) {
      if (!state.active) return false;
      var u;
      try {
        u = new URL(raw, location.href);
      } catch (e) {
        return false;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (u.origin === ORIGIN) return false; // 同源本来就能取，别多事
      var h = u.hostname.toLowerCase();
      if (state.hosts['*'] || state.hosts[h]) return true;
      // 同站不同子域（www.4399.com 取 s1.4399.com）是最常见的情况：
      // 浏览器要求 CORS 头，而这些站从来不发。第三方统计/广告不属于这里。
      if (state.sameSite && siteOf(h) === PAGE_SITE) return true;
      return false;
    }

    function ask(msg) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending[id] = { resolve: resolve, reject: reject };
        msg.__rffp = 1;
        msg.token = TOKEN;
        msg.type = 'req';
        msg.id = id;
        window.postMessage(msg, '*');
      });
    }

    window.addEventListener('message', function (ev) {
      var d = ev.data;
      if (!d || d.__rffp !== 1 || d.token !== TOKEN) return;
      if (ev.source && ev.source !== window) return;
      if (d.type === 'resp') {
        var p = pending[d.id];
        if (!p) return;
        delete pending[d.id];
        if (d.ok) p.resolve(d);
        else p.reject(new Error(d.error || 'ruffle-proxy failed'));
      } else if (d.type === 'cfg') {
        state.active = !!d.active;
        state.sameSite = d.sameSite !== false;
        var hs = d.hosts || [];
        for (var i = 0; i < hs.length; i++) state.hosts[String(hs[i]).toLowerCase()] = 1;
        window[NS].ready = true;
      } else if (d.type === 'ping') {
        window.postMessage({ __rffp: 1, token: TOKEN, type: 'pong' }, '*');
      }
    });

    function toB64(u8) {
      var s = '';
      var CH = 0x8000;
      for (var i = 0; i < u8.length; i += CH) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      }
      return btoa(s);
    }
    function fromB64(b64) {
      var bin = atob(b64);
      var u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }

    // 只有能同步拿到字节体的请求才走代理；Stream/FormData 之类交回原生 fetch。
    function bodyOf(v) {
      if (v == null) return Promise.resolve(null);
      if (typeof v === 'string') return Promise.resolve({ text: v });
      if (v instanceof ArrayBuffer) return Promise.resolve({ bin: toB64(new Uint8Array(v)) });
      if (ArrayBuffer.isView(v)) {
        return Promise.resolve({ bin: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) });
      }
      return 'unsupported';
    }

    // new Response() 造出来的对象 url 是空串，而 Ruffle 拿 response.url 当影片的
    // 来源地址去判安全域；空地址会让影片进错沙箱，症状是「画得出来但点不动」。
    // 这里包一层 Proxy 只把 url 补回去，其余成员仍然走真的 Response。
    function withUrl(res, url) {
      try {
        return new Proxy(res, {
          get: function (t, k) {
            if (k === 'url') return url;
            var v = t[k];
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      } catch (e) {
        try {
          Object.defineProperty(res, 'url', { value: url, configurable: true });
        } catch (e2) {}
        return res;
      }
    }

    window.fetch = function (input, init) {
      var raw = null;
      try {
        if (typeof input === 'string' || input instanceof URL) raw = String(input);
        else if (input && typeof input.url === 'string') raw = input.url;
      } catch (e) {}
      if (!raw || !needProxy(raw)) return origFetch.apply(this, arguments);

      var method =
        (init && init.method) || (input && input.method) || 'GET';
      method = String(method).toUpperCase();
      var headers = {};
      try {
        var src = (init && init.headers) || (input && input.headers);
        if (src) {
          if (typeof src.forEach === 'function') src.forEach(function (v, k) { headers[k] = v; });
          else for (var k in src) headers[k] = src[k];
        }
      } catch (e) {}

      var body = init && init.body !== undefined ? init.body : null;
      var resolved = bodyOf(body);
      if (resolved === 'unsupported') return origFetch.apply(this, arguments);

      return resolved.then(function (b) {
        return ask({
          method: method,
          url: new URL(raw, location.href).href,
          headers: headers,
          text: b && b.text ? b.text : null,
          bin: b && b.bin ? b.bin : null,
        });
      }).then(function (r) {
        var status = r.status | 0;
        if (status < 200 || status > 599) status = 200;
        var res = new Response(r.bin ? fromB64(r.bin) : null, {
          status: status,
          statusText: r.statusText || '',
          headers: r.headers || {},
        });
        return withUrl(res, new URL(raw, location.href).href);
      });
    };

    window[NS] = { ready: false, token: TOKEN, needs: needProxy };
  }

  // ------------------------------------------------------------ 扩展上下文侧

  var token = null;
  var bridgeAlive = false;
  var bridgeTried = false;
  var allowHosts = {};
  var running = false;
  var observer = null;
  var mounted = [];
  var stats = { proxied: 0, failed: 0, bytes: 0 };

  function installBridge() {
    if (bridgeTried) return;
    bridgeTried = true;
    token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var src = '(' + bridgeSource.toString() + ')()';
    src = src.replace(/__RFFP_TOKEN__/g, token).replace(/__RFFP_NS__/g, NS);
    var el = document.createElement('script');
    el.textContent = src;
    // document-start 时 head 可能还不存在。
    (document.documentElement || document).appendChild(el);
    el.remove();
    window.addEventListener('message', onMessage);
  }

  function pushCfg() {
    var hosts = Object.keys(allowHosts);
    post2page({ __rffp: 1, token: token, type: 'cfg', active: cfg.proxy, hosts: hosts, sameSite: true });
  }

  function post2page(msg) {
    try {
      window.postMessage(msg, '*');
    } catch (e) {}
  }

  function handshake() {
    return new Promise(function (resolve) {
      if (!bridgeTried) return resolve(false);
      var done = false;
      var on = function (ev) {
        var d = ev.data;
        if (done || !d || d.__rffp !== 1 || d.token !== token || d.type !== 'pong') return;
        done = true;
        window.removeEventListener('message', on);
        bridgeAlive = true;
        resolve(true);
      };
      window.addEventListener('message', on);
      post2page({ __rffp: 1, token: token, type: 'ping' });
      setTimeout(function () {
        if (done) return;
        done = true;
        window.removeEventListener('message', on);
        resolve(false);
      }, 900);
    });
  }

  function parseHeaders(raw) {
    var out = [];
    String(raw || '').split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    });
    return out;
  }

  function bytesToB64(u8) {
    var s = '';
    var CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  /**
   * 页面的 fetch 被改走后发来 req，这里代为取字节。安全边界：
   * 只认带本帧 token 的消息；只放行 http(s) 的 GET/HEAD；主机必须在
   * 「同站」或已发现的游戏主机名单里（页面里的脚本可以伪造请求，
   * 但不能借此读任意站点）。
   */
  function onMessage(ev) {
    var d = ev.data;
    if (!d || d.__rffp !== 1 || d.token !== token || d.type !== 'req') return;
    var url = String(d.url || '');
    var method = String(d.method || 'GET').toUpperCase();
    if (!/^https?:/i.test(url) || (method !== 'GET' && method !== 'HEAD')) {
      reply(d.id, { ok: false, error: 'rejected by userscript policy' });
      return;
    }
    var host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (e) {
      return reply(d.id, { ok: false, error: 'bad url' });
    }
    if (!allowHosts[host] && !(sameSite(host) || allowHosts['*'])) {
      return reply(d.id, { ok: false, error: 'host not allowed: ' + host });
    }
    var headers = {};
    var src = d.headers || {};
    Object.keys(src).forEach(function (k) {
      // 这几个头由扩展/浏览器决定，页面传过来会被拒绝或造成混乱。
      if (/^(host|origin|referer|cookie|user-agent|content-length|connection)$/i.test(k)) return;
      headers[k] = String(src[k]);
    });
    var data = null;
    if (d.text != null) data = d.text;
    else if (d.bin != null) {
      var bin = atob(d.bin);
      var u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      data = u.buffer;
    }
    GM_xmlhttpRequest({
      method: method,
      url: url,
      headers: headers,
      data: data,
      responseType: 'arraybuffer',
      timeout: 60000,
      anonymous: !sameSite(host),
      onload: function (r) {
        stats.proxied++;
        var bin = r.response == null ? null : new Uint8Array(r.response);
        stats.bytes += bin ? bin.byteLength : 0;
        reply(d.id, {
          ok: true,
          status: r.status,
          statusText: r.statusText,
          headers: parseHeaders(r.responseHeaders),
          bin: bin && bin.byteLength ? bytesToB64(bin) : null,
        });
      },
      onerror: function (r) {
        stats.failed++;
        reply(d.id, { ok: false, error: 'network error' + (r && r.status ? ' status=' + r.status : '') });
      },
      ontimeout: function () {
        stats.failed++;
        reply(d.id, { ok: false, error: 'timeout' });
      },
    });
  }

  function reply(id, msg) {
    msg.__rffp = 1;
    msg.token = token;
    msg.type = 'resp';
    msg.id = id;
    post2page(msg);
  }

  function sameSite(host) {
    function s(h) {
      h = String(h || '').toLowerCase();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h === 'localhost' || /^\[.*\]$/.test(h)) return h;
      var p = h.split('.');
      return p.length <= 2 ? h : p.slice(-2).join('.');
    }
    return s(host) === s(location.hostname);
  }

  // -------------------------------------------------------------- 注入 Ruffle

  var rufflePromise = null;

  /**
   * 依次尝试候选源。每轮注入前都必须先写好 config：Ruffle 会按 config.publicPath
   * （缺省时按自己 script 标签的 URL）去取同目录下的 core.ruffle.*.js 与 *.wasm，
   * 而 polyfill 是在 ruffle.js 求值后不久就开跑的，事后补设置来不及。
   */
  function loadRuffle() {
    if (rufflePromise) return rufflePromise;
    rufflePromise = new Promise(function (resolve, reject) {
      var bases = cfg.bases;
      var i = 0;
      function attempt(base) {
        preconfigure(base);
        var s = document.createElement('script');
        s.setAttribute('data-ruffle-runtime', base);
        s.src = base + 'ruffle.js';
        s.onload = function () {
          GM_setValue('ruffleBaseUsed', base);
          log('Ruffle 已就位：' + base);
          resolve(base);
        };
        s.onerror = function () {
          console.warn('[Ruffle免插件] 源不可用，换下一个：' + base);
          s.remove();
          if (++i >= bases.length) return reject(new Error('所有 Ruffle 源都加载失败（可在菜单里指定自建目录）'));
          attempt(bases[i]);
        };
        (document.head || document.documentElement).appendChild(s);
      }
      attempt(bases[0]);
    });
    return rufflePromise;
  }

  /** RufflePlayer.config 必须在 ruffle.js 求值前写好；键名以 0.6.0 真正读的那份为准。 */
  function preconfigure(base) {
    var stub = PAGE.RufflePlayer || (PAGE.RufflePlayer = {});
    stub.config = Object.assign(
      {
        publicPath: base,
        autoplay: cfg.autoplay,
        warnOnUnsupportedContent: false,
        showSwfDownload: false,
        splashScreen: false,
        letterbox: 'on',
        allowFullscreen: true,
        openUrlMode: GM_getValue('openUrl', 'sameTab'),
        upgradeToHttps: false,
        unmuteOverlay: 'hidden',
        scale: 'showAll',
        quality: 'high',
        logLevel: 'error',
        contextMenu: 'rightClickOnly',
        // allowScriptAccess 故意不写：Ruffle 会按影片 URL 自己判 same-domain。
        // 这里塞一个它不认的值（比如字符串）会把安全域整个弄坏，
        // 症状是影片画得出来、isPlaying 也为真，但鼠标点不动。
      },
      stub.config || {}
    );
    var maxFps = Number(GM_getValue('maxFrameRate', 0));
    if (maxFps > 0) stub.config.frameRate = maxFps; // 0.6.0 读的是 frameRate，不是 maxFrameRate
    // publicPath 跟着本次尝试的源走，不能被上一次的残留值盖掉。
    stub.config.publicPath = base;
    return stub.config;
  }

  // ------------------------------------------------------------ SWF 证据发现

  function isFlashEl(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'embed') {
      var t = (el.getAttribute('type') || '').toLowerCase();
      if (FLASH_MIME.indexOf(t) >= 0) return true;
      return /\.swf(\?|$)/i.test(stripUrl(el.getAttribute('src') || ''));
    }
    if (tag === 'object') {
      var cid = (el.getAttribute('classid') || '').toLowerCase();
      if (cid.indexOf(FLASH_CLASSID.replace('clsid:', '')) >= 0 || cid === FLASH_CLASSID) return true;
      var m = el.querySelector("param[name='movie'],param[name='MOVIE']");
      var movie = m ? m.value : '';
      return /\.swf(\?|$)/i.test(stripUrl(movie));
    }
    return false;
  }

  function stripUrl(u) {
    return String(u || '').split('#')[0].split('?')[0];
  }

  function elUrl(el) {
    if (!el) return '';
    if (el.tagName.toLowerCase() === 'object') {
      var m = el.querySelector("param[name='movie'],param[name='MOVIE']");
      if (m && m.value) return resolveUrl(m.value);
    }
    return resolveUrl(el.getAttribute('src') || '');
  }

  function resolveUrl(raw) {
    if (!raw) return '';
    var s = String(raw).trim();
    if (/^(blob|data|javascript|about):/i.test(s)) return '';
    // 4399 的 src 是 //s1.4399.com/... 或 /upload_swf/...，交给 URL 处理协议相对。
    if (/^https?:\/\//i.test(s) || s.charAt(0) === '/') {
      try {
        return new URL(s, location.href).href;
      } catch (e) {
        return '';
      }
    }
    try {
      return new URL(s, document.baseURI).href;
    } catch (e) {
      return '';
    }
  }

  /**
   * <object …>…<embed …></object> 是 Flash 时代给非 IE 准备的回退写法，插件只会
   * 实例化其中一个。Ruffle 的 polyfill 却会把 object 和它内部的 embed 各自换
   * 一遍：同一个游戏加载两次（实测多一整个 SWF 的流量），而且换出来的播放器
   * 落在 object 的回退内容里，输入事件不一定进得去（实测点击无反应）。
   *
   * 处理方向选的是「留 embed、把 object 变成普通容器」：站方脚本找播放器主要靠
   * document.embeds[0]（Replay / SetVariable / 全屏按钮都挂在它上面），而 Ruffle
   * 只把 ruffle-embed 计进 document.embeds，换成 ruffle-object 就查不到了。
   * object 的 id 挪到一个 div 上，getElementById 那条路也留着。
   */
  function unwrapNestedEmbeds() {
    var objs = document.querySelectorAll('object');
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i];
      if (!isFlashEl(o)) continue;
      var e = o.querySelector('embed');
      if (!e || !isFlashEl(e)) continue;

      // 内层 embed 缺的属性从外层补，保证换出来的播放器尺寸/参数和原来一致。
      if (!elUrl(e)) {
        var outer = elUrl(o);
        if (outer) e.setAttribute('src', outer);
      }
      ['width', 'height', 'flashvars', 'base', 'quality', 'wmode', 'allowfullscreen'].forEach(function (k) {
        if (!e.getAttribute(k) && o.getAttribute(k)) e.setAttribute(k, o.getAttribute(k));
      });
      if (!e.getAttribute('flashvars')) {
        var fv = o.querySelector("param[name='flashvars']");
        if (fv && fv.value) e.setAttribute('flashvars', fv.value);
      }

      var box = document.createElement('div');
      if (o.id) box.id = o.id;
      if (o.className) box.className = o.className;
      if (o.getAttribute('style')) box.setAttribute('style', o.getAttribute('style'));
      if (!box.id && !box.className && !box.getAttribute('style')) box.style.display = 'contents';
      o.parentNode.insertBefore(box, o);
      box.appendChild(e);
      o.remove();
      log('已合并 object 内嵌的 fallback embed，避免重复加载并保住 document.embeds');
    }
  }

  function scanElements() {
    unwrapNestedEmbeds();
    var out = [];
    var list = document.querySelectorAll('embed,object');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.dataset && el.dataset.rufflePolyfilled !== undefined) continue;
      if (!isFlashEl(el)) continue;
      var url = elUrl(el);
      // 站方脚本挂了时 webServer 是 undefined，src 会变成 ".../undefined/upload_swf/..."
      if (!url || /undefined|null/i.test(url)) url = '';
      out.push({ kind: 'element', el: el, url: url });
    }
    return out;
  }

  /** 站点变量：4399 用 _strGamePath + webServer，7k7k 用 gameInfo.gamePath。 */
  function scanGlobals() {
    var out = [];
    function push(v, base) {
      if (!v) return;
      var u = '';
      try {
        u = new URL(String(v), base || location.href).href;
      } catch (e) {
        return;
      }
      if (/\.swf(\?|$)/i.test(stripUrl(u))) out.push(u);
    }
    try {
      // 「基准 + 路径」两个变量拼出地址是所有老播放页的通用写法，不限定域名。
      var base = PAGE.webServer || PAGE.gameServer || PAGE.flashServer || PAGE._strGameServer || PAGE.baseURL || '';
      var path = PAGE._strGamePath || PAGE.game_url || PAGE.flashUrl || PAGE.swfUrl || PAGE.gamePath;
      if (base && path) push(joinUrl(base, path));
      // 4399 的 server.js 挂了时 webServer 是 undefined，用它的公开 CDN 兜底。
      else if (/4399\./i.test(location.hostname) && path) push(joinUrl('//s1.4399.com/4399swf', path));
      var gi = PAGE.gameInfo;
      if (gi) {
        push(gi.gamePath || gi.gameUrl || gi.swfUrl || gi.url);
        push(gi.gameSrc);
      }
      var fv = PAGE.flashvars;
      if (fv && typeof fv === 'string') {
        var mm = /(?:^|&)(?:url|file|swf)=(%2F|\/|https?%3A|https?:)([^&]*)/.exec(fv);
        if (mm) push(decodeURIComponent(mm[1] + mm[2]));
      }
      // 通用兜底：挂在 window 上的裸字符串变量（很多小站就是这么写的）。
      var names = Object.getOwnPropertyNames(PAGE);
      var checked = 0;
      for (var i = 0; i < names.length && out.length < 8 && checked < 4000; i++) {
        var n = names[i];
        if (/^(location|top|parent|self|frames|chrome|document|localStorage|sessionStorage|history|navigator|external|speechSynthesis|name|status|origin)$/.test(n)) continue;
        checked++;
        var v;
        try {
          v = PAGE[n];
        } catch (e) {
          continue; // getter 抛错的（跨域 frame 之类）直接跳过
        }
        if (typeof v === 'string' && v.length < 512 && /\.swf(\?|$)/i.test(stripUrl(v))) {
          push(v);
        }
      }
    } catch (e) {
      console.warn('[Ruffle免插件] 读站点变量失败', e);
    }
    return dedupe(out);
  }

  /** base 与 path 的斜杠不一定配得上，拼出 //host 会被当成协议相对地址。 */
  function joinUrl(base, path) {
    base = String(base);
    path = String(path);
    if (/\/$/.test(base) && /^\//.test(path)) return base + path.slice(1);
    if (!/\/$/.test(base) && !/^\//.test(path) && !/^https?:/i.test(path)) return base + '/' + path;
    return base + path;
  }


  /** 行内脚本 / 属性里的 .swf 字面量：给没有 embed 的老页面用。 */
  function scanMarkup() {
    var out = [];
    var budget = 2 * 1024 * 1024;
    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length && budget > 0; i++) {
      var txt = scripts[i].textContent || '';
      budget -= txt.length;
      var re = /["'`]([^"'`\s<>]{0,500}?\.swf(?:\?[^"'`\s<>]*)?)["'`]/gi;
      var m;
      while ((m = re.exec(txt)) && out.length < 12) {
        var raw = m[1];
        // 形如 "'+webServer+str1+'" 的拼接片段没有意义，丢掉。
        if (/\+|\{|\}|%22/.test(raw)) continue;
        var u = resolveUrl(raw);
        if (u) out.push(u);
      }
    }
    var attrs = document.querySelectorAll('[src],[href],[data-src],[data-url],[data-file]');
    for (var j = 0; j < attrs.length && out.length < 16; j++) {
      var v = attrs[j].getAttribute('src') || attrs[j].getAttribute('href') || attrs[j].getAttribute('data-src') || attrs[j].getAttribute('data-url') || attrs[j].getAttribute('data-file') || '';
      if (/\.swf(\?|$)/i.test(stripUrl(v))) {
        var uu = resolveUrl(v);
        if (uu) out.push(uu);
      }
    }
    return out;
  }

  function dedupe(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!u || seen[u]) continue;
      seen[u] = 1;
      out.push(u);
    }
    return out;
  }

  function collect() {
    var els = scanElements();
    var urls = [];
    els.forEach(function (e) {
      if (e.url) urls.push(e.url);
    });
    var g = scanGlobals();
    var mk = scanMarkup();
    return {
      elements: els,
      urls: dedupe(urls.concat(g, mk)),
      fromGlobals: dedupe(g.concat(mk)),
    };
  }

  // ----------------------------------------------------------------- 挂载

  function gameBox() {
    var sel = ['#swfdiv', '#game', '#flashs', '#flashcontent', '#divgame', '#gamecontent', '.game-play', '#Game', '[id*=flash]', '[class*=flash]'];
    for (var i = 0; i < sel.length; i++) {
      try {
        var n = document.querySelector(sel[i]);
        if (n && n !== document.body) return n;
      } catch (e) {}
    }
    return null;
  }

  /** 站点给的尺寸：4399 是 _w/_h，其它站常见 500x384 之类。 */
  function gameSize() {
    var w = Number(PAGE._w || PAGE.gameWidth || 0);
    var h = Number(PAGE._h || PAGE.gameHeight || 0);
    if (w > 40 && h > 40) return { w: w, h: h };
    return { w: 0, h: 0 };
  }

  function mountEmbed(url, opts) {
    var box = (opts && opts.box) || gameBox() || document.body;
    var size = gameSize();
    var embed = document.createElement('embed');
    embed.setAttribute('type', FLASH_MIME[0]);
    embed.setAttribute('src', url);
    embed.setAttribute('width', String((opts && opts.w) || size.w || 640));
    embed.setAttribute('height', String((opts && opts.h) || size.h || 480));
    embed.setAttribute('quality', 'high');
    embed.setAttribute('allowScriptAccess', 'sameDomain');
    embed.setAttribute('allowFullScreen', 'true');
    embed.setAttribute('data-ruffle-mount', '1');
    if (opts && opts.id) embed.id = opts.id;
    if (box === document.body) {
      embed.className = 'rffp-center';
      var wrap = document.createElement('div');
      wrap.className = 'rffp-stage';
      wrap.appendChild(embed);
      box.appendChild(wrap);
    } else {
      box.appendChild(embed);
    }
    return embed;
  }

  /** iframe 指向 .swf 的情况（7k7k 的老游戏）：iframe 里只会是下载/空白，换成 embed。 */
  function repairIframes(urls) {
    var frames = document.querySelectorAll('iframe[src],frame[src]');
    for (var i = 0; i < frames.length; i++) {
      var src = resolveUrl(frames[i].getAttribute('src'));
      if (!/\.swf(\?|$)/i.test(stripUrl(src))) continue;
      var embed = document.createElement('embed');
      embed.setAttribute('type', FLASH_MIME[0]);
      embed.setAttribute('src', src);
      embed.setAttribute('width', String(frames[i].getAttribute('width') || frames[i].clientWidth || 550));
      embed.setAttribute('height', String(frames[i].getAttribute('height') || frames[i].clientHeight || 400));
      embed.setAttribute('data-ruffle-mount', '1');
      frames[i].replaceWith(embed);
      mounted.push({ el: embed, url: src });
      log('iframe 指向 SWF，已替换为 embed：' + src);
    }
  }

  // ------------------------------------------------------------------ 主流程

  var cfg = conf();

  function log(msg) {
    console.log('[Ruffle免插件] ' + msg);
  }

  function setStatus(text, bad) {
    var el = document.getElementById('rffp-badge-msg');
    if (el) el.textContent = text;
    var b = document.getElementById('rffp-badge');
    if (b) b.classList.toggle('rffp-bad', !!bad);
    if (text) (bad ? console.warn : console.log).call(console, '[Ruffle免插件] ' + text);
  }

  /**
   * 一条路径：
   *  - 页面上本来就有 embed/object → 什么都不做，交给 Ruffle 自己的 polyfill 替换
   *    （它会带上 flashvars / base / 尺寸，还会修补 document.embeds，站方
   *    的 Replay()、全屏按钮仍可寻址到播放器）。
   *  - 只有站点变量（页面已经没有任何 Flash 容器）→ 我们自己插一个 embed。
   * 代理不可用时（CSP 拦住注入、或者管理器没有 GM 权限），改成用
   * GM_xmlhttpRequest 预取 SWF 换成 blob: URL，并把 base 指回原地址。
   */
  function activate(reason) {
    if (running) return;
    running = true;
    if (observer) observer.disconnect(); // 一旦启动就别再跟着 DOM 变化跑了
    document.documentElement.classList.add('rffp-on');
    var found = collect();
    var urls = found.urls;
    if (!urls.length && !found.elements.length) {
      running = false;
      return;
    }
    log('发现 Flash 内容（' + reason + '）：' + urls.slice(0, 4).join(' , '));
    document.documentElement.classList.add('rffp-on');
    urls.forEach(function (u) {
      try {
        allowHosts[new URL(u).hostname.toLowerCase()] = 1;
      } catch (e) {}
    });
    try {
      allowHosts[location.hostname.toLowerCase()] = 1;
    } catch (e) {}

    installBridge();
    pushCfg();
    handshake().then(function (alive) {
      if (!alive && cfg.proxy) {
        setStatus('页面上下文桥未响应（可能被 CSP 拦截），改用预取模式');
        return prefetchAndRewrite(found).then(function () {
          return startWithRuffle(found, true);
        });
      }
      return startWithRuffle(found, false);
    }).catch(function (e) {
      setStatus('启动失败：' + e.message, true);
    });
  }

  function startWithRuffle(found, prefetched) {
    repairIframes(found.urls);
    var els = scanElements();
    if (!els.length) {
      if (!found.urls.length) {
        setStatus('没有可播放的 SWF 地址', true);
        return Promise.resolve();
      }
      var target = pickPrimary(found.urls, found.fromGlobals);
      mountEmbed(target, {});
      log('页面无 embed，已挂载：' + target);
    } else if (!prefetched) {
      // 站方脚本没跑完时 src 里会留 undefined 之类的坏值，从站点变量补全。
      els.forEach(function (item) {
        if (item.url || !found.urls.length) return;
        var fixed = pickPrimary(found.urls, found.fromGlobals);
        if (fixed && item.el) {
          item.el.setAttribute('src', fixed);
          log('修正缺失的 embed src → ' + fixed);
        }
      });
    }
    return loadRuffle().then(function (base) {
      // polyfill 与 config 都在 ruffle.js 求值前就绪（见 loadRuffle），这里只负责观察结果。
      ensurePolyfillRan();
      startSaveFlusher();
      setStatus('已启用免插件播放 · 源 ' + base);
    }).catch(function (e) {
      setStatus(e.message, true);
    });
  }

  function pickPrimary(urls, globals) {
    // 优先同站的、出现在站点变量里的地址。
    var pref = globals || [];
    for (var i = 0; i < pref.length; i++) {
      try {
        if (sameSite(new URL(pref[i]).hostname) && /\.swf$/i.test(stripUrl(pref[i]))) return pref[i];
      } catch (e) {}
    }
    for (var j = 0; j < urls.length; j++) if (/\.swf$/i.test(stripUrl(urls[j]))) return urls[j];
    return urls[0];
  }

  /**
   * Ruffle 的 polyfill 只有在「navigator 里没有 Shockwave Flash 插件，或其
   * filename 恰为 ruffle.js」时才接管替换；有的站点早期已写入假插件对象会挡住它。
   * 真遇到了就用官方 createPlayer() 自己接管一次。
   */
  function ensurePolyfillRan() {
    setTimeout(function () {
      var els = document.querySelectorAll('embed[data-ruffle-mount],embed[type="' + FLASH_MIME[0] + '"]');
      var stuck = [];
      for (var i = 0; i < els.length; i++) if (!els[i].dataset.rufflePolyfilled) stuck.push(els[i]);
      if (!stuck.length) {
        // polyfill 正常干活：等它把播放器挂出来。
        waitForPlayer();
        return;
      }
      var player = PAGE.RufflePlayer && PAGE.RufflePlayer.newest && PAGE.RufflePlayer.newest();
      if (!player || !player.createPlayer) {
        setStatus('Ruffle 未能接管 embed，请查看控制台', true);
        return;
      }
      stuck.forEach(function (el) {
        var p = player.createPlayer();
        p.setAttribute('width', el.getAttribute('width') || '100%');
        p.setAttribute('height', el.getAttribute('height') || '100%');
        p.style.width = '100%';
        p.style.height = '100%';
        if (el.id) p.id = el.id;
        el.replaceWith(p);
        var opts = { url: elUrl(el) || el.getAttribute('src'), autoplay: cfg.autoplay };
        var fv = el.getAttribute('flashvars');
        if (fv) opts.parameters = fv.split('&').reduce(function (a, kv) {
          var i = kv.indexOf('=');
          if (i > 0) a[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
          return a;
        }, {});
        p.ruffle().load(opts).catch(function (e) {
          setStatus('载入失败：' + (e && e.message ? e.message : e), true);
        });
      });
      waitForPlayer();
    }, 600);
  }

  function waitForPlayer() {
    var end = Date.now() + 10000;
    (function poll() {
      var p = document.querySelector('ruffle-player,ruffle-embed,ruffle-object');
      if (p) {
        mounted.push({ player: p });
        setStatus('播放器已挂载' + (cfg.proxy ? ' · 代理 ' + stats.proxied + ' 次' : ' · 预取模式'));
        return;
      }
      if (Date.now() > end) return setStatus('等待播放器超时', true);
      setTimeout(poll, 200);
    })();
  }

  /** 预取模式：没有代理能力时，把 SWF 变成 blob: URL，base 指回原始地址。 */
  function prefetchAndRewrite(found) {
    var jobs = [];
    found.elements.forEach(function (item) {
      if (!item.url || !item.el) return;
      jobs.push(fetchAsUrl(item.url).then(function (blobUrl) {
        var el = item.el;
        if (!el.getAttribute('base')) el.setAttribute('base', dirname(item.url));
        if (el.tagName.toLowerCase() === 'embed') {
          el.setAttribute('type', FLASH_MIME[0]);
          el.setAttribute('src', blobUrl);
        } else {
          var m = el.querySelector("param[name='movie'],param[name='MOVIE']");
          if (m) m.value = blobUrl;
          el.setAttribute('data', blobUrl);
        }
      }));
    });
    if (!found.elements.length && found.urls.length) {
      jobs.push(
        fetchAsUrl(found.urls[0]).then(function (blobUrl) {
          var el = mountEmbed(blobUrl, {});
          el.setAttribute('base', dirname(found.urls[0]));
        })
      );
    }
    return Promise.all(jobs).catch(function (e) {
      setStatus('预取 SWF 失败：' + e.message, true);
    });
  }

  function dirname(url) {
    return url.replace(/[^/]*$/, '');
  }

  function fetchAsUrl(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        timeout: 60000,
        onload: function (r) {
          if (r.status >= 400) return reject(new Error('HTTP ' + r.status));
          var type = 'application/octet-stream';
          String(r.responseHeaders || '').split(/\r?\n/).forEach(function (l) {
            if (/^content-type:/i.test(l)) type = l.split(':').slice(1).join(':').trim();
          });
          resolve(URL.createObjectURL(new Blob([r.response], { type: type })));
        },
        onerror: function () { reject(new Error('网络错误')); },
        ontimeout: function () { reject(new Error('超时')); },
      });
    });
  }

  // ------------------------------------------------------- 存档落盘（沿用本项目经验）

  /**
   * Ruffle 把 Flash 的 SharedObject 存在 localStorage，但只在实例销毁和
   * pagehide 时落盘。游戏站不会给「离开前确认」的机会，刷新就丢进度，
   * 所以周期性派发一个合成 pagehide 促它保存，并挡住自己的监听回环。
   */
  var syntheticPagehide = false;
  var flushTimer = null;

  function flushSaves() {
    var p = document.querySelector('ruffle-player,ruffle-embed,ruffle-object');
    if (!p || !p.ruffle || !p.ruffle()) return false;
    syntheticPagehide = true;
    try {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    } catch (e) {
      try {
        window.dispatchEvent(new Event('pagehide'));
      } catch (e2) {}
    }
    syntheticPagehide = false;
    return true;
  }

  function startSaveFlusher() {
    if (flushTimer || !GM_getValue('flushSaves', true)) return;
    flushTimer = setInterval(function () {
      if (document.hidden) return;
      flushSaves();
    }, SAVE_FLUSH_MS);
    window.addEventListener('pagehide', function () {
      if (syntheticPagehide) return;
      flushSaves();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flushSaves();
    });
  }

  // ------------------------------------------------------------------- UI

  function style() {
    GM_addStyle(
      [
        '.rffp-stage{display:flex;justify-content:center;align-items:center;min-height:200px;background:#000;}',
        '.rffp-center{display:block;max-width:100%;}',
        'ruffle-player,ruffle-embed,ruffle-object{display:block;}',
        '#rffp-badge{position:fixed;right:10px;bottom:10px;z-index:2147483646;font:12px/1.5 system-ui,sans-serif;',
        '  color:#dfe7ff;background:rgba(15,19,32,.86);border:1px solid #2b3556;border-radius:8px;padding:5px 9px;',
        '  max-width:52vw;display:flex;gap:8px;align-items:center;}',
        '#rffp-badge.rffp-bad{border-color:#8a2b2b;color:#ffd9d9;}',
        '#rffp-badge button{font:inherit;color:inherit;background:#243056;border:1px solid #3a4a7a;border-radius:6px;',
        '  padding:1px 6px;cursor:pointer;}',
        ':fullscreen #rffp-badge{display:none;}',
        // 站方的「加载中 / 装 Flash」提示层在插件缺失时永远不会自己收起，
        // 会盖在播放器上面。只在确实接管了页面之后隐藏，避免误伤正常布局。
        '.rffp-on #loadingdiv,.rffp-on #addiv,.rffp-on #flashNotice,.rffp-on .flash-tip{display:none!important;}',
      ].join('')
    );
  }

  function badge() {
    if (document.getElementById('rffp-badge')) return;
    var el = document.createElement('div');
    el.id = 'rffp-badge';
    el.innerHTML =
      '<span id="rffp-badge-msg">正在检测 Flash 内容…</span>' +
      '<button id="rffp-hide" title="在本域停用并刷新">停用</button>';
    (document.body || document.documentElement).appendChild(el);
    el.addEventListener('click', function (ev) {
      if (ev.target && ev.target.id === 'rffp-hide') {
        toggleDisabled('site:' + location.hostname);
        location.reload();
      }
    });
    // 20 秒内没有任何 SWF 证据就别把角标留在页面上碍眼。
    setTimeout(function () {
      if (!mounted.length && el.parentNode) el.remove();
    }, 20000);
  }

  function menus() {
    GM_registerMenuCommand('本域启用/免插件播放', function () {
      var on = toggleDisabled('site:' + location.hostname);
      alert(on ? '已在本域启用，刷新页面生效。' : '已在本域停用，刷新页面生效。');
    });
    GM_registerMenuCommand('跨域代理 开/关', function () {
      var on = toggleDisabled('proxy:' + location.hostname);
      alert(on ? '代理已开启（刷新生效）。' : '代理已关闭，将改用预取模式（刷新生效）。');
    });
    GM_registerMenuCommand('放宽代理范围（本站全部跨域请求）', function () {
      var on = toggleProxyAll();
      if (on) allowHosts['*'] = 1;
      else delete allowHosts['*'];
      pushCfg();
      alert(on
        ? '已放宽：本站发起的跨域请求都会经扩展代发（刷新生效）。仅在你信任该站点时使用。'
        : '已恢复严格范围：只代发游戏主机与同站主机。');
    });
    GM_registerMenuCommand('指定 .swf 地址播放', function () {
      var u = prompt('输入要播放的 SWF 地址（可用相对路径）：');
      if (!u) return;
      var abs = resolveUrl(u);
      if (!abs) return alert('地址无法解析');
      running = true;
      if (observer) observer.disconnect();
      allowHosts[new URL(abs).hostname.toLowerCase()] = 1;
      installBridge();
      pushCfg();
      handshake().then(function (alive) {
        var go = alive || !cfg.proxy
          ? Promise.resolve(mountEmbed(abs, {}))
          : fetchAsUrl(abs).then(function (blobUrl) {
              var el = mountEmbed(blobUrl, {});
              el.setAttribute('base', dirname(abs));
              return el;
            });
        return go.then(function () {
          return loadRuffle();
        }).then(function () {
          ensurePolyfillRan();
          startSaveFlusher();
        });
      });
    });
    GM_registerMenuCommand('设置 Ruffle 来源（留空用 CDN）', function () {
      var v = prompt('Ruffle 目录地址，需以 / 结尾。留空恢复默认。\n例：https://cdn.example.com/ruffle/', GM_getValue('ruffleBase', ''));
      if (v === null) return;
      GM_setValue('ruffleBase', v.trim());
      cfg = conf();
      alert(v.trim() ? '已保存，刷新页面生效。' : '已恢复默认 CDN。');
    });
    GM_registerMenuCommand('诊断信息', function () {
      alert(
        'Ruffle 版本：' + cfg.version + '\n' +
        '实际来源：' + (GM_getValue('ruffleBaseUsed', '（未加载）')) + '\n' +
        '代理：' + (cfg.proxy ? '开' : '关') + '，页面桥：' + (bridgeAlive ? '已连通' : '未连通') + '\n' +
        '已代理请求：' + stats.proxied + ' 次 / 失败 ' + stats.failed + ' 次 / ' + Math.round(stats.bytes / 1024) + ' KB\n' +
        '放行主机：' + (Object.keys(allowHosts).join(', ') || '（无）') + '\n' +
        '已挂载：' + mounted.length + ' 个'
      );
    });
  }

  // ------------------------------------------------------------------ 启动

  /**
   * @run-at document-start 的脚本有可能在 <html> 被解析出来之前就跑到了，
   * 那时 document.documentElement 还是 null，appendChild/observe 都会抛。
   * 所以整个启动流程都等它出现（用 document 上的观察器等第一棵树出来，
   * 再加一个 readystate 兜底）。
   */
  function whenRoot(fn) {
    if (document.documentElement) return fn();
    var done = false;
    function go() {
      if (done || !document.documentElement) return;
      done = true;
      try { obs.disconnect(); } catch (e) {}
      fn();
    }
    var obs = new MutationObserver(go);
    obs.observe(document, { childList: true });
    document.addEventListener('readystatechange', go);
    document.addEventListener('DOMContentLoaded', go);
    setTimeout(go, 50);
  }

  function boot() {
    style();
    menus();
    if (!cfg.enabled) {
      log('本域已停用（菜单可重新启用）。');
      return;
    }
    if (window.top !== window && !GM_getValue('inFrames', true)) return;
    if (proxyAllOn()) allowHosts['*'] = 1;

    badge();

    // document-start 时 4399 的 embed 还要等一会儿才被 document.write 出来，
    // 所以既要扫一遍现有的，也要盯着 DOM 变化；一旦启动成功就撤掉观察器。
    observer = new MutationObserver(function () {
      if (running) return;
      if (scanElements().length) activate('DOM 中出现 embed/object');
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    function sweep(reason) {
      if (running) return;
      var found = collect();
      if (found.elements.length) return activate('已存在 Flash 元素（' + reason + '）');
      if (found.urls.length) return activate('站点变量/脚本里有 SWF（' + reason + '）');
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { sweep('DOM ready'); });
    } else {
      sweep('已经是交互态');
    }
    window.addEventListener('load', function () {
      sweep('window load');
      // 站点变量比 DOM 更晚才有的页面（先拉 json 再写 embed），给一次宽限期。
      setTimeout(function () {
        sweep('延迟复查');
        if (!running) {
          var b = document.getElementById('rffp-badge');
          if (b) b.remove();
          if (observer) observer.disconnect();
        }
      }, 4000);
    });
  }

  whenRoot(boot);
})();
