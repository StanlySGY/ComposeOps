<template>
  <div :class="embedded ? '' : 'page-shell'">
    <div v-if="!embedded" class="page-header">
      <div><h1 class="page-title">操作中心</h1><p class="page-subtitle">跟踪后台任务进度，审计 Compose 操作、配置修改和维护结果</p></div>
      <div class="page-actions"><button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button></div>
    </div>

    <div class="tabs" role="tablist" aria-label="操作中心视图" @keydown="handleTabKeydown">
      <button id="operations-tab-records" data-tab="operations" :class="{ active: activeTab === 'operations' }" role="tab" aria-controls="operations-panel-records" :aria-selected="activeTab === 'operations'" :tabindex="activeTab === 'operations' ? 0 : -1" @click="setTab('operations')"><History class="h-4 w-4" />操作记录 <span class="count-badge">{{ operations.length }}</span></button>
      <button id="operations-tab-jobs" data-tab="jobs" :class="{ active: activeTab === 'jobs' }" role="tab" aria-controls="operations-panel-jobs" :aria-selected="activeTab === 'jobs'" :tabindex="activeTab === 'jobs' ? 0 : -1" @click="setTab('jobs')"><ListChecks class="h-4 w-4" />后台任务 <span class="count-badge">{{ jobs.length }}</span></button>
    </div>

    <section id="operations-panel-records" v-show="activeTab === 'operations'" role="tabpanel" aria-labelledby="operations-tab-records" tabindex="0">
      <div class="metric-grid">
        <button class="metric-tile" :class="{ active: statusFilter === 'all' }" @click="statusFilter = 'all'">
          <span class="metric-icon text-blue-300"><History class="h-5 w-5" /></span><span><strong>{{ operations.length }}</strong><small>最近操作</small></span><span class="metric-meta">最多显示 100 条</span>
        </button>
        <button class="metric-tile" :class="{ active: statusFilter === 'success' }" @click="statusFilter = statusFilter === 'success' ? 'all' : 'success'">
          <span class="metric-icon text-status-ok"><CircleCheckBig class="h-5 w-5" /></span><span><strong>{{ successCount }}</strong><small>执行成功</small></span><span class="metric-meta">成功率 {{ successRate }}%</span>
        </button>
        <button class="metric-tile" :class="{ active: statusFilter === 'failed' }" @click="statusFilter = statusFilter === 'failed' ? 'all' : 'failed'">
          <span class="metric-icon text-status-error"><CircleX class="h-5 w-5" /></span><span><strong>{{ failedCount }}</strong><small>执行失败</small></span><span class="metric-meta">优先检查错误详情</span>
        </button>
        <MetricTile title="操作类型" :value="actionTypes" sub="Compose、配置与维护" :icon="Activity" tone="text-violet-300" />
      </div>
      <div class="toolbar-panel">
        <label class="search-field"><Search class="h-4 w-4" /><input v-model="query" aria-label="搜索项目、操作或详情" placeholder="搜索项目、操作或详情" /></label>
        <select v-model="statusFilter" class="input sm:w-36" aria-label="筛选操作记录结果"><option value="all">全部结果</option><option value="success">成功</option><option value="failed">失败</option></select>
        <span class="ml-auto whitespace-nowrap text-muted">{{ filteredOperations.length }} 条记录</span>
      </div>
      <div v-if="error" class="alert-error mb-3 flex items-center justify-between gap-3" role="alert"><span>{{ error }}</span><button class="btn-secondary btn-sm" @click="load">重试</button></div>
      <div v-else class="table-wrap flex-1 min-h-64">
        <table class="data-table">
          <thead><tr><th>时间</th><th>项目</th><th>操作</th><th>结果</th><th class="w-20">详情</th></tr></thead>
          <tbody>
            <tr v-for="item in filteredOperations" :key="item.id" class="ops-row">
              <td class="whitespace-nowrap font-mono tabular-nums">{{ formatTime(item.createdAt) }}</td>
              <td><span class="ops-project">{{ item.projectName || '系统' }}</span></td>
              <td><span class="ops-action">{{ actionLabel(item.action) }}</span><span class="ml-2 hidden font-mono text-[10px] text-surface-400 xl:inline">{{ item.action }}</span></td>
              <td><span class="ops-status" :class="item.status === 'success' ? 'ops-status-ok' : 'ops-status-fail'"><span class="h-1.5 w-1.5 rounded-full" :class="item.status === 'success' ? 'bg-status-ok' : 'bg-status-error'"></span>{{ item.status === 'success' ? '成功' : '失败' }}</span></td>
              <td><button v-if="item.detail" class="icon-btn" title="查看输出" aria-label="查看操作输出" @click="selectedOperation = item"><Eye class="h-4 w-4" /></button></td>
            </tr>
            <tr v-if="!filteredOperations.length"><td colspan="5"><EmptyState compact :icon="operations.length ? 'Search' : 'History'" :title="operations.length ? '没有匹配的操作记录' : '暂无操作记录'" :description="operations.length ? '调整筛选条件后重试' : '执行 Compose 操作后会自动记录审计日志'" /></td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section id="operations-panel-jobs" v-show="activeTab === 'jobs'" role="tabpanel" aria-labelledby="operations-tab-jobs" tabindex="0">
      <div class="metric-grid">
        <MetricTile title="最近任务" :value="jobs.length" sub="最多显示 100 条" :icon="ListChecks" tone="text-blue-300" />
        <button class="metric-tile" :class="{ active: jobStatusFilter === 'active' }" @click="jobStatusFilter = jobStatusFilter === 'active' ? 'all' : 'active'">
          <span class="metric-icon text-blue-300"><LoaderCircle class="h-5 w-5" :class="{ 'animate-spin': activeJobCount }" /></span><span><strong>{{ activeJobCount }}</strong><small>正在执行</small></span><span class="metric-meta">排队与运行中</span>
        </button>
        <button class="metric-tile" :class="{ active: jobStatusFilter === 'success' }" @click="jobStatusFilter = jobStatusFilter === 'success' ? 'all' : 'success'">
          <span class="metric-icon text-status-ok"><CircleCheckBig class="h-5 w-5" /></span><span><strong>{{ successfulJobCount }}</strong><small>已完成</small></span><span class="metric-meta">所有项目执行成功</span>
        </button>
        <button class="metric-tile" :class="{ active: jobStatusFilter === 'abnormal' }" @click="jobStatusFilter = jobStatusFilter === 'abnormal' ? 'all' : 'abnormal'">
          <span class="metric-icon text-status-error"><TriangleAlert class="h-5 w-5" /></span><span><strong>{{ abnormalJobCount }}</strong><small>异常任务</small></span><span class="metric-meta">失败或意外中断</span>
        </button>
      </div>
      <div class="toolbar-panel">
        <label class="search-field"><Search class="h-4 w-4" /><input v-model="jobQuery" aria-label="搜索任务 ID 或动作" placeholder="搜索任务 ID 或动作" /></label>
        <select v-model="jobStatusFilter" class="input sm:w-40" aria-label="筛选后台任务状态"><option value="all">全部状态</option><option value="active">正在执行</option><option value="success">已完成</option><option value="abnormal">异常任务</option></select>
        <span class="ml-auto whitespace-nowrap text-muted">{{ filteredJobs.length }} 个任务</span>
      </div>
      <div v-if="error" class="alert-error mb-3 flex items-center justify-between gap-3" role="alert"><span>{{ error }}</span><button class="btn-secondary btn-sm" @click="load">重试</button></div>
      <div v-else class="table-wrap flex-1 min-h-64">
        <table class="data-table">
          <thead><tr><th>创建时间</th><th>任务</th><th>项目数</th><th class="min-w-44">进度</th><th>状态</th><th class="w-20">详情</th></tr></thead>
          <tbody>
            <tr v-for="job in filteredJobs" :key="job.id">
              <td class="whitespace-nowrap">{{ formatTime(job.createdAt) }}</td>
              <td><span class="action-label">{{ actionLabel(job.action) }}</span><div class="mt-1 max-w-52 truncate font-mono text-[10px] text-surface-400" :title="job.id">{{ job.id }}</div></td>
              <td>{{ job.total }} 个项目</td>
              <td><div class="mb-1 flex justify-between text-[11px] text-surface-400"><span>{{ job.completed }} / {{ job.total }}</span><span>{{ jobProgress(job) }}%</span></div><div class="progress"><span :style="{ width: `${jobProgress(job)}%` }"></span></div></td>
              <td><StatusBadge :status="job.status === 'running' ? 'task' : job.status" /></td>
              <td><button class="icon-btn" title="查看任务详情" aria-label="查看任务详情" @click="openJob(job.id)"><Eye class="h-4 w-4" /></button></td>
            </tr>
            <tr v-if="!filteredJobs.length"><td colspan="6"><EmptyState compact :icon="jobs.length ? 'Search' : 'ListChecks'" :title="jobs.length ? '没有匹配的后台任务' : '暂无后台任务'" :description="jobs.length ? '调整筛选条件后重试' : '批量操作会以后台任务形式出现在这里'" /></td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <BaseModal :show="!!selectedOperation" :title="selectedOperation ? actionLabel(selectedOperation.action) : ''" @close="selectedOperation = null">
      <div v-if="selectedOperation" class="mb-4 flex flex-wrap items-center gap-2 text-xs text-surface-400"><span>{{ selectedOperation.projectName || '全局操作' }}</span><span>·</span><time>{{ formatTime(selectedOperation.createdAt) }}</time><span class="ml-auto" :class="selectedOperation.status === 'success' ? 'text-status-ok' : 'text-status-error'">{{ selectedOperation.status === 'success' ? '成功' : '失败' }}</span></div>
      <pre v-if="selectedOperation" class="terminal-output max-h-[70vh] min-h-48">{{ selectedOperation.detail }}</pre>
    </BaseModal>

    <BaseModal :show="!!requestedJobId" :title="selectedJob ? `${actionLabel(selectedJob.action)} · ${selectedJob.total} 个项目` : ''" size-class="flex max-h-[88vh] max-w-5xl flex-col" body-class="flex min-h-0 flex-1 flex-col p-0" @close="closeJob()">
      <template #header-actions>
        <StatusBadge v-if="selectedJob" :status="selectedJob.status === 'running' ? 'task' : selectedJob.status" />
      </template>
      <p v-if="jobLoading && !selectedJob" class="p-6 text-sm text-surface-400" role="status">正在加载任务详情…</p>
      <div v-if="jobError" class="alert-error m-4 flex items-center gap-3" role="alert"><span class="flex-1">{{ jobError }}</span><button class="btn-secondary" :disabled="jobLoading" @click="openJob(requestedJobId)">重试</button></div>
      <template v-if="selectedJob">
        <div class="shrink-0 border-b border-surface-800 p-4">
          <div class="mb-2 flex items-center justify-between text-muted"><span>{{ formatTime(selectedJob.createdAt) }} 创建</span><span>{{ selectedJob.completed }} / {{ selectedJob.total }} 已完成</span></div>
          <div class="progress"><span :style="{ width: `${jobProgress(selectedJob)}%` }"></span></div>
        </div>
        <div class="grid min-h-0 flex-1 md:grid-cols-[17rem_minmax(0,1fr)]">
          <div class="max-h-44 overflow-y-auto border-b border-surface-800 p-2 md:max-h-none md:border-b-0 md:border-r">
            <button v-for="item in selectedJob.items" :key="item.id" class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-800" :class="{ 'bg-surface-800': selectedJobItem?.id === item.id }" @click="selectedJobItem = item">
              <LoaderCircle v-if="item.status === 'running'" class="h-4 w-4 shrink-0 animate-spin text-status-info" /><CircleCheckBig v-else-if="item.status === 'success'" class="h-4 w-4 shrink-0 text-status-ok" /><CircleX v-else-if="item.status === 'failed'" class="h-4 w-4 shrink-0 text-status-error" /><TriangleAlert v-else-if="item.status === 'interrupted'" class="h-4 w-4 shrink-0 text-status-warn" /><span v-else class="h-2 w-2 shrink-0 rounded-full bg-surface-600"></span>
              <span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-surface-200">{{ item.projectName }}</strong><small class="mt-0.5 block text-muted">{{ item.exitCode === null ? statusLabel(item.status) : `退出码 ${item.exitCode}` }}</small></span>
            </button>
          </div>
          <pre class="terminal-output min-h-32 max-md:max-h-[40dvh] md:min-h-52">{{ selectedJobItem?.output || '该项目尚无输出。' }}</pre>
        </div>
      </template>
    </BaseModal>
  </div>
