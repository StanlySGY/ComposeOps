import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import AppSidebar from '../src/components/AppSidebar.vue';

describe('移动端更多功能抽屉可访问性', () => {
  let wrapper;

  async function start() {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
    });
    await router.push('/');
    await router.isReady();
    wrapper = mount(AppSidebar, {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    await flushPromises();
    return router;
  }

  function trigger() {
    return document.querySelector('button[aria-label="更多功能"]');
  }

  function dialog() {
    return document.querySelector('[role="dialog"]#mobile-more-dialog');
  }

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('使用有名称的模态对话框并把初始焦点移入抽屉', async () => {
    await start();
    trigger().focus();
    trigger().click();
    await flushPromises();

    const panel = dialog();
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-labelledby')).toBe('mobile-more-dialog-title');
    expect(panel.querySelector('#mobile-more-dialog-title').textContent).toBe('更多功能');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement.textContent).toContain('入门指南');
  });

  it('循环 Tab 焦点，并在 Escape 或关闭按钮后恢复到触发按钮', async () => {
    await start();
    const openButton = trigger();
    openButton.focus();
    openButton.click();
    await flushPromises();

    const panel = dialog();
    const focusables = () => [...panel.querySelectorAll('a[href], button:not([disabled])')];
    const first = focusables()[0];
    const last = focusables().at(-1);
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(openButton);
    expect(openButton.getAttribute('aria-expanded')).toBe('false');

    openButton.click();
    await flushPromises();
    document.querySelector('button[aria-label="关闭更多功能"]').click();
    await flushPromises();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(openButton);
  });
});
