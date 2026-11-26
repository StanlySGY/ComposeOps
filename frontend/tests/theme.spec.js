import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';

let theme;
let stop;
let media;
let wrapper;
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '<meta name="theme-color" content="">';
  media = new EventTarget();
  media.matches = true;
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  theme = await import('../src/lib/theme.js');
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('界面主题', () => {
  it('首次访问默认深色，显式浅色可持久化并在重新初始化后恢复', () => {
    stop = theme.initializeTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
    theme.setTheme('light');
    expect(localStorage.getItem('composeops:theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    stop();
    stop = theme.initializeTheme();
    expect(theme.useTheme().themePreference.value).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]').content).toBe('#f3f6fa');
  });

  it('跟随系统响应系统变化，显式主题不受系统变化影响', () => {
    stop = theme.initializeTheme();
    theme.setTheme('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    expect(document.documentElement.dataset.theme).toBe('light');
    theme.setTheme('dark');
    media.dispatchEvent(new Event('change'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('同步其他标签页的主题，并处理清空存储和无效值', () => {
    stop = theme.initializeTheme();
    localStorage.setItem('composeops:theme', 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'composeops:theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    theme.setTheme('invalid');
    expect(theme.useTheme().themePreference.value).toBe('dark');
  });

  it('存储被禁用仍可切换；重复初始化不会重复绑定监听', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const listen = vi.spyOn(media, 'addEventListener');
    const remove = vi.spyOn(media, 'removeEventListener');
    stop = theme.initializeTheme();
    theme.initializeTheme();
    theme.setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(listen).toHaveBeenCalledTimes(1);
    stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('终端随主题更新 ANSI 色板，背景和文字具有相反明度', () => {
    stop = theme.initializeTheme();
    theme.setTheme('light');
    const palette = theme.useTerminalTheme();
    expect(palette.value.background).toBe('#ffffff');
    expect(palette.value.foreground).toBe('#1e293b');
    theme.setTheme('dark');
    expect(palette.value.background).toBe('#0b0d10');
    expect(palette.value.foreground).toBe('#e5e7eb');
  });

  it('中文主题控件即时生效，无需提交表单', async () => {
    const { default: ThemeSelect } = await import('../src/components/common/ThemeSelect.vue');
    wrapper = mount(ThemeSelect, { props: { compact: true } });
    stop = theme.initializeTheme();
    const select = wrapper.get('select[aria-label="界面主题"]');
    expect(wrapper.findAll('option').map(option => option.text())).toEqual(['浅色', '深色', '跟随系统']);
    await select.setValue('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await select.setValue('system');
    expect(theme.useTheme().themePreference.value).toBe('system');
  });

  it('首屏脚本与运行时对每种偏好和系统颜色解析一致', () => {
    const bootstrap = readFileSync('public/theme-init.js', 'utf8');
    for (const value of [null, 'light', 'dark', 'system', 'invalid']) {
      for (const dark of [true, false]) {
        localStorage.clear();
        if (value) localStorage.setItem('composeops:theme', value);
        media.matches = dark;
        window.eval(bootstrap);
        const earlyTheme = document.documentElement.dataset.theme;
        stop = theme.initializeTheme();
        expect(document.documentElement.dataset.theme).toBe(earlyTheme);
        stop();
      }
    }
  });
});
