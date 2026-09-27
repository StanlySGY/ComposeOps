<template>
  <div class="page-shell page-shell-workspace">
    <div class="page-header">
      <div><h1 class="page-title">实时日志</h1><p class="page-subtitle">多容器聚合、着色分流与即时过滤</p></div>
      <div class="page-actions">
        <select v-model="projectId" class="input" @change="onProjectChange"><option value="">选择项目</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.projectName }}</option></select>
        <button class="btn-secondary" :class="{ 'btn-primary': aggregateMode }" :disabled="!projectId" :title="aggregateMode ? '当前为聚合模式,点击切换为单容器' : '聚合所有选中容器' " @click="toggleAggregate"><Layers class="w-4 h-4" />{{ aggregateMode ? '聚合中' : '聚合' }}</button>
        <select v-if="!aggregateMode" v-model="containerId" class="input" @change="onContainerChange"><option value="">选择容器</option><option v-for="c in containers" :key="c.id" :value="c.id">{{ c.name }}</option></select>
        <select v-else v-model="selectedContainers" class="input" multiple size="1" title="聚合容器(按住 Ctrl 多选)"><option v-for="c in containers" :key="c.id" :value="c.id">{{ c.name }}</option></select>
        <select v-model="levelFilter" class="input w-28" title="级别过滤"><option value="">全部</option><option value="error">ERROR{{ levelCounts.error ? ` (${levelCounts.error})` : '' }}</option><option value="warn">WARN{{ levelCounts.warn ? ` (${levelCounts.warn})` : '' }}</option></select>
        <input v-model="search" class="input w-40" placeholder="搜索或 /regex/" />
        <button v-if="!connected && !reconnecting" class="btn-primary" :disabled="!canConnect" @click="connect"><Play class="w-4 h-4" />连接</button>
        <button v-else class="btn-danger" @click="disconnect"><Square class="w-4 h-4" />断开</button>
        <button class="icon-btn" :title="paused ? '继续接收' : '暂停显示'" @click="togglePause"><Play v-if="paused" class="w-4 h-4" /><Pause v-else class="w-4 h-4" /></button>
        <button class="icon-btn" title="下载日志" :disabled="!filtered.length" @click="download"><Download class="w-4 h-4" /></button>
        <button class="icon-btn" title="清屏" @click="clearLines"><Trash2 class="w-4 h-4" /></button>
        <button v-if="hasErrors" class="btn-primary" @click="diagnosis = true"><Sparkles class="w-4 h-4" />AI 诊断</button>
      </div>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>
    <div class="flex items-center gap-3 text-muted">
      <span :class="connected ? 'text-emerald-400' : reconnecting ? 'text-amber-400' : ''"><span class="status-dot" :class="connected ? 'bg-emerald-400' : reconnecting ? 'bg-amber-400 animate-pulse' : 'bg-surface-600'"></span>{{ connected ? '已连接' : reconnecting ? '重连中…' : '未连接' }}</span>
      <span>{{ filtered.length }} 条</span>
      <span v-if="levelCounts.error" class="text-rose-400">ERROR {{ levelCounts.error }}</span>
      <span v-if="levelCounts.warn" class="text-amber-400">WARN {{ levelCounts.warn }}</span>
      <span v-if="paused" class="text-amber-400">已暂停 · {{ pending.length }} 条待显示</span>
      <span v-if="sawError && !paused" class="text-rose-300">检测到 {{ retainedCount }} 行异常日志,退出后可到事件中心查阅</span>
      <label class="toggle-label ml-auto"><input v-model="autoScroll" type="checkbox" />自动滚动</label>
    </div>

    <div ref="boxEl" class="terminal-output card flex-1 min-h-[420px]" @scroll="onScroll" @wheel="onWheel">
      <template v-if="filtered.length">
        <div :style="{ height: scrollPadTop + 'px' }" aria-hidden="true"></div>
        <template v-if="aggregateMode">
          <LogLine v-for="line in visibleLines" :key="line.id" :line="line" />
        </template>
        <template v-else>
          <div v-for="line in visibleLines" :key="line.id" class="aggregate-line" :class="line.type === 'stderr' || line.type === 'error' ? 'text-rose-400' : 'text-surface-200'" style="white-space: nowrap; overflow-x: auto;">{{ line.data }}</div>
        </template>
        <div :style="{ height: scrollPadBottom + 'px' }" aria-hidden="true"></div>
      </template>
      <p v-else class="text-muted px-2 py-1">等待日志…</p>
    </div>

    <button v-if="connected && autoScrollPaused && !paused" class="scroll-resume-chip" @click="resumeScroll">已暂停自动滚动(向上) · 点击回到底部</button>

    <AIDiagnosisModal v-if="diagnosis" :open="diagnosis" :project-id="projectId" :project-name="projectName" :container-id="containerId" :raw-logs="recentErrorLogs" :exit-code="null" @close="diagnosis = false" />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Download, Layers, Pause, Play, Sparkles, Square, Trash2 } from 'lucide-vue-next';
