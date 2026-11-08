import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';

const api = vi.hoisted(() => Object.fromEntries(['createAgentSession', 'agentExecuteStream', 'setAgentApprovalMode', 'truncateAiHistory', 'agentApprove'].map(key => [key, vi.fn()])));
vi.mock('../src/api/client.js', () => ({ api }));
const { useAgentChat } = await import('../src/composables/useAgentChat.js');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let chat, streams, nextChannel = 0;
beforeEach(() => {
  vi.resetAllMocks(); chat = useAgentChat({ channel: `stream-resilience-${++nextChannel}` }); chat.resetSession(); streams = [];
  api.createAgentSession.mockResolvedValue({ sessionId: 8 });
  api.setAgentApprovalMode.mockResolvedValue({ success: true });
  api.truncateAiHistory.mockResolvedValue({ success: true });
  api.agentExecuteStream.mockImplementation((payload, emit, signal) => {
    const task = deferred(); streams.push({ ...task, payload, emit, signal }); return task.promise;
  });
});
async function start(text = '检查服务', extra = {}) { const task = chat.sendMessage(text, extra); await flushPromises(); return { task, stream: streams.at(-1) }; }
function seedHistory() { chat.sessionId.value = 8; chat.messages.value = [
  { id: 1, role: 'user', content: '第一条问题', persistedId: 101 }, { id: 2, role: 'assistant', content: '第一条答案' },
  { id: 3, role: 'user', content: '第二条问题', persistedId: 103 }, { id: 4, role: 'assistant', content: '第二条答案' },
]; }

