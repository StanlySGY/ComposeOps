import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const monacoYamlEntry = createRequire(import.meta.url).resolve('monaco-yaml');

export default defineConfig({
  root: 'preview',
  base: './',
  plugins: [vue()],
  publicDir: false,
  resolve: { alias: [
    { find: '@composeops/monaco-yaml-real', replacement: monacoYamlEntry },
    { find: /^monaco-yaml$/, replacement: fileURLToPath(new URL('./preview/monaco-yaml.js', import.meta.url)) },
  ] },
  build: { target: 'esnext', chunkSizeWarningLimit: 3000, outDir: '../preview-dist', emptyOutDir: true },
});
