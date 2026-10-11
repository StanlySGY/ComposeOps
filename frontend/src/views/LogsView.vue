<template>
  <div class="page-shell page-shell-workspace">
    <div class="page-header">
      <div><h1 class="page-title">实时日志</h1><p class="page-subtitle">多容器聚合、着色分流与即时过滤</p></div>
      <div class="page-actions">
        <select v-model="projectId" class="input" @change="onProjectChange"><option value="">选择项目</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.projectName }}</option></select>
        <button class="btn-secondary" :class="{ 'btn-primary': aggregateMode }" :disabled="!projectId" :title="aggregateMode ? '当前为聚合模式,点击切换为单容器' : '聚合所有选中容器'" @click="toggleAggregate"><Layers class="w-4 h-4" />{{ aggregateMode ? '聚合中' : '聚合' }}</button>
        <select v-model="levelFilter" class="input w-28" title="级别过滤"><option value="">全部</option><option value="error">ERROR{{ levelCounts.error ? ` (${levelCounts.error})` : '' }}</option><option value="warn">WARN{{ levelCounts.warn ? ` (${levelCounts.warn})` : '' }}</option></select>
        <label class="search-field w-44"><Search class="h-4 w-4" /><input ref="searchEl" v-model="search" placeholder="搜索或 /regex/" /></label>
        <button v-if="!connected && !reconnecting" class="btn-primary" :disabled="!canConnect" @click="connect"><Play class="w-4 h-4" />连接</button>
        <button v-else class="btn-danger" @click="disconnect"><Square class="w-4 h-4" />断开</button>
        <button class="icon-btn" :title="paused ? '继续接收' : '暂停显示'" @click="togglePause"><Play v-if="paused" class="w-4 h-4" /><Pause v-else class="w-4 h-4" /></button>
        <button class="icon-btn" title="下载日志" :disabled="!filtered.length" @click="download"><Download class="w-4 h-4" /></button>
        <button class="icon-btn" title="清屏" @click="clearLines"><Trash2 class="w-4 h-4" /></button>
        <button v-if="hasErrors" class="btn-primary" @click="diagnosis = true"><Sparkles class="w-4 h-4" />AI 诊断</button>
      </div>
    </div>

    <!-- 容器选择条(借鉴 Dozzle:模糊匹配容器名 + 名称旁直接挂实时 CPU/内存) -->
    <div v-if="containers.length" class="container-picker">
      <div class="flex flex-wrap items-center gap-2">
        <label class="search-field w-44"><Filter class="h-4 w-4" /><input v-model="containerQuery" :placeholder="aggregateMode ? '过滤容器(可多选)' : '过滤容器(支持缩写)'" /></label>
        <span class="text-[11px] text-muted">{{ aggregateMode ? (selectedContainers.length ? `已选 ${selectedContainers.length} 个容器` : '未选择时聚合全部容器') : '点击容器切换日志源' }}</span>
        <template v-if="aggregateMode">
          <button class="btn-secondary min-h-7! px-2! py-0.5! text-[11px]!" @click="selectVisibleContainers">全选可见</button>
          <button class="btn-secondary min-h-7! px-2! py-0.5! text-[11px]!" :disabled="!selectedContainers.length" @click="selectedContainers = []">清空</button>
        </template>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="c in visibleContainers"
          :key="c.id"
          class="container-chip"
          :class="{ active: aggregateMode ? selectedContainers.includes(c.id) : c.id === containerId }"
          :title="`${c.name} · ${c.state || '未知状态'}${c.image ? ' · ' + c.image : ''}`"
          @click="pickContainer(c)"
        >
          <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="c.state === 'running' ? 'bg-emerald-400' : 'bg-surface-600'"></span>
          <span class="min-w-0 max-w-40 truncate">{{ c.name }}</span>
          <span v-if="liveStats[c.id]" class="metric-chip">{{ liveStats[c.id] }}</span>
        </button>
        <span v-if="!visibleContainers.length" class="py-1 text-[11px] text-muted">没有匹配的容器</span>
      </div>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>
    <p v-if="pausedDropped" class="text-xs text-amber-400" role="status">暂停期间仅保留最近 5000 条日志,已丢弃 {{ pausedDropped }} 条。</p>
    <div class="flex flex-wrap items-center gap-3 text-muted">
      <span :class="connected ? 'text-emerald-400' : reconnecting ? 'text-amber-400' : ''"><span class="status-dot" :class="connected ? 'bg-emerald-400' : reconnecting ? 'bg-amber-400 animate-pulse' : 'bg-surface-600'"></span>{{ connected ? '已连接' : reconnecting ? '重连中…' : streamEnded ? '日志已结束' : '未连接' }}</span>
      <span>{{ filtered.length }} 条</span>
      <span v-if="levelCounts.error" class="text-rose-400">ERROR {{ levelCounts.error }}</span>
      <span v-if="levelCounts.warn" class="text-amber-400">WARN {{ levelCounts.warn }}</span>
      <span v-if="paused" class="text-amber-400">已暂停 · {{ pending.length }} 条待显示</span>
      <span v-if="sawError && !paused" class="text-rose-300">当前保留 {{ retainedCount }} 行异常日志</span>
      <label class="toggle-label ml-auto"><input v-model="autoScroll" type="checkbox" />自动滚动</label>
    </div>

    <div ref="boxEl" class="terminal-output card flex-1 min-h-[420px]" @scroll="onScroll" @wheel="onWheel">
      <template v-if="filtered.length">
        <div :style="{ height: scrollPadTop + 'px' }" aria-hidden="true"></div>
        <!-- 单容器与聚合共用 LogLine:单容器流的帧里没有 containerName,由 fallback-name 补上徽章。 -->
        <LogLine v-for="line in visibleLines" :key="line.id" :line="line" :fallback-name="activeContainerName" />
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
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useRoute } from 'vue-router';
import { Download, Filter, Layers, Pause, Play, Search, Sparkles, Square, Trash2 } from 'lucide-vue-next';
import { api, streamProjectStats, wsUrl } from '../api/client.js';
import AIDiagnosisModal from '../components/services/AIDiagnosisModal.vue';
import LogLine from '../components/logs/LogLine.vue';
import { filterContainers } from '../lib/container-match.js';
import { useWebSocket } from '../composables/useWebSocket.js';

