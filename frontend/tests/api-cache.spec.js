import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, bumpHostEpoch, invalidateSwr, streamComposeControl } from '../src/api/client.js';

const response = (name) => new Response(JSON.stringify({ projects: [{ id: name }] }), { headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('API 缓存刷新', () => {
  let fetchMock;
  beforeEach(() => { bumpHostEpoch(); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('只读 POST 不广播写入、不失效缓存，内部元数据不进入 fetch', async () => {
    const changed = vi.fn();
    window.addEventListener('composeops:data-changed', changed);
    try {
      fetchMock.mockResolvedValueOnce(response('cached'));
      await api.getProjects();
      fetchMock.mockResolvedValueOnce(response('preview'));
      await api.previewDeploy('p1');
      expect(changed).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('readOnly');
      fetchMock.mockReturnValueOnce(new Promise(() => {}));
      expect((await api.getProjects()).projects[0].id).toBe('cached');
      fetchMock.mockResolvedValueOnce(response('saved'));
      await api.saveProjectPreference('p1', { name: 'new' });
      expect(changed).toHaveBeenCalledOnce();
      fetchMock.mockResolvedValueOnce(response('fresh'));
      expect((await api.getProjects()).projects[0].id).toBe('fresh');
    } finally { window.removeEventListener('composeops:data-changed', changed); }
  });

  it('强制刷新更新后续读取的缓存', async () => {
    fetchMock.mockResolvedValueOnce(response('old'));
    await api.getProjects();
    fetchMock.mockResolvedValueOnce(response('new'));
    await api.getProjects(true);
    fetchMock.mockResolvedValueOnce(response('new'));
    expect((await api.getProjects()).projects[0].id).toBe('new');
  });

  it('刷新前发出的慢请求不能覆盖强制刷新的结果', async () => {
    fetchMock.mockResolvedValueOnce(response('old'));
    await api.getProjects();
    const slow = deferred();
    fetchMock.mockReturnValueOnce(slow.promise);
    await api.getProjects();
    fetchMock.mockResolvedValueOnce(response('new'));
    await api.getProjects(true);
    slow.resolve(response('stale'));
    await new Promise(resolve => setTimeout(resolve, 0));
    fetchMock.mockResolvedValueOnce(response('new'));
    expect((await api.getProjects()).projects[0].id).toBe('new');
  });

  it('失效缓存后旧的后台刷新不能把缓存复活', async () => {
    fetchMock.mockResolvedValueOnce(response('old'));
    await api.getProjects();
    const slow = deferred();
    fetchMock.mockReturnValueOnce(slow.promise);
    await api.getProjects();
    invalidateSwr('/projects');
    slow.resolve(response('stale'));
    await new Promise(resolve => setTimeout(resolve, 0));
    fetchMock.mockResolvedValueOnce(response('fresh'));
    expect((await api.getProjects()).projects[0].id).toBe('fresh');
  });

  it('首次加载期间发生写入失效,迟到响应也不能缓存', async () => {
    const slow = deferred();
    fetchMock.mockReturnValueOnce(slow.promise);
    const first = api.getProjects();
    invalidateSwr('/projects');
    slow.resolve(response('stale'));
    await first;
    fetchMock.mockResolvedValueOnce(response('fresh'));
    expect((await api.getProjects()).projects[0].id).toBe('fresh');
  });
  it.each(['complete', 'interrupted'])('Compose %s 后不复用执行期间的旧容器缓存', async (outcome) => {
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; } });
    fetchMock.mockResolvedValueOnce(new Response(body));
    const operation = streamComposeControl('project', 'up', () => {});
    const result = operation.catch(error => error);
    await Promise.resolve();
    // A background refresh runs while Compose is replacing its container.
    fetchMock.mockResolvedValueOnce(response('old-container'));
    await api.getProjects();
    if (outcome === 'complete') controller.close();
    else controller.error(new Error('connection lost'));
    await result;
    fetchMock.mockResolvedValueOnce(response('replacement-container'));
    expect((await api.getProjects()).projects[0].id).toBe('replacement-container');
  });

  it('切节点后新请求不会复用旧节点的在途数据', async () => {
    const slow = deferred();
    fetchMock.mockReturnValueOnce(slow.promise);
    const first = api.getProjects();
    bumpHostEpoch();
    fetchMock.mockResolvedValueOnce(response('current-host'));
    expect((await api.getProjects()).projects[0].id).toBe('current-host');
    slow.resolve(response('old-host'));
    await first;
    fetchMock.mockResolvedValueOnce(response('current-host'));
    expect((await api.getProjects()).projects[0].id).toBe('current-host');
  });
  it.each([
    ['工作流', () => api.getWorkflowDefinitions(), () => api.createWorkflowDefinition({ name: 'new' })],
    ['资产', () => api.getCmdbAssets(), () => api.deleteCmdbAsset('asset')],
    ['事件', () => api.getEventStats(), () => api.updateEvent(1, { status: 'resolved' })],
  ])('%s 写入后第一次读取就是新数据', async (_name, read, write) => {
    fetchMock.mockResolvedValueOnce(response('old'));
    await read();
    fetchMock.mockResolvedValueOnce(response('saved'));
    await write();
    fetchMock.mockResolvedValueOnce(response('new'));
    expect((await read()).projects[0].id).toBe('new');
  });
});