</template>

<script setup>
import MetricTile from '../components/common/MetricTile.vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useRoute, useRouter } from 'vue-router';
import { Activity, CircleCheckBig, CircleX, Eye, History, ListChecks, LoaderCircle, RefreshCw, Search, TriangleAlert } from 'lucide-vue-next';
import { api } from '../api/client.js';
import StatusBadge from '../components/common/StatusBadge.vue';
import EmptyState from '../components/common/EmptyState.vue';
import BaseModal from '../components/common/BaseModal.vue';
import { formatTimestamp as formatTime } from '../lib/date-time.js';
import { handleTablistKeydown } from '../lib/tablist-keyboard.js';

const route = useRoute();
const router = useRouter();
// embedded 模式供事件中心「操作与任务」tab 复用:隐藏页头,且不再读写路由 query(tab 归父级页面管)
const props = defineProps({ embedded: { type: Boolean, default: false } });
const operations = ref([]); const jobs = ref([]); const loading = ref(false); const error = ref('');
const selectedOperation = ref(null); const selectedJob = ref(null); const selectedJobItem = ref(null);

const STORAGE_KEY_FILTERS = 'composeops:operations:filters';
function loadFilters() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_FILTERS);
    return stored ? JSON.parse(stored) : {};
  } catch { return {}; }
}
function saveFilters(filters) {
  try { localStorage.setItem(STORAGE_KEY_FILTERS, JSON.stringify(filters)); } catch {
    // 筛选条件无法持久化时仍保留当前页面状态。
  }
}

