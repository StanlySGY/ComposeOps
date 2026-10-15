<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4">
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
    <p v-if="truncated" class="alert-warning" role="status">窗口内事件量超出后端单次批量上限,下方时长为截断后的部分结果。</p>

    <!-- 窗口摘要 -->
    <div class="metric-grid">
      <div class="metric-tile"><span class="metric-icon text-blue-300"><Boxes class="h-5 w-5" /></span><span><strong>{{ summary.containers || 0 }}</strong><small>容器数</small></span><span class="metric-meta">{{ rangeLabel }}</span></div>
      <div class="metric-tile"><span class="metric-icon" :class="availabilityTone(summary.availability)"><Gauge class="h-5 w-5" /></span><span><strong>{{ availabilityText(summary.availability) }}</strong><small>整体可用率</small></span><span class="metric-meta">未知时长不计入分母</span></div>
      <div class="metric-tile"><span class="metric-icon text-rose-300"><CircleX class="h-5 w-5" /></span><span><strong>{{ summary.abnormalExits || 0 }}</strong><small>异常退出</small></span><span class="metric-meta">退出码非 0</span></div>
      <div class="metric-tile"><span class="metric-icon text-violet-300"><ArrowRightLeft class="h-5 w-5" /></span><span><strong>{{ summary.transitions || 0 }}</strong><small>状态转换</small></span><span class="metric-meta">共 {{ summary.exits || 0 }} 次退出</span></div>
      <div class="metric-tile"><span class="metric-icon text-amber-300"><Clock3 class="h-5 w-5" /></span><span><strong>{{ formatSeconds(summary.unknownSeconds) }}</strong><small>状态未知</small></span><span class="metric-meta">运行 {{ formatSeconds(summary.upSeconds) }}</span></div>
    </div>

    <!-- 过滤器 -->
    <div class="toolbar-panel flex flex-wrap items-center gap-2">
      <select v-model="projectId" class="input sm:w-44" aria-label="项目筛选" @change="load">
        <option value="">全部纳管项目</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
      </select>
      <select v-model="days" class="input sm:w-32" aria-label="时间窗口" @change="load">
        <option :value="1">最近 1 天</option>
        <option :value="7">最近 7 天</option>
        <option :value="30">最近 30 天</option>
        <option :value="90">最近 90 天</option>
      </select>
      <select v-model="actionFilter" class="input sm:w-36" aria-label="动作筛选" @change="load">
        <option value="">全部动作</option>
        <option v-for="action in ACTIONS" :key="action" :value="action">{{ actionLabel(action) }}</option>
      </select>
      <label class="search-field"><Search class="h-4 w-4" /><input v-model="query" aria-label="搜索容器或项目名" placeholder="搜索容器或项目名" /></label>
      <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button>
      <button class="btn-secondary" @click="showPruneConfirm = true"><Trash2 class="h-4 w-4" />清理历史</button>
      <span class="ml-auto whitespace-nowrap text-muted">显示 {{ filteredContainers.length }} / {{ containers.length }} 个容器</span>
    </div>

    <ConfirmDialog
      :show="showPruneConfirm"
      title="清理状态历史"
      :message="`确认删除 ${pruneDays} 天前的容器状态事件?宕机历史与可用率统计将一并丢失,该操作不可恢复。`"
      tone="warning"
      confirm-text="清理"
      @confirm="prune"
      @cancel="showPruneConfirm = false"
    />

    <Skeleton v-if="loading && !containers.length" variant="table" :rows="6" label="状态历史加载中" class="flex-1" />
    <EmptyState
      v-else-if="!containers.length && !error"
      icon="FileClock"
      title="暂无状态历史"
      description="状态记录器常驻后,容器的启动、退出、销毁会持续落库;有事件之后这里会给出逐容器可用率与宕机明细。"
    />
    <EmptyState v-else-if="!filteredContainers.length && !error" icon="Search" title="没有匹配的容器" description="调整项目、窗口或搜索条件后重试" action-label="清除筛选" @action="resetFilters" />

    <!-- 逐容器可用率 -->
    <section v-if="filteredContainers.length" class="section-panel">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div><h2 class="section-title">可用率</h2><p class="mt-1 text-muted">按状态转换事件换算,不可判定的时长不计入分母</p></div>
        <span class="count-badge">可用率升序</span>
      </div>
      <div class="table-wrap">
        <table class="data-table min-w-[720px]">
          <thead>
            <tr>
              <th class="whitespace-nowrap">容器</th>
              <th class="hidden sm:table-cell whitespace-nowrap">项目</th>
              <th class="min-w-32 whitespace-nowrap">可用率</th>
              <th class="text-right whitespace-nowrap">运行</th>
              <th class="text-right whitespace-nowrap">宕机</th>
              <th class="text-right whitespace-nowrap">转换</th>
              <th class="whitespace-nowrap">最近状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in visibleContainers" :key="item.containerId">
              <td class="whitespace-nowrap">{{ item.containerName }}</td>
              <td class="hidden max-w-40 truncate sm:table-cell">{{ item.projectName }}</td>
              <td class="min-w-32">
                <div class="progress"><span :class="availabilityBarTone(item.availability)" :style="{ width: `${Math.max(0, Math.min(100, item.availability ?? 0))}%` }"></span></div>
                <div class="mt-1 text-[11px]" :class="availabilityTone(item.availability)">{{ availabilityText(item.availability) }}</div>
              </td>
              <td class="text-right whitespace-nowrap">{{ formatSeconds(item.upSeconds) }}</td>
              <td class="text-right whitespace-nowrap">{{ formatSeconds(item.downSeconds) }}</td>
              <td class="text-right whitespace-nowrap">{{ item.transitions }}</td>
              <td class="whitespace-nowrap">
                <span class="count-badge" :class="actionTone(item.lastAction)">{{ actionLabel(item.lastAction) }}</span>
                <span v-if="item.lastExitCode !== null && item.lastExitCode !== undefined" class="count-badge ml-1.5" :class="item.abnormalExits ? 'text-rose-300' : 'text-emerald-300'">exit {{ item.lastExitCode }}</span>
                <span v-if="item.destroyed" class="count-badge ml-1.5 text-surface-500">已销毁</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="filteredContainers.length > visibleContainers.length" class="mt-2 text-muted">仅显示前 {{ visibleContainers.length }} 个,其余 {{ filteredContainers.length - visibleContainers.length }} 个可用率更高。</p>
    </section>

    <!-- 退出明细 -->
    <section v-if="filteredExits.length" class="section-panel">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div><h2 class="section-title">退出明细</h2><p class="mt-1 text-muted">异常退出置顶,用于定位"最近为什么挂过"</p></div>
        <span class="count-badge">{{ exitsTotal }} 次退出</span>
      </div>
      <div class="space-y-1.5">
        <div v-for="exit in visibleExits" :key="`${exit.containerId}-${exit.timestamp}`" class="flex flex-wrap items-center gap-2 rounded-xl border border-surface-800 bg-surface-950/40 px-3 py-2">
          <span class="count-badge shrink-0" :class="exit.abnormal ? 'text-rose-300' : 'text-emerald-300'">exit {{ exit.exitCode ?? '未知' }}</span>
          <span class="text-sm font-medium text-surface-100">{{ exit.containerName }}</span>
          <span v-if="exit.projectName" class="truncate text-xs text-surface-500">{{ exit.projectName }}</span>
          <span class="ml-auto font-mono text-xs tabular-nums text-surface-400">{{ formatTime(exit.timestamp) }}</span>
          <span class="count-badge shrink-0">存活 {{ formatSeconds(exit.execDuration) }}</span>
        </div>
        <p v-if="filteredExits.length > visibleExits.length" class="text-muted">仅显示前 {{ visibleExits.length }} 条。</p>
      </div>
    </section>

    <!-- 状态转换流水 -->
    <section v-if="filteredHistory.length" class="section-panel">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div><h2 class="section-title">状态转换流水</h2><p class="mt-1 text-muted">服务端持久化的原始事件,刷新不再丢失</p></div>
        <span class="count-badge">{{ history.length }} 条</span>
      </div>
      <div class="relative space-y-1">
        <div class="absolute left-[7px] top-2 bottom-2 w-px bg-surface-800" aria-hidden="true"></div>
        <div v-for="item in visibleHistory" :key="item.id" class="relative flex gap-3 py-1.5">
          <div class="relative z-10 mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
            <span class="h-3 w-3 rounded-full border-2" :class="actionDot(item.action)"></span>
          </div>
          <div class="min-w-0 flex-1 rounded-xl border border-surface-800 bg-surface-950/60 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="count-badge shrink-0" :class="actionTone(item.action)">{{ actionLabel(item.action) }}</span>
              <span v-if="item.healthStatus" class="count-badge shrink-0 text-sky-300">{{ item.healthStatus }}</span>
              <span v-if="item.action === 'die'" class="count-badge shrink-0" :class="item.exitCode ? 'text-rose-300' : 'text-emerald-300'">exit {{ item.exitCode ?? '未知' }}</span>
              <span class="text-sm font-medium text-surface-100">{{ item.containerName }}</span>
              <span class="ml-auto font-mono text-xs tabular-nums text-surface-400">{{ formatTime(item.timestamp) }}</span>
            </div>
            <p v-if="item.projectName" class="mt-1 truncate text-xs text-surface-500">{{ item.projectName }}</p>
          </div>
        </div>
        <p v-if="filteredHistory.length > visibleHistory.length" class="text-muted">仅显示前 {{ visibleHistory.length }} 条,缩小窗口可看到更完整的流水。</p>
      </div>
    </section>
  </div>
