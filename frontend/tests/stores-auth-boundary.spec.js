import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
const { api } = vi.hoisted(() => ({ api: Object.fromEntries([
  'getProjects', 'getWorkflowDefinitions', 'getWorkflowInstances', 'createWorkflowDefinition', 'runWorkflow',
  'getProjectGroups', 'createProjectGroup', 'getHosts', 'pingHost', 'setActiveHost',
  'getCmdbAssets', 'getCmdbTopology', 'syncCmdbAssets', 'getEvents', 'getEventStats', 'updateEvent',
  'getAiConfig', 'getAiHistory', 'getAiSessions',
].map(name => [name, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api, bumpHostEpoch: vi.fn() }));
import { useServicesStore } from '../src/stores/services.js';
import { useWorkflowStore } from '../src/stores/workflow.js';
import { useProjectGroupsStore } from '../src/stores/project-groups.js';
import { useHostsStore } from '../src/stores/hosts.js';
import { useCmdbStore } from '../src/stores/cmdb.js';
import { useEventStore } from '../src/stores/events.js';
import { useAiStore } from '../src/stores/ai.js';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';

let pinia;
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  pinia = createPinia(); setActivePinia(pinia); vi.useFakeTimers();
  for (const mock of Object.values(api)) mock.mockReset();
  api.getProjects.mockResolvedValue({ projects: [] });
  api.getWorkflowDefinitions.mockResolvedValue({ definitions: [] });
  api.getWorkflowInstances.mockResolvedValue({ instances: [] });
});
afterEach(() => { disposePinia(pinia); vi.useRealTimers(); });

describe('登录身份变化时共享数据的归属', () => {
  it('立即清除旧项目、刷新时间和错误，迟到读取不能重新填回', async () => {
    const store = useServicesStore(), pending = deferred();
    store.projects = [{ id: 'private-old-project' }]; store.lastLoadedAt = 123;
    api.getProjects.mockReturnValueOnce(pending.promise);
    const read = store.refresh(true); store.error = '旧节点失败';
    advanceAuthEpoch();
    expect(store.projects).toEqual([]); expect(store.lastLoadedAt).toBe(0);
    expect(store.error).toBe(''); expect(store.loading).toBe(false);
    pending.resolve({ projects: [{ id: 'late-old-project' }] }); await read;
    expect(store.projects).toEqual([]);
    api.getProjects.mockResolvedValueOnce({ projects: [{ id: 'new-project' }] });
    await store.refresh(); expect(store.projects).toEqual([{ id: 'new-project' }]);
  });

  it('清理轮询与事件去抖，旧 WebSocket 错误不能在退出后重启轮询', async () => {
    const store = useServicesStore(); let onError;
    const hook = { connect: vi.fn(), close: vi.fn(), setErrorHandler: fn => { onError = fn; } };
    store.startWebSocket(hook); store.startAutoRefresh(); await flushPromises();
    store.projects = [{ id: 'old' }]; store.handleContainerEvent({ type: 'container_event', projectId: 'old' });
    advanceAuthEpoch(); const count = api.getProjects.mock.calls.length;
    expect(hook.close).toHaveBeenCalledTimes(1); expect(store.wsConnected).toBe(false);
    onError(); await vi.advanceTimersByTimeAsync(16000);
    expect(api.getProjects).toHaveBeenCalledTimes(count); expect(store.projects).toEqual([]);
  });

  it('旧连接同步 close 错误和迟到错误都不能影响替换后的连接', async () => {
    const store = useServicesStore(); let oldError, newError;
    store.startWebSocket({ connect() {}, setErrorHandler(fn) { oldError = fn; }, close() { oldError(); } });
    store.stopWebSocket();
    store.startWebSocket({ connect() {}, close() {}, setErrorHandler(fn) { newError = fn; } });
    store.wsConnected = true; oldError();
    expect(store.wsConnected).toBe(true); expect(api.getProjects).not.toHaveBeenCalled();
    newError(); await flushPromises();
    expect(store.wsConnected).toBe(false); expect(api.getProjects).toHaveBeenCalledTimes(1);
    store.stopWebSocket(); store.stopAutoRefresh();
  });

  it('退出后工作流定义、实例及错误清空，旧读取与写入不回灌也不触发刷新', async () => {
    const store = useWorkflowStore();
    store.definitions = [{ id: 'old-definition' }]; store.instances = [{ id: 'old-run' }];
    const defs = deferred(), instances = deferred(), creation = deferred(), run = deferred();
    api.getWorkflowDefinitions.mockReturnValueOnce(defs.promise);
    api.getWorkflowInstances.mockReturnValueOnce(instances.promise);
    api.createWorkflowDefinition.mockReturnValueOnce(creation.promise); api.runWorkflow.mockReturnValueOnce(run.promise);
    const pending = [store.loadDefinitions(), store.loadInstances(), store.create({}), store.run('old-definition')];
    store.definitionsError = '旧定义失败'; store.instancesError = '旧实例失败';
    advanceAuthEpoch();
    expect(store.definitions).toEqual([]); expect(store.instances).toEqual([]);
    expect(store.error).toBe(''); expect(store.loading).toBe(false);
    defs.resolve({ definitions: [{ id: 'late-old-definition' }] }); instances.reject(new Error('迟到失败'));
    creation.resolve({ definition: { id: 'old-created' } }); run.resolve({ instance: { id: 'old-run' } });
    await Promise.all(pending); await flushPromises();
    expect(store.definitions).toEqual([]); expect(store.instances).toEqual([]); expect(store.error).toBe('');
    expect(api.getWorkflowDefinitions).toHaveBeenCalledTimes(1); expect(api.getWorkflowInstances).toHaveBeenCalledTimes(1);
  });

  it('销毁 store 会注销身份监听并停止实时资源', async () => {
    const store = useServicesStore(), close = vi.fn();
    store.startWebSocket({ connect() {}, close }); store.startAutoRefresh(); await flushPromises();
    store.$dispose(); expect(close).toHaveBeenCalledTimes(1);
    store.projects = [{ id: 'disposed-sentinel' }];
    advanceAuthEpoch(); await vi.advanceTimersByTimeAsync(16000);
    expect(store.projects).toEqual([{ id: 'disposed-sentinel' }]); expect(api.getProjects).toHaveBeenCalledTimes(1);
    const workflow = useWorkflowStore(); workflow.$dispose(); workflow.definitions = [{ id: 'disposed' }];
    advanceAuthEpoch(); expect(workflow.definitions).toEqual([{ id: 'disposed' }]);
  });

  it.each([
    [useProjectGroupsStore, 'groups', 'load', 'getProjectGroups', { groups: [{ id: 'old' }] }],
    [useHostsStore, 'hosts', 'load', 'getHosts', { hosts: [{ id: 'old', active: true }] }],
    [useCmdbStore, 'assets', 'load', 'getCmdbAssets', { assets: [{ id: 'old' }] }],
    [useEventStore, 'events', 'load', 'getEvents', { events: [{ id: 'old' }] }],
    [useAiStore, 'history', 'loadHistory', 'getAiHistory', { messages: [{ id: 'old' }] }],
  ])('%s 缓存和迟到读取都不能跨越身份边界', async (useStore, key, method, apiMethod, result) => {
    const store = useStore(), old = deferred(); store[key] = [{ id: 'cached-old' }];
    api[apiMethod].mockReturnValueOnce(old.promise);
    const read = store[method](true); const outcome = Promise.allSettled([read]);
    advanceAuthEpoch(); expect(store[key]).toEqual([]);
    old.resolve(result); await outcome; await flushPromises();
    expect(store[key]).toEqual([]); expect(store.error || '').toBe('');
  });

  it('同时清除节点选择、资产关系、事件统计与 AI 配置和会话', () => {
    const hosts = useHostsStore(), cmdb = useCmdbStore(), events = useEventStore(), ai = useAiStore();
    hosts.activeHostId = 'private-old-host'; hosts.pinging = 'old'; hosts.error = 'old';
    cmdb.relations = [{ id: 'old-relation' }]; cmdb.error = 'old'; cmdb.syncing = true;
    events.stats = { private: true }; events.statsError = 'old'; events.statsLoading = true;
    ai.config = { apiKey: 'fictional-old-key', systemPrompt: 'private-old-prompt' }; ai.sessions = [{ id: 'old' }];
    advanceAuthEpoch();
    expect(hosts.activeHostId).toBe('local'); expect(hosts.pinging).toBe(''); expect(hosts.error).toBe('');
    expect(cmdb.relations).toEqual([]); expect(cmdb.error).toBe(''); expect(cmdb.syncing).toBe(false);
    expect(events.stats).toBeNull(); expect(events.statsError).toBe(''); expect(events.statsLoading).toBe(false);
    expect(ai.config.apiKey).toBe(''); expect(ai.config.systemPrompt).toBe(''); expect(ai.sessions).toEqual([]);
  });

  it('旧分组保存、节点切换与资产同步成功返回后不得在新身份下接着读取或广播', async () => {
    const groups = useProjectGroupsStore(), hosts = useHostsStore(), cmdb = useCmdbStore();
    const group = deferred(), host = deferred(), sync = deferred();
    api.createProjectGroup.mockReturnValueOnce(group.promise); api.setActiveHost.mockReturnValueOnce(host.promise);
    api.syncCmdbAssets.mockReturnValueOnce(sync.promise);
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const results = Promise.allSettled([groups.save({ name: 'old' }), hosts.switchHost('old'), cmdb.sync()]);
    advanceAuthEpoch();
    group.resolve({ group: { id: 'old' } }); host.resolve({ activeHostId: 'old' }); sync.resolve({ ok: true });
    await results;
    expect(api.getProjectGroups).not.toHaveBeenCalled(); expect(api.getCmdbAssets).not.toHaveBeenCalled();
    expect(hosts.activeHostId).toBe('local');
    expect(dispatch.mock.calls.some(([event]) => ['composeops:host-changed', 'composeops:project-groups-changed'].includes(event.type))).toBe(false);
    dispatch.mockRestore();
  });

  it('旧事件更新完成时不会接用新身份刷新，也不能删掉同 ID 的新请求', async () => {
    const store = useEventStore(), old = deferred(), current = deferred();
    api.updateEvent.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    api.getEvents.mockResolvedValue({ events: [] }); api.getEventStats.mockResolvedValue({ stats: {} });
    const oldResult = Promise.allSettled([store.update('event', { status: 'resolved' })]);
    advanceAuthEpoch(); const next = store.update('event', { status: 'acknowledged' });
    old.resolve({ event: { id: 'event', status: 'resolved' } }); await oldResult;
    expect(api.getEvents).not.toHaveBeenCalled();
    const duplicate = store.update('event', { status: 'acknowledged' });
    expect(api.updateEvent).toHaveBeenCalledTimes(2);
    current.resolve({ event: { id: 'event', status: 'acknowledged' } }); await Promise.all([next, duplicate]);
    expect(api.getEvents).toHaveBeenCalledTimes(1);
  });

  it('同 ID 的新节点探测不会被旧身份的探测清理掉', async () => {
    const store = useHostsStore(), old = deferred(), current = deferred();
    api.pingHost.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    store.hosts = [{ id: 'host' }]; const previous = Promise.allSettled([store.ping('host')]);
    advanceAuthEpoch(); store.hosts = [{ id: 'host', status: 'unknown' }];
    const next = store.ping('host'); old.resolve({ host: { status: 'old' } }); await previous;
    expect(store.hosts[0].status).toBe('unknown'); expect(store.pinging).toBe('host');
    const duplicate = store.ping('host'); expect(api.pingHost).toHaveBeenCalledTimes(2);
    current.resolve({ host: { status: 'online' } }); await Promise.all([next, duplicate]);
    expect(store.hosts[0].status).toBe('online'); expect(store.pinging).toBe('');
  });

  it('本人修改密码仅轮换凭据，不清空已确认的节点与数据；旧读取仍失效', async () => {
    const services = useServicesStore(), hosts = useHostsStore(), workflow = useWorkflowStore();
    const groups = useProjectGroupsStore(), cmdb = useCmdbStore(), events = useEventStore(), ai = useAiStore();
    services.projects = [{ id: 'kept' }]; services.lastLoadedAt = 123;
    hosts.hosts = [{ id: 'remote' }]; hosts.activeHostId = 'remote';
    workflow.definitions = [{ id: 'kept' }]; groups.groups = [{ id: 'kept' }];
    cmdb.assets = [{ id: 'kept' }]; events.events = [{ id: 'kept' }]; ai.config.model = 'kept-model';
    const old = deferred(); api.getProjects.mockReturnValueOnce(old.promise);
    const pending = services.refresh(); advanceAuthEpoch({ identityChanged: false });
    old.reject(new Error('旧凭据请求')); await pending;
    expect(services.projects).toEqual([{ id: 'kept' }]); expect(services.lastLoadedAt).toBe(123); expect(services.error).toBe('');
    expect(hosts.hosts).toEqual([{ id: 'remote' }]); expect(hosts.activeHostId).toBe('remote');
    expect(workflow.definitions).toEqual([{ id: 'kept' }]); expect(groups.groups).toEqual([{ id: 'kept' }]);
    expect(cmdb.assets).toEqual([{ id: 'kept' }]); expect(events.events).toEqual([{ id: 'kept' }]); expect(ai.config.model).toBe('kept-model');
  });
});
