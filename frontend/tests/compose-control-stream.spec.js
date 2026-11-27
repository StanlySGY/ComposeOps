import { afterEach, expect, it, vi } from 'vitest';
import { streamComposeControl } from '../src/api/client.js';
afterEach(() => vi.unstubAllGlobals());
const bytes = value => new TextEncoder().encode(value);
function response(chunks, { close = true, cancel = () => {} } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(bytes(chunk)); if (close) controller.close(); }, cancel,
  }), { headers: { 'content-type': 'text/event-stream' } })));
}
it('控制流跨分片 CRLF 分隔和错误JSON后继续读取，中文及空格不被丢弃', async () => {
  response(['data: {invalid}\r\n\r', '\ndata: {"type":"stdout","data":"你好  "}\r\n\r', '\ndata: {"type":"exit","data":{"code":0}}\n\n']);
  const seen = [];
  await streamComposeControl('test', 'up', frame => seen.push(frame));
  expect(seen).toEqual([{ type: 'stdout', data: '你好  ' }, { type: 'exit', data: { code: 0 } }]);
});
it('无边界的超大控制帧停止接收并取消流，不能无界增长', async () => {
  const cancel = vi.fn(); response(['data: ' + 'x'.repeat(2 * 1024 * 1024)], { close: false, cancel });
  await expect(streamComposeControl('test', 'up', vi.fn())).rejects.toThrow('持续未结束');
  expect(cancel).toHaveBeenCalledOnce();
});
it('完整超大控制帧也拒绝，不执行回调', async () => {
  const seen = vi.fn(); response(['data: ' + 'x'.repeat(2 * 1024 * 1024) + '\n\n']);
  await expect(streamComposeControl('test', 'up', seen)).rejects.toThrow('单条控制消息');
  expect(seen).not.toHaveBeenCalled();
});
it('消费者回调错误向调用方报告并关闭流，不假装操作已完成', async () => {
  const cancel = vi.fn(); response(['data: {"type":"stdout","data":"test"}\n\n'], { close: false, cancel });
  await expect(streamComposeControl('test', 'up', () => { throw new Error('consumer failed'); })).rejects.toThrow('consumer failed');
  expect(cancel).toHaveBeenCalledOnce();
});
