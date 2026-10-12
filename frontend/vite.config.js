import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { precompressAssets } from './build/precompress.js';

// 开发环境通过代理转发到后端 Fastify(默认 3001)

// 手动分块:包名 → 块名。monaco / xterm 只被懒加载路由用到,单独成块让它们留在首屏之外。
const MANUAL_CHUNKS = [
  ['monaco-editor', ['monaco-editor']],
  ['xterm', ['@xterm/xterm', '@xterm/addon-fit']],
  ['vue-vendor', ['vue', 'vue-router', 'pinia', 'lucide-vue-next']],
];

export default defineConfig({
  plugins: [
    vue(),
    {
      // 产物预压缩:后端 @fastify/static 以 preCompressed 直接发送 .br/.gz,见 build/precompress.js。
      name: 'composeops-precompress',
      apply: 'build',
      closeBundle() {
        const outDir = this.options?.build?.outDir || 'dist';
        return precompressAssets(path.resolve(this.cwd || process.cwd(), outDir));
      },
    },
  ],
  test: { environment: 'jsdom', globals: true },
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        // 函数式分组:必须把 vite 的 __vitePreload 助手单独成块。
        // 它被每个动态 import 用到,默认会被并进 monaco 块 —— 入口于是静态依赖 monaco,
        // index.html 会给它挂 modulepreload,首屏白白多拉 2.2 MB(470 kB brotli)。
        manualChunks(id) {
          if (id.includes('vite/preload-helper')) return 'preload-helper';
          for (const [name, packages] of MANUAL_CHUNKS) {
            if (packages.some((pkg) => id.includes(`node_modules/${pkg}/`))) return name;
          }
          return null;
        },
      },
    },
  },
});
