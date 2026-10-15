import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api, metricsApi } = vi.hoisted(() => ({
  api: { getProjects: vi.fn() },
  metricsApi: {
    getAlerts: vi.fn(),
    getContainerMetrics: vi.fn(),
    getHistoricalMetrics: vi.fn(),
    detectAnomalies: vi.fn(),
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
  metricsApi.getContainerMetrics.mockResolvedValue({ data: { current: 25, unit: '%' } });
  metricsApi.getHistoricalMetrics.mockResolvedValue({ metrics: [] });
  metricsApi.detectAnomalies.mockResolvedValue({ anomalies: [] });
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

  it('所选容器没有告警时显示空状态，不受其他容器的规则影响', async () => {
    api.getProjects.mockResolvedValue({
      projects: [{
        id: 'p1',
        projectName: 'web-stack',
        managed: true,
        containers: [
          { id: 'c1', name: 'api', state: 'running', health: 'healthy' },
          { id: 'c2', name: 'worker', state: 'running', health: 'healthy' },
        ],
      }],
    });
    metricsApi.getAlerts.mockResolvedValue({
      alerts: [{ id: 'rule-c2', containerId: 'c2', metric: 'cpu', threshold: 80 }],
    });
    await mountView();

    const selects = [...document.querySelectorAll('select')];
    selects[1].value = 'c1';
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(document.body.textContent).toContain('暂无告警规则');
    expect(document.body.textContent).not.toContain('rule-c2');
    expect(document.body.textContent).not.toContain('阈值: 80%');
  });

  it('指标卡片可通过 Enter 和 Space 选择，且向读屏器暴露按钮及选中状态', async () => {
    api.getProjects.mockResolvedValue({
      projects: [{
        id: 'p1',
        projectName: 'web-stack',
        managed: true,
        containers: [{ id: 'c1', name: 'api', state: 'running', health: 'healthy' }],
      }],
    });
    await mountView();

    const selects = [...document.querySelectorAll('select')];
    selects[1].value = 'c1';
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    const cpu = document.querySelector('[aria-label="选择CPU指标"]');
    const memory = document.querySelector('[aria-label="选择内存指标"]');
    expect(cpu).not.toBeNull();
    expect(memory).not.toBeNull();
    expect(cpu.getAttribute('role')).toBe('button');
    expect(cpu.getAttribute('tabindex')).toBe('0');
    expect(cpu.getAttribute('aria-pressed')).toBe('true');
    expect(memory.getAttribute('aria-pressed')).toBe('false');

    memory.focus();
    memory.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(memory.getAttribute('aria-pressed')).toBe('true');
    expect(cpu.getAttribute('aria-pressed')).toBe('false');

    cpu.focus();
    const spaceDown = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    cpu.dispatchEvent(spaceDown);
    expect(spaceDown.defaultPrevented).toBe(true);
    expect(cpu.getAttribute('aria-pressed')).toBe('false');
    cpu.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(cpu.getAttribute('aria-pressed')).toBe('true');
    expect(memory.getAttribute('aria-pressed')).toBe('false');
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
