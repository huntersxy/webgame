import { execFileSync } from 'node:child_process';
import { constants as zlibConstants } from 'node:zlib';
import { defineConfig } from 'vite';
import { compression } from 'vite-plugin-compression2';
import { VitePWA } from 'vite-plugin-pwa';

// Rapfi 多线程 WASM 引擎依赖 SharedArrayBuffer，浏览器要求页面处于
// cross-origin isolated 状态（服务器必须返回这两个响应头）。
// 生产环境由 nginx 配置同样的头（见 README 部署一节）。
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * 引擎资产目录（含 WASM、权重、开局库，合计约 27MB）。
 *
 * 这些文件**不进 Service Worker 预缓存清单**——否则首次安装就要拉 27MB，
 * 而且多数访客只玩其中一两款。改为运行时 CacheFirst：玩家真正用到的引擎
 * 第一次加载后即落盘，之后断网也能开局。
 */
const ENGINE_DIRS = ['rapfi', 'go', 'xqnn', 'xqwlight', 'egaroucid'];

/** 运行时缓存的 URL 匹配（不锚定行首，兼容部署到子目录的情况） */
const engineAssetPattern = new RegExp(`/(${ENGINE_DIRS.join('|')})/`);

/**
 * 不值得再压一遍的文件。
 *
 * 注意 **不要** 把 `.wasm` 加进来——实测 Rapfi / Egaroucid / TF.js 的 wasm 用 brotli
 * 能压掉 47%~76%（rapfi-single.wasm 1192KB → 291KB），而它们在引擎首次加载的
 * 关键路径上，是收益最大的一类。
 *
 * 真正该跳过的是「压了几乎不省」和「本来就已压缩」的：
 *   · `.data`（Rapfi NNUE 权重 9.7MB）实测只省 4%
 *   · `.onnx`（象棋权重 8.5MB）实测只省 7%
 *   · 图片 / 音视频 / woff2 / 已有的 .br·.gz —— 都是已压缩格式
 *   · `.map` —— sourcemap 只在开 devtools 时才拉，不值得付构建时间
 */
const NOT_WORTH_COMPRESSING = /\.(png|jpe?g|gif|webp|avif|ico|m4a|mp3|ogg|woff2?|data|onnx|br|gz|zst|map)$/i;

/**
 * 构建标识，写进 Service Worker 的注册 URL（`/sw.js?v=<id>`）。
 *
 * 为什么光靠 `Cache-Control: no-cache` 还不够：现代浏览器在更新检查时确实会绕过
 * HTTP 缓存，但如果站点前面挂了 CDN / 反代，而它无视 Cache-Control 缓存了
 * `sw.js`，访客就会一直拿到旧脚本、永远卡在旧版本。把版本写进 URL 是唯一
 * 不依赖中间层配合的办法——版本一变 URL 就变，缓存键必然不同。
 *
 * 取 git 短 SHA 而不是时间戳：同一次提交重复构建得到同一个 id，构建可复现；
 * 本地有未提交改动时带 `-dirty` 后缀，免得改了 SW 相关代码却共用旧 URL。
 */
function resolveBuildId(): string {
  const fromCi = process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA;
  if (fromCi) return fromCi.slice(0, 8);
  const git = (args: string[]): string =>
    execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const sha = git(['rev-parse', '--short=8', 'HEAD']);
    return git(['status', '--porcelain']).length > 0 ? `${sha}-dirty` : sha;
  } catch {
    // 不在 git 仓库里（如源码包解压后构建）时退化为时间戳
    return Date.now().toString(36);
  }
}

const BUILD_ID = resolveBuildId();

