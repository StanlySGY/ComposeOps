<template>
  <div :class="embedded ? '' : 'page-shell'">
    <div v-if="!embedded" class="page-header">
      <div><h1 class="page-title">操作中心</h1><p class="page-subtitle">跟踪后台任务进度，审计 Compose 操作、配置修改和维护结果</p></div>
      <div class="page-actions"><button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button></div>
    </div>

    <div class="tabs" role="tablist" aria-label="操作中心视图">
      <button :class="{ active: activeTab === 'operations' }" role="tab" :aria-selected="activeTab === 'operations'" @click="setTab('operations')"><History class="h-4 w-4" />操作记录 <span class="count-badge">{{ operations.length }}</span></button>
      <button :class="{ active: activeTab === 'jobs' }" role="tab" :aria-selected="activeTab === 'jobs'" @click="setTab('jobs')"><ListChecks class="h-4 w-4" />后台任务 <span class="count-badge">{{ jobs.length }}</span></button>
    </div>

    <template v-if="activeTab === 'operations'">
      <div class="metric-grid">
        <button class="metric-tile" :class="{ active: statusFilter === 'all' }" @click="statusFilter = 'all'">
          <span class="metric-icon text-blue-300"><History class="h-5 w-5" /></span><span><strong>{{ operations.length }}</strong><small>最近操作</small></span><span class="metric-meta">最多显示 100 条</span>
        </button>
        <button class="metric-tile" :class="{ active: statusFilter === 'success' }" @click="statusFilter = statusFilter === 'success' ? 'all' : 'success'">
          <span class="metric-icon text-emerald-300"><CircleCheckBig class="h-5 w-5" /></span><span><strong>{{ successCount }}</strong><small>执行成功</small></span><span class="metric-meta">成功率 {{ successRate }}%</span>
        </button>
        <button class="metric-tile" :class="{ active: statusFilter === 'failed' }" @click="statusFilter = statusFilter === 'failed' ? 'all' : 'failed'">
          <span class="metric-icon text-rose-300"><CircleX class="h-5 w-5" /></span><span><strong>{{ failedCount }}</strong><small>执行失败</small></span><span class="metric-meta">优先检查错误详情</span>
        </button>
        <div class="metric-tile"><span class="metric-icon text-violet-300"><Activity class="h-5 w-5" /></span><span><strong>{{ actionTypes }}</strong><small>操作类型</small></span><span class="metric-meta">Compose、配置与维护</span></div>
      </div>
      <div class="toolbar-panel">
        <label class="search-field"><Search class="h-4 w-4" /><input v-model="query" placeholder="搜索项目、操作或详情" /></label>
        <select v-model="statusFilter" class="input sm:w-36"><option value="all">全部结果</option><option value="success">成功</option><option value="failed">失败</option></select>
        <span class="ml-auto whitespace-nowrap text-muted">{{ filteredOperations.length }} 条记录</span>
      </div>
      <div v-if="error" class="alert-error mb-3 flex items-center justify-between gap-3"><span>{{ error }}</span><button class="btn-secondary min-h-8! py-1!" @click="load">重试</button></div>
      <div v-else class="table-wrap flex-1 min-h-64">
        <table class="data-table">
          <thead><tr><th>时间</th><th>项目</th><th>操作</th><th>结果</th><th class="w-20">详情</th></tr></thead>
          <tbody>
            <tr v-for="item in filteredOperations" :key="item.id" class="ops-row">
              <td class="whitespace-nowrap font-mono tabular-nums">{{ formatTime(item.createdAt) }}</td>
              <td><span class="ops-project">{{ item.projectName || '系统' }}</span></td>
              <td><span class="ops-action">{{ actionLabel(item.action) }}</span><span class="ml-2 hidden font-mono text-[10px] text-surface-600 xl:inline">{{ item.action }}</span></td>
              <td><span class="ops-status" :class="item.status === 'success' ? 'ops-status-ok' : 'ops-status-fail'"><span class="h-1.5 w-1.5 rounded-full" :class="item.status === 'success' ? 'bg-emerald-400' : 'bg-rose-400'"></span>{{ item.status === 'success' ? '成功' : '失败' }}</span></td>
              <td><button v-if="item.detail" class="icon-btn" title="查看输出" @click="selectedOperation = item"><Eye class="h-4 w-4" /></button></td>
            </tr>
            <tr v-if="!filteredOperations.length"><td colspan="5"><EmptyState compact :icon="operations.length ? 'Search' : 'History'" :title="operations.length ? '没有匹配的操作记录' : '暂无操作记录'" :description="operations.length ? '调整筛选条件后重试' : '执行 Compose 操作后会自动记录审计日志'" /></td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else>
      <div class="metric-grid">
        <div class="metric-tile"><span class="metric-icon text-blue-300"><ListChecks class="h-5 w-5" /></span><span><strong>{{ jobs.length }}</strong><small>最近任务</small></span><span class="metric-meta">最多显示 100 条</span></div>
        <button class="metric-tile" :class="{ active: jobStatusFilter === 'active' }" @click="jobStatusFilter = jobStatusFilter === 'active' ? 'all' : 'active'">
          <span class="metric-icon text-blue-300"><LoaderCircle class="h-5 w-5" :class="{ 'animate-spin': activeJobCount }" /></span><span><strong>{{ activeJobCount }}</strong><small>正在执行</small></span><span class="metric-meta">排队与运行中</span>
        </button>
        <button class="metric-tile" :class="{ active: jobStatusFilter === 'success' }" @click="jobStatusFilter = jobStatusFilter === 'success' ? 'all' : 'success'">
          <span class="metric-icon text-emerald-300"><CircleCheckBig class="h-5 w-5" /></span><span><strong>{{ successfulJobCount }}</strong><small>已完成</small></span><span class="metric-meta">所有项目执行成功</span>
        </button>
        <button class="metric-tile" :class="{ active: jobStatusFilter === 'abnormal' }" @click="jobStatusFilter = jobStatusFilter === 'abnormal' ? 'all' : 'abnormal'">
          <span class="metric-icon text-rose-300"><TriangleAlert class="h-5 w-5" /></span><span><strong>{{ abnormalJobCount }}</strong><small>异常任务</small></span><span class="metric-meta">失败或意外中断</span>
        </button>
      </div>
      <div class="toolbar-panel">
        <label class="search-field"><Search class="h-4 w-4" /><input v-model="jobQuery" placeholder="搜索任务 ID 或动作" /></label>
        <select v-model="jobStatusFilter" class="input sm:w-40"><option value="all">全部状态</option><option value="active">正在执行</option><option value="success">已完成</option><option value="abnormal">异常任务</option></select>
        <span class="ml-auto whitespace-nowrap text-muted">{{ filteredJobs.length }} 个任务</span>
      </div>
      <div v-if="error" class="alert-error mb-3 flex items-center justify-between gap-3"><span>{{ error }}</span><button class="btn-secondary min-h-8! py-1!" @click="load">重试</button></div>
      <div v-else class="table-wrap flex-1 min-h-64">
        <table class="data-table">
          <thead><tr><th>创建时间</th><th>任务</th><th>项目数</th><th class="min-w-44">进度</th><th>状态</th><th class="w-20">详情</th></tr></thead>
          <tbody>
            <tr v-for="job in filteredJobs" :key="job.id">
              <td class="whitespace-nowrap">{{ formatTime(job.createdAt) }}</td>
              <td><span class="action-label">{{ actionLabel(job.action) }}</span><div class="mt-1 max-w-52 truncate font-mono text-[10px] text-surface-600" :title="job.id">{{ job.id }}</div></td>
              <td>{{ job.total }} 个项目</td>
              <td><div class="mb-1 flex justify-between text-[11px] text-surface-500"><span>{{ job.completed }} / {{ job.total }}</span><span>{{ jobProgress(job) }}%</span></div><div class="progress"><span :style="{ width: `${jobProgress(job)}%` }"></span></div></td>
              <td><StatusBadge :status="job.status === 'running' ? 'task' : job.status" /></td>
              <td><button class="icon-btn" title="查看任务详情" @click="openJob(job.id)"><Eye class="h-4 w-4" /></button></td>
            </tr>
            <tr v-if="!filteredJobs.length"><td colspan="6"><EmptyState compact :icon="jobs.length ? 'Search' : 'ListChecks'" :title="jobs.length ? '没有匹配的后台任务' : '暂无后台任务'" :description="jobs.length ? '调整筛选条件后重试' : '批量操作会以后台任务形式出现在这里'" /></td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <BaseModal :show="!!selectedOperation" :title="selectedOperation ? actionLabel(selectedOperation.action) : ''" @close="selectedOperation = null">
      <pre v-if="selectedOperation" class="terminal-output max-h-[70vh] min-h-48">{{ selectedOperation.detail }}</pre>
    </BaseModal>

    <BaseModal :show="!!selectedJob" :title="selectedJob ? `${actionLabel(selectedJob.action)} · ${selectedJob.total} 个项目` : ''" size-class="flex max-h-[88vh] max-w-5xl flex-col" body-class="flex min-h-0 flex-1 flex-col p-0" @close="closeJob">
      <template #header-actions>
        <StatusBadge v-if="selectedJob" :status="selectedJob.status === 'running' ? 'task' : selectedJob.status" />
      </template>
      <template v-if="selectedJob">
        <div class="shrink-0 border-b border-surface-800 p-4">
          <div class="mb-2 flex items-center justify-between text-muted"><span>{{ formatTime(selectedJob.createdAt) }} 创建</span><span>{{ selectedJob.completed }} / {{ selectedJob.total }} 已完成</span></div>
          <div class="progress"><span :style="{ width: `${jobProgress(selectedJob)}%` }"></span></div>
        </div>
        <div class="grid min-h-0 flex-1 md:grid-cols-[17rem_minmax(0,1fr)]">
          <div class="overflow-y-auto border-b border-surface-800 p-2 md:border-b-0 md:border-r">
            <button v-for="item in selectedJob.items" :key="item.id" class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-800" :class="{ 'bg-surface-800': selectedJobItem?.id === item.id }" @click="selectedJobItem = item">
              <LoaderCircle v-if="item.status === 'running'" class="h-4 w-4 shrink-0 animate-spin text-accent" /><CircleCheckBig v-else-if="item.status === 'success'" class="h-4 w-4 shrink-0 text-emerald-400" /><CircleX v-else-if="item.status === 'failed'" class="h-4 w-4 shrink-0 text-rose-400" /><TriangleAlert v-else-if="item.status === 'interrupted'" class="h-4 w-4 shrink-0 text-amber-400" /><span v-else class="h-2 w-2 shrink-0 rounded-full bg-surface-600"></span>
              <span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-surface-200">{{ item.projectName }}</strong><small class="mt-0.5 block text-muted">{{ item.exitCode === null ? statusLabel(item.status) : `退出码 ${item.exitCode}` }}</small></span>
            </button>
          </div>
          <pre class="terminal-output min-h-52">{{ selectedJobItem?.output || '该项目尚无输出。' }}</pre>
        </div>
      </template>
    </BaseModal>
  </div>
