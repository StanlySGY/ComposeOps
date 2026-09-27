<template>
  <BaseModal :show="open" :title="`AI 一键诊断 · ${title}`" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[86vh] flex-col" body-class="min-h-0 flex-1 p-0" @close="close">
    <template #header-actions>
      <Sparkles class="w-4 h-4 text-accent" />
    </template>
    <div class="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_11rem]">
      <div class="min-w-0 overflow-y-auto p-4">
        <div v-if="!streaming && !text" class="flex h-full min-h-32 items-center justify-center text-muted">等待 AI 诊断结果…</div>
        <AgentMarkdown class="ai-diagnosis agent-rich-markdown" :content="text" />
      </div>
      <aside class="flex flex-col gap-2 border-t border-surface-800 p-3 md:border-l md:border-t-0">
        <p class="text-xs text-muted">快捷操作</p>
        <button class="btn-secondary" :disabled="!fullText" @click="copyFix"><Copy class="w-4 h-4" />复制修复命令</button>
        <button class="btn-secondary" :disabled="!projectId" @click="goCompose"><FileCode2 class="w-4 h-4" />跳转 Compose 编辑器</button>
        <button class="btn-secondary" :disabled="!projectId || !envEditable" @click="goEnv"><KeyRound class="w-4 h-4" />跳转 Env 编辑器</button>
      </aside>
    </div>
    <footer v-if="statusText" class="shrink-0 border-t border-surface-800 px-4 py-2 text-xs" :class="statusClass">{{ statusText }}</footer>
  </BaseModal>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { streamSse } from '../../api/client.js';
import { stripAgentProtocol } from '../../lib/agent-text.js';
import { useToastStore } from '../../stores/toast.js';
import { Copy, FileCode2, KeyRound, Sparkles } from 'lucide-vue-next';
import { useRouter } from 'vue-router';
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
const toast = useToastStore();
const text = ref('');
const fullText = ref('');
const streaming = ref(false);
const status = ref('idle'); // idle | running | done | error
const statusMessage = ref('');
let controller = null;

const title = computed(() => props.projectName || '容器诊断');
const statusText = computed(() => status.value === 'error' && statusMessage.value ? statusMessage.value : ({ idle: '', running: 'AI 正在分析日志…', done: '诊断完成', error: '诊断失败' })[status.value] || '');
const statusClass = computed(() => status.value === 'error' ? 'text-rose-400' : status.value === 'done' ? 'text-emerald-400' : 'text-muted');

watch(() => props.open, (isOpen) => { if (isOpen) start(); });

async function start() {
  stop();
  text.value = '';
  fullText.value = '';
  streaming.value = true;
  status.value = 'running';
  statusMessage.value = '';
  controller = new AbortController();
  let rawText = '';
  try {
    await streamSse('/ai/diagnose', {
      projectId: props.projectId,
      containerId: props.containerId,
      failedCommand: props.failedCommand,
      exitCode: props.exitCode,
      rawLogs: props.rawLogs,
      envKeys: props.envKeys,
    }, (frame) => {
      if (frame.type === 'token') { rawText += frame.data || ''; text.value = stripAgentProtocol(rawText); }
      else if (frame.type === 'done') { fullText.value = stripAgentProtocol(frame.data || rawText); text.value = fullText.value; status.value = 'done'; }
      else if (frame.type === 'error') { status.value = 'error'; statusMessage.value = frame.data; }
    }, controller.signal);
  } catch (e) {
    if (e.name !== 'AbortError') { status.value = 'error'; }
  } finally {
    streaming.value = false;
  }
}
function stop() {
  if (controller) {
    try { controller.abort(); } catch {
      // 控制器已经结束时 abort 失败不影响关闭诊断弹窗。
    }
    controller = null;
  }
}
function close() { stop(); emit('close'); }
async function copyFix() {
  try { await navigator.clipboard.writeText(fullText.value); toast.success('修复建议已复制到剪贴板'); }
  catch { toast.error('复制失败,请手动选择文本'); }
}
function goCompose() { close(); router.push(`/compose?projectId=${props.projectId}`); }
function goEnv() { close(); router.push(`/services?env=${props.projectId}`); }
</script>
