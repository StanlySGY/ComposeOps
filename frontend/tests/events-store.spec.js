import { beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useEventStore } from '../src/stores/events.js';
const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['getEvents', 'getEventStats', 'updateEvent', 'pruneEvents'].map(name => [name, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api }));
beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); api.getEvents.mockResolvedValue({ events: [] }); api.getEventStats.mockResolvedValue({ stats: { total: 1 } }); });

it('筛选快速切换时迟到结果和失败都不能覆盖当前条件', async () => {
  const store = useEventStore();
  let resolveOld;
  api.getEvents.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  const old = store.load({ eventType: 'alert' });
  api.getEvents.mockResolvedValueOnce({ events: [{ id: 2, eventType: 'cron' }] });
  await store.load({ eventType: 'cron' });
  resolveOld({ events: [{ id: 1, eventType: 'alert' }] });
  await old;
  expect(store.events.map(event => event.id)).toEqual([2]);
  expect(store.loading).toBe(false);
});

it('状态变更防重复提交，结束后按期间新选的筛选刷新', async () => {
  const store = useEventStore();
  let resolveWrite;
  api.updateEvent.mockReturnValueOnce(new Promise(resolve => { resolveWrite = resolve; }));
  await store.load({ status: 'open' });
  const first = store.update(1, { status: 'resolved' });
  const second = store.update(1, { status: 'closed' });
  await store.load({ status: 'closed', eventType: 'cron' });
  resolveWrite({ event: { id: 1, status: 'resolved' } });
  await Promise.all([first, second]);
  expect(api.updateEvent).toHaveBeenCalledTimes(1);
  expect(api.getEvents).toHaveBeenLastCalledWith({ limit: 200, status: 'closed', eventType: 'cron' }, true);
  expect(store.events).toEqual([]);
});

it('状态已保存但刷新失败时仍显示服务端确认的状态', async () => {
  const store = useEventStore();
  api.getEvents.mockResolvedValueOnce({ events: [{ id: 7, title: '容器退出', status: 'open', eventType: 'alert' }] });
  await store.load();
  api.updateEvent.mockResolvedValueOnce({ event: { id: 7, title: '容器退出', status: 'resolved', eventType: 'alert' } });
  api.getEvents.mockRejectedValueOnce(new Error('刷新暂时失败'));
  await store.update(7, { status: 'resolved' });
  expect(store.events[0].status).toBe('resolved');
  expect(store.error).toBe('刷新暂时失败');
});

it('已解决事件在刷新失败时也移出待处理筛选', async () => {
  const store = useEventStore();
  api.getEvents.mockResolvedValueOnce({ events: [{ id: 7, status: 'open', eventType: 'alert' }] });
  await store.load({ status: 'open' });
  api.updateEvent.mockResolvedValueOnce({ event: { id: 7, status: 'resolved', eventType: 'alert' } });
  api.getEvents.mockRejectedValueOnce(new Error('offline'));
  await store.update(7, { status: 'resolved' });
  expect(store.events).toEqual([]);
});

it('统计读取失败独立提示，重试恢复后不残留错误', async () => {
  const store = useEventStore();
  api.getEventStats.mockRejectedValueOnce(new Error('统计服务暂不可用'));
  await Promise.all([store.load(), store.loadStats()]);
  expect(store.error).toBe('');
  expect(store.statsError).toBe('统计服务暂不可用');
  await store.loadStats();
  expect(store.statsError).toBe('');
  expect(store.stats.total).toBe(1);
});
