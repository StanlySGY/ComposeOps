// 本地预览配置:把 /api 与 /ws 代理到已部署面板,用于前端改动的视觉验收。
// 用法:npx vite --config vite.preview.config.mjs(或 vite preview,两段代理都配了)
// 注意:auth 的 validateOrigin 校验 origin 与 host 一致,故改写 origin 头。
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.js';
const target = 'http://100.86.191.116:28765';
const proxy = {
  '/api': { target, changeOrigin: true, headers: { origin: target } },
  '/ws': { target, ws: true, changeOrigin: true, headers: { origin: target } },
};
export default mergeConfig(base, defineConfig({
  server: {
    port: 5199, strictPort: true, proxy,
  },
  preview: {
    port: 5199, strictPort: true, proxy,
  },
}));