const route = useRoute();
const projects = ref([]);
const projectId = ref(route.query.projectId || '');
const containerId = ref(route.query.containerId || '');
const aggregateMode = ref(!!route.query.projectId && !route.query.containerId);
const selectedContainers = ref([]);
const containerQuery = ref('');
const levelFilter = ref('');
const tail = ref(200);
const lines = ref([]);
const pending = ref([]);
const search = ref('');
const paused = ref(false);
const pausedDropped = ref(0);
const streamEnded = ref(false);
const MAX_LINES = 5000;
let disposed = false;
let loadId = 0;
const autoScroll = ref(true);
const autoScrollPaused = ref(false);
const error = ref('');
const boxEl = ref(null);
const searchEl = ref(null);
const diagnosis = ref(false);
const sequence = ref(0);
const errorLines = ref(0);
const levelCounts = ref({ error: 0, warn: 0, info: 0 });
const sawError = ref(false);
const retainedCount = ref(0);
const liveStats = ref({});
const LINE_H = 24;
const OVERSCAN = 30;
const viewStart = ref(0);
const viewEnd = ref(0);
let followFrame = 0;
let resizeObserver;
let statsController = null;

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
    return wsUrl(`/ws/aggregated-logs?projectId=${encodeURIComponent(projectId.value)}&containers=${ids ? encodeURIComponent(ids) : ''}&tail=${tail.value}`);
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
const visibleContainers = computed(() => filterContainers(containers.value, containerQuery.value));
const activeContainerName = computed(() => containers.value.find((c) => c.id === containerId.value)?.name || '');
const projectName = computed(() => projects.value.find((p) => p.id === projectId.value)?.projectName || '');
const hasErrors = computed(() => errorLines.value > 0);
const recentErrorLogs = computed(() => lines.value.filter((line) => line.level === 'error' || line.type === 'stderr').map((line) => line.data).join('\n').slice(-50000));
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

// 只重读项目列表:日志流本身由 WebSocket 推,下拉刷新不主动断流重建连接。
usePullRefresh(reloadProjects);
onMounted(() => {
  nextTick(syncViewport);
  window.addEventListener('composeops:host-changed', onHostChanged);
  window.addEventListener('keydown', onKeydown);
  if (boxEl.value) {
    resizeObserver = new ResizeObserver(syncViewport);
    resizeObserver.observe(boxEl.value);
  }
  void reloadProjects();
});

function onHostChanged() { disconnect(); closeStats(); clearLines(); projects.value = []; void reloadProjects(); }
async function reloadProjects() {
  const currentLoad = ++loadId;
  const [result, prefs] = await Promise.allSettled([api.getProjects(true), api.getPreferences()]);
  if (disposed || currentLoad !== loadId) return;
  if (prefs.status === 'fulfilled' && Number.isFinite(Number(prefs.value?.logTail))) tail.value = Number(prefs.value.logTail);
  if (result.status === 'rejected') {
    error.value = result.reason?.message || '项目列表刷新失败,请稍后重试';
    return;
  }
  projects.value = (result.value?.projects || []).filter(project => project.managed);
  error.value = '';
  openStats();
  if (canConnect.value && projects.value.some(project => project.id === projectId.value)) connect();
}
watch(() => [route.query.projectId, route.query.containerId], ([nextProject, nextContainer]) => {
  disconnect();
  clearLines();
  projectId.value = nextProject || '';
  containerId.value = nextContainer || '';
  aggregateMode.value = !!nextProject && !nextContainer;
  selectedContainers.value = [];
  containerQuery.value = '';
  openStats();
  if (canConnect.value && projects.value.some(project => project.id === projectId.value)) connect();
});
function onProjectChange() { containerId.value = ''; selectedContainers.value = []; containerQuery.value = ''; disconnect(); closeStats(); clearLines(); }
function onContainerChange() { disconnect(); clearLines(); }
function toggleAggregate() {
  aggregateMode.value = !aggregateMode.value;
  selectedContainers.value = [];
  disconnect();
  clearLines();
}

