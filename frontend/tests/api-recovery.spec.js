import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, bumpHostEpoch } from '../src/api/client.js';

const ok = () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
const offline = () => new TypeError('Failed to fetch');

describe('API 瞬时断网恢复', () => {
  let fetchMock;
  beforeEach(() => { bumpHostEpoch(); vi.useFakeTimers(); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('GET 断网后短暂等待，只重试一次并恢复正常结果', async () => {
    fetchMock.mockRejectedValueOnce(offline()).mockResolvedValueOnce(ok());
    const pending = api.getProjects();
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('读取响应体期间断流也可恢复', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: () => Promise.reject(offline()) }).mockResolvedValueOnce(ok());
    const pending = api.getProjects();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ ok: true });
  });
  it('持续断网正常报错，不无限重试，也不把失败缓存起来', async () => {
    fetchMock.mockRejectedValue(offline());
    const pending = api.getProjects().catch(error => error);
    await vi.runAllTimersAsync();
    expect((await pending).message).toContain('无法连接服务');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(ok());
    expect(await api.getProjects()).toEqual({ ok: true });
  });
  it.each([401, 403, 404, 429, 500, 503])('HTTP %s 不自动重试', async status => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));
    await expect(api.getProjects()).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['写入', () => api.saveProjectPreference('p1', { name: 'test' })],
    ['只读 POST', () => api.previewDeploy('p1')],
  ])('%s 结果未知时不自动重放', async (_name, call) => {
    fetchMock.mockRejectedValue(offline());
    await expect(call()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('等待恢复期间取消立即释放计时器，不再发请求', async () => {
    const controller = new AbortController();
    fetchMock.mockRejectedValue(offline());
    const pending = api.getAuthStatus(controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect((await pending).name).toBe('AbortError');
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('已经取消的调用不请求，AbortError 和程序 TypeError 不重试', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(api.getAuthStatus(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await expect(api.getProjects()).rejects.toMatchObject({ name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(new TypeError('invalid URL'));
    await expect(api.getProjects()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('等待期间切换节点，旧请求停止，新节点正常读取', async () => {
    fetchMock.mockRejectedValueOnce(offline()).mockResolvedValueOnce(ok());
    const old = api.getProjects().catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    bumpHostEpoch();
    expect(await api.getProjects()).toEqual({ ok: true });
    await vi.runAllTimersAsync();
    expect((await old).name).toBe('AbortError');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
