<template>
  <BaseModal :show="open" :title="`AI 一键诊断 · ${title}`" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[86vh] flex-col" body-class="min-h-0 flex-1 p-0" @close="close">
    <template #header-actions>
      <Sparkles class="w-4 h-4 text-status-info" />
    </template>
    <div class="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_11rem]">
      <div class="min-w-0 overflow-y-auto p-4">
        <div v-if="!streaming && !text" class="flex h-full min-h-32 items-center justify-center text-muted">等待 AI 诊断结果…</div>
        <AgentMarkdown class="ai-diagnosis agent-rich-markdown" :content="text" />
      </div>
      <aside class="flex flex-col gap-2 border-t border-surface-800 p-3 md:border-l md:border-t-0">
        <p class="text-xs text-muted">快捷操作</p>
        <button v-if="!streaming && status !== 'idle'" class="btn-secondary" aria-label="重新运行 AI 诊断" @click="start">重新诊断</button>
        <button class="btn-primary" :disabled="!fullText || !projectId" @click="sendToAgent"><Sparkles class="w-4 h-4" />交给 Agent 制定修复</button>
        <button class="btn-secondary" :disabled="!fullText" @click="copyFix"><Copy class="w-4 h-4" />复制修复建议</button>
        <button class="btn-secondary" :disabled="!projectId" @click="goCompose"><FileCode2 class="w-4 h-4" />跳转 Compose 编辑器</button>
        <button class="btn-secondary" :disabled="!projectId || !envEditable" @click="goEnv"><KeyRound class="w-4 h-4" />跳转 Env 编辑器</button>
      </aside>
    </div>
    <footer v-if="statusText" :role="status === 'error' ? 'alert' : 'status'" :aria-live="status === 'error' ? 'assertive' : 'polite'" aria-atomic="true" class="shrink-0 border-t border-surface-800 px-4 py-2 text-xs" :class="statusClass">{{ statusText }}</footer>
  </BaseModal>
</template>

<script setup>
import { deepLink } from '../../lib/deep-links.js';
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { streamSse } from '../../api/client.js';
import { stripAgentProtocol } from '../../lib/agent-text.js';
import { useToastStore } from '../../stores/toast.js';
import { Copy, FileCode2, KeyRound, Sparkles } from 'lucide-vue-next';
import { useRoute, useRouter } from 'vue-router';
import AgentMarkdown from '../common/AgentMarkdown.vue';
import BaseModal from '../common/BaseModal.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  projectId: { type: String, default: '' },
  projectName: { type: String, default: '' },
  containerId: { type: String, default: '' },
  rawLogs: { type: String, default: '' },
  envKeys: { type: Array, default: () => [] },
  failedCommand: { type: String, default: '' },
  exitCode: { type: Number, default: null },
  envEditable: { type: Boolean, default: false },
});
const emit = defineEmits(['close']);
const router = useRouter();
const route = useRoute();
const toast = useToastStore();
const text = ref('');
const fullText = ref('');
const streaming = ref(false);
const status = ref('idle'); // idle | running | done | error
const statusMessage = ref('');
let controller = null;
let request = 0, pageActive = true;

const title = computed(() => props.projectName || '容器诊断');
const statusText = computed(() => ['error', 'stopped'].includes(status.value) && statusMessage.value ? statusMessage.value : ({ idle: '', running: 'AI 正在分析日志…', done: '诊断完成', error: '诊断失败' })[status.value] || '');
const statusClass = computed(() => status.value === 'error' ? 'text-status-error' : status.value === 'stopped' ? 'text-status-warn' : status.value === 'done' ? 'text-status-ok' : 'text-muted');

watch(() => [props.open, props.projectId, props.containerId, props.rawLogs, props.failedCommand, props.exitCode, props.envKeys], () => {
  if (props.open && pageActive) void start();
  else stop();
}, { immediate: true });
onBeforeUnmount(stop);
onDeactivated(() => { pageActive = false; stop(); });
// Returning to a cached page must not silently repeat a billed model request.
onActivated(() => { pageActive = true; });

async function start() {
  stop();
  if (!props.open || !pageActive) return;
  const version = request, activeController = new AbortController();
  const current = () => pageActive && props.open && version === request;
  let terminal = false, rawText = '';
  text.value = ''; fullText.value = '';
  streaming.value = true; status.value = 'running'; statusMessage.value = '';
  controller = activeController;
  try {
    await streamSse('/ai/diagnose', {
      projectId: props.projectId,
      containerId: props.containerId,
      failedCommand: props.failedCommand,
      exitCode: props.exitCode,
      rawLogs: props.rawLogs,
      envKeys: props.envKeys,
    }, frame => {
      if (!current() || terminal) return;
      if (frame.type === 'token') { rawText += frame.data || ''; text.value = stripAgentProtocol(rawText); }
      else if (frame.type === 'done') {
        terminal = true; fullText.value = stripAgentProtocol(frame.data || rawText); text.value = fullText.value; status.value = 'done'; streaming.value = false;
        activeController.abort();
      } else if (frame.type === 'error') {
        terminal = true; status.value = 'error'; statusMessage.value = String(frame.data?.message || frame.data || '诊断失败'); streaming.value = false;
        activeController.abort();
      }
    }, activeController.signal);
    if (current() && !terminal) { status.value = 'error'; statusMessage.value = '诊断连接已结束，但未收到完成结果。可重新运行诊断。'; }
  } catch (error) {
    if (current() && !terminal) {
      status.value = error.name === 'AbortError' ? 'stopped' : 'error';
      statusMessage.value = error.name === 'AbortError' ? '诊断已中止，可重新运行。' : error.message || '诊断连接失败，可重新运行。';
    }
  } finally {
    if (current()) { streaming.value = false; controller = null; }
  }
}
function stop() {
  request++;
  controller?.abort(); controller = null;
  if (streaming.value) { status.value = 'stopped'; statusMessage.value = '诊断已中止，保留已收到的内容。需要时可重新运行。'; }
  streaming.value = false;
}
function close() { stop(); emit('close'); }
async function copyFix() {
  try { await navigator.clipboard.writeText(fullText.value); toast.success('修复建议已复制到剪贴板'); }
  catch { toast.error('复制失败,请手动选择文本'); }
}
function goCompose() { close(); router.push(deepLink('/compose', { projectId: props.projectId, from: route.name })); }
function goEnv() { close(); router.push(deepLink('/services', { env: props.projectId, from: route.name })); }
async function sendToAgent() {
  if (!fullText.value || !props.projectId) return;
  const prompt = '这是刚完成的 AI 诊断结果，请基于它制定修复方案。不要直接执行有副作用的操作，先说明计划并等待确认。' + '\n\n' + fullText.value;

  close();
  const query = { projectId: props.projectId, diagnose: '1', from: route.name };
  if (props.containerId) query.containerId = props.containerId;
  await router.push({ path: '/agent', query });
  window.dispatchEvent(new CustomEvent('composeops:agent-prompt', { detail: { prompt } }));

}
</script>