import { api, wsUrl } from '../api/client.js';
import AIDiagnosisModal from '../components/services/AIDiagnosisModal.vue';
import LogLine from '../components/logs/LogLine.vue';
import { useWebSocket } from '../composables/useWebSocket.js';

const route = useRoute();
const projects = ref([]);
const projectId = ref(route.query.projectId || '');
const containerId = ref(route.query.containerId || '');
const aggregateMode = ref(false);
const selectedContainers = ref([]);
const levelFilter = ref('');
const tail = ref(200);
const lines = ref([]);
const pending = ref([]);
const search = ref('');
const paused = ref(false);
const autoScroll = ref(true);
const autoScrollPaused = ref(false);
const error = ref('');
const boxEl = ref(null);
const diagnosis = ref(false);
const sequence = ref(0);
const errorLines = ref(0);
const levelCounts = ref({ error: 0, warn: 0, info: 0 });
const sawError = ref(false);
const retainedCount = ref(0);
const LINE_H = 24;
const OVERSCAN = 30;
const viewStart = ref(0);
const viewEnd = ref(0);
let followFrame = 0;
let resizeObserver;

/** 单容器与聚合两条流各自持有一个连接实例,URL 用 getter 读取最新筛选条件。 */
const logSocket = useWebSocket(
  () => wsUrl(`/ws/logs?projectId=${encodeURIComponent(projectId.value)}&containerId=${encodeURIComponent(containerId.value)}&tail=${tail.value}`),
  {
    onOpen: onStreamOpen,
    onMessage: (event) => ingest(event, false),
    onError: (err) => { error.value = err.message || '日志连接失败'; },
  }
);
const aggSocket = useWebSocket(
  () => {
    const ids = selectedContainers.value.join(',');
    return wsUrl(`/ws/aggregated-logs?projectId=${encodeURIComponent(projectId.value)}&containers=${ids ? encodeURIComponent(ids) : ''}`);
  },
  {
    onOpen: onStreamOpen,
    onMessage: (event) => ingest(event, true),
    onError: (err) => { error.value = err.message || '聚合日志连接失败'; },
  }
);

const connected = computed(() => logSocket.connected.value || aggSocket.connected.value);
const reconnecting = computed(() => logSocket.reconnecting.value || aggSocket.reconnecting.value);

const containers = computed(() => projects.value.find((p) => p.id === projectId.value)?.containers || []);
const projectName = computed(() => projects.value.find((p) => p.id === projectId.value)?.projectName || '');
const hasErrors = computed(() => errorLines.value > 0);
const recentErrorLogs = computed(() => lines.value.filter((line) => line.type === 'stderr' || line.type === 'error').map((line) => line.data).join('').slice(-50000));
const canConnect = computed(() => projectId.value && (aggregateMode.value || containerId.value));
const scrollPadTop = computed(() => viewStart.value * LINE_H);
const scrollPadBottom = computed(() => Math.max(0, (filtered.value.length - viewEnd.value) * LINE_H));
const visibleLines = computed(() => viewEnd.value > viewStart.value ? filtered.value.slice(viewStart.value, viewEnd.value) : []);
watch(levelFilter, () => nextTick(syncViewport));
watch(search, () => nextTick(syncViewport));

const filtered = computed(() => {
  let result = lines.value;
  if (levelFilter.value) result = result.filter((line) => (line.level || classifyLevel(line.data)) === levelFilter.value);
  const needle = search.value.trim();
  if (needle) {
    let regex = null;
    if (needle.length > 2 && needle.startsWith('/') && needle.endsWith('/')) {
      try { regex = new RegExp(needle.slice(1, -1), 'i'); }
      catch { regex = null; }
    }
    result = result.filter((line) => regex ? regex.test(line.data) : line.data.toLowerCase().includes(needle.toLowerCase()));
  }
  return result;
});

onMounted(async () => {
  nextTick(syncViewport);
  try {
    projects.value = (await api.getProjects()).projects.filter((project) => project.managed);
    const prefs = await api.getPreferences();
    tail.value = prefs.logTail;
    // 仅当 URL 只有 projectId 时进入聚合模式(带 containerId 则单容器)
    aggregateMode.value = !!(route.query.projectId && !route.query.containerId);
    if (containerId.value && projects.value.some((project) => project.id === projectId.value)) connect();
  } catch (loadError) {
    error.value = loadError.message || '日志页面加载失败';
  }
  window.addEventListener('composeops:host-changed', onHostChanged);
  if (boxEl.value) {
    resizeObserver = new ResizeObserver(() => syncViewport());
    resizeObserver.observe(boxEl.value);
  }
});