</template>

<script setup>
// uptime-kuma 式服务端状态历史的只读视图:可用率、宕机明细、转换流水,嵌入事件中心 tab
import { computed, onMounted, ref } from 'vue';
import { usePullRefresh } from '../../composables/usePullRefresh.js';
import { ArrowRightLeft, Boxes, CircleX, Clock3, Gauge, RefreshCw, Search, Trash2 } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import Skeleton from '../common/Skeleton.vue';
import EmptyState from '../common/EmptyState.vue';
import ConfirmDialog from '../common/ConfirmDialog.vue';

const loading = ref(false);
const error = ref('');
const truncated = ref(false);
const projects = ref([]);
const projectId = ref('');
const days = ref(7);
const actionFilter = ref('');
const query = ref('');
const containers = ref([]);
const exits = ref([]);
const exitsTotal = ref(0);
const history = ref([]);
const summary = ref({});
const showPruneConfirm = ref(false);
const pruneDays = 90;

// 表格/列表的渲染上限:窗口拉到 90 天时行数可能上千,全渲染会拖慢首屏。
const CONTAINER_LIMIT = 60;
const EXIT_LIMIT = 40;
const HISTORY_LIMIT = 60;

const ACTIONS = ['start', 'die', 'stop', 'kill', 'pause', 'unpause', 'restart', 'destroy', 'health_status'];
const ACTION_LABELS = {
  start: '启动', die: '退出', stop: '停止', kill: '强杀', pause: '暂停',
  unpause: '恢复', restart: '重启', destroy: '销毁', create: '创建', health_status: '健康检查',
};