export default defineConfig({
  // 供 src/pwa.ts 拼 Service Worker 的版本化 URL
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // Oxc 压缩器（Rust 实现），比 esbuild 更快且压缩率略好
    minify: 'oxc',
  },
  worker: {
    format: 'es',
  },
  plugins: [
    // ── 预压缩（两档，因为 wasm 的性价比拐点明显更低）────────────────────
    // 产物同时带 .br 与 .gz：nginx 用 brotli_static / gzip_static 直接下发，
    // 省掉每次请求的运行时压缩；没有 brotli 模块的环境还能退回 gzip。

    // ① 代码与小文本：brotli q=11。文件小、收益大（510KB 的 JS 块 → 58KB），
    //    慢一点也完全值得。
    compression({
      include: /\.(html|xml|css|json|js|mjs|svg|yaml|yml|toml)$/i,
      algorithms: [
        ['brotliCompress', { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }],
        ['gzip', { level: 9 }],
      ],
      threshold: 1024,
      exclude: NOT_WORTH_COMPRESSING,
      skipIfLargerOrEqual: true,
    }),

    // ② WASM：brotli q=9。实测 q=11 相对 q=9 只多省 3~7 个百分点，却要多花
    //    十几秒构建时间（egar.wasm 单文件 q=11 要 4.1s、q=9 只要 0.27s），
    //    而 wasm 压缩本身是收益最大的一类（rapfi-single.wasm 1192KB → 286KB）。
    compression({
      include: /\.wasm$/i,
      algorithms: [
        ['brotliCompress', { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } }],
        ['gzip', { level: 9 }],
      ],
      threshold: 1024,
      skipIfLargerOrEqual: true,
    }),
    VitePWA({
      strategies: 'generateSW',
      // 注册由 src/pwa.ts 负责（要带版本化 URL），这里别注入任何东西。
      // registerType 仍需设成 prompt：它决定生成的 sw.js 不自动 skipWaiting，
      // 而是等页面发 SKIP_WAITING 消息——对局中途被刷新会毁掉一盘棋。
      registerType: 'prompt',
      injectRegister: null,
      manifestFilename: 'manifest.webmanifest',
      // 不用 includeAssets：它是相对 public/ 解析的，够不到 src/assets/ 里带哈希的
      // 构建产物（恶魔头像就在那儿）；而 public/ 下的图标已被上面的 png glob 覆盖。
      manifest: {
        id: '/',
        name: '汐兮雨的小鱼池',
        short_name: '小鱼池',
        description: '免注册、无广告、可离线运行的网页游戏平台：五子棋、围棋、中国象棋、黑白棋、军棋与休闲小游戏，AI 全部在浏览器本地计算。',
        lang: 'zh-CN',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui', 'browser'],
        orientation: 'any',
        background_color: '#f2f6f5',
        theme_color: '#10a88c',
        categories: ['games', 'entertainment'],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 预缓存应用外壳：HTML / JS / CSS / SVG / 图片。
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        globIgnores: [
          '**/*.map',
          'sw.js',
          'workbox-*.js',
          // 这四个会被插件**自动**加入预缓存（manifest.icons 里声明的图标 + manifest
          // 本身），glob 再匹配一次就会各来一遍。这里显式挡掉，保证清单零重复。
          'pwa-192.png',
          'pwa-512.png',
          'pwa-maskable-512.png',
          'manifest.webmanifest',
          ...ENGINE_DIRS.map((d) => `${d}/**`),
        ],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // 单页应用：任何导航请求回落到预缓存好的 index.html。
        // 路由本身走 hash，不依赖服务器重写。
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        // 不自动 skipWaiting：留一张旧页面在新版本就绪后仍然可用，
        // 直到玩家点「刷新」为止（见 src/pwa.ts）。
        skipWaiting: false,
        runtimeCaching: [
          {
            urlPattern: engineAssetPattern,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pond-engine-assets',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // 恶魔主题 BGM（3.2MB）：只在真正播放时缓存，不占安装流量
            urlPattern: /\.m4a$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pond-media',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    open: true,
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    port: 4173,
    headers: crossOriginIsolationHeaders,
  },
});
