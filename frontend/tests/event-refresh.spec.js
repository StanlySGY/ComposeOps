import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api } = vi.hoisted(() => ({
  api: Object.fromEntries(
    ['getEvents', 'getEventStats', 'updateEvent', 'pruneEvents'].map((name) => [name, vi.fn()]),
  ),
}));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/toast.js', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}));
import EventCenterView from '../src/views/EventCenterView.vue';

describe('事件中心下拉刷新', () => {
  let wrapper;
  let router;
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    api.getEvents.mockResolvedValue({ events: [] });
    api.getEventStats.mockResolvedValue({ stats: { total: 0 } });
  });
  afterEach(() => wrapper?.unmount());
  async function start(query = {}) {
    router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/events', component: EventCenterView }],
    });
    await router.push({ path: '/events', query });
    wrapper = mount(EventCenterView, {
      global: {
        plugins: [router, createPinia()],
        stubs: { EventTimeline: true, OperationsView: true, ConfirmDialog: true, StateHistoryPanel: true },
      },
    });
    await flushPromises();
  }
  it('挂载后拉取事件与统计', async () => {
    await start();
    expect(api.getEvents).toHaveBeenCalledTimes(1);
    expect(api.getEventStats).toHaveBeenCalledTimes(1);
  });
  it('下拉刷新事件触发重新加载', async () => {
    await start();
    window.dispatchEvent(new CustomEvent('composeops:refresh'));
    await flushPromises();
    expect(api.getEvents).toHaveBeenCalledTimes(2);
  });
  it('卸载后不再响应下拉刷新(无监听泄漏)', async () => {
    await start();
    const calls = api.getEvents.mock.calls.length;
    wrapper.unmount();
    wrapper = null;
    window.dispatchEvent(new CustomEvent('composeops:refresh'));
    await flushPromises();
    expect(api.getEvents).toHaveBeenCalledTimes(calls);
  });
  it('?tab=state 渲染状态历史面板,且不重复发告警事件请求', async () => {
    await start({ tab: 'state' });
    expect(api.getEvents).not.toHaveBeenCalled();
    expect(wrapper.findComponent({ name: 'StateHistoryPanel' }).exists()).toBe(true);

    // 下拉刷新归面板自己:视图层不能再发一遍事件请求
    window.dispatchEvent(new CustomEvent('composeops:refresh'));
    await flushPromises();
    expect(api.getEvents).not.toHaveBeenCalled();
  });
  it('未知 tab 参数回落到告警事件', async () => {
    await start({ tab: 'nope' });
    expect(api.getEvents).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent({ name: 'StateHistoryPanel' }).exists()).toBe(false);
  });
});
