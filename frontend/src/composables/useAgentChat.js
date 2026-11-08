import { notifyDataChanged } from '../lib/data-changes.js';
import { computed, getCurrentInstance, nextTick, onBeforeUnmount, reactive, ref } from 'vue';
import { useEscapeKey } from './useEscapeKey.js';
import { api } from '../api/client.js';
import { stripAgentProtocol } from '../lib/agent-text.js';

/** 抽屉与工作台共享会话、输入草稿和执行状态；只有显式新建会话才重置。 */
export const WORKBENCH_CHANNEL = 'workbench';
export const PAGE_DRAWER_CHANNEL = WORKBENCH_CHANNEL;

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
    generation: 0,
    sessionPromise: null,
    activeRun: null,
    operation: ref(''),
    modeBusy: ref(false),
    approvalVersion: 0,
    historyLoading: ref(false),
    historyError: ref(''),
    queuePaused: ref(false),
    queueId: 0,
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
  const messages = state.messages;
  const input = state.input;
  const running = state.running;
  const sessionId = state.sessionId;
  const approvalMode = state.approvalMode;
  const pendingQueue = state.pendingQueue;
  const queuePaused = state.queuePaused;
  const operation = state.operation;
  const modeBusy = state.modeBusy;
  const historyLoading = state.historyLoading;
  const historyError = state.historyError;
  const sendingBlocked = computed(() => !!operation.value || modeBusy.value || historyLoading.value || !!historyError.value);
  const busy = computed(() => running.value || !!operation.value || modeBusy.value);
  const scrollEl = ref(null);
  const subscriber = { onEventExtra, onApproval, onContent: () => scrollBottom() };
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
      for (const item of state.subscribers) { if (item.active !== false) item.onContent?.(); }
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
    if (sessionId.value) return sessionId.value;
    if (state.sessionPromise) return state.sessionPromise;
    const generation = state.generation;
    const pending = (async () => {
      const result = await api.createAgentSession();
      if (generation !== state.generation || state.sessionPromise !== pending || sessionId.value) return null;
      const id = Number(result.sessionId);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('创建会话失败：服务未返回有效会话编号');
      sessionId.value = id;
      return id;
    })();
    state.sessionPromise = pending;
    try { return await pending; }
    finally { if (state.sessionPromise === pending) state.sessionPromise = null; }
  }

  /** 消息 ID 在共享渠道内递增，历史和新回复均使用同一计数器。 */
  function nextMessageId() { return ++state.nextId; }

  function resetSession() {
    ++state.generation;
    state.controller?.abort();
    state.controller = null;
    state.activeRun = null;
    state.sessionPromise = null;
    running.value = false;
    operation.value = '';
    modeBusy.value = false;
    historyLoading.value = false;
    historyError.value = '';
    queuePaused.value = false;
    resetChannel(state);
    approvalMode.value = 'ask';
  }

  /** 页面历史写入也使用此锁，让抽屉不能同时发送或切换会话。 */
  function lockSession(label) {
    if (busy.value) return null;
    const generation = state.generation;
    operation.value = label;
    return () => { if (generation === state.generation) operation.value = ''; };
  }

  function removeQueued(id) {
    pendingQueue.value = pendingQueue.value.filter(item => item.id !== id);
    if (!pendingQueue.value.length && !running.value) queuePaused.value = false;
  }

  async function resumeQueue() {
    if (busy.value || sendingBlocked.value || !pendingQueue.value.length) return false;
    queuePaused.value = false;
    const next = pendingQueue.value.shift();
    try { return await sendMessage(next.text, next.extraPayload); }
    catch (error) {
      pendingQueue.value.unshift(next); queuePaused.value = true;
      throw error;
    }
  }

  async function sendMessage(text, extraPayload = {}, { immediate = false } = {}) {
    if (!String(text || '').trim()) return false;
    if (sendingBlocked.value) throw new Error(historyError.value || '会话正在同步，请稍后发送');
    if (running.value || (!immediate && queuePaused.value && pendingQueue.value.length)) {
      pendingQueue.value.push({ id: ++state.queueId, text, extraPayload: { ...extraPayload } });
      if (input.value.trim() === text.trim()) input.value = '';
      return true;
    }
    if (!pendingQueue.value.length) queuePaused.value = false;
    const run = { generation: state.generation, approvalVersion: state.approvalVersion, controller: new AbortController(), sessionId: undefined, stopped: false, text, draft: input.value };
    const current = () => state.activeRun === run && state.generation === run.generation && (run.sessionId === undefined || sessionId.value === run.sessionId);
    state.activeRun = run; state.controller = run.controller; running.value = true;
    const draft = input.value;
    if (input.value.trim() === text.trim()) input.value = '';
    let assistant;
    try {
      const id = await ensureSession();
      if (!current()) return false;
      if (run.stopped || !id) { if (!input.value) input.value = draft || text; return false; }
      run.sessionId = id;
      assistant = reactive({ id: nextMessageId(), role: 'assistant', content: '', streaming: true, requestContext: { ...extraPayload } });
      run.assistant = assistant;
      const userMessage = reactive({ id: nextMessageId(), role: 'user', content: text, persistedId: 0 });
      messages.value.push(userMessage, assistant);
      atBottom.value = true; scrollBottom(true);
      await api.agentExecuteStream({ role: 'auto', ...extraPayload, message: text, sessionId: id }, event => {
        if (!current() || run.stopped) return;
        if (event.type === 'session_meta') { userMessage.persistedId = event.userMessageId; return; }
        if (event.type === 'approval_mode' && run.approvalVersion !== state.approvalVersion) return;
        if (['done', 'error', 'interrupted', 'max_loops_reached'].includes(event.type)) run.terminal = true;
        if (['error', 'interrupted', 'max_loops_reached'].includes(event.type)) queuePaused.value = true;
        handleEvent(event, assistant);
      }, run.controller.signal);
      if (current() && !run.stopped && !run.terminal) {
        assistant.error = '连接已结束，但未收到任务完成确认。请先核对执行结果，再继续。';
        assistant.interrupted = true; queuePaused.value = true;
      }
      return true;
    } catch (error) {
      if (!current()) return false;
      queuePaused.value = true;
      if (!assistant) { if (!input.value) input.value = draft || text; throw error; }
      flushTokens();
      if (error.name === 'AbortError') assistant.interrupted = true;
      else { assistant.error = `连接或执行失败：${error.message}`; assistant.interrupted = true; }
      return true;
    } finally {
      if (current()) {
        flushTokens();
        if (assistant) {
          assistant.streaming = false; assistant.confirmation = null; assistant.thinkingStreaming = false;
          if (run.stopped) assistant.interrupted = true;
        }
        running.value = false; state.controller = null; state.activeRun = null;
        scrollBottom();
        if (!run.stopped && !queuePaused.value && pendingQueue.value.length) {
          const next = pendingQueue.value.shift();
          try { await sendMessage(next.text, next.extraPayload); }
          catch { pendingQueue.value.unshift(next); queuePaused.value = true; }
        }
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

  async function continueAfterInterrupt(extraPayload = {}, messageId = null) {
    if (busy.value || sendingBlocked.value) return false;
    const last = [...messages.value].reverse().find(m => m.role === 'assistant' && m.interrupted && (!messageId || m.id === messageId));
    if (!last) return false;
    const accepted = await sendMessage('请继续刚才被中断的任务，先核对已执行步骤的结果，避免重复修改，再完成剩余部分。', { ...extraPayload, ...last.requestContext }, { immediate: true });
    if (accepted) last.interrupted = false;
    return accepted;
  }

  async function regenerate(extraPayload = {}, messageId = null) {
    const end = messageId == null ? messages.value.length : messages.value.findIndex(message => message.id === messageId);
    if (end < 0) return false;
    const user = messages.value.slice(0, end).reverse().find(message => message.role === 'user');
    if (!user) return false;
    const answer = messageId == null ? messages.value.at(-1) : messages.value[end];
    return editAndResend(user.id, user.content, { ...extraPayload, ...answer?.requestContext });
  }

  async function editAndResend(messageId, newContent, extraPayload = {}) {
    if (busy.value || sendingBlocked.value) return false;
    const index = messages.value.findIndex(message => message.id === messageId && message.role === 'user');
    if (index < 0) return false;
    const target = messages.value[index], id = sessionId.value, generation = state.generation;
    const unlock = lockSession('正在同步历史');
    if (!unlock) return false;
    const current = () => generation === state.generation && id === sessionId.value && messages.value[index] === target;
    try {
      if (id && target.persistedId) await api.truncateAiHistory(Number(id), Number(target.persistedId));
      if (!current()) return false;
      messages.value.splice(index);
    } catch (error) {
      if (!current()) return false;
      throw new Error(`同步历史失败：${error.message}`, { cause: error });
    } finally { unlock(); }
    return sendMessage(newContent, extraPayload, { immediate: true });
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
    if (event.type === 'token') {
      queueToken(assistant, event.content);
      scrollBottom();
    } else if (event.type === 'confirmation_required') {
      flushTokens();
      assistant.confirmation = { ...event, busy: false, error: '' };
    } else if (event.type === 'context_data' && event.kind === 'projects') assistant.projects = event.projects;
    else if (event.type === 'context_data' && event.kind === 'search_sources') assistant.searchSources = event.sources;
    else if (event.type === 'action_completed') {
      notifyDataChanged({ source: 'agent', tool: event.tool, projectId: event.projectId, hostId: event.hostId });
      if (event.kind === 'cron_created') window.dispatchEvent(new CustomEvent('composeops:cron-agent-created', { detail: event.result || {} }));
    }
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
    else if (event.type === 'error') { flushTokens(); assistant.interrupted = true; assistant.confirmation = null; assistant.content += `${assistant.content ? '\n\n' : ''}${stripAgentProtocol(event.content || 'Agent 执行失败')}`; }
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
    for (const item of state.subscribers) {
      if (item.active !== false) { item.onEventExtra?.(event, assistant); item.onContent?.(); }
    }
    scrollBottom();
  }

  async function approve(message, inputOverride = null, remember = null) {
    const confirmation = message.confirmation;
    if (!confirmation || confirmation.busy) return;
    const generation = state.generation, id = sessionId.value;
    const current = () => generation === state.generation && id === sessionId.value && message.confirmation === confirmation;
    confirmation.busy = true;
    confirmation.error = '';
    try {
      const payload = { executionId: confirmation.executionId, toolCallId: confirmation.toolCallId, approved: true };
      if (inputOverride && typeof inputOverride === 'object' && Object.keys(inputOverride).length) payload.input = inputOverride;
      if (remember === 'call' || remember === 'tool') payload.remember = remember;
      await api.agentApprove(payload);
      if (!current()) return;
      message.confirmation = null;
      for (const item of state.subscribers) { if (item.active !== false) item.onApproval?.(message, 'approved'); }
    } catch (error) {
      if (!current()) return;
      confirmation.busy = false;
      confirmation.error = String(error?.message || '确认请求失败，请检查连接后重试');
    }
  }

  async function reject(message) {
    const confirmation = message.confirmation;
    if (!confirmation || confirmation.busy) return;
    const generation = state.generation, id = sessionId.value;
    const current = () => generation === state.generation && id === sessionId.value && message.confirmation === confirmation;
    confirmation.busy = true;
    confirmation.error = '';
    try {
      await api.agentApprove({ executionId: confirmation.executionId, toolCallId: confirmation.toolCallId, approved: false });
      if (!current()) return;
      message.confirmation = null;
      for (const item of state.subscribers) { if (item.active !== false) item.onApproval?.(message, 'rejected'); }
    } catch (error) {
      if (!current()) return;
      confirmation.busy = false;
      confirmation.error = String(error?.message || '拒绝请求失败，请检查连接后重试');
    }
  }

  function interrupt() {
    queuePaused.value = true;
    const run = state.activeRun;
    if (run) run.stopped = true;
    state.controller?.abort();
    // 会话创建还没有发出执行流，立即恢复输入。迟到创建由 promise 身份丢弃。
    if (run && !run.assistant) {
      state.sessionPromise = null; state.activeRun = null; state.controller = null; running.value = false;
      if (!input.value) input.value = run.draft || run.text;
    }
  }

  /** 富内容块"放大查看"(页面内浮层,类似豆包)的状态与点击委托。 */
  const zoomOpen = ref(false);
  const zoomContent = ref('');
  const zoomScale = ref(1);
  const zoomReturnFocus = ref(null);

  function openZoom(block, returnFocus = null) {
    zoomReturnFocus.value = returnFocus || (typeof document !== 'undefined' ? document.activeElement : null);
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
      if (block) openZoom(block, button);
      return;
    }
    if (hitMedia) {
      const block = target.closest('.rich-block');
      // Direct media clicks should return keyboard focus to the block's accessible zoom control.
      const zoomButton = block?.querySelector('.rich-zoom-btn');
      zoomButton?.focus({ preventScroll: true });
      if (block) openZoom(block, zoomButton);
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
  // 服务端确认后再更新界面，避免失败时显示未生效的授权。
  // 尚未建会话时先建:否则模式会落进匿名 default 桶,而首条消息发出的
  // 执行流用的是真实 sessionId 桶,选择看起来"没生效"。
  async function setApprovalMode(mode) {
    const next = String(mode || '');
    if (!['ask', 'allow_writes', 'full'].includes(next) || next === approvalMode.value || modeBusy.value || operation.value || historyLoading.value || historyError.value || (running.value && !sessionId.value)) return false;
    const generation = state.generation;
    modeBusy.value = true;
    ++state.approvalVersion;
    try {
      const id = await ensureSession();
      if (generation !== state.generation || !id) return false;
      await api.setAgentApprovalMode({ sessionId: id, mode: next });
      if (generation !== state.generation || sessionId.value !== id) return false;
      approvalMode.value = next;
      return true;
    } catch (error) {
      if (generation !== state.generation) return false;
      throw error;
    } finally { if (generation === state.generation) modeBusy.value = false; }
  }

  return { busy, operation, lockSession, modeBusy, historyLoading, historyError, sendingBlocked, queuePaused, removeQueued, resumeQueue, messages, input, running, sessionId, approvalMode, setApprovalMode, scrollEl, atBottom, onScroll, scrollBottom, scrollToBottom, nextMessageId, ensureSession, resetSession, sendMessage, regenerate, editAndResend, continueAfterInterrupt, rateMessage, pendingQueue, approve, reject, interrupt, handleRichBlockClick, zoomOpen, zoomContent, zoomScale, zoomReturnFocus, onZoomWheel, closeZoom, setSubscriberActive };
}
