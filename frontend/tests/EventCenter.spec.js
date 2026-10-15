import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api, eventStream } = vi.hoisted(() => ({
  api: {
    getProjects: vi.fn(),
    getOperations: vi.fn(),
    getUpdateSettings: vi.fn(),
    listJobs: vi.fn(),
    getAlertEvents: vi.fn(),
    getGuardian: vi.fn(),
  },
  eventStream: {
    connect: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock('../src/api/client.js', () => ({ api, wsUrl: (path) => path }));
vi.mock('../src/composables/useWebSocket.js', () => ({
  useWebSocket: vi.fn(() => eventStream),
}));
vi.mock('../src/composables/useAgentConsole.js', () => ({
  useAgentConsole: () => ({ openAgent: vi.fn(), updateAgentContext: vi.fn() }),
}));

import EventCenter from '../src/components/EventCenter.vue';

let wrapper;
let router;

beforeEach(() => {
  vi.clearAllMocks();
  api.getProjects.mockResolvedValue({ projects: [] });
  api.getOperations.mockResolvedValue({ operations: [] });
  api.getUpdateSettings.mockResolvedValue({ lastResults: [] });
  api.listJobs.mockResolvedValue({ jobs: [] });
  api.getAlertEvents.mockResolvedValue({ events: [] });
  api.getGuardian.mockResolvedValue({ enabled: false, aiConfigured: false });
  localStorage.clear();
  document.body.innerHTML = '';
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<main><h1>首页</h1></main>' } },
      { path: '/:pathMatch(.*)*', component: { template: '<main><h1>页面</h1></main>' } },
    ],
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  localStorage.clear();
});

async function mountEventCenter() {
  await router.push('/');
  await router.isReady();
  wrapper = mount(EventCenter, {
    attachTo: document.body,
    global: {
      plugins: [router, createPinia()],
      stubs: { EmptyState: true, ConfirmDialog: true },
    },
  });
  await flushPromises();
  return wrapper;
}

describe('事件中心弹层的键盘可访问性与资源清理', () => {
  it('打开后声明为命名模态框、聚焦面板并循环 Tab 焦点', async () => {
    await mountEventCenter();
    const trigger = document.querySelector('button[aria-label="打开事件中心"]');
    trigger.focus();
    trigger.click();
    await flushPromises();

    const panel = document.querySelector('#event-center-panel');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe('event-center-panel');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-labelledby')).toBe('event-center-title');
    expect(document.activeElement).toBe(panel);
    expect(eventStream.connect).toHaveBeenCalledTimes(1);

    const focusable = [...panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => element.closest('[role="dialog"]') === panel);
    expect(focusable.length).toBeGreaterThan(1);
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
  });

  it('Escape 关闭面板、释放事件流并将焦点还给入口按钮', async () => {
    await mountEventCenter();
    const trigger = document.querySelector('button[aria-label="打开事件中心"]');
    trigger.click();
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();

    expect(document.querySelector('#event-center-panel')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(eventStream.close).toHaveBeenCalled();
  });

  it('点击遮罩关闭也执行同一套事件流清理与焦点恢复', async () => {
    await mountEventCenter();
    const trigger = document.querySelector('button[aria-label="打开事件中心"]');
    trigger.click();
    await flushPromises();

    document.querySelector('.fixed.inset-0.z-50').click();
    await flushPromises();

    expect(document.querySelector('#event-center-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(eventStream.close).toHaveBeenCalled();
  });

  it('显式关闭按钮与其他关闭方式共享相同清理路径', async () => {
    await mountEventCenter();
    const trigger = document.querySelector('button[aria-label="打开事件中心"]');
    trigger.click();
    await flushPromises();

    document.querySelector('button[aria-label="关闭事件中心"]').click();
    await flushPromises();

    expect(document.querySelector('#event-center-panel')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(eventStream.close).toHaveBeenCalled();
  });

  it('持久化告警的图标操作均提供明确的可访问名称', async () => {
    api.getAlertEvents.mockResolvedValue({
      events: [{
        id: 'alert-1',
        title: '磁盘空间告警',
        detail: '剩余空间不足',
        target: '/events',
        priority: 'danger',
        read: false,
        muted: false,
        logs: 'disk usage is high',
        diagnosis: '',
        created_at: '2026-10-15T00:00:00.000Z',
      }],
    });
    await mountEventCenter();
    document.querySelector('button[aria-label="打开事件中心"]').click();
    await flushPromises();

    const panel = document.querySelector('#event-center-panel');
    for (const label of ['AI 诊断此告警(守护模式)', '展开日志', '标记已读', '静默此告警']) {
      expect(panel.querySelector(`button[aria-label="${label}"]`), label).not.toBeNull();
    }
  });
});