/** 容器 chip 点击:聚合模式改多选集合,单容器模式换日志源。 */
function pickContainer(container) {
  if (aggregateMode.value) {
    const index = selectedContainers.value.indexOf(container.id);
    if (index >= 0) selectedContainers.value.splice(index, 1);
    else selectedContainers.value.push(container.id);
    if (connected.value) connect();
    return;
  }
  if (containerId.value === container.id) return;
  containerId.value = container.id;
  onContainerChange();
}
function selectVisibleContainers() { selectedContainers.value = visibleContainers.value.map((c) => c.id); }

function connect() {
  if (disposed || !canConnect.value) return;
  // 聚合模式改选容器:URL 是 getter,直接 connect 即可让 useWebSocket 换址重连,
  // 先 close 会让日志整段断一下,肉眼可见地闪。
  if (!(aggregateMode.value && aggSocket.connected.value)) disconnect();
  streamEnded.value = false;
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
  if (disposed) return;
  try {
    const frame = JSON.parse(event.data);
    if (frame.type === 'error') { error.value = frame.data; return; }
    if (frame.type === 'end') { streamEnded.value = true; disconnect(); return; }
    const line = aggregate ? (frame.type === 'line' ? frame.data : null)
      : (['stdout', 'stderr'].includes(frame.type) ? frame : null);
    if (!line || typeof line.data !== 'string') return;
    pending.value.push({ ...line, id: ++sequence.value });
    if (pending.value.length > MAX_LINES) {
      const overflow = pending.value.length - MAX_LINES;
      pending.value.splice(0, overflow);
      pausedDropped.value += overflow;
    }
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
  if (lines.value.length > MAX_LINES) {
    const removed = lines.value.splice(0, lines.value.length - MAX_LINES);
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
  pending.value = [];
  pausedDropped.value = 0;
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

const ACTIVE_TAG = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
function isTyping(target) {
  if (!target || !target.tagName) return false;
  if (ACTIVE_TAG.has(target.tagName) || target.isContentEditable) return true;
  return !!target.closest?.('.monaco-editor');
}
/** 与速查表一致的日志页快捷键:/ 聚焦搜索,Space 暂停/继续,End 恢复自动滚动。 */
function onKeydown(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === '/') {
    if (isTyping(event.target)) return;
    event.preventDefault();
    searchEl.value?.focus();
    return;
  }
  if (isTyping(event.target)) return;
  // 焦点在按钮上时交给浏览器原生激活,避免一次按键触发两次。
  if (event.target?.closest?.('button')) return;
  if (event.key === ' ') { event.preventDefault(); togglePause(); }
  else if (event.key === 'End') { event.preventDefault(); resumeScroll(); }
}

function numberValue(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(Math.round(num * 10) / 10) : '0';
}
/** 复用项目指标 SSE 流,在容器 chip 上挂实时 CPU/内存(Dozzle 侧栏同款)。 */
function closeStats() {
  statsController?.abort();
  statsController = null;
  liveStats.value = {};
}
function openStats() {
  closeStats();
  if (disposed || !projectId.value) return;
  if (!containers.value.some((c) => c.state === 'running')) return;
  const controller = new AbortController();
  statsController = controller;
  streamProjectStats(projectId.value, (frame) => {
    if (disposed || statsController !== controller) return;
    if (frame.type !== 'stats') return;
    const next = {};
    for (const row of frame.data || []) {
      if (!row?.containerId) continue;
      next[row.containerId] = `${numberValue(row.cpuPercent)}% · ${numberValue(row.memUsageMB)}MB`;
    }
    liveStats.value = next;
  }, controller.signal, 5000).catch(() => {
    // 指标流不可用时静默降级,日志流本身不受影响。
  });
}

function download() {
  const blob = new Blob([filtered.value.map((l) => `${l.containerName || activeContainerName.value || ''}${l.ts ? ' ' + l.ts : ''} ${l.data}`).join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `composeops-${Date.now()}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}
onBeforeUnmount(() => {
  disposed = true;
  loadId += 1;
  disconnect();
  closeStats();
  if (followFrame) cancelAnimationFrame(followFrame);
  resizeObserver?.disconnect();
  window.removeEventListener('composeops:host-changed', onHostChanged);
  window.removeEventListener('keydown', onKeydown);
});
</script>
