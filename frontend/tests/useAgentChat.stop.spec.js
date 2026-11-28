import { beforeEach, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';

const api = vi.hoisted(() => ({ createAgentSession: vi.fn(), agentExecuteStream: vi.fn(), stopAgentRun: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { useAgentChat } = await import('../src/composables/useAgentChat.js');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let chat, streams, serial = 0;
beforeEach(() => {
  vi.resetAllMocks(); streams = [];
  chat = useAgentChat({ channel: `stop-regression-${++serial}` });
  api.createAgentSession.mockResolvedValue({ sessionId: 7 });
  api.stopAgentRun.mockResolvedValue({ run: { status: 'stopping' } });
  api.agentExecuteStream.mockImplementation((_payload, emit, signal) => {
    const task = deferred();
    signal.addEventListener('abort', () => task.reject(new DOMException('停止', 'AbortError')), { once: true });
    streams.push({ ...task, emit, signal });
    return task.promise;
  });
});
async function start() { const task = chat.sendMessage('只读检查'); await flushPromises(); return { task, stream: streams.at(-1) }; }

it('旧任务停止确认迟到不能中断新任务的连接', async () => {
  const first = await start(); first.stream.emit({ type: 'durable_run', runId: 'old', status: 'running' });
  const stop = deferred(); api.stopAgentRun.mockReturnValue(stop.promise);
  chat.interrupt(); chat.resetSession(); await first.task;
  const second = await start(); stop.resolve({}); await flushPromises();
  expect(second.stream.signal.aborted).toBe(false);
  expect(chat.running.value).toBe(true);
  second.stream.emit({ type: 'done' }); second.stream.resolve(); await second.task;
});

it('任务编号迟到后确认停止时释放原连接，保持后续队列暂停', async () => {
  const first = await start(); await chat.sendMessage('后续检查'); chat.interrupt();
  expect(first.stream.signal.aborted).toBe(false);
  first.stream.emit({ type: 'durable_run', runId: 'late', status: 'running' });
  await flushPromises();
  expect(api.stopAgentRun).toHaveBeenCalledWith('late');
  expect(first.stream.signal.aborted).toBe(true);
  expect(chat.running.value).toBe(false);
  expect(chat.queuePaused.value).toBe(true);
  expect(streams).toHaveLength(1);
  // Also settle the original implementation on failure without leaking work.
  first.stream.resolve(); await first.task;
});

it('任务编号迟到时停止失败明确反馈，继续接收结果且可以重试', async () => {
  const first = await start(); chat.interrupt();
  api.stopAgentRun.mockRejectedValueOnce(new Error('停止服务离线'));
  first.stream.emit({ type: 'durable_run', runId: 'late-failure', status: 'running' });
  await flushPromises();
  expect(chat.messages.value[1].error).toContain('停止请求未确认');
  expect(first.stream.signal.aborted).toBe(false);
  first.stream.emit({ type: 'token', content: '服务端仍在执行，结果继续可见。' });
  chat.interrupt(); await flushPromises(); await first.task;
  expect(chat.messages.value[1].content).toContain('结果继续可见');
  expect(chat.messages.value[1].error).toBeUndefined();
  expect(api.stopAgentRun).toHaveBeenCalledTimes(2);
});

it('连续点击停止只发送一次，终态编号事件不重复停止', async () => {
  const first = await start(); first.stream.emit({ type: 'durable_run', runId: 'repeat', status: 'running' });
  const stop = deferred(); api.stopAgentRun.mockReturnValue(stop.promise);
  chat.interrupt(); chat.interrupt();
  first.stream.emit({ type: 'durable_run', runId: 'repeat', status: 'interrupted' });
  expect(api.stopAgentRun).toHaveBeenCalledTimes(1);
  stop.resolve({}); await flushPromises(); await first.task;
});

it('停止请求失败后任务自行结束，过期的停止错误不覆盖最终结果', async () => {
  const first = await start(); first.stream.emit({ type: 'durable_run', runId: 'finishes', status: 'running' });
  api.stopAgentRun.mockRejectedValueOnce(new Error('响应超时'));
  chat.interrupt(); await flushPromises();
  expect(chat.messages.value[1].error).toContain('停止请求未确认');
  first.stream.emit({ type: 'done', content: '已完成只读核查' }); first.stream.resolve(); await first.task;
  expect(chat.messages.value[1].error).toBeUndefined();
  expect(chat.messages.value[1].content).toBe('已完成只读核查');
});

it('重置后的旧停止失败不能写回新任务或重新打开旧会话', async () => {
  const first = await start(); first.stream.emit({ type: 'durable_run', runId: 'stale', status: 'running' });
  const stop = deferred(); api.stopAgentRun.mockReturnValue(stop.promise);
  chat.interrupt(); chat.resetSession(); await first.task;
  const second = await start(); stop.reject(new Error('旧停止失败')); await flushPromises();
  expect(chat.messages.value[1].error).toBeUndefined(); expect(chat.running.value).toBe(true);
  second.stream.emit({ type: 'done' }); second.stream.resolve(); await second.task;
});

it('只有持久状态缺少结束帧时仍保留未完成提示，不自动运行队列', async () => {
  const first = await start(); await chat.sendMessage('下一项写操作');
  first.stream.emit({ type: 'durable_run', runId: 'incomplete', status: 'failed' });
  first.stream.resolve(); await flushPromises();
  expect(streams).toHaveLength(1);
  expect(chat.messages.value[1].error).toContain('未收到任务完成确认');
  expect(chat.queuePaused.value).toBe(true);
});