function onHostChanged() { disconnect(); clearLines(); projects.value = []; void reloadProjects(); }
async function reloadProjects() {
  try {
    projects.value = (await api.getProjects()).projects.filter((project) => project.managed);
    if ((containerId.value || aggregateMode.value) && projects.value.some((project) => project.id === projectId.value)) connect();
  } catch {
    error.value = '项目列表刷新失败,请稍后重试';
  }
}
function onProjectChange() { containerId.value = ''; selectedContainers.value = []; disconnect(); clearLines(); }
function onContainerChange() { disconnect(); clearLines(); }
function toggleAggregate() {
  aggregateMode.value = !aggregateMode.value;
  selectedContainers.value = [];
  disconnect();
  clearLines();
}

function connect() {
  disconnect();
  error.value = '';
  if (aggregateMode.value) aggSocket.connect();
  else logSocket.connect();
}

/** 重连成功后插入分隔行,提示上方日志与下方日志之间可能存在缺口。 */
function onStreamOpen({ resumed } = {}) {
  if (!resumed) return;
  error.value = '';
  append({ id: ++sequence.value, type: 'stdout', level: 'warn', data: '—— 连接已恢复,期间日志可能有缺失 ——' });
}

function ingest(event, aggregate) {
  try {
    const frame = JSON.parse(event.data);
    if (aggregate) {
      if (frame.type === 'line') {
        pending.value.push({ id: ++sequence.value, ...frame.data });
        flushPending();
      } else if (frame.type === 'error') error.value = frame.data;
      return;
    }
    pending.value.push({ id: ++sequence.value, type: frame.type, data: frame.data });
    flushPending();
  } catch {
    // 非法 WebSocket 帧被丢弃,连接仍可继续接收后续日志。
  }
}
function flushPending() {
  if (paused.value) return;
  for (const item of pending.value.splice(0)) append(item);
}
function append(item) {
  const level = item.level || classifyLevel(item.data);
  item.level = level;
  lines.value.push(item);
  levelCounts.value[level] = (levelCounts.value[level] || 0) + 1;
  if (level === 'error') { errorLines.value += 1; sawError.value = true; retainedCount.value += 1; }
  if (lines.value.length > 5000) {
    const removed = lines.value.splice(0, lines.value.length - 5000);
    for (const oldLine of removed) {
      const oldLevel = oldLine.level || classifyLevel(oldLine.data);
      levelCounts.value[oldLevel] = Math.max(0, (levelCounts.value[oldLevel] || 0) - 1);
      if (oldLevel === 'error') {
        errorLines.value = Math.max(0, errorLines.value - 1);
        retainedCount.value = Math.max(0, retainedCount.value - 1);
      }
    }
  }
  if (autoScroll.value && !autoScrollPaused.value) scheduleFollow();
}
function clearLines() {
  lines.value = [];
  errorLines.value = 0;
  levelCounts.value = { error: 0, warn: 0, info: 0 };
  sawError.value = false;
  retainedCount.value = 0;
  viewStart.value = 0;
  viewEnd.value = 0;
  nextTick(syncViewport);
}
function classifyLevel(text = '') {
  const t = String(text || '');
  if (/(error|exception|fatal|panic|crash|failed)/i.test(t)) return 'error';
  if (/(warn|deprecat)/i.test(t)) return 'warn';
  return 'info';
}
/** rAF 合并的滚底调度:高频日志每帧只滚一次,避免反复强制 reflow 卡死主线程。 */
function scheduleFollow() {
  if (!autoScroll.value || autoScrollPaused.value || followFrame) return;
  followFrame = requestAnimationFrame(() => {
    followFrame = 0;
    if (!boxEl.value) return;
    boxEl.value.scrollTop = boxEl.value.scrollHeight;
    syncViewport();
  });
}
function syncViewport() {
  if (!boxEl.value) return;
  const height = boxEl.value.clientHeight || 420;
  const scrollTop = boxEl.value.scrollTop;
  viewStart.value = Math.max(0, Math.floor(scrollTop / LINE_H) - OVERSCAN);
  viewEnd.value = Math.min(filtered.value.length, Math.ceil((scrollTop + height) / LINE_H) + OVERSCAN);
}
function onScroll() { syncViewport(); }
function togglePause() { paused.value = !paused.value; if (!paused.value) flushPending(); }
function onWheel(event) {
  if (!connected.value || !autoScroll.value) return;
  if (event.deltaY < 0) { autoScrollPaused.value = true; return; }
  autoScrollPaused.value = false;
  scheduleFollow();
}
function resumeScroll() { autoScrollPaused.value = false; scheduleFollow(); }
function disconnect() {
  logSocket.close();
  aggSocket.close();
}
function download() {
  const blob = new Blob([filtered.value.map((l) => `${l.containerName || ''}${l.ts ? ' ' + l.ts : ''} ${l.data}`).join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `composeops-${Date.now()}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}
onBeforeUnmount(() => {
  disconnect();
  if (followFrame) cancelAnimationFrame(followFrame);
  resizeObserver?.disconnect();
  window.removeEventListener('composeops:host-changed', onHostChanged);
});
</script>