const savedFilters = loadFilters();
const query = ref(''); const jobQuery = ref('');
const statusFilter = ref(savedFilters.statusFilter || (!props.embedded && route.query.status === 'failed' ? 'failed' : 'all'));
const jobStatusFilter = ref(savedFilters.jobStatusFilter || 'all');
const activeTab = ref(props.embedded ? 'operations' : (route.query.tab === 'jobs' || route.query.job ? 'jobs' : 'operations'));
const jobLoading = ref(false);
const jobError = ref('');
const requestedJobId = ref(null);
let jobGeneration = 0;
let disposed = false;
let jobPollTimer;
let jobStreamController = null;

const successCount = computed(() => operations.value.filter((item) => item.status === 'success').length);
const failedCount = computed(() => operations.value.length - successCount.value);
const successRate = computed(() => operations.value.length ? Math.round(successCount.value / operations.value.length * 100) : 100);
const actionTypes = computed(() => new Set(operations.value.map((item) => item.action)).size);
const activeJobCount = computed(() => jobs.value.filter((job) => ['queued', 'running'].includes(job.status)).length);
const successfulJobCount = computed(() => jobs.value.filter((job) => job.status === 'success').length);
const abnormalJobCount = computed(() => jobs.value.filter((job) => ['failed', 'interrupted'].includes(job.status)).length);
const filteredOperations = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return operations.value.filter((item) => (statusFilter.value === 'all' || item.status === statusFilter.value) && (!needle || `${item.projectName || ''} ${item.action} ${item.detail || ''} ${actionLabel(item.action)}`.toLowerCase().includes(needle)));
});
const filteredJobs = computed(() => {
  const needle = jobQuery.value.trim().toLowerCase();
  return jobs.value.filter((job) => {
    if (jobStatusFilter.value === 'active' && !['queued', 'running'].includes(job.status)) return false;
    if (jobStatusFilter.value === 'success' && job.status !== 'success') return false;
    if (jobStatusFilter.value === 'abnormal' && !['failed', 'interrupted'].includes(job.status)) return false;
    return !needle || `${job.id} ${job.action} ${actionLabel(job.action)}`.toLowerCase().includes(needle);
  });
});

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const [operationData, jobData] = await Promise.all([api.getOperations(), api.listJobs(100)]);
    if (disposed) return;
    operations.value = operationData.operations || [];
    jobs.value = jobData.jobs || [];
  } catch (loadError) { error.value = loadError.message || '操作记录加载失败';
  } finally { loading.value = false; }
}
function handleTabKeydown(event) {
  handleTablistKeydown(event, setTab);
}
function setTab(tab) {
  activeTab.value = tab;
  if (props.embedded) return;
  const next = { ...route.query, tab };
  if (tab !== 'jobs') delete next.job;
  router.replace({ query: next });
}
function stopJobUpdates() {
  jobGeneration++;
  clearTimeout(jobPollTimer);
  jobStreamController?.abort();
  jobStreamController = null;
}
function applyJob(job) {
  selectedJob.value = job;
  selectedJobItem.value = job.items?.find(item => item.id === selectedJobItem.value?.id) || job.items?.[0] || null;
  const index = jobs.value.findIndex(item => item.id === job.id);
  if (index >= 0) jobs.value[index] = { ...jobs.value[index], ...job, items: undefined };
}
async function openJob(id, updateRoute = true) {
  stopJobUpdates();
  if (disposed) return;
  const generation = jobGeneration;
  requestedJobId.value = id;
  if (selectedJob.value?.id !== id) { selectedJob.value = null; selectedJobItem.value = null; }
  activeTab.value = 'jobs';
  jobLoading.value = true;
  jobError.value = '';
  try {
    const job = await api.getJob(id);
    if (disposed || generation !== jobGeneration) return;
    applyJob(job);
    if (updateRoute && !props.embedded && route.query.job !== id) void router.replace({ query: { ...route.query, tab: 'jobs', job: id } });
    if (['queued', 'running'].includes(job.status)) {
      const controller = new AbortController();
      jobStreamController = controller;
      const pollIfActive = () => {
        if (!disposed && generation === jobGeneration && !controller.signal.aborted && ['queued', 'running'].includes(selectedJob.value?.status)) jobPollTimer = setTimeout(() => void openJob(id, false), 1200);
      };
      api.streamJobUpdates(id, frame => {
        if (disposed || generation !== jobGeneration || controller.signal.aborted || frame.job?.id !== id) return;
        if (frame.type === 'snapshot' || frame.type === 'update') {
          applyJob(frame.job);
          if (!['queued', 'running'].includes(frame.job.status)) controller.abort();
        }
      }, controller.signal).then(pollIfActive, pollIfActive);
    }
  } catch (e) {
    if (!disposed && generation === jobGeneration) jobError.value = e.message || '任务详情加载失败';
  } finally { if (generation === jobGeneration) jobLoading.value = false; }
}
function closeJob(updateRoute = true) {
  stopJobUpdates();
  requestedJobId.value = null;
  selectedJob.value = null;
  selectedJobItem.value = null;
  jobLoading.value = false;
  jobError.value = '';
  if (props.embedded || !updateRoute) return;
  const next = { ...route.query };
  delete next.job;
  void router.replace({ query: next });
}
function jobProgress(job) { return job.total ? Math.round(job.completed / job.total * 100) : 0; }
function statusLabel(status) { return ({ pending: '等待执行', queued: '排队中', running: '执行中', success: '执行成功', failed: '执行失败', interrupted: '意外中断' })[status] || status; }
function actionLabel(action) {
  const labels = { 'compose.save': '保存配置', 'compose.restore': '恢复配置', 'projects.management': '更新纳管范围', 'projects.mounts': '更新目录范围', 'docker.prune': '清理 Docker 空间', 'images.check': '检查镜像更新', 'settings.import': '导入设置', up: '启动项目', restart: '重启项目', stop: '停止项目', pull: '拉取镜像', ps: '检查状态' };
  return labels[action] || labels[String(action).split('.').pop()] || action;
}

watch([statusFilter, jobStatusFilter], () => {
  saveFilters({ statusFilter: statusFilter.value, jobStatusFilter: jobStatusFilter.value });
});
watch(() => route.query.job, (id) => {
  if (props.embedded) return;
  if (id && requestedJobId.value !== String(id)) void openJob(String(id), false);
  if (!id && requestedJobId.value) closeJob(false);
});
usePullRefresh(load);
onMounted(async () => { await load(); if (!disposed && !props.embedded && route.query.job) await openJob(String(route.query.job), false); });
onUnmounted(() => { disposed = true; stopJobUpdates(); });
</script>
