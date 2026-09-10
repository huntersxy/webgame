import { defineConfig } from 'vite';

// Rapfi 多线程 WASM 引擎依赖 SharedArrayBuffer，浏览器要求页面处于
// cross-origin isolated 状态（服务器必须返回这两个响应头）。
// 生产环境由 nginx 配置同样的头（见 README 部署一节）。
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
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
