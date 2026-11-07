import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, expect, it, vi } from 'vitest';
const { api, bumpHostEpoch } = vi.hoisted(() => ({ api: Object.fromEntries(['getHosts', 'pingHost', 'setActiveHost', 'setHostGroup'].map(k => [k, vi.fn()])), bumpHostEpoch: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api, bumpHostEpoch }));
import { useHostsStore } from '../src/stores/hosts.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks(); });
it('旧列表不能覆盖已完成的切节点与分组变更', async () => {
  const store = useHostsStore();
  store.hosts = [{ id: 'local', active: true }, { id: 'remote', group: 'production' }];
  const old = deferred(); api.getHosts.mockReturnValue(old.promise);
  const loading = store.load(true);
  api.setActiveHost.mockResolvedValue({ activeHostId: 'remote' });
  api.setHostGroup.mockResolvedValue({ group: 'edge' });
  await store.switchHost('remote'); await store.assignGroup('remote', 'edge');
  old.resolve({ hosts: [{ id: 'local', active: true }, { id: 'remote', group: 'production' }] });
  await loading;
  expect(store.activeHostId).toBe('remote');
  expect(store.active.group).toBe('edge');
});
it('探测去重且迟到结果只更新状态，不覆盖名称、分组和活跃节点', async () => {
  const store = useHostsStore(); store.hosts = [{ id: 'remote', name: '新名称', active: false, group: 'edge' }];
  const pending = deferred(); api.pingHost.mockReturnValue(pending.promise);
  const first = store.ping('remote'); const second = store.ping('remote');
  api.setActiveHost.mockResolvedValue({ activeHostId: 'remote' }); await store.switchHost('remote');
  pending.resolve({ ok: true, host: { id: 'remote', name: '旧名称', active: false, group: 'production', status: 'online', containerCount: 2 } });
  await Promise.all([first, second]);
  expect(api.pingHost).toHaveBeenCalledTimes(1);
  expect(store.active).toMatchObject({ name: '新名称', active: true, group: 'edge', status: 'online', containerCount: 2 });
  expect(store.pinging).toBe('');
});
it('新列表先完成时旧响应不能回退列表', async () => {
  const store = useHostsStore(); const old = deferred();
  api.getHosts.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ hosts: [{ id: 'new', active: true }] });
  const first = store.load(); await store.load(true);
  old.resolve({ hosts: [{ id: 'old', active: true }] }); await first;
  expect(store.activeHostId).toBe('new');
});
