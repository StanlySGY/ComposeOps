import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: 'preview',
  base: './',
  plugins: [vue()],
  publicDir: false,
  build: { outDir: '../preview-dist', emptyOutDir: true },
});
