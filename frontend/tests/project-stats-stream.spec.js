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
  vi.useRealTimers();
});
describe('项目指标连接复用', () => {
  it('四个项目共用一条长连接，全部收到指标；收起只移除相应订阅', async () => {
    let send;
    const fetchMock = vi.fn(async (_url, options) => {
      let closed = false;
      return { ok: true, body: new ReadableStream({
        start(controller) {
          send = frame => controller.enqueue(encoder.encode('data: ' + JSON.stringify(frame) + '\n\n'));
          options.signal.addEventListener('abort', () => { if (!closed) { closed = true; controller.close(); } }, { once: true });
        },
        cancel() { closed = true; },
      }) };
    });
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

it('服务端正常结束也通知视图清除旧指标，再重新连接', async () => {
  let end;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) { end = () => controller.close(); } }) })));
  const view = subscribe('a');
  await vi.waitFor(() => expect(end).toBeTypeOf('function'));
  end();
  await vi.waitFor(() => expect(view.callback).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
});

it('支持 CRLF 分隔和注释字段，不丢失合法数据帧', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(': keepalive\r\nevent: message\r\ndata: {"type":"stats",\r\ndata: "projectId":"a","data":[]}\r\n\r\n'));
  } }) })));
  const view = subscribe('a');
  await vi.waitFor(() => expect(view.callback).toHaveBeenCalledWith({ type: 'stats', projectId: 'a', data: [] }));
});

it('未结束的大帧超过上限后取消读取并提示错误', async () => {
  const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('data: ' + 'x'.repeat(2 * 1024 * 1024 + 1)));
  }, cancel }) })));
  const view = subscribe('a');
  await vi.waitFor(() => expect(view.callback).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(cancel).toHaveBeenCalled();
});

it('建连挂起到期限会取消，通知订阅者并重新尝试', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn((_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
  vi.stubGlobal('fetch', fetchMock);
  const view = subscribe('a');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(view.callback).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
});

it('已建立连接长期没有字节也会取消和重连', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const fetchMock = vi.fn(async () => ({ ok: true, body: new ReadableStream({ cancel }) }));
  vi.stubGlobal('fetch', fetchMock);
  const view = subscribe('a');
  await vi.advanceTimersByTimeAsync(65_000);
  expect(view.callback).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  expect(cancel).toHaveBeenCalled();
  expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
});

it('心跳和其他项目指标不能使本项目旧数值保持新鲜，恢复采样后清除过期状态', async () => {
  vi.useFakeTimers();
  let send;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    send = frame => controller.enqueue(encoder.encode('data: ' + JSON.stringify(frame) + '\n\n'));
  } }) })));
  const a = subscribe('a'), b = subscribe('b');
  await vi.advanceTimersByTimeAsync(1);
  send({ type: 'stats', projectId: 'a', data: [] }); send({ type: 'stats', projectId: 'b', data: [] });
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(15_001);
    send({ type: 'heartbeat' }); send({ type: 'stats', projectId: 'a', data: [] });
  }
  await vi.advanceTimersByTimeAsync(1);
  expect(a.callback.mock.calls.some(([frame]) => frame.code === 'stale')).toBe(false);
  expect(b.callback.mock.calls.filter(([frame]) => frame.code === 'stale')).toHaveLength(1);
  send({ type: 'stats', projectId: 'b', data: [{ cpuPercent: 18 }] });
  await vi.advanceTimersByTimeAsync(1);
  expect(b.callback).toHaveBeenLastCalledWith({ type: 'stats', projectId: 'b', data: [{ cpuPercent: 18 }] });
});

it('末尾 CR 与下个块 LF 拆分时不提前完成事件', async () => {
  let send;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) { send = text => controller.enqueue(encoder.encode(text)); } }) })));
  const view = subscribe('a');
  await vi.waitFor(() => expect(send).toBeTypeOf('function'));
  send('data: {"type":"stats",\r'); send('\ndata: "projectId":"a","data":[]}\r'); send('\n\r'); send('\n');
  await vi.waitFor(() => expect(view.callback).toHaveBeenCalledWith({ type: 'stats', projectId: 'a', data: [] }));
});

it('处理帧期间切换订阅，旧连接的帧不送入新订阅', async () => {
  let send;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    send = frame => controller.enqueue(encoder.encode('data: ' + JSON.stringify(frame) + '\n\n'));
  } }) })));
  let replacement;
  const first = subscribe('a', () => { first.controller.abort(); replacement = subscribe('a'); });
  await vi.waitFor(() => expect(send).toBeTypeOf('function'));
  send({ type: 'stats', projectId: 'a', data: [] });
  await vi.waitFor(() => expect(replacement).toBeDefined());
  expect(replacement.callback).not.toHaveBeenCalled();
});
