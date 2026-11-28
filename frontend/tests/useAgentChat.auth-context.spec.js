import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';

const api = vi.hoisted(() => Object.fromEntries(['createAgentSession', 'agentExecuteStream', 'getAgentRun', 'resumeAgentRun', 'stopAgentRun'].map(key => [key, vi.fn()])));
vi.mock('../src/api/client.js', () => ({ api }));
const { useAgentChat } = await import('../src/composables/useAgentChat.js');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let chat, streams;
beforeEach(() => {
  vi.resetAllMocks(); advanceAuthEpoch(); chat = useAgentChat(); chat.resetSession(); streams = [];
  api.createAgentSession.mockResolvedValue({ sessionId: 12 });
  api.agentExecuteStream.mockImplementation((payload, emit, signal) => {
    const pending = deferred(); streams.push({ ...pending, payload, emit, signal }); return pending.promise;
  });
});
afterEach(() => { chat.resetSession(); vi.useRealTimers(); });
async function start(text) { const task = chat.sendMessage(text); await flushPromises(); return { task, stream: streams.at(-1) }; }

describe('Agent 客户端会话在认证变化时隔离', () => {
  it('清理聊天、草稿、会话、待发队列与审批模式，已挂载实例也同步清空', () => {
    const drawer = useAgentChat();
    chat.messages.value = [{ id: 1, role: 'user', content: '旧账号项目' }]; chat.input.value = '旧草稿';
    chat.sessionId.value = 12; chat.pendingQueue.value = [{ id: 1, text: '旧动作' }]; chat.approvalMode.value = 'full';
    advanceAuthEpoch();
    expect(drawer.messages.value).toEqual([]); expect(drawer.input.value).toBe(''); expect(drawer.sessionId.value).toBeNull();
    expect(drawer.pendingQueue.value).toEqual([]); expect(drawer.approvalMode.value).toBe('ask');
  });

  it('只断开旧前端流，不发送后台停止指令，迟到事件和收尾不覆盖新任务', async () => {
    const old = await start('旧任务'); old.stream.emit({ type: 'durable_run', runId: 'old-run' });
    old.stream.emit({ type: 'token', content: '缓存中的旧文字' }); await chat.sendMessage('旧队列');
    advanceAuthEpoch();
    expect(old.stream.signal.aborted).toBe(true); expect(api.stopAgentRun).not.toHaveBeenCalled();
    const fresh = await start('新任务');
    old.stream.emit({ type: 'token', content: '迟到的旧文字' }); old.stream.emit({ type: 'done', content: '旧结果' });
    old.stream.resolve(); await old.task;
    expect(chat.messages.value.map(message => message.content)).toEqual(['新任务', '']);
    expect(chat.running.value).toBe(true); expect(chat.pendingQueue.value).toEqual([]);
    fresh.stream.emit({ type: 'done', content: '新结果' }); fresh.stream.resolve(); await fresh.task;
    expect(streams).toHaveLength(2);
  });

  it('迟到的会话创建不能在新账号下发送旧草稿', async () => {
    const pending = deferred(); api.createAgentSession.mockReturnValue(pending.promise);
    chat.input.value = '旧草稿'; const task = chat.sendMessage('旧草稿'); advanceAuthEpoch();
    pending.resolve({ sessionId: 12 }); await task;
    expect(api.agentExecuteStream).not.toHaveBeenCalled(); expect(chat.input.value).toBe(''); expect(chat.sessionId.value).toBeNull();
  });

  it('恢复队列时创建失败，认证变化后不把旧待发内容重新插回', async () => {
    const pending = deferred(); api.createAgentSession.mockReturnValue(pending.promise);
    chat.pendingQueue.value = [{ id: 1, text: '旧队列' }]; chat.queuePaused.value = true;
    const task = chat.resumeQueue().catch(error => error); advanceAuthEpoch(); pending.reject(new Error('旧连接失效')); await task;
    expect(chat.pendingQueue.value).toEqual([]); expect(chat.input.value).toBe('');
  });

  it('读取中断任务时认证变化，不会接着用新身份发出恢复写入', async () => {
    const pending = deferred(); api.getAgentRun.mockReturnValue(pending.promise);
    chat.sessionId.value = 12;
    chat.messages.value = [{ id: 1, role: 'assistant', interrupted: true, durableRunId: 'old-run' }];
    const task = chat.continueAfterInterrupt(); advanceAuthEpoch();
    pending.resolve({ run: { id: 'old-run', revision: 3 } }); await task;
    expect(api.resumeAgentRun).not.toHaveBeenCalled();
  });
});
