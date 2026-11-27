import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { useServicesStore } from '../src/stores/services.js';
import { api, bumpHostEpoch } from '../src/api/client.js';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let fetchMock;
beforeEach(() => { setActivePinia(createPinia()); bumpHostEpoch(); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('真实客户端和服务Store的刷新时间契约', () => {
  it('缓存存在时刷新失败仍可见，保留列表和上次成功时间', async () => {
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockResolvedValueOnce(response({ projects: [{ id: 'kept' }] }));
    const store = useServicesStore(); await store.refresh();
    now = 2000;
    fetchMock.mockResolvedValueOnce(response({ message: '节点离线，读取失败' }, 502));
    await store.refresh(); await flushPromises();
    expect(store.projects).toEqual([{ id: 'kept' }]);
    expect(store.lastLoadedAt).toBe(1000);
    expect(store.error).toContain('节点离线');
  });

  it('刷新等待新响应；成功才展示新数据并更新时间，不提前标记缓存为刚刷新', async () => {
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockResolvedValueOnce(response({ projects: [{ id: 'old' }] }));
    const store = useServicesStore(); await store.refresh();
    let finish; now = 2000;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = store.refresh(); await flushPromises();
    expect(store.lastLoadedAt).toBe(1000);
    expect(store.projects).toEqual([{ id: 'old' }]);
    finish(response({ projects: [{ id: 'new' }] })); await pending;
    expect(store.projects).toEqual([{ id: 'new' }]); expect(store.lastLoadedAt).toBe(2000);
  });

  it('HTTP200但数据形状错误不能冒充刷新成功', async () => {
    fetchMock.mockResolvedValueOnce(response({ projects: [{ id: 'kept' }] }));
    const store = useServicesStore(); await store.refresh(); const timestamp = store.lastLoadedAt;
    fetchMock.mockResolvedValueOnce(response({ unexpected: true })); await store.refresh(true);
    expect(store.projects).toEqual([{ id: 'kept' }]); expect(store.lastLoadedAt).toBe(timestamp);
    expect(store.error).toContain('项目列表');
  });

  it('节点与调度读取返回新结果，不能静默返回过期的连接修订或任务状态', async () => {
    for (const read of [api.getHosts, api.listCronJobs]) {
      fetchMock.mockResolvedValueOnce(response({ version: 'old' })); await read();
      fetchMock.mockResolvedValueOnce(response({ version: 'new' }));
      expect(await read()).toEqual({ version: 'new' });
    }
  });

  it('已有快照时多个读取共用本轮请求，缓存错误不会变成成功或阻止后续重试', async () => {
    fetchMock.mockResolvedValueOnce(response({ projects: [] })); await api.getProjects();
    let finish;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = api.getProjects(), second = api.getProjects();
    const results = Promise.allSettled([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('fresh');
    finish(response({ message: '本轮失败' }, 503));
    expect((await results).every(result => result.status === 'rejected')).toBe(true);
    fetchMock.mockResolvedValueOnce(response({ projects: [{ id: 'recovered' }] }));
    expect(await api.getProjects()).toEqual({ projects: [{ id: 'recovered' }] });
  });

  it('已读取的真实空列表在后台刷新时不反复切回首次加载骨架', async () => {
    fetchMock.mockResolvedValueOnce(response({ projects: [] }));
    const store = useServicesStore(); await store.refresh();
    let finish; fetchMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = store.refresh(); await flushPromises();
    expect(store.loading).toBe(false); expect(store.lastLoadedAt).toBeGreaterThan(0);
    finish(response({ projects: [] })); await pending;
  });
});
