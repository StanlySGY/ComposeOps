import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamProjectStats } from '../src/api/project-stats-stream.js';
const controllers = [];
const pending = [];
const encoder = new TextEncoder();
function subscribe(id, callback = vi.fn()) {
  const controller = new AbortController(); controllers.push(controller);
  pending.push(streamProjectStats(id, callback, controller.signal).catch(error => error));
  return { controller, callback };
}
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort());
  await Promise.all(pending.splice(0));
  vi.unstubAllGlobals();
});
describe('项目指标连接复用', () => {
  it('四个项目共用一条长连接，全部收到指标；收起只移除相应订阅', async () => {
    let send;
    const fetchMock = vi.fn(async (_url, options) => ({ ok: true, body: new ReadableStream({
      start(controller) { send = frame => controller.enqueue(encoder.encode('data: ' + JSON.stringify(frame) + '\n\n')); options.signal.addEventListener('abort', () => controller.close(), { once: true }); },
    }) }));
    vi.stubGlobal('fetch', fetchMock);
    const views = Array.from({ length: 4 }, (_, index) => subscribe('project-' + index));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).projectIds).toHaveLength(4);
    for (let index = 0; index < 4; index++) send({ type: 'stats', projectId: 'project-' + index, data: [{ cpuPercent: 10 + index }] });
    await vi.waitFor(() => views.forEach(view => expect(view.callback).toHaveBeenCalledOnce()));
    views[0].controller.abort();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).projectIds).toEqual(['project-1', 'project-2', 'project-3']);
  });
  it('最后订阅退出后释放连接，节点切换取消所有旧订阅', async () => {
    const fetchMock = vi.fn((_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    vi.stubGlobal('fetch', fetchMock);
    subscribe('a'); subscribe('b');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('composeops:host-changed'));
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await Promise.all(pending);
    subscribe('c');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).projectIds).toEqual(['c']);
  });
});
