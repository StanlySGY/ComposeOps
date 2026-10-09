import { getCurrentInstance, nextTick, onBeforeUnmount, ref } from 'vue';
import { useEscapeKey } from './useEscapeKey.js';
import { api } from '../api/client.js';
import { stripAgentProtocol } from '../lib/agent-text.js';

/**
 * Agent 会话流逻辑。工作台与"页面 Agent"抽屉各用一个 channel,状态完全隔离。
 *
 * 为什么要分 channel:此前工作台和抽屉共用同一份模块级状态,在别的页面点开
 * "页面 Agent"会直接续上 AI 助手工作台里那段会话 —— 用户看到的是别人的上下文,
 * 这是串台,不是特性。参考 Pebrel(全新标签页 = 全新 session id)的做法,
 * 这里把"会话"收敛成 channel 维度:每个入口有自己的 messages/sessionId/中断控制器。
 *
 * - 会话历史以服务端 DB 为单一通道,前端不回传 history(有 sessionId 时后端只读 DB)。
 * - token 分片由服务端保证干净,这里原样追加;done 用后端最终全文覆盖自愈。
 * - onEventExtra/onApproval 供各界面挂自己的展示逻辑(执行动态面板等),按 channel 派发。
 */
export const WORKBENCH_CHANNEL = 'workbench';
export const PAGE_DRAWER_CHANNEL = 'page-drawer';

// 单轮思考文本上限,与后端 MAX_REASONING_CHARS 对齐。
const REASONING_LIMIT = 120000;

const channels = new Map();

function createChannel() {
  return {
    messages: ref([]),
    input: ref(''),
    running: ref(false),
    sessionId: ref(null),
    // 本轮生效的审批模式,由后端 approval_mode 事件同步(会话级,与 approval-gate 同一维度)
    approvalMode: ref('ask'),
    pendingQueue: ref([]),
    controller: null,
    starting: false,
    nextId: 0,
    tokenBuffer: '',
    bufferingAssistant: null,
    tokenTimer: null,
    subscribers: new Set(),
  };
}

function channelState(name) {
  const key = String(name || WORKBENCH_CHANNEL);
  if (!channels.has(key)) channels.set(key, createChannel());
  return channels.get(key);
}

function resetChannel(state) {
  state.messages.value = [];
  state.input.value = '';
  state.sessionId.value = null;
  state.pendingQueue.value = [];
  state.nextId = 0;
  state.tokenBuffer = '';
  state.bufferingAssistant = null;
  if (state.tokenTimer) clearTimeout(state.tokenTimer);
  state.tokenTimer = null;
}

