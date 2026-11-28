import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { api, followDeploymentJob, streamComposeControl } from '../src/api/client.js';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const bytes = text => new TextEncoder().encode(text);
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
function stream() {
  let writer;
  const cancel = vi.fn(), body = new ReadableStream({ start(value) { writer = value; }, cancel });
  return { body, cancel, writer, close() { try { writer.close(); } catch { /* Cancelled by implementation. */ } } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

for (const [name, start] of [
  ['部署控制', (receive, signal) => streamComposeControl('project', 'up', receive, null, null, signal)],
  ['任务订阅', (receive, signal) => api.streamJobUpdates('job', receive, signal)],
]) describe(name + '流的身份与资源边界', () => {
  it('EOF 前没有空行的终态消息不算完整 SSE 事件', async () => {
    const fixture = stream(); fixture.writer.enqueue(bytes('data: {"type":"exit","data":{"code":0}}')); fixture.close();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture.body))); const receive = vi.fn();
    await start(receive); expect(receive).not.toHaveBeenCalled(); expect(fixture.body.locked).toBe(false);
  });

  it('认证变化关闭安静的旧流且释放 reader，不依赖新的消息', async () => {
    const fixture = stream(), received = [];
    const fetchMock = vi.fn(async () => new Response(fixture.body)); vi.stubGlobal('fetch', fetchMock);
    const task = start(value => received.push(value)).catch(error => error);
    try {
      fixture.writer.enqueue(bytes(frame({ type: 'output', data: 'old' }))); await flushPromises();
      advanceAuthEpoch(); await flushPromises();
      expect(fixture.cancel).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
      expect(await task).toMatchObject({ name: 'AbortError' }); expect(fixture.body.locked).toBe(false);
      expect(received).toEqual([{ type: 'output', data: 'old' }]);
    } finally { fixture.close(); await task; }
  });

  it('同一批数据第一帧改变身份后，剩余旧帧不再派发', async () => {
    const fixture = stream(); fixture.writer.enqueue(bytes(frame({ type: 'output', data: 'first' }) + frame({ type: 'output', data: 'old-second' }))); fixture.close();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture.body))); const received = [];
    await expect(start(value => { received.push(value); advanceAuthEpoch(); })).rejects.toMatchObject({ name: 'AbortError' });
    expect(received).toEqual([{ type: 'output', data: 'first' }]); expect(fixture.body.locked).toBe(false);
  });

  it('旧响应头迟到时取消 body，不能写入新会话', async () => {
    const pending = deferred(), fixture = stream(), receive = vi.fn();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise)); const task = start(receive).catch(error => error);
    try {
      advanceAuthEpoch(); pending.resolve(new Response(fixture.body)); await flushPromises();
      expect(fixture.cancel).toHaveBeenCalledOnce(); expect(await task).toMatchObject({ name: 'AbortError' });
      expect(receive).not.toHaveBeenCalled();
    } finally { fixture.close(); await task; }
  });

  it('当前 401 通知过期；旧 401 不影响新身份', async () => {
    const unauthorized = vi.fn(); window.addEventListener('composeops:unauthorized', unauthorized);
    try {
      const old = deferred(); vi.stubGlobal('fetch', vi.fn(() => old.promise));
      const task = start(() => {}).catch(error => error); advanceAuthEpoch();
      old.resolve(new Response('{"message":"old"}', { status: 401 })); await task;
      expect(unauthorized).not.toHaveBeenCalled();
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"current"}', { status: 401 })));
      await expect(start(() => {})).rejects.toMatchObject({ status: 401 }); expect(unauthorized).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('composeops:unauthorized', unauthorized); }
  });

  it('消费者异常会报告失败并关闭流，不能被当成坏 JSON 忽略', async () => {
    const fixture = stream(); fixture.writer.enqueue(bytes(frame({ type: 'output', data: 'old' })));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture.body)));
    const task = start(() => { throw new Error('consumer failed'); }).catch(error => error);
    try {
      await flushPromises(); expect(fixture.cancel).toHaveBeenCalledOnce();
      expect((await task).message).toBe('consumer failed'); expect(fixture.body.locked).toBe(false);
    } finally { fixture.close(); await task; }
  });
});

it('任务流支持跨片 CRLF、多行 data 和 UTF8，限制超大未结束帧', async () => {
  const encoder = bytes('data: {"type":"output",\r\ndata: "data":"中文  "}\r\n\r\n');
  const fixture = stream(); for (let offset = 0; offset < encoder.length; offset += 3) fixture.writer.enqueue(encoder.slice(offset, offset + 3)); fixture.close();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture.body))); const received = [];
  await api.streamJobUpdates('job', value => received.push(value));
  expect(received).toEqual([{ type: 'output', data: '中文  ' }]); expect(fixture.body.locked).toBe(false);
  const huge = stream(); huge.writer.enqueue(bytes('data: ' + 'x'.repeat(2 * 1024 * 1024)));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(huge.body)));
  const task = api.streamJobUpdates('job', () => {}).catch(error => error);
  try {
    await flushPromises(); expect(huge.cancel).toHaveBeenCalledOnce(); expect((await task).message).toMatch(/上限|过大/);
  } finally { huge.close(); await task; }
});

it('部署跟踪在轮询等待期间身份改变，不会用新 Cookie 继续读取旧任务', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'job', status: 'running', items: [] }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock); const received = [], controller = new AbortController();
  const task = followDeploymentJob('job', frame => received.push(frame), controller.signal).catch(error => error);
  try {
    await flushPromises(); expect(fetchMock).toHaveBeenCalledTimes(1);
    advanceAuthEpoch(); await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(await task).toMatchObject({ name: 'AbortError' });
  } finally { controller.abort(); await task; }
});
