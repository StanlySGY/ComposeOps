import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
const { getProjects } = vi.hoisted(() => ({ getProjects: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api: { getProjects } }));
import { useServicesStore } from '../src/stores/services.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('项目列表刷新顺序', () => {
  beforeEach(() => { setActivePinia(createPinia()); getProjects.mockReset(); });
  it('较早的慢请求不会覆盖最新的强制刷新', async () => {
    const store = useServicesStore();
    const slow = deferred();
    getProjects.mockReturnValueOnce(slow.promise);
    const first = store.refresh();
    getProjects.mockResolvedValueOnce({ projects: [{ id: 'new' }] });
    await store.refresh(true);
    slow.resolve({ projects: [{ id: 'old' }] });
    await first;
    expect(store.projects).toEqual([{ id: 'new' }]);
  });
  it('新快照为空时移除已经删除的项目', () => {
    const store = useServicesStore();
    store.projects = [{ id: 'deleted' }];
    store.handleContainerEvent({ type: 'snapshot', projects: [] });
    expect(store.projects).toEqual([]);
  });
  it('切节点立即清空旧项目,旧请求不能填回列表', async () => {
    const store = useServicesStore();
    store.projects = [{ id: 'previous-host' }];
    const old = deferred();
    const current = deferred();
    getProjects.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = store.refresh();
    const switched = store.refreshForHost();
    expect(store.projects).toEqual([]);
    expect(store.lastLoadedAt).toBe(0);
    old.resolve({ projects: [{ id: 'old-host-late' }] });
    await first;
    expect(store.projects).toEqual([]);
    expect(store.loading).toBe(true);
    current.resolve({ projects: [{ id: 'current-host' }] });
    await switched;
    expect(store.projects).toEqual([{ id: 'current-host' }]);
    expect(store.loading).toBe(false);
  });
});
