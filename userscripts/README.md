# Flash 免插件游玩（Ruffle 播放器）

一个油猴脚本：在 4399、7k7k 一类 Flash 小游戏页面上，直接用 [Ruffle](https://ruffle.rs)（WebAssembly 写的 Flash 播放器）把页面上的 SWF 播出来，**不需要安装任何 Flash 插件**。

文件：[`flash-free-ruffle.user.js`](./flash-free-ruffle.user.js)（版本 1.0.0，MIT）。

思路和本仓库的「龙卷风牧场」页面一样——SWF 由自托管的 Ruffle 播放；区别是这里不改动网站，只在浏览器里接管页面。

---

## 安装

1. 先装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome/Edge 用商店版；Firefox 需在 `about:addons` 里额外打开「工具或扩展」→「允许运行用户脚本」）。
2. Chrome/Edge 还要在 `chrome://extensions` → Tampermonkey「详情」里打开**「允许用户脚本」**，否则脚本装了也不运行。
3. 点 Tampermonkey 图标 → 「添加脚本」→ 删掉编辑器里的模板内容，把 `flash-free-ruffle.user.js` 全文粘进去 → `Ctrl+S` 保存。
   （也可以在「实用工具」标签页里用「从文件导入」。）
4. 打开一个受支持站点的游戏页，右下角会出现角标，显示「已启用免插件播放 · 源 …」。

## 支持的站点

`@match` 里已覆盖：`4399.com`、`4399.cn`、`3304399.net`、`i3839.com`、`7k7k.com`、`7k7kjs.cn`、`7k7kimg.cn`、`2144.com`、`17173.com`。

加别的站点，在脚本头部补两行即可：

```js
// @match        *://*.例子.com/*
// @connect      swf.例子.com     // SWF 所在的域名，@connect * 已经放行，写了更明确
```

## 它做了什么

- **加载 Ruffle**：默认按 `unpkg → cdn.jsdelivr → fastly.jsdelivr → testingcf.jsdelivr` 顺序取 `@ruffle-rs/ruffle@0.6.0`，任一源失败自动换下一个。`publicPath` 跟着实际用的源走，所以 wasm 和分块文件不会 404。
- **让 Ruffle 自己接管页面**：不新建播放器，而是让 Ruffle 的 polyfill 把站点的 `<object>`/`<embed>` 换成 `ruffle-object`/`ruffle-embed`。这样 `flashvars`、`base`、宽高、元素 id 全部保留，站点自己的工具条脚本靠 `document.embeds`、`getElementById('flashgame')` 仍然找得到播放器。
  - 站点常见的「`<object>` 里再套一个 `<embed>`」会让 SWF 被取两次、并挂出两个播放器实例，脚本会先把内层 `<embed>` 提出来（属性照搬），只留一个实例。
- **跨域代理**：游戏 CDN 取 `.swf` 一般不返回 `Access-Control-Allow-Origin`，Ruffle 用 `fetch` 取不到。脚本在页面里改写了 `window.fetch`，把这类请求转给扩展上下文，用 `GM_xmlhttpRequest` 取回字节再交回去。
  - 只代发 **GET/HEAD**，范围限于「游戏主机 + 同站主机」；扩展侧会再校验一遍主机白名单。
  - 合成的响应会补回真实的 `response.url`——Ruffle 用它判定影片的安全域，留空串会让影片画得出来但鼠标点不动。
  - 页面有 CSP 挡住注入、代理拿不到响应时，退回「预取 blob」模式：先整份取回 SWF 再交给 Ruffle，并把 `base` 指回 SWF 原目录，好让片内的相对路径仍能解析。这种模式下片内**绝对地址**的跨域资源照样取不到。
- **按站点变量挂载**：有些页面里根本没有 `<embed>`（站点脚本没跑起来，或只留了一句「请安装 Flash」）。脚本会读常见的全局变量（4399 的 `webServer` + `_strGamePath`、7k7k 的 `gamePath`/`gameUrl`/`swfUrl`、`flashvars.url` 等），再兜底扫一遍全局对象里的 `.swf` 字符串，自己把播放器挂到 `#swfdiv`/`#game`/`#flashs` 这类容器里，尺寸取 `_w`/`_h`。
- **存档**：Ruffle 把 SharedObject 写进 `localStorage`，但只在 `pagehide` 时落盘。脚本每 3 秒合成一次 `pagehide` 促它保存，刷新/关页不至于丢进度。
- **子框架**：游戏页常被套在 iframe 里，脚本默认在框架内也运行（`inFrames`）。

## 菜单项

点 Tampermonkey 图标，在弹出菜单里：

| 菜单 | 作用 |
| --- | --- |
| 本域启用/免插件播放 | 在当前域名整体开关脚本，切换后刷新生效 |
| 跨域代理 开/关 | 关掉后不再代发请求，改用预取 blob 模式 |
| 放宽代理范围（本站全部跨域请求） | **默认关**。打开后代发本站发起的全部跨域 GET/HEAD，只代发游戏主机看不到某些资源时才需要，且只在你信任该站点时用 |
| 指定 .swf 地址播放 | 页面里找不到 SWF 证据时，手动填地址（支持相对路径）挂载 |
| 设置 Ruffle 来源（留空用 CDN） | 填自建目录，必须以 `/` 结尾；留空恢复走 CDN |
| 诊断信息 | 实际用的源、桥是否连通、代理了多少请求/字节、放行主机、挂载了几个播放器 |

右下角角标上的「停用」按钮等价于「本域启用/免插件播放」的关闭 + 刷新。20 秒内没发现任何 SWF 证据，角标会自己消失。

## 自建 Ruffle 来源

CDN 不稳或内网环境时，把 Ruffle 的发布目录整个传到自己服务器上，然后在菜单「设置 Ruffle 来源」里填目录地址（带结尾 `/`）。这些文件必须在同一目录下：`ruffle.js`、`core.ruffle.<hash>.js`、`<hash>.wasm`（本仓库 `public/ruffle/` 里是一对 SIMD 内核，hash 随版本变，整目录搬过去就行；`copy-ruffle.mjs` 会自动跳过 Ruffle 附带的 vanilla 兜底对——现代浏览器用不到，别单独拷一半）。

本仓库 `public/ruffle/` 就是一份可用的自托管副本（`npm run prebuild` 从 npm 包 `@ruffle-rs/ruffle` 拷出来）。换 Ruffle 版本时，改脚本里 `conf()` 读的默认值 `ruffleVersion`（现为 `0.6.0`），否则 CDN 路径仍指向旧版本。

## 已知限制

- **Ruffle 不是 100% 兼容 Flash。** AS1/AS2 支持较好，AS3 覆盖度还在推进；个别游戏会黑屏、卡在第一屏、声音不对或某个按钮失效。这不是脚本能修的，只能等 Ruffle 上游。
- **存档是本机的。** SharedObject 落到当前浏览器的 `localStorage`，不会同步回站点服务器，所以排行榜、云存档、跨设备进度这些一律没有；清浏览器数据等于删档。
- **站点工具条可能失效。** 依赖 `FSCommand`/`ExternalInterface` 与页面通信的功能（暂停上报、广告计时、道具栏）在 Ruffle 上行为不一致；脚本已尽量保留元素 id 和 `document.embeds`，但不保证站方脚本逻辑照旧。
- **防盗链。** 有些 CDN 校验 `Referer`/签名，扩展代发时 `anonymous` 模式不带 Cookie，可能直接 403。这种页面只能靠「指定 .swf 地址播放」手动喂。
- **只作用于 http/https 页面。** `@match` 没写 `file://`，直接把 HTML 拖进浏览器打开时脚本不会运行。
- 脚本靠 `GM_xmlhttpRequest`、`unsafeWindow` 等能力，**必须保留头部的 `@grant` 列表**；被某些管理器剥掉 GM 接口时，会退化成「能挂播放器但取不到跨域 SWF」。

## 自动化测试

```
npm run test:userscript:smoke
```

脚本会起两个本地 HTTP 服务（一个仿 4399 播放页，一个只出 SWF 且**不带任何 CORS 头**），用无头 Edge + CDP 注入 GM 环境和被测脚本，跑 20 条断言：是否挂载、是否只挂一个实例、SWF 是否经代理取回且字节数一致、站方脚本能否寻址到播放器、画面是否真渲染、**点「开始游戏」后是否换屏**（验证输入经 Shadow DOM 和代理链路进了游戏）、代理响应有没有带真实 url、存档落盘有没有被促发，以及没有任何 embed 的第二种页面能否靠站点变量自己挂起来。截图与结果在 `.tmp/rffp-smoke/`。

它**不覆盖**真实站点的行为（页面结构、防盗链、站点自己的播放器脚本），那部分只能拿真页面验。
