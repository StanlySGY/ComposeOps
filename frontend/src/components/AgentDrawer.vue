<!-- eslint-disable vue/no-v-html -- 放大浮层内容来自 renderAgentMarkdown 的 DOMPurify 净化结果。 -->
<template>
  <div v-if="open" class="agent-drawer-layer">
    <button class="agent-drawer-backdrop" aria-label="关闭 Agent" @click="closeAgent"></button>
    <aside class="agent-drawer" role="dialog" aria-modal="true" aria-label="页面 Agent">
      <header class="agent-drawer-head">
        <div class="flex min-w-0 items-center gap-2"><Bot class="h-4 w-4 text-accent" /><div class="min-w-0"><strong class="block truncate">页面 Agent</strong><small class="block truncate">{{ pageContext.page || '当前页面' }} · {{ pageContext.mode || '运维问答与操作' }}</small></div></div>
        <div class="flex items-center gap-1"><button class="icon-btn" title="新建会话(清空当前上下文)" aria-label="新建会话" @click="startFreshSession"><MessageSquarePlus class="h-4 w-4" /></button><button class="icon-btn" title="中断执行" :disabled="!running" @click="interrupt"><Square class="h-4 w-4" /></button><button class="icon-btn" title="关闭 Agent" @click="closeAgent"><X class="h-4 w-4" /></button></div>
      </header>
      <div class="agent-drawer-context"><span>已携带当前页面上下文</span><small>{{ contextSummary }}</small></div>
      <div ref="scrollEl" class="agent-drawer-messages" @click="handleRichBlockClick">
        <div v-if="!messages.length" class="agent-drawer-empty"><MessageCircle class="h-6 w-6 text-accent" /><p>可以询问当前页面的数据、状态或操作方式。</p><button class="preset-chip" @click="input = defaultPrompt; focusInput()">{{ defaultPrompt }}</button></div>
        <article v-for="message in messages" :key="message.id" class="agent-drawer-message" :class="message.role">
          <div class="agent-drawer-avatar"><UserRound v-if="message.role === 'user'" class="h-3.5 w-3.5" /><Bot v-else class="h-3.5 w-3.5" /></div>
          <div class="min-w-0 max-w-[calc(100%-2rem)]"><div v-if="message.tools?.length" class="agent-drawer-tools"><div class="agent-drawer-tool-track"><span v-for="(tool, index) in message.tools" :key="index" class="agent-drawer-tool-chip" :class="tool.status"><i></i>{{ tool.tool }}<em v-if="tool.durationMs">{{ (tool.durationMs / 1000).toFixed(1) }}s</em></span></div><details v-if="toolDetailCount(message)" class="agent-drawer-tool-detail"><summary>参数与结果({{ toolDetailCount(message) }})</summary><div v-for="(tool, index) in message.tools" :key="index" class="agent-drawer-tool-block" :class="tool.status"><strong>{{ tool.tool }} · {{ toolStatusLabel(tool.status) }}</strong><pre v-if="tool.paramsText && tool.paramsText !== '{}'">{{ tool.paramsText }}</pre><pre v-if="tool.error" class="is-error">{{ tool.error }}</pre><pre v-else-if="tool.summary">{{ tool.summary }}</pre></div></details></div><div v-if="message.taskNotices?.length" class="agent-task-notice"><p v-for="(notice, index) in message.taskNotices" :key="index">{{ notice }}</p></div><AgentThinking v-if="message.role === 'assistant'" :thinking="message.thinking" :live="!!message.thinkingStreaming" /><div v-if="message.streaming && !message.content" class="agent-typing"><i></i><i></i><i></i><span>正在处理</span></div><div v-else-if="message.role === 'assistant' && !message.content" class="agent-empty-reply">(未返回内容)</div><AgentMarkdown v-else-if="message.role === 'assistant'" class="agent-drawer-markdown" :content="message.content" /><div v-else class="agent-drawer-user">{{ message.content }}</div>
            <div v-if="message.confirmation" class="agent-drawer-confirm"><strong>需要确认后执行<span v-if="message.confirmation.tool" class="ml-1.5 font-mono text-[11px] text-amber-200/80">{{ message.confirmation.tool }}</span></strong><p>{{ message.confirmation.description }}</p><details class="agent-confirm-params" @toggle="initParamsEdit($event, message)"><summary>查看 / 编辑参数</summary><textarea v-model="message.confirmation.paramsText" class="agent-confirm-params-text" rows="5" spellcheck="false"></textarea></details><div class="mt-2 flex flex-wrap gap-2"><button class="btn-primary !py-1 !text-xs" :disabled="message.confirmation.busy" @click="approveWithParams(message)">确认执行</button><button class="btn-secondary !py-1 !text-xs" :disabled="message.confirmation.busy" @click="approveWithParams(message, 'call')">确认并本会话不再询问(同参数)</button><button class="btn-secondary !py-1 !text-xs" :disabled="message.confirmation.busy" @click="reject(message)">拒绝</button></div></div>
          </div>
        </article>
      </div>
      <form class="agent-drawer-composer" @submit.prevent="submit"><textarea ref="inputEl" v-model="input" class="agent-input" rows="3" placeholder="询问当前页面或让 Agent 执行任务…" @keydown.enter.exact.prevent="submit"></textarea><div class="flex items-center justify-between gap-2"><small class="text-surface-500">{{ running ? (pendingQueue.length ? '执行中,已排队 ' + pendingQueue.length + ' 条' : '执行中,可继续输入并自动排队') : '需要修改时会先请求确认' }}</small><button class="btn-primary" type="submit" :disabled="!input.trim()"><Send class="h-4 w-4" />{{ running ? '排队' : '发送' }}</button></div></form>
    </aside>
    <teleport to="body">
      <div v-if="zoomOpen" class="rich-zoom-mask" @click.self="closeZoom()" @wheel.prevent="onZoomWheel">
        <div class="rich-zoom-card agent-markdown" :style="{ transform: `scale(${zoomScale})` }">
          <button class="rich-zoom-close" title="关闭(Esc)" @click="closeZoom">×</button>
          <div class="rich-zoom-content" v-html="zoomContent"></div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Bot, MessageCircle, MessageSquarePlus, Send, Square, UserRound, X } from 'lucide-vue-next';
