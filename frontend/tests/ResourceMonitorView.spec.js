import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api, metricsApi } = vi.hoisted(() => ({
  api: { getProjects: vi.fn() },
  metricsApi: {
    getAlerts: vi.fn(),
    createAlert: vi.fn(),
    deleteAlert: vi.fn(),
  },
}));

vi.mock('../src/api/client.js', () => ({ api, metricsApi }));

import ResourceMonitorView from '../src/views/ResourceMonitorView.vue';

let wrapper;
let router;

beforeEach(async () => {
  vi.clearAllMocks();
  api.getProjects.mockResolvedValue({ projects: [] });
  metricsApi.getAlerts.mockResolvedValue({ alerts: [] });
  metricsApi.createAlert.mockResolvedValue({ ok: true });
  metricsApi.deleteAlert.mockResolvedValue({ ok: true });
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<main>测试路由</main>' } }],
  });
  await router.push('/');
  await router.isReady();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

async function mountView() {
  wrapper = mount(ResourceMonitorView, {
    attachTo: document.body,
    global: {
      plugins: [router],
      stubs: { StatusBadge: true, InteractiveChart: true },
    },
  });
  await flushPromises();
  return wrapper;
}

describe('资源监控告警配置弹窗的键盘可访问性', () => {
  it('提供命名模态框语义及正确关联的表单标签，并在打开时聚焦弹窗内', async () => {
    await mountView();
    const trigger = document.querySelector('button.btn-primary');
    trigger.focus();
    trigger.click();
    await flushPromises();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('resource-alert-modal-title');
    expect(document.querySelector('label[for="resource-alert-metric"]')).not.toBeNull();
    expect(document.querySelector('label[for="resource-alert-threshold"]')).not.toBeNull();
    expect(document.querySelector('label[for="resource-alert-action"]')).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('循环 Tab 焦点，Escape 关闭并恢复触发按钮焦点与滚动', async () => {
    await mountView();
    const trigger = document.querySelector('button.btn-primary');
    trigger.focus();
    trigger.click();
    await flushPromises();

    const dialog = document.querySelector('[role="dialog"]');
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )];
    expect(focusable.length).toBeGreaterThan(2);

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    first.focus();
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe('');
  });

  it('点击遮罩或关闭按钮也会关闭弹窗并恢复焦点', async () => {
    await mountView();
    const trigger = document.querySelector('button.btn-primary');
    trigger.focus();
    trigger.click();
    await flushPromises();

    document.querySelector('.modal-overlay').click();
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    await flushPromises();
    document.querySelector('button[aria-label="关闭告警规则配置"]').click();
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
