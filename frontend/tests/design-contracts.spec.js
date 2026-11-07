// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '@vue/compiler-sfc';
const root = resolve(import.meta.dirname, '../src');
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? (item.name === '__tests__' ? [] : walk(resolve(directory, item.name))) : [resolve(directory, item.name)]);
const files = walk(root).filter(file => /\.(vue|css|js)$/.test(file));
const source = new Map(files.map(file => [file, readFileSync(file, 'utf8')]));
const css = source.get(resolve(root, 'style.css'));
const colors = Object.fromEntries([...css.matchAll(/--color-([\w-]+):\s*#([\da-f]{6})/gi)].map(([, key, hex]) => [key, hex.match(/../g).map(v => parseInt(v, 16) / 255)]));
function luminance(rgb) { return rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0); }
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
describe('设计系统契约', () => {
  it('正文、表头、计数与状态色在主要面板背景达到 AA 4.5:1', () => {
    for (const fg of ['surface-100', 'surface-200', 'surface-300', 'surface-400', 'text-secondary', 'status-ok', 'status-warn', 'status-error', 'status-info']) {
      for (const bg of ['surface-800', 'surface-900', 'surface-950']) expect(contrast(colors[fg], colors[bg]), `${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const status of ['ok', 'warn', 'error', 'info']) {
      const foreground = colors[`status-${status}`]; const background = colors['surface-900'].map((v, i) => v * .85 + foreground[i] * .15);
      expect(contrast(foreground, background), status).toBeGreaterThanOrEqual(4.5);
    }
    for (const bg of ['accent', 'accent-hover', 'status-danger']) expect(contrast([1, 1, 1], colors[bg]), bg).toBeGreaterThanOrEqual(4.5);
  });
  it('所有 Vue 模板可解析，页头有中文，toast 使用中文冒号', () => {
    for (const [file, text] of source) {
      if (file.endsWith('.vue')) {
        expect(parse(text, { filename: file }).errors, file).toEqual([]);
        for (const title of text.matchAll(/<h1\b[^>]*>([^<{]+)<\/h1>/g)) expect(title[1], file).toMatch(/[\u4e00-\u9fff]|^ComposeOps$/);
      }
      expect(text, file).not.toMatch(/(?:toast|useToastStore\(\))\.(?:error|success|warning|info)\([^\n]*[\u4e00-\u9fff]:/);
    }
  });
  it('组件有实际运行引用，尺寸与色板不退回旧覆写', () => {
    const preview = walk(resolve(root, '../preview')).filter(file => /\.(js|vue)$/.test(file)).map(file => readFileSync(file, 'utf8')).join('\n');
    for (const [file, text] of source) {
      expect(text, file).not.toMatch(/\bzinc-|\b(?:min-h-\d+!|px-\d+!|text-\[11px\]!)/);
      if (file.includes('/components/') && file.endsWith('.vue')) {
        const name = file.split('/').at(-1);
        expect([...source].some(([other, content]) => other !== file && content.includes(name)) || preview.includes(name), file).toBe(true);
      }
    }
  });
});