import { useAgentConsole } from '../composables/useAgentConsole.js';
import { PAGE_DRAWER_CHANNEL, useAgentChat } from '../composables/useAgentChat.js';
import { useEscapeKey } from '../composables/useEscapeKey.js';
import AgentMarkdown from './common/AgentMarkdown.vue';
import AgentThinking from './agent/AgentThinking.vue';

const { open, context, closeAgent } = useAgentConsole();
// 抽屉用自己的 channel:与 AI 助手工作台的状态彻底隔离。
// 在别的页面点"页面 Agent"应该是全新会话,而不是续上工作台里那段对话。
const chat = useAgentChat({ channel: PAGE_DRAWER_CHANNEL });
const { messages, input, running, scrollEl, resetSession, sendMessage, pendingQueue, approve, reject, interrupt, handleRichBlockClick, zoomOpen, zoomContent, zoomScale, onZoomWheel, closeZoom } = chat;
const inputEl = ref(null);
// 页面通过"交给 Agent"按钮携带一段预填 prompt 打开抽屉:事件可能早于
// open 的 watch 派发,先暂存,startFreshSession 清空输入后再写入。
let pendingPrompt = '';
function handleAgentPrompt(event) { pendingPrompt = String(event.detail?.prompt || ''); }
// 抽屉每次打开都是一段独立会话;用户也可以在不关闭抽屉的情况下手动开新会话。
function startFreshSession() {
  if (running.value) { interrupt(); }
  resetSession();
  input.value = '';
  if (pendingPrompt) { input.value = pendingPrompt; pendingPrompt = ''; }
  focusInput();
}
const pageContext = computed(() => ({ page: context.value.page || '当前页面', route: window.location.hash.replace(/^#/, '') || '/', mode: context.value.mode || '运维问答与操作', summary: context.value.summary || '', state: context.value.state || '' }));
const contextSummary = computed(() => pageContext.value.summary || pageContext.value.state || '路由与页面状态已同步');
const defaultPrompt = computed(() => {
  if (pageContext.value.mode === "cron-editor") return "根据当前表单帮我创建这个定时任务";
  if (pageContext.value.mode === "inspection-fix" || pageContext.value.mode === "inspection-review") return "分析这次巡检结论,给出处置建议";
  return "请分析当前页面,并告诉我可以做什么";
});
useEscapeKey({ active: open, onClose: closeAgent, layer: 'drawer', lockBody: true });
function focusInput() { void nextTick(() => inputEl.value?.focus()); }
function submit() {
  const text = input.value.trim();
  if (!text) return;
  // 抽屉与工作台共用同一 chat 实例:执行中提交会进入队列,由 useAgentChat 自动续发。
  void sendMessage(text, { pageContext: pageContext.value });
}
// 会话 id 在第一次发送时惰性创建(ensureSession),这里不做历史回填 ——
// 抽屉是"就当前页面问一句"的轻入口,续上历史会让上下文与页面不符。
watch(open, (value) => {
  if (!value) return;
  startFreshSession();
});
onMounted(() => {
  if (open.value) startFreshSession();
  window.addEventListener('composeops:agent-prompt', handleAgentPrompt);
});
onBeforeUnmount(() => window.removeEventListener('composeops:agent-prompt', handleAgentPrompt));
const TOOL_STATUS_LABELS = { requested: '已请求', executing: '执行中', done: '完成', failed: '失败', rejected: '已拒绝' };
function toolStatusLabel(status) { return TOOL_STATUS_LABELS[status] || status; }
/** 抽屉是精简视图,工具详情收进一个折叠块;没有可展示内容时不渲染。 */
function toolDetailCount(message) {
  return (message.tools || []).filter((tool) => (tool.paramsText && tool.paramsText !== '{}') || tool.summary || tool.error).length;
}
function initParamsEdit(event, message) {
  if (event.target.open && message.confirmation && message.confirmation.paramsText === undefined) {
    message.confirmation.paramsText = JSON.stringify(message.confirmation.params || {}, null, 2);
  }
}
function approveWithParams(message, remember = null) {
  let inputOverride = null;
  const confirmation = message.confirmation;
  if (confirmation?.paramsText !== undefined && confirmation.paramsText.trim()) {
    try {
      inputOverride = JSON.parse(confirmation.paramsText);
    } catch {
      message.content = '参数不是合法 JSON,请修正后再确认';
      return;
    }
  }
  void approve(message, inputOverride, remember);
}
onBeforeUnmount(() => interrupt());
</script>

<style scoped>
.agent-drawer-layer { position: fixed; inset: 0; z-index: 51; pointer-events: none; }.agent-drawer-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: rgba(0,0,0,.58); pointer-events: auto; }.agent-drawer { position: absolute; top: 0; right: 0; display: flex; width: min(100vw, 30rem); max-width: 100%; height: 100%; flex-direction: column; color: #d4d4d8; border-left: 1px solid #3f4653; background: #181c23; box-shadow: -18px 0 45px rgba(0,0,0,.35); pointer-events: auto; }.agent-drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid #303641; }.agent-drawer-head strong { font-size: 13px; color: #f4f4f5; }.agent-drawer-head small { color: #71717a; font-size: 10px; }.agent-drawer-context { padding: 9px 16px; border-bottom: 1px solid #272c35; background: #11151b; }.agent-drawer-context span, .agent-drawer-context small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.agent-drawer-context span { color: #67e8f9; font-size: 10px; }.agent-drawer-context small { margin-top: 2px; color: #71717a; font-size: 10px; }.agent-drawer-messages { min-height: 0; flex: 1; overflow-y: auto; padding: 16px; }.agent-drawer-empty { display: grid; min-height: 100%; place-content: center; justify-items: center; gap: 10px; color: #71717a; font-size: 12px; text-align: center; }.agent-drawer-message { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 16px; }.agent-drawer-message.user { flex-direction: row-reverse; }.agent-drawer-avatar { display: grid; width: 25px; height: 25px; flex: 0 0 auto; place-items: center; color: #67e8f9; border: 1px solid #155e75; border-radius: 7px; background: #082f49; }.agent-drawer-message.user .agent-drawer-avatar { color: #a1a1aa; border-color: #3f4653; background: #20252d; }.agent-drawer-user, .agent-drawer-markdown { padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.65; }.agent-drawer-user { white-space: pre-wrap; background: #082f49; color: #f4f4f5; }.agent-drawer-markdown { background: #20252d; color: #d4d4d8; }.agent-drawer-markdown :deep(p) { margin: 0 0 7px; }.agent-drawer-markdown :deep(p:last-child) { margin-bottom: 0; }.agent-drawer-markdown :deep(pre) { overflow: auto; padding: 8px; background: #11151b; }.agent-drawer-markdown :deep(table) { display: block; width: 100%; margin: 7px 0; overflow-x: auto; border-collapse: collapse; font-size: 11px; }.agent-drawer-markdown :deep(th), .agent-drawer-markdown :deep(td) { padding: 4px 7px; border: 1px solid #303641; text-align: left; vertical-align: top; }.agent-drawer-markdown :deep(th) { color: #e4e4e7; font-weight: 600; background: #11151b; }.agent-drawer-markdown :deep(tr:nth-child(even) td) { background: rgba(17,21,27,.4); }.agent-drawer-markdown :deep(hr) { margin: 10px 0; border: 0; border-top: 1px solid #303641; }
.agent-typing { display: inline-flex; align-items: center; gap: 4px; padding: 3px 0; color: #71717a; font-size: 11px; }
.agent-typing i { width: 4px; height: 4px; border-radius: 999px; background: #22d3ee; animation: typing-bounce 1.1s cubic-bezier(0.34, 1.3, 0.64, 1) infinite; }
.agent-typing i:nth-child(2) { animation-delay: .14s; }
.agent-typing i:nth-child(3) { animation-delay: .28s; }
@keyframes typing-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }
.agent-empty-reply { color: #52525b; font-size: 11px; font-style: italic; }
.agent-drawer-tool-track { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.agent-drawer-tool-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; color: #a1a1aa; border: 1px solid #303641; border-radius: 999px; background: #181c23; font-size: 9px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.agent-drawer-tool-chip em { color: #52525b; font-style: normal; }
.agent-drawer-tool-chip i { width: 5px; height: 5px; border-radius: 999px; background: #52525b; }
.agent-drawer-tool-chip.executing i { background: #22d3ee; }
.agent-drawer-tool-chip.done i { background: #34d399; }
.agent-drawer-tool-chip.failed i { background: #fb7185; }
.agent-drawer-tool-chip.rejected i { background: #a78bfa; }
/* 抽屉里的工具详情:与工作台的工具卡片同源,但收进单个折叠块以保持精简 */
.agent-drawer-tool-detail { margin-bottom: 7px; }
.agent-drawer-tool-detail > summary { color: #67e8f9; font-size: 10px; cursor: pointer; }
.agent-drawer-tool-block { margin-top: 6px; padding: 7px 8px; border: 1px solid #303641; border-radius: 7px; background: #11151b; }
.agent-drawer-tool-block strong { display: block; margin-bottom: 4px; color: #a1a1aa; font-size: 9.5px; font-weight: 600; }
.agent-drawer-tool-block pre { margin: 0 0 5px; padding: 6px 7px; overflow: auto; max-height: 200px; color: #cbd5e1; border-radius: 5px; background: #0b0e13; font-size: 10px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.agent-drawer-tool-block pre:last-child { margin-bottom: 0; }
.agent-drawer-tool-block pre.is-error { color: #fda4af; }
.agent-drawer-tool-block.failed strong { color: #fda4af; }
.agent-drawer-tool-block.done strong { color: #6ee7b7; }
/* 思考过程:默认收起,与工作台一致 */
.agent-drawer-thinking { margin-bottom: 7px; padding: 7px 9px; border: 1px solid #303641; border-radius: 7px; background: rgba(17, 21, 27, 0.6); }
.agent-drawer-thinking > summary { color: #67e8f9; font-size: 10px; font-weight: 600; cursor: pointer; }
.agent-drawer-thinking > div { margin-top: 6px; max-height: 220px; overflow-y: auto; color: #8b919c; font-size: 10.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }.agent-drawer-confirm { margin-top: 8px; padding: 10px; border: 1px solid rgba(146,64,14,.7); border-radius: 7px; background: rgba(69,26,3,.35); font-size: 11px; }.agent-drawer-confirm p { margin-top: 4px; color: #fde68a; line-height: 1.55; }
.agent-confirm-params { margin-top: 6px; }
.agent-confirm-params summary { color: rgba(254, 243, 199, 0.85); font-size: 10px; cursor: pointer; }
.agent-confirm-params-text { display: block; width: 100%; margin-top: 5px; padding: 6px 8px; color: #e4e4e7; border: 1px solid rgba(146, 64, 14, 0.5); border-radius: 6px; background: rgba(0, 0, 0, 0.3); font-family: ui-monospace, Menlo, monospace; font-size: 10px; outline: none; resize: vertical; }.agent-drawer-composer { padding: 12px 16px 16px; border-top: 1px solid #303641; background: #151920; }.agent-drawer-composer .agent-input { display: block; width: 100%; min-height: 76px; max-height: 160px; margin-bottom: 9px; resize: vertical; padding: 10px 12px; color: #f4f4f5; border: 1px solid #46505e; border-radius: 9px; outline: none; background: #0f1319; font-size: 12px; line-height: 1.6; }.agent-drawer-composer .agent-input:focus { border-color: #0891b2; box-shadow: 0 0 0 2px rgba(8,145,178,.16); }.agent-drawer-composer small { font-size: 10px; }.agent-drawer-composer button[type='submit'] { flex: 0 0 auto; }
@media (max-width: 520px) { .agent-drawer-head, .agent-drawer-context, .agent-drawer-messages { padding-left: 12px; padding-right: 12px; } .agent-drawer-composer { padding: 10px 12px 12px; } .agent-drawer-composer small { max-width: 65%; line-height: 1.4; } }
</style>
