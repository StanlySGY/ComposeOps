<template>
  <section class="card agent-inspector-card">
    <div class="agent-inspector-title"><span>日志上下文</span><em v-if="lines.length">{{ lines.length }} 条已挂载</em></div>
    <p class="text-[11px] leading-5 text-zinc-600">勾选容器日志挂载给 Agent 作为排障证据,与问题一起发送。</p>
    <div class="mt-2 flex flex-col gap-1.5">
      <select v-model="projectId" class="input min-h-8! py-1! text-xs" aria-label="选择项目" @change="onProjectChange"><option value="">选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select>
      <div class="flex gap-1.5">
        <select v-model="containerId" class="input min-h-8! py-1! text-xs" aria-label="选择容器" :disabled="!projectId" @change="onContainerChange"><option value="">选择容器</option><option v-for="container in containers" :key="container.id" :value="container.id">{{ container.name }}</option></select>
        <button class="btn-secondary min-h-8! px-2! py-1! text-xs" :disabled="!projectId || !containerId || loading" aria-label="加载所选容器日志" @click="loadLogs"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />加载</button>
      </div>
      <div v-if="logLines.length" class="flex items-center justify-between text-[11px] text-zinc-500">
        <span role="status" aria-live="polite" aria-atomic="true">{{ filteredLines.length }} 行</span>
        <button class="text-cyan-400 hover:text-cyan-300" :disabled="!errorLines.length" :aria-label="allErrorsSelected ? '取消选择所有异常日志' : '选择所有异常日志'" @click="toggleAllErrors">{{ allErrorsSelected ? '取消全选异常' : '全选异常行' }}</button>
      </div>
      <label v-if="logLines.length" class="search-field min-h-8!"><Search class="h-3.5 w-3.5" /><input v-model="query" class="py-1! text-xs" aria-label="检索日志上下文" placeholder="检索日志..." /></label>
    </div>
    <div class="mt-1.5 max-h-64 overflow-y-auto">
      <p v-if="!projectId" class="px-1 py-4 text-center text-[11px] text-zinc-600">选择容器后加载最近日志</p>
      <p v-else-if="loading" class="px-1 py-4 text-center text-[11px] text-zinc-500" role="status" aria-live="polite">正在拉取日志…</p>
      <p v-else-if="loadError" class="px-1 py-4 text-center text-[11px] text-rose-400" role="alert">{{ loadError }}</p>
      <p v-else-if="containerId && !logLines.length" class="px-1 py-4 text-center text-[11px] text-zinc-600">暂无日志</p>
      <label v-for="log in filteredLines" :key="log.id" class="log-line-item" :class="{ 'is-error': log.level === 'error', 'is-selected': selected.includes(log.id) }">
        <input v-model="selected" type="checkbox" :value="log.id" class="accent-cyan-500" />
        <span class="shrink-0 font-mono text-[9px] uppercase" :class="levelClass(log.level)">{{ log.level }}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-400">{{ log.data }}</span>
      </label>
    </div>
    <div v-if="lines.length" class="mt-2 flex items-center justify-between gap-2">
      <span class="mount-hint"><Check class="h-3 w-3" />将随下一条消息发送</span>
      <button class="text-xs text-zinc-500 hover:text-rose-300" aria-label="清除已挂载日志" @click="clear">清除</button>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { Check, RefreshCw, Search } from 'lucide-vue-next';
import { api } from '../../api/client.js';

const props = defineProps({
  projects: { type: Array, default: () => [] },
});
const emit = defineEmits(['attach']);

const MEMORY_KEY = 'composeops:logpicker';
const projectId = ref('');
const containerId = ref('');

try {
  const remembered = JSON.parse(localStorage.getItem(MEMORY_KEY) || '{}');
  projectId.value = remembered.projectId || '';
  containerId.value = remembered.containerId || '';
} catch {
  // 本地记忆损坏时使用空选择,不阻断 Agent 工作台加载。
}
const logLines = ref([]);
const loading = ref(false);
const loadError = ref('');
let loadRequest = 0;
const query = ref('');
const selected = ref([]);

const containers = computed(() => props.projects.find((project) => project.id === projectId.value)?.containers || []);
const filteredLines = computed(() => {
  let result = logLines.value;
  const needle = query.value.trim().toLowerCase();
  if (needle) result = result.filter((line) => line.data.toLowerCase().includes(needle));
  return result;
});
const errorLines = computed(() => logLines.value.filter((line) => line.level === 'error'));
const allErrorsSelected = computed(() => errorLines.value.length > 0 && errorLines.value.every((line) => selected.value.includes(line.id)));
/** 挂载文本按勾选顺序取行,截尾与后端 50KB 上限对齐。 */
const lines = computed(() => logLines.value.filter((line) => selected.value.includes(line.id)).map((line) => line.data));

function levelClass(level) {
  return { error: 'text-rose-400', warn: 'text-amber-400', info: 'text-zinc-500' }[level] || 'text-zinc-500';
}
function onProjectChange() { loadRequest += 1; loading.value = false; loadError.value = ''; containerId.value = ''; logLines.value = []; selected.value = []; remember(); }
function remember() {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify({ projectId: projectId.value, containerId: containerId.value })); } catch {
    // 隐私模式或存储配额不足时仅放弃记忆,不影响当前选择。
  }
}
function onContainerChange() { loadRequest += 1; loading.value = false; loadError.value = ''; logLines.value = []; selected.value = []; remember(); if (containerId.value) loadLogs(); }
function clear() { selected.value = []; }
function emitAttach() { emit('attach', { text: lines.value.join('\n').slice(0, 50000), count: lines.value.length }); }
watch(selected, emitAttach);

onMounted(() => {
  // 恢复记忆的项目/容器后自动拉取日志,省一次点击
  if (projectId.value && containerId.value) loadLogs();
});

async function loadLogs() {
  if (!projectId.value || !containerId.value) return;
  const request = ++loadRequest;
  const requestedProject = projectId.value;
  const requestedContainer = containerId.value;
  loading.value = true;
  loadError.value = '';
  try {
    const res = await api.getProjectLogs(requestedProject, requestedContainer);
    // 用户切换项目/容器后,迟到的响应不能覆盖当前选择的日志。
    if (request !== loadRequest || requestedProject !== projectId.value || requestedContainer !== containerId.value) return;
    logLines.value = typeof res?.logs === 'string' ? parseLogText(res.logs) : [];
    selected.value = [];
  } catch {
    if (request === loadRequest && requestedProject === projectId.value && requestedContainer === containerId.value) {
      logLines.value = [];
      selected.value = [];
      loadError.value = '日志加载失败，请检查连接后重试。';
    }
  } finally {
    if (request === loadRequest) loading.value = false;
  }
}
function parseLogText(text) {
  return String(text || '').split('\n').filter((line) => line.trim()).slice(-200).map((line, index) => {
    const level = /(error|exception|fatal|panic|failed|crash)/i.test(line) ? 'error' : /(warn|deprecat)/i.test(line) ? 'warn' : 'info';
    return { id: `log-${index}-${Date.now()}`, level, data: line.slice(0, 300) };
  });
}

</script>
