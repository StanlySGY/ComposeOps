import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { streamSse } from '../src/api/client.js';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const bytes = text => new TextEncoder().encode(text);
const frame = content => `data: ${JSON.stringify({ type: 'token', content })}\n\n`;
afterEach(() => { vi.unstubAllGlobals(); });

describe('AI SSE 认证归属和接收生命周期', () => {
  it('认证变化立即断开无新事件的流，释放 reader 且不再派发帧', async () => {
    const cancel = vi.fn(); let controller;
    const body = new ReadableStream({ start(value) { controller = value; }, cancel });
    const fetchMock = vi.fn(async () => new Response(body)); vi.stubGlobal('fetch', fetchMock);
    const received = [], task = streamSse('/ai/diagnose', {}, value => received.push(value)).catch(error => error);
    controller.enqueue(bytes(frame('已有结果'))); await flushPromises();
    advanceAuthEpoch(); await flushPromises();
    expect(cancel).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(await task).toMatchObject({ name: 'AbortError' }); expect(body.locked).toBe(false);
    expect(received).toEqual([{ type: 'token', content: '已有结果' }]);
  });

  it('旧响应头迟到时取消其 body，不能交给新账号', async () => {
    const pending = deferred(), cancel = vi.fn(); const body = new ReadableStream({ cancel });
    vi.stubGlobal('fetch', vi.fn(() => pending.promise)); const receive = vi.fn();
    const task = streamSse('/ai/diagnose', {}, receive).catch(error => error);
    advanceAuthEpoch(); pending.resolve(new Response(body)); await flushPromises();
    expect(cancel).toHaveBeenCalledOnce(); expect(await task).toMatchObject({ name: 'AbortError' }); expect(receive).not.toHaveBeenCalled();
  });

  it('旧 401 响应不退出新账号，当前 401 仍通知认证失效', async () => {
    const unauthorized = vi.fn(); window.addEventListener('composeops:unauthorized', unauthorized);
    try {
      const pending = deferred(); vi.stubGlobal('fetch', vi.fn(() => pending.promise));
      const task = streamSse('/ai/diagnose', {}, () => {}).catch(error => error); advanceAuthEpoch();
      pending.resolve(new Response('{"message":"旧登录失效"}', { status: 401 })); await task;
      expect(unauthorized).not.toHaveBeenCalled();
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"请登录"}', { status: 401 })));
      await expect(streamSse('/ai/diagnose', {}, () => {})).rejects.toMatchObject({ status: 401 });
      expect(unauthorized).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('composeops:unauthorized', unauthorized); }
  });

  it('同一数据块内回调改变身份后，剩余帧不再派发', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(bytes(frame('first') + frame('old-second'))); controller.close(); } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body))); const received = [];
    await expect(streamSse('/ai/diagnose', {}, value => { received.push(value); advanceAuthEpoch(); })).rejects.toMatchObject({ name: 'AbortError' });
    expect(received.map(item => item.content)).toEqual(['first']); expect(body.locked).toBe(false);
  });

  it('消费回调出错时取消未关闭的网络流，释放锁', async () => {
    const cancel = vi.fn(); const body = new ReadableStream({ start(controller) { controller.enqueue(bytes(frame('first'))); }, cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    await expect(streamSse('/ai/diagnose', {}, () => { throw new Error('consumer failed'); })).rejects.toThrow('consumer failed');
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
  });

  it('调用者中断可关闭忽略 fetch signal 的接收流', async () => {
    const cancel = vi.fn(); const body = new ReadableStream({ cancel }), controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const task = streamSse('/ai/diagnose', {}, () => {}, controller.signal).catch(error => error);
    await flushPromises(); controller.abort(); await flushPromises();
    expect(cancel).toHaveBeenCalledOnce(); expect(await task).toMatchObject({ name: 'AbortError' }); expect(body.locked).toBe(false);
  });

  it('帧持续不结束时限制缓冲区并取消流', async () => {
    const cancel = vi.fn(); const body = new ReadableStream({ start(controller) { controller.enqueue(bytes('data: ' + 'x'.repeat(2 * 1024 * 1024))); }, cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const task = streamSse('/ai/diagnose', {}, () => {}).catch(error => error); await flushPromises();
    expect(cancel).toHaveBeenCalledOnce(); expect((await task).message).toMatch(/过大|过长|上限/); expect(body.locked).toBe(false);
  });

  it('正常结束释放 reader，后续认证变化不再触发旧连接', async () => {
    const body = new ReadableStream({ start(controller) { controller.close(); } });
    const fetchMock = vi.fn(async () => new Response(body)); vi.stubGlobal('fetch', fetchMock);
    await streamSse('/ai/diagnose', {}, () => {}); expect(body.locked).toBe(false);
    advanceAuthEpoch(); expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
  });
});