export function useAgentChat({ channel = WORKBENCH_CHANNEL, onEventExtra = null, onApproval = null } = {}) {
  const instance = getCurrentInstance();
  const state = channelState(channel);
  // 非组件调用(例如单测或一次性脚本)没有卸载钩子,避免共享状态污染下一次独立调用。
  if (!instance && !state.running.value) resetChannel(state);
  const messages = state.messages;
  const input = state.input;
  const running = state.running;
  const sessionId = state.sessionId;
  const approvalMode = state.approvalMode;
  const pendingQueue = state.pendingQueue;
  const scrollEl = ref(null);
  const subscriber = { onEventExtra, onApproval };
  if (instance) state.subscribers.add(subscriber);
  function setSubscriberActive(active) { subscriber.active = active !== false; }
  // 滚动跟随:用户向上回看时暂停自动滚底,回到底部(或手动点"回到底部")后恢复。
  const atBottom = ref(true);
  // token 节流:SSE 分片逐条追加会让 marked+DOMPurify 每个 chunk 全量重渲染,
  // 长回复时一顿一顿;缓冲 120ms 合并刷新,流式更顺滑。
  function flushTokens() {
    if (state.tokenTimer) { clearTimeout(state.tokenTimer); state.tokenTimer = null; }
    if (state.bufferingAssistant && state.tokenBuffer) {
      state.bufferingAssistant.content += state.tokenBuffer;
      state.tokenBuffer = '';
    }
    state.bufferingAssistant = null;
  }

  function queueToken(assistant, chunk) {
    if (state.tokenTimer && state.bufferingAssistant && state.bufferingAssistant !== assistant) flushTokens();
    state.bufferingAssistant = assistant;
    state.tokenBuffer += chunk;
    if (!state.tokenTimer) state.tokenTimer = setTimeout(flushTokens, 120);
  }

  function isNearBottom() {
    const el = scrollEl.value;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function onScroll() {
    atBottom.value = isNearBottom();
  }

  function scrollBottom(force = false) {
    if (!force && !atBottom.value) return; // 用户在回看历史,不打断
    void nextTick(() => { if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight; });
  }

  function scrollToBottom() {
    atBottom.value = true;
    scrollBottom(true);
  }

  async function ensureSession() {
    if (!sessionId.value) sessionId.value = Number((await api.createAgentSession()).sessionId);
    return sessionId.value;
  }

  /** 消息 ID 统一由此生成,保证历史回放与新消息之间 :key 不冲突。 */
  function nextMessageId() { return ++state.nextId; }

  function resetSession() {
    messages.value = [];
    sessionId.value = null;
    state.nextId = 0;
    state.controller?.abort();
    state.controller = null;
    // 队列残留消息若不清,会在新会话里被 sendMessage 的"自动发送下一条"带出去,
    // 造成用户以为已丢弃的内容发进了全新会话。
    state.pendingQueue.value = [];
  }

  async function sendMessage(text, extraPayload = {}) {
    if (!text) return;
    if (running.value || state.starting) {
      pendingQueue.value.push({ text, extraPayload });
      input.value = '';
      return;
    }
    state.starting = true;
    try {
      await ensureSession();
    } finally {
      state.starting = false;
    }
    const assistant = { id: ++state.nextId, role: 'assistant', content: '', streaming: true };
    const userMessage = { id: ++state.nextId, role: 'user', content: text, persistedId: 0 };
    messages.value.push(userMessage, assistant);
    input.value = '';
    running.value = true;
    state.controller = new AbortController();
    atBottom.value = true; // 发送即回到底部
    scrollBottom(true);
    try {
      await api.agentExecuteStream({ message: text, sessionId: sessionId.value, role: 'planner', ...extraPayload }, (event) => handleEvent(event, assistant), state.controller.signal);
    } catch (error) {
      if (error.name !== 'AbortError') assistant.content = `执行失败：${error.message}`;
    } finally {
      flushTokens();
      assistant.streaming = false;
      assistant.confirmation = null;
      // 执行结束(含中断/失败)必须停掉"思考中"脉冲,否则非 done 收尾的路径
      // 会把思考面板永远留在"正在思考"状态。
      assistant.thinkingStreaming = false;
      running.value = false;
      state.controller = null;
      scrollBottom();
      // 自动发送队列中的下一条
      if (pendingQueue.value.length > 0) {
        const next = pendingQueue.value.shift();
        await sendMessage(next.text, next.extraPayload);
      }
    }
  }

  /** 对某条回复点赞(5)/点踩(1),写回后端 agent_plans.rating,用于沉淀失败样本。 */
  async function rateMessage(message, rating, feedbackText = '') {
    if (!message?.planId) return false;
    try {
      await api.agentFeedback({ planId: Number(message.planId), rating, feedbackText });
      message.rating = rating;
      return true;
    } catch {
      return false;
    }
  }

  async function continueAfterInterrupt() {
    if (running.value) return;
    const last = [...messages.value].reverse().find((m) => m.role === 'assistant' && m.interrupted);
    if (last) last.interrupted = false;
    await sendMessage('请继续刚才被中断的任务,从中断处接着完成;已经执行过的步骤不要重复执行。');
  }

  async function regenerate() {
    const lastUser = [...messages.value].reverse().find((m) => m.role === 'user');
    if (!lastUser || running.value) return;
    const lastUserIndex = messages.value.lastIndexOf(lastUser);
    // 重跑等同于"从这条提问重新开始":后端历史必须一并截断,否则重开会话会看到两遍同一轮。
    if (sessionId.value && lastUser.persistedId) {
      try {
        await api.truncateAiHistory(Number(sessionId.value), Number(lastUser.persistedId));
      } catch (error) {
        throw new Error(`同步历史失败:${error.message}`, { cause: error });
      }
    }
    messages.value.splice(lastUserIndex);
    await sendMessage(lastUser.content);
  }

  async function editAndResend(messageId, newContent) {
    if (running.value) return;
    const index = messages.value.findIndex((m) => m.id === messageId);
    if (index === -1) return;
    const target = messages.value[index];
    // 先截断持久化历史,再删本地气泡:顺序反了会让"截断失败"变成静默的前后端分叉。
    if (sessionId.value && target?.persistedId) {
      try {
        await api.truncateAiHistory(Number(sessionId.value), Number(target.persistedId));
      } catch (error) {
        // 截断失败时不继续,避免本地删了、服务端还留着旧轮次。
        throw new Error(`同步历史失败:${error.message}`, { cause: error });
      }
    }
    messages.value.splice(index);
    await sendMessage(newContent);
  }

  /** 工具执行轨迹:requested → executing → done/failed/rejected,供消息区展示。 */
  function trackTool(assistant, event) {
    if (!assistant.tools) assistant.tools = [];
    const pending = [...assistant.tools].reverse().find((item) => item.tool === event.tool && ['requested', 'executing'].includes(item.status));
    if (event.type === 'tool_requested') assistant.tools.push({ tool: event.tool, status: 'requested', paramsText: event.paramsText || '' });
    else if (event.type === 'tool_executing') {
      // 执行阶段也带脱敏参数:落到已有条目上,避免"参数与结果"展开是空。
      const detail = { paramsText: event.paramsText || '' };
      if (pending) Object.assign(pending, detail, { status: 'executing' });
      else assistant.tools.push({ tool: event.tool, status: 'executing', ...detail });
    } else if (event.type === 'tool_result') {
      const status = event.success ? 'done' : 'failed';
      // 结果摘要/错误只在后端透出的脱敏字段里,不再假设前端持有完整结果体。
      const detail = { durationMs: event.durationMs, summary: event.summary || '', error: event.error || '' };
      if (pending) Object.assign(pending, detail, { status });
      else assistant.tools.push({ tool: event.tool, status, ...detail });
    } else if (event.type === 'tool_error') {
      const detail = { error: event.error || '执行失败' };
      if (pending) Object.assign(pending, detail, { status: 'failed' });
      else assistant.tools.push({ tool: event.tool, status: 'failed', ...detail });
    } else if (event.type === 'tool_rejected') {
      if (pending) pending.status = 'rejected';
      else assistant.tools.push({ tool: event.tool, status: 'rejected' });
    }
  }

  function handleEvent(event, assistant) {
    if (event.type === 'session_meta') {
      // 后端刚把这条用户消息落库,回填 id;编辑重发时据此删除对应历史段。
      const lastUser = [...messages.value].reverse().find((item) => item.role === 'user' && !item.persistedId);
      if (lastUser) lastUser.persistedId = event.userMessageId;
      return;
    }
    if (event.type === 'token') {
      queueToken(assistant, event.content);
      scrollBottom();
    } else if (event.type === 'confirmation_required') {
      flushTokens();
      assistant.confirmation = { ...event, busy: false };
    } else if (event.type === 'context_data' && event.kind === 'projects') assistant.projects = event.projects;
    else if (event.type === 'context_data' && event.kind === 'search_sources') assistant.searchSources = event.sources;
    else if (event.type === 'action_completed' && event.kind === 'cron_created') window.dispatchEvent(new CustomEvent('composeops:cron-agent-created', { detail: event.result || {} }));
    else if (event.type.startsWith('channel_')) {
      const sameChannel = event.type === 'channel_selected' && assistant.aiChannel?.name === event.channelName && assistant.aiChannel?.model === event.model;
      if (!sameChannel) assistant.taskNotices = [...(assistant.taskNotices || []), event.content || ''].slice(-40);
      if (event.type === 'channel_selected') assistant.aiChannel = { name: event.channelName, model: event.model };
    }
    else if (event.type === 'task_notice') {
      // 后台任务完成通知:模型侧已搭车注入,界面侧以提示条同步展示,用户不必翻思考过程。
      assistant.taskNotices = [...(assistant.taskNotices || []), event.content || ''];
    }
    else if (event.type === 'compaction') {
      // 会话超阈值自动压缩:提示条同步展示,避免用户困惑"更早的对话怎么不见了"。
      assistant.taskNotices = [...(assistant.taskNotices || []), event.content || ''];
    }
    else if (event.type === 'max_loops_reached') {
      // 此前该事件被公共事件层丢弃,达到 20 轮上限时前端只看到流关闭、无任何提示。
      flushTokens();
      assistant.confirmation = null;
      assistant.content += `${assistant.content ? '\n\n' : ''}已达最大工具循环次数(${Number(event.maxLoops) || 20} 轮),本次执行终止。可发送"继续"接续处理,或拆小任务后重试。`;
    }
    else if (event.type === 'approval_mode') approvalMode.value = String(event.mode || 'ask');
    else if (event.type.startsWith('tool_')) { trackTool(assistant, event); }
    else if (event.type === 'interrupted') {
      flushTokens();
      assistant.confirmation = null;
      // 标记中断,消息区据此显示"继续执行"入口(重新以会话上下文接续,而非从头开始)
      assistant.interrupted = true;
      assistant.content += `${assistant.content ? '\n\n' : ''}${stripAgentProtocol(event.reason || '执行已中断')}`;
    }
    else if (event.type === 'error') { flushTokens(); assistant.confirmation = null; assistant.content += `${assistant.content ? '\n\n' : ''}${stripAgentProtocol(event.content || 'Agent 执行失败')}`; }
    else if (event.type === 'done') {
      flushTokens();
      if (event.content) assistant.content = stripAgentProtocol(event.content);
      if (event.usage) assistant.usage = event.usage;
      if (event.planId) assistant.planId = event.planId;
      // 不再清空 thinking:思考过程是用户要回看的内容,执行结束后必须留在气泡里。
      assistant.thinkingStreaming = false;
    }
    else if (event.type === 'thinking') {
      // 轮次分隔:开一个新的思考轮次分组(占位文案也仍然显示,便于无 reasoning 的模型有反馈)。
      if (!assistant.thinking) assistant.thinking = [];
      assistant.thinking.push({ round: Number(event.round) || assistant.thinking.length + 1, content: String(event.content || ''), streaming: true });
      assistant.thinkingStreaming = true;
    }
    else if (event.type === 'reasoning') {
      // 真实推理增量:追加到当前轮次,不覆盖。此前是"点开只有一句正在思考",
      // 根因是这里把每片思考都覆盖写,且 done 时又整体置空。
      if (!assistant.thinking) assistant.thinking = [];
      const round = Number(event.round) || assistant.thinking.length || 1;
      let group = [...assistant.thinking].reverse().find((item) => item.round === round);
      if (!group) { group = { round, content: '', streaming: true }; assistant.thinking.push(group); }
      // 单轮思考上限与后端一致(120k):超长推理只留前段,避免模板反复拼接
      // 超长字符串把主线程拖死(思考面板是纯文本渲染,越界后不再增长)。
      if (group.content.length < REASONING_LIMIT) {
        group.content = (group.content + String(event.content || '')).slice(0, REASONING_LIMIT);
      }
      assistant.thinkingStreaming = true;
    }
    for (const item of state.subscribers) { if (item.active !== false) item.onEventExtra?.(event, assistant); }
    scrollBottom();
  }

  async function approve(message, inputOverride = null, remember = null) {
    const confirmation = message.confirmation;
    if (!confirmation || confirmation.busy) return;
    confirmation.busy = true;
    try {
      const payload = { executionId: confirmation.executionId, toolCallId: confirmation.toolCallId, approved: true };
      if (inputOverride && typeof inputOverride === 'object' && Object.keys(inputOverride).length) payload.input = inputOverride;
      if (remember === 'call' || remember === 'tool') payload.remember = remember;
      await api.agentApprove(payload);
      message.confirmation = null;
      for (const item of state.subscribers) { if (item.active !== false) item.onApproval?.(message, 'approved'); }
    } catch (error) {
      confirmation.busy = false;
      // 追加而不是覆盖:此时回复正文可能已经流式输出了一部分,覆盖会吃掉已有内容。
      message.content += `${message.content ? '\n\n' : ''}确认失败：${error.message}`;
    }
  }

  async function reject(message) {
    const confirmation = message.confirmation;
    if (!confirmation || confirmation.busy) return;
    confirmation.busy = true;
    try {
      await api.agentApprove({ executionId: confirmation.executionId, toolCallId: confirmation.toolCallId, approved: false });
      message.confirmation = null;
      for (const item of state.subscribers) { if (item.active !== false) item.onApproval?.(message, 'rejected'); }
    } catch (error) {
      confirmation.busy = false;
      message.content += `${message.content ? '\n\n' : ''}拒绝失败：${error.message}`;
    }
  }

  function interrupt() { state.controller?.abort(); }

  /** 富内容块"放大查看"(页面内浮层,类似豆包)的状态与点击委托。 */
  const zoomOpen = ref(false);
  const zoomContent = ref('');
  const zoomScale = ref(1);

  function openZoom(block) {
    zoomContent.value = block.querySelector('.rich-block-body')?.innerHTML || block.innerHTML;
    zoomScale.value = 1;
    zoomOpen.value = true;
  }

  function handleRichBlockClick(event) {
    const button = event.target.closest?.('.rich-zoom-btn');
    const target = event.target;
    // 点击 SVG/图片本体也可直接放大(豆包式)
    const hitMedia = target.closest?.('.rich-block') && target.matches?.('svg, svg *, img');
    if (button) {
      const block = button.closest('.rich-block');
      if (block) openZoom(block);
      return;
    }
    if (hitMedia) {
      openZoom(target.closest('.rich-block'));
    }
  }

  function onZoomWheel(event) {
    if (!zoomOpen.value) return;
    const direction = event.deltaY > 0 ? -0.1 : 0.1;
    zoomScale.value = Math.min(4, Math.max(0.5, Math.round((zoomScale.value + direction) * 10) / 10));
  }

  function closeZoom() {
    zoomOpen.value = false;
    zoomContent.value = '';
    zoomScale.value = 1;
  }

  // Esc 关闭放大浮层,并锁定背景滚动(复用全局弹层 Esc 分层体系)。
  // 非组件调用不具备 router 注入和卸载生命周期,跳过 DOM 生命周期绑定。
  if (instance) {
    useEscapeKey({ active: zoomOpen, layer: 'modal', onClose: closeZoom, lockBody: true });
    onBeforeUnmount(() => state.subscribers.delete(subscriber));
  }

  // 切换本会话审批模式:后端 ApprovalGate 按 sessionId 记忆,这里只负责把
  // 选择立刻反映到界面(不等下一轮 approval_mode 事件回来)。
  // 尚未建会话时先建:否则模式会落进匿名 default 桶,而首条消息发出的
  // 执行流用的是真实 sessionId 桶,选择看起来"没生效"。
  async function setApprovalMode(mode) {
    const next = String(mode || '');
    if (!['ask', 'allow_writes', 'full'].includes(next) || next === approvalMode.value) return;
    const previous = approvalMode.value;
    approvalMode.value = next;
    try {
      await ensureSession();
      await api.setAgentApprovalMode({ sessionId: sessionId.value, mode: next });
    } catch (error) {
      approvalMode.value = previous;
      throw error;
    }
  }

  return { messages, input, running, sessionId, approvalMode, setApprovalMode, scrollEl, atBottom, onScroll, scrollBottom, scrollToBottom, nextMessageId, ensureSession, resetSession, sendMessage, regenerate, editAndResend, continueAfterInterrupt, rateMessage, pendingQueue, approve, reject, interrupt, handleRichBlockClick, zoomOpen, zoomContent, zoomScale, onZoomWheel, closeZoom, setSubscriberActive };
}