function actionLabel(action) { return ACTION_LABELS[action] || action || '未知'; }
function actionTone(action) {
  return { start: 'text-emerald-300', restart: 'text-emerald-300', unpause: 'text-emerald-300', die: 'text-rose-300', kill: 'text-rose-300', stop: 'text-amber-300', pause: 'text-amber-300', destroy: 'text-surface-400', health_status: 'text-sky-300' }[action] || 'text-surface-400';
}
function actionDot(action) {
  return { start: 'border-emerald-400 bg-emerald-400', restart: 'border-emerald-400 bg-emerald-400', unpause: 'border-emerald-400 bg-emerald-400', die: 'border-rose-400 bg-rose-400', kill: 'border-rose-400 bg-rose-400', stop: 'border-amber-400 bg-amber-400', pause: 'border-amber-400 bg-amber-400', destroy: 'border-surface-600 bg-surface-600', health_status: 'border-sky-400 bg-sky-400' }[action] || 'border-surface-500 bg-surface-500';
}

function availabilityText(value) {
  // null 表示窗口内没有任何可判定区间(只有 health_status),不能显示成 0%
  if (value === null || value === undefined) return '不可判定';
  return `${Number(value).toFixed(2)}%`;
}
function availabilityTone(value) {
  if (value === null || value === undefined) return 'text-surface-500';
  if (value >= 99) return 'text-emerald-300';
  if (value >= 90) return 'text-amber-300';
  return 'text-rose-300';
}
function availabilityBarTone(value) {
  if (value === null || value === undefined) return 'bg-surface-600';
  if (value >= 99) return 'bg-emerald-400';
  if (value >= 90) return 'bg-amber-400';
  return 'bg-rose-400';
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  if (!seconds) return '0s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${rest}s`;
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

const rangeLabel = computed(() => `最近 ${days.value} 天`);
const needle = computed(() => query.value.trim().toLowerCase());

function matches(item) {
  return !needle.value || `${item.containerName || ''} ${item.projectName || ''}`.toLowerCase().includes(needle.value);
}

const filteredContainers = computed(() => containers.value.filter(matches));
const filteredExits = computed(() => exits.value.filter(matches));
const filteredHistory = computed(() => history.value.filter(matches));
const visibleContainers = computed(() => filteredContainers.value.slice(0, CONTAINER_LIMIT));
const visibleExits = computed(() => filteredExits.value.slice(0, EXIT_LIMIT));
const visibleHistory = computed(() => filteredHistory.value.slice(0, HISTORY_LIMIT));

function resetFilters() { query.value = ''; actionFilter.value = ''; }

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const [projectsResult, uptimeResult, exitsResult, historyResult] = await Promise.allSettled([
      api.getProjects(),
      api.getStateUptime({ projectId: projectId.value, days: days.value }),
      api.getStateExits({ projectId: projectId.value, days: days.value }),
      api.getStateHistory({ projectId: projectId.value, action: actionFilter.value, limit: 200 }),
    ]);

    if (projectsResult.status === 'fulfilled') {
      projects.value = (projectsResult.value?.projects || []).filter((project) => project.managed);
    }
    if (uptimeResult.status === 'fulfilled') {
      const report = uptimeResult.value || {};
      containers.value = report.containers || [];
      summary.value = report.summary || {};
      truncated.value = !!report.truncated;
    }
    if (exitsResult.status === 'fulfilled') {
      exits.value = exitsResult.value?.exits || [];
      exitsTotal.value = exitsResult.value?.total || 0;
    }
    if (historyResult.status === 'fulfilled') {
      history.value = historyResult.value?.history || [];
    }

    const failed = [uptimeResult, exitsResult, historyResult].find((result) => result.status === 'rejected');
    if (failed) error.value = failed.reason?.message || '状态历史加载失败';
  } catch (e) {
    error.value = e.message || '状态历史加载失败';
  } finally {
    loading.value = false;
  }
}

async function prune() {
  showPruneConfirm.value = false;
  try {
    const result = await api.pruneStateHistory(pruneDays);
    await load();
    void result;
  } catch (e) {
    error.value = e.message || '清理状态历史失败';
  }
}

usePullRefresh(load);
onMounted(load);
</script>
