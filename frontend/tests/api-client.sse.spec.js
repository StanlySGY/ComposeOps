import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamSse } from '../src/api/client.js';

afterEach(() => vi.unstubAllGlobals());

describe('streamSse', () => {
  it('在流未结束前立即分发到达的帧，并支持 CRLF 与最后一个无空行终止帧', async () => {
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const received = [];
    let settled = false;
    const task = streamSse('/ai/agent/execute-stream', {}, event => received.push(event)).finally(() => { settled = true; });
    controller.enqueue(new TextEncoder().encode('data: {"type":"thinking","round":1}\r\n\r\n'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(received).toEqual([{ type: 'thinking', round: 1 }]);
    expect(settled).toBe(false);
    controller.enqueue(new TextEncoder().encode('data: {"type":"token","content":"逐字输出"}'));
    controller.close();
    await task;
    expect(received).toEqual([{ type: 'thinking', round: 1 }, { type: 'token', content: '逐字输出' }]);
  });

  it('回调异常向调用方传播，不会被当作无效 JSON 静默吞掉', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"token"}\n\n')); controller.close(); } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    await expect(streamSse('/ai/agent/execute-stream', {}, () => { throw new Error('render callback failed'); })).rejects.toThrow('render callback failed');
  });
});
