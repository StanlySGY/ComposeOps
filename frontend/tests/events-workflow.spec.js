import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['getEvents', 'getEventStats', 'updateEvent', 'pruneEvents'].map(name => [name, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => ({ success: vi.fn(), error: vi.fn() }) }));
import EventCenterView from '../src/views/EventCenterView.vue';
import ConfirmDialog from '../src/components/common/ConfirmDialog.vue';
let wrapper;
let router;
beforeEach(() => {
  vi.clearAllMocks();
  api.getEvents.mockResolvedValue({ events: [{ id: 1, title: '缓存连接失败', status: 'open', eventType: 'alert', severity: 'warning', source: 'monitor', detail: '错误详情。'.repeat(80), createdAt: '2026-11-08T12:00:00Z' }] });
  api.getEventStats.mockResolvedValue({ stats: { total: 1, open: 1 } });
});
afterEach(() => wrapper?.unmount());
async function start(query = {}) {
  router = createRouter({ history: createMemoryHistory(), routes: [{ name: 'events', path: '/events', component: EventCenterView }, { path: '/:pathMatch(.*)*', component: { template: '<main />' } }] });
  await router.push({ path: '/events', query });
  wrapper = mount(EventCenterView, { global: { renderStubDefaultSlot: true, plugins: [router, createPinia()], stubs: { ConfirmDialog: true, EventTimeline: true, StateHistoryPanel: true, OperationsView: true, SceneIllustration: true } } });
  await flushPromises();
}

it('清理确认在请求期间保持忙碌，失败后原地重试而不关闭', async () => {
  let rejectPrune;
  api.pruneEvents.mockReturnValueOnce(new Promise((resolve, reject) => { rejectPrune = reject; }));
  await start();
  await wrapper.findAll('button').find(button => button.text() === '清理过期').trigger('click');
  const dialog = wrapper.findComponent(ConfirmDialog);
  dialog.vm.$emit('confirm');
  dialog.vm.$emit('confirm');
  await flushPromises();
  expect(api.pruneEvents).toHaveBeenCalledTimes(1);
  expect(dialog.props('show')).toBe(true);
  expect(dialog.props('busy')).toBe(true);
  rejectPrune(new Error('删除失败，请重试'));
  await flushPromises();
  expect(dialog.props('show')).toBe(true);
  expect(dialog.props('busy')).toBe(false);
  expect(wrapper.text()).toContain('删除失败，请重试');
});

it('当前记录搜索支持深链和清除，搜索过程不重新请求列表', async () => {
  await start({ q: '不匹配' });
  expect(wrapper.findAll('.event-row')).toHaveLength(0);
  expect(wrapper.text()).toContain('没有匹配的事件');
  const search = wrapper.get('input[aria-label="搜索当前事件记录"]');
  await search.setValue('缓存');
  await flushPromises();
  expect(router.currentRoute.value.query.q).toBe('缓存');
  expect(wrapper.findAll('.event-row')).toHaveLength(1);
  expect(api.getEvents).toHaveBeenCalledTimes(1);
});

it('长详情有显式展开与收起，不把全部日志直接铺满列表', async () => {
  await start();
  const toggle = wrapper.get('button[aria-controls="event-detail-1"]');
  expect(toggle.attributes('aria-expanded')).toBe('false');
  await toggle.trigger('click');
  expect(toggle.attributes('aria-expanded')).toBe('true');
  expect(toggle.text()).toContain('收起');
});
