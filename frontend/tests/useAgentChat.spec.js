import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  agentExecuteStream: vi.fn(),
  agentApprove: vi.fn(),
}));
vi.mock('../src/api/client.js', () => ({ api: apiMock }));

const { useAgentChat, WORKBENCH_CHANNEL, PAGE_DRAWER_CHANNEL } = await import('../src/composables/useAgentChat.js');

describe('useAgentChat', () => {
  it('渠道切换独立显示，不污染回复正文且相同渠道不重复刷提示', async () => {
    const chat = useAgentChat({ channel: 'ai-channel-events' });
    apiMock.createAgentSession.mockResolvedValue({ sessionId: 17 });
    apiMock.agentExecuteStream.mockImplementation(async (_payload, onEvent) => {
      onEvent({ type: 'channel_failed', content: '主渠道超时，尝试备用' });
      for (let i = 0; i < 2; i++) onEvent({ type: 'channel_selected', channelName: '备用', model: 'm', content: '使用备用' });
      onEvent({ type: 'token', content: '回答正文' });
    });
    await chat.sendMessage('测试');
    const answer = chat.messages.value[1];
    expect(answer.content).toBe('回答正文');
    expect(answer.taskNotices).toEqual(['主渠道超时，尝试备用', '使用备用']);
    expect(answer.aiChannel).toEqual({ name: '备用', model: 'm' });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.createAgentSession.mockResolvedValue({ sessionId: 7 });
  });

  it('发送时惰性建会话,不回传 history,token 分片原样拼接', async () => {
    const chat = useAgentChat();
    apiMock.agentExecuteStream.mockImplementation(async (payload, onEvent) => {
      expect(payload.sessionId).toBe(7);
      expect(payload.history).toBeUndefined();
      onEvent({ type: 'token', content: '结论 ' });
      onEvent({ type: 'token', content: '\n\n| a | b |' });
    });
    await chat.sendMessage('检查项目', { pageContext: { page: '服务' } });
    expect(apiMock.createAgentSession).toHaveBeenCalledTimes(1);
    expect(chat.messages.value).toHaveLength(2);
    expect(chat.messages.value[1].content).toBe('结论 \n\n| a | b |');
    expect(chat.running.value).toBe(false);
    expect(chat.messages.value[1].streaming).toBe(false);
  });

  it('done 事件用后端最终全文覆盖,自愈流式期间任何错位', async () => {
    const chat = useAgentChat();
    apiMock.agentExecuteStream.mockImplementation(async (payload, onEvent) => {
      onEvent({ type: 'token', content: '流式中间态 tool_' });
      onEvent({ type: 'done', content: '最终干净文本' });
    });
    await chat.sendMessage('hi');
    expect(chat.messages.value[1].content).toBe('最终干净文本');
  });

  it('error/interrupted 追加并清理确认卡,confirmation 卡走 approve', async () => {
    const chat = useAgentChat();
    apiMock.agentExecuteStream.mockImplementation(async (payload, onEvent) => {
      onEvent({ type: 'confirmation_required', executionId: 'plan-1', toolCallId: 'call-1', description: '重启' });
      onEvent({ type: 'error', content: '执行失败' });
    });
    await chat.sendMessage('hi');
    const assistant = chat.messages.value[1];
    expect(assistant.confirmation).toBeNull();
    expect(assistant.content).toContain('执行失败');

    apiMock.agentApprove.mockResolvedValue({ success: true });
    const message = { confirmation: { executionId: 'p', toolCallId: 'c', busy: false } };
    await chat.approve(message);
    expect(apiMock.agentApprove).toHaveBeenCalledWith({ executionId: 'p', toolCallId: 'c', approved: true });
    expect(message.confirmation).toBeNull();
  });

  it('抽屉频道与工作台频道完全隔离,互不串会话', async () => {
    const workbench = useAgentChat({ channel: WORKBENCH_CHANNEL });
    apiMock.agentExecuteStream.mockImplementation(async (payload, onEvent) => {
      onEvent({ type: 'token', content: '工作台的回答' });
    });
    await workbench.sendMessage('工作台的问题');

    const drawer = useAgentChat({ channel: PAGE_DRAWER_CHANNEL });
    // 抽屉此时必须是干净的:既没有工作台的消息,也没有它的 sessionId
    expect(drawer.messages.value).toHaveLength(0);
    expect(drawer.sessionId.value).toBeNull();

    apiMock.createAgentSession.mockResolvedValue({ sessionId: 99 });
    apiMock.agentExecuteStream.mockImplementation(async (payload, onEvent) => {
      expect(payload.sessionId).toBe(99);
      onEvent({ type: 'token', content: '抽屉的回答' });
    });
    await drawer.sendMessage('抽屉的问题', { pageContext: { page: '服务' } });

    expect(drawer.messages.value.map((m) => m.content)).toEqual(['抽屉的问题', '抽屉的回答']);
    expect(workbench.messages.value.map((m) => m.content)).toEqual(['工作台的问题', '工作台的回答']);
  });

  it('思考过程按轮次增量累积,done 之后仍然保留', async () => {
    const chat = useAgentChat({ channel: 'thinking-test' });
    apiMock.agentExecuteStream.mockImplementation(async (payload, onEvent) => {
      onEvent({ type: 'thinking', round: 1 });
      onEvent({ type: 'reasoning', round: 1, content: '先看容器状态。' });
      onEvent({ type: 'reasoning', round: 1, content: '再看最近日志。' });
      onEvent({ type: 'thinking', round: 2 });
      onEvent({ type: 'reasoning', round: 2, content: '确认没有异常。' });
      onEvent({ type: 'token', content: '结论:一切正常。' });
      onEvent({ type: 'done', content: '结论:一切正常。' });
    });
    await chat.sendMessage('检查一下');

    const assistant = chat.messages.value[1];
    // 增量拼接而不是覆盖:这是"点开只有一句占位、结束就没了"的根因修复
    expect(assistant.thinking).toEqual([
      { round: 1, content: '先看容器状态。再看最近日志。', streaming: true },
      { round: 2, content: '确认没有异常。', streaming: true },
    ]);
  });

  it('tool_executing 的参数会落到对应工具条目上,展开不再是空', async () => {
    const chat = useAgentChat({ channel: 'tool-params-test' });
    apiMock.agentExecuteStream.mockImplementation(async (payload, onEvent) => {
      onEvent({ type: 'tool_requested', tool: 'compose.restart', paramsText: '{"service":"web"}' });
      onEvent({ type: 'tool_executing', tool: 'compose.restart', paramsText: '{"service":"web"}' });
      onEvent({ type: 'tool_result', tool: 'compose.restart', success: true, durationMs: 120, summary: '{"ok":true}' });
    });
    await chat.sendMessage('重启 web');

    const tool = chat.messages.value[1].tools[0];
    expect(tool.paramsText).toBe('{"service":"web"}');
    expect(tool.summary).toBe('{"ok":true}');
    expect(tool.status).toBe('done');
  });
});