</template>

<script setup>
import { computed, onActivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Activity, CircleCheckBig, CircleX, Eye, History, ListChecks, LoaderCircle, RefreshCw, Search, TriangleAlert } from 'lucide-vue-next';
import { api } from '../api/client.js';
import StatusBadge from '../components/common/StatusBadge.vue';
import EmptyState from '../components/common/EmptyState.vue';
import BaseModal from '../components/common/BaseModal.vue';

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
    operations.value = operationData.operations || [];
    jobs.value = jobData.jobs || [];
  } catch (loadError) { error.value = loadError.message || '操作记录加载失败';
  } finally { loading.value = false; }
}
function setTab(tab) {
  activeTab.value = tab;
  if (props.embedded) return;
  const next = { ...route.query, tab };
  if (tab !== 'jobs') delete next.job;
  router.replace({ query: next });
}
async function openJob(id, updateRoute = true) {
  clearTimeout(jobPollTimer);
  if (jobStreamController) {
    jobStreamController.abort();
    jobStreamController = null;
  }
  
  activeTab.value = 'jobs';
  const job = await api.getJob(id);
  selectedJob.value = job;
  const previousItemId = selectedJobItem.value?.id;
  selectedJobItem.value = job.items.find((item) => item.id === previousItemId) || job.items[0] || null;
  const index = jobs.value.findIndex((item) => item.id === job.id);
  if (index >= 0) jobs.value[index] = { ...jobs.value[index], ...job, items: undefined };
  if (updateRoute && !props.embedded && route.query.job !== id) router.replace({ query: { ...route.query, tab: 'jobs', job: id } });
  
  // 活跃任务使用 SSE 推送
  if (['queued', 'running'].includes(job.status)) {
    jobStreamController = new AbortController();
    api.streamJobUpdates(id, (frame) => {
      if (frame.type === 'snapshot') {
        selectedJob.value = frame.job;
        const idx = jobs.value.findIndex((item) => item.id === frame.job.id);
        if (idx >= 0) jobs.value[idx] = { ...jobs.value[idx], ...frame.job, items: undefined };
      } else if (frame.type === 'update') {
        selectedJob.value = frame.job;
        const idx = jobs.value.findIndex((item) => item.id === frame.job.id);
        if (idx >= 0) jobs.value[idx] = { ...jobs.value[idx], ...frame.job, items: undefined };
        // 任务结束时清理流
        if (!['queued', 'running'].includes(frame.job.status)) {
          if (jobStreamController) {
            jobStreamController.abort();
            jobStreamController = null;
          }
        }
      }
    }, jobStreamController.signal).catch(() => {
      // SSE 连接失败时降级到轮询
      if (['queued', 'running'].includes(job.status)) {
        jobPollTimer = setTimeout(() => void openJob(id, false), 1200);
      }
    });
  }
}
function closeJob() {
  clearTimeout(jobPollTimer);
  if (jobStreamController) {
    jobStreamController.abort();
    jobStreamController = null;
  }
  selectedJob.value = null;
  selectedJobItem.value = null;
  if (props.embedded) return;
  const next = { ...route.query };
  delete next.job;
  router.replace({ query: next });
}
function formatTime(value) { return value ? new Date(`${value}Z`).toLocaleString() : '—'; }
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
  if (id && selectedJob.value?.id !== String(id)) void openJob(String(id), false);
  if (!id && selectedJob.value) {
    clearTimeout(jobPollTimer);
    if (jobStreamController) {
      jobStreamController.abort();
      jobStreamController = null;
    }
    selectedJob.value = null;
    selectedJobItem.value = null;
  }
});
onMounted(async () => { await load(); if (!props.embedded && route.query.job) await openJob(String(route.query.job), false); });
let opsActivatedOnce = false;
onActivated(() => { if (opsActivatedOnce) void load(); opsActivatedOnce = true; });
onUnmounted(() => {
  clearTimeout(jobPollTimer);
  if (jobStreamController) {
    jobStreamController.abort();
    jobStreamController = null;
  }
});
</script>
