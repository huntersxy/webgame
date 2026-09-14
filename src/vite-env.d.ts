/// <reference types="vite/client" />

/** 构建标识，由 vite.config.ts 的 define 注入；用于 Service Worker 的版本化 URL */
declare const __BUILD_ID__: string;

declare module '*.m4a' {
  const src: string;
  export default src;
}
declare module '*.mp3' {
  const src: string;
  export default src;
}
declare module '*.png' {
  const src: string;
  export default src;
}