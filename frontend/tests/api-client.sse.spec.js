import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, streamSse } from '../src/api/client.js';

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

  it('解析 AG-UI 命名 SSE 事件并只向聊天状态机透传受信任的 ComposeOps 扩展', async () => {
    const frames = [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '你好' },
      { type: 'CUSTOM', name: 'composeops.confirmation_required', value: { type: 'confirmation_required', toolCallId: 'c1' } },
      { type: 'RUN_FINISHED', threadId: 't', runId: 'r' },
    ].map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frames)); controller.close(); } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const received = [];
    await streamSse('/ai/agent/execute-stream', { protocol: 'ag-ui' }, event => received.push(event), undefined, 'ag-ui');
    expect(received).toEqual([
      { type: 'token', content: '你好' },
      { type: 'confirmation_required', toolCallId: 'c1' },
    ]);
  });

  it('Agent 默认请求 AG-UI 传输协议', async () => {
    const body = new ReadableStream({ start(controller) { controller.close(); } });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.agentExecuteStream({ sessionId: 7, message: '测试' }, () => {});
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).protocol).toBe('ag-ui');
  });
});