describe('共享 Agent 异步状态隔离', () => {
  it('并发取得会话合并为一次创建', async () => {
    const pending = deferred(); api.createAgentSession.mockReturnValue(pending.promise);
    const first = chat.ensureSession(), second = chat.ensureSession();
    expect(api.createAgentSession).toHaveBeenCalledTimes(1);
    pending.resolve({ sessionId: 9 }); expect(await first).toBe(9); expect(await second).toBe(9);
  });
  it('等待创建时已呈现执行态，停止后迟到创建不能执行', async () => {
    const pending = deferred(); api.createAgentSession.mockReturnValue(pending.promise);
    chat.input.value = '检查服务'; const task = chat.sendMessage(chat.input.value);
    expect(chat.running.value).toBe(true); chat.interrupt(); expect(chat.running.value).toBe(false); expect(chat.input.value).toBe('检查服务'); pending.resolve({ sessionId: 9 }); await task;
    expect(api.agentExecuteStream).not.toHaveBeenCalled(); expect(chat.input.value).toBe('检查服务');
  });
  it('重置后旧创建不会恢复已丢弃会话或发送旧内容', async () => {
    const pending = deferred(); api.createAgentSession.mockReturnValue(pending.promise);
    const task = chat.sendMessage('旧任务'); chat.resetSession(); pending.resolve({ sessionId: 9 }); await task;
    expect(chat.sessionId.value).toBeNull(); expect(api.agentExecuteStream).not.toHaveBeenCalled(); expect(chat.messages.value).toEqual([]);
  });
  it('创建失败保留草稿并释放执行态，允许重试', async () => {
    chat.input.value = '尚未送达'; api.createAgentSession.mockRejectedValueOnce(new Error('离线'));
    await expect(chat.sendMessage(chat.input.value)).rejects.toThrow('离线'); expect(chat.input.value).toBe('尚未送达'); expect(chat.running.value).toBe(false);
    const { task, stream } = await start(chat.input.value); stream.resolve(); await task; expect(chat.messages.value[0].content).toBe('尚未送达');
  });
  it('创建过程中输入的新草稿不会被发送请求清空', async () => {
    const pending = deferred(); api.createAgentSession.mockReturnValue(pending.promise);
    chat.input.value = '第一条'; const task = chat.sendMessage('第一条'); chat.input.value = '下一条草稿'; pending.resolve({ sessionId: 9 }); await flushPromises();
    expect(chat.input.value).toBe('下一条草稿'); streams[0].resolve(); await task;
  });
  it('中断暂停队列并保留已到达回复，必须主动恢复', async () => {
    const { task, stream } = await start(); stream.emit({ type: 'token', content: '已有结果 ' });
    await chat.sendMessage('下一条'); chat.interrupt(); stream.reject(new DOMException('停止', 'AbortError')); await task;
    expect(streams).toHaveLength(1); expect(chat.pendingQueue.value).toHaveLength(1); expect(chat.queuePaused.value).toBe(true);
    expect(chat.messages.value[1]).toMatchObject({ content: '已有结果 ', interrupted: true });
    const resume = chat.resumeQueue(); await flushPromises(); expect(streams).toHaveLength(2); streams[1].resolve(); await resume;
    expect(chat.pendingQueue.value).toEqual([]);
  });
  it('网络失败不覆盖已接收文本且不自动运行下一项', async () => {
    const { task, stream } = await start(); stream.emit({ type: 'token', content: '| a | b |\n' }); await chat.sendMessage('待处理');
    stream.reject(new Error('连接断开')); await task;
    expect(chat.messages.value[1].content).toBe('| a | b |\n'); expect(chat.messages.value[1].error).toContain('连接断开'); expect(streams).toHaveLength(1);
  });
  it('服务端明确失败也暂停后续队列', async () => {
    const { task, stream } = await start(); await chat.sendMessage('待处理'); stream.emit({ type: 'error', content: '工具循环失败' }); stream.resolve(); await task;
    expect(streams).toHaveLength(1); expect(chat.queuePaused.value).toBe(true);
  });
  it('重置后旧流事件和收尾不能覆盖新执行或已落库ID', async () => {
    const first = await start('旧任务'); chat.resetSession(); const second = await start('新任务');
    first.stream.emit({ type: 'session_meta', userMessageId: 101 }); first.stream.emit({ type: 'token', content: '旧内容' }); first.stream.resolve(); await first.task;
    expect(chat.running.value).toBe(true); expect(chat.messages.value[0].persistedId).toBe(0); expect(chat.messages.value[1].content).toBe('');
    chat.interrupt(); expect(second.stream.signal.aborted).toBe(true); second.stream.resolve(); await second.task;
  });
  it('恢复中断任务沿用该轮项目、角色和日志，不携带DOM事件', async () => {
    const { task, stream } = await start('排障', { role: 'validator', projectId: 'p1', attachedLogs: '证据' });
    chat.interrupt(); stream.reject(new DOMException('停止', 'AbortError')); await task;
    const continuation = chat.continueAfterInterrupt(); await flushPromises();
    expect(streams[1].payload).toMatchObject({ role: 'validator', projectId: 'p1', attachedLogs: '证据' }); streams[1].resolve(); await continuation;
  });
  it('重新生成指定回复对应的问题，后续历史准确截断', async () => {
    seedHistory(); const task = chat.regenerate({}, 2); await flushPromises();
    expect(api.truncateAiHistory).toHaveBeenCalledWith(8, 101); expect(streams[0].payload.message).toBe('第一条问题'); streams[0].resolve(); await task;
  });
  it('历史截断期间重复点击只发起一次请求', async () => {
    seedHistory(); const pending = deferred(); api.truncateAiHistory.mockReturnValue(pending.promise);
    const first = chat.editAndResend(1, '修订'); const second = chat.editAndResend(1, '重复');
    expect(api.truncateAiHistory).toHaveBeenCalledTimes(1); pending.resolve({}); await flushPromises(); streams[0].resolve(); await Promise.all([first, second]);
  });
  it('截断途中重置后迟到结果不能裁剪新会话消息', async () => {
    seedHistory(); const pending = deferred(); api.truncateAiHistory.mockReturnValue(pending.promise);
    const task = chat.editAndResend(1, '修订'); chat.resetSession(); chat.messages.value = [{ id: 20, role: 'user', content: '新的草稿' }];
    pending.resolve({}); await task; expect(chat.messages.value).toHaveLength(1); expect(api.agentExecuteStream).not.toHaveBeenCalled();
  });
  it('旧审批完成不能清除更新的确认卡', async () => {
    const pending = deferred(); api.agentApprove.mockReturnValue(pending.promise);
    const message = { confirmation: { executionId: 'old', toolCallId: 'a' } }; const task = chat.approve(message);
    message.confirmation = { executionId: 'new', toolCallId: 'b' }; pending.resolve({}); await task;
    expect(message.confirmation?.executionId).toBe('new');
  });
  it('模式更新串行化且旧请求失败不回滚新会话', async () => {
    const pending = deferred(); api.setAgentApprovalMode.mockReturnValue(pending.promise);
    const task = chat.setApprovalMode('full'); await flushPromises(); chat.resetSession(); chat.approvalMode.value = 'allow_writes';
    pending.reject(new Error('旧请求失败')); await task; expect(chat.approvalMode.value).toBe('allow_writes');
  });
  it('暂停队列可移除指定消息且不改变其他任务顺序', async () => {
    const first = await start(); await chat.sendMessage('保留的任务'); await chat.sendMessage('移除的任务');
    chat.interrupt(); first.stream.resolve(); await first.task;
    const id = chat.pendingQueue.value[1].id; chat.removeQueued(id);
    expect(chat.pendingQueue.value.map(item => item.text)).toEqual(['保留的任务']);
    await chat.sendMessage('稍后处理'); expect(streams).toHaveLength(1);
    expect(chat.pendingQueue.value.map(item => item.text)).toEqual(['保留的任务', '稍后处理']);
  });
  it('中断后移除最后一个待发项并立即排队也不能触发自动续发', async () => {
    const first = await start(); await chat.sendMessage('移除的任务'); chat.interrupt(); chat.removeQueued(chat.pendingQueue.value[0].id);
    await chat.sendMessage('保留待发'); first.stream.resolve(); await first.task;
    expect(streams).toHaveLength(1); expect(chat.queuePaused.value).toBe(true);
  });
  it('没有积压时新发的一轮能正常串行发送队列', async () => {
    const first = await start(); chat.interrupt(); first.stream.resolve(); await first.task;
    const second = await start('新的任务'); await chat.sendMessage('随后处理'); second.stream.emit({ type: 'done' }); second.stream.resolve(); await flushPromises();
    expect(streams).toHaveLength(3); streams[2].resolve(); await second.task;
  });
  it('共享历史恢复状态和写锁阻止抽屉发送，释放后可继续', async () => {
    chat.historyLoading.value = true;
    await expect(chat.sendMessage('不能提前发送')).rejects.toThrow('同步');
    chat.historyLoading.value = false; const unlock = chat.lockSession('历史写入');
    await expect(chat.sendMessage('不能并发发送')).rejects.toThrow('同步'); unlock();
    const { task, stream } = await start(); stream.resolve(); await task; expect(streams).toHaveLength(1);
  });
  it('相邻两次模式操作不会并发写入，确认前显示旧模式', async () => {
    const pending = deferred(); api.setAgentApprovalMode.mockReturnValue(pending.promise);
    const task = chat.setApprovalMode('full'); await flushPromises(); expect(chat.approvalMode.value).toBe('ask');
    expect(await chat.setApprovalMode('allow_writes')).toBe(false); expect(api.setAgentApprovalMode).toHaveBeenCalledTimes(1);
    pending.resolve({}); await task; expect(chat.approvalMode.value).toBe('full');
  });
  it('已更新的审批模式不被旧执行流的启动事件覆盖', async () => {
    const { task, stream } = await start(); await chat.setApprovalMode('full'); stream.emit({ type: 'approval_mode', mode: 'ask' });
    expect(chat.approvalMode.value).toBe('full'); stream.resolve(); await task;
  });
  it('连接提前正常关闭但没有完成事件时，不推断成功或自动续发', async () => {
    const { task, stream } = await start(); stream.emit({ type: 'token', content: '只收到一部分结果' }); await chat.sendMessage('待发送'); stream.resolve(); await task;
    expect(chat.messages.value[1].error).toContain('未收到任务完成确认'); expect(chat.queuePaused.value).toBe(true); expect(streams).toHaveLength(1);
  });
});
