import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';
const { api } = vi.hoisted(() => ({ api: Object.fromEntries([
  'getCmdbAssets', 'getCmdbTopology', 'syncCmdbAssets', 'deleteCmdbAsset', 'addCmdbRelation', 'deleteCmdbRelation',
].map(name => [name, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api }));
import { useCmdbStore } from '../src/stores/cmdb.js';
let pinia;
const a = { id: 'project:a', kind: 'project' }, b = { id: 'host:b', kind: 'host' };
const edge = { id: 1, sourceId: a.id, targetId: b.id, relation: 'runs_on' };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
beforeEach(() => {
  pinia = createPinia(); setActivePinia(pinia);
  for (const mock of Object.values(api)) mock.mockReset();
  api.getCmdbAssets.mockResolvedValue({ assets: [a, b] });
  api.getCmdbTopology.mockResolvedValue({ assets: [a, b], relations: [edge] });
});
afterEach(() => disposePinia(pinia));

describe('资产清单与关系的写后读取一致性', () => {
  it('同步后同时刷新资产和关系，不能保留旧关系计数', async () => {
    const store = useCmdbStore(); store.relations = [{ id: 99 }];
    await store.sync();
    expect(store.assets).toEqual([a, b]); expect(store.relations).toEqual([edge]);
  });
  it('同步已经执行但刷新失败时明确报告，不重复同步或伪报成功', async () => {
    const store = useCmdbStore(); store.assets = [a];
    api.getCmdbTopology.mockRejectedValue(new Error('网络中断'));
    api.getCmdbAssets.mockRejectedValue(new Error('网络中断'));
    await expect(store.sync()).rejects.toThrow(/同步已完成.*刷新失败/);
    expect(api.syncCmdbAssets).toHaveBeenCalledTimes(1); expect(store.assets).toEqual([a]); expect(store.syncing).toBe(false);
  });
  it('删除资产后关联边同时移除，删除前的迟到拓扑不能复活资产', async () => {
    const store = useCmdbStore(), read = deferred(); store.assets = [a, b]; store.relations = [edge];
    api.getCmdbTopology.mockReturnValueOnce(read.promise);
    const pending = store.loadTopology(); await store.remove(a.id);
    expect(store.assets).toEqual([b]); expect(store.relations).toEqual([]);
    read.resolve({ assets: [a, b], relations: [edge] }); await pending;
    expect(store.assets).toEqual([b]); expect(store.relations).toEqual([]); expect(store.loading).toBe(false);
  });
  it('删除关系后迟到读取不能复活它，也不能覆盖新的错误状态', async () => {
    const store = useCmdbStore(), read = deferred(); store.relations = [edge];
    api.getCmdbTopology.mockReturnValueOnce(read.promise);
    const pending = store.loadTopology(); await store.removeRelation(edge.id);
    read.reject(new Error('删除前旧查询失败')); await pending;
    expect(store.relations).toEqual([]); expect(store.error).toBe(''); expect(store.loading).toBe(false);
  });
  it('删除失败保留现有资产与关系', async () => {
    const store = useCmdbStore(); store.assets = [a, b]; store.relations = [edge];
    api.deleteCmdbAsset.mockRejectedValueOnce(new Error('只读权限'));
    await expect(store.remove(a.id)).rejects.toThrow('只读权限');
    expect(store.assets).toEqual([a, b]); expect(store.relations).toEqual([edge]);
  });
  it('关系写入后刷新失败不能误报写入失败并引导重复提交', async () => {
    const store = useCmdbStore(); api.getCmdbTopology.mockRejectedValueOnce(new Error('连接中断'));
    await expect(store.addRelation(edge)).rejects.toThrow(/关系已保存.*刷新失败/);
    expect(api.addCmdbRelation).toHaveBeenCalledTimes(1);
  });
  it('删除完成跨越身份边界时不修改新身份资产', async () => {
    const store = useCmdbStore(), write = deferred(); api.deleteCmdbAsset.mockReturnValueOnce(write.promise);
    const pending = store.remove(a.id); const outcome = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    advanceAuthEpoch(); store.assets = [a, b]; store.relations = [edge]; write.resolve({ ok: true }); await outcome;
    expect(store.assets).toEqual([a, b]); expect(store.relations).toEqual([edge]);
  });
  it('并发手动刷新不能把同步后的真实读取失败变成成功', async () => {
    const store = useCmdbStore(), own = deferred(), other = deferred();
    api.getCmdbTopology.mockReturnValueOnce(own.promise).mockReturnValueOnce(other.promise);
    const sync = store.sync(); const outcome = expect(sync).rejects.toThrow(/同步已完成.*刷新失败/);
    await flushPromises(); const read = store.loadTopology();
    own.reject(new Error('同步后的查询失败')); await outcome;
    other.resolve({ assets: [a, b], relations: [edge] }); await read;
    expect(store.assets).toEqual([a, b]); expect(store.error).toBe('');
  });

});
