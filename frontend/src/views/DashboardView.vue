<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">运维总览</h1>
        <p class="page-subtitle">项目、容器与主机资源</p>
      </div>
      <div class="page-actions">
        <span v-if="lastUpdated" class="text-xs text-muted">更新于 {{ lastUpdated }}</span>
        <button class="btn-secondary" :disabled="loading" @click="load">
          <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新
        </button>
      </div>
    </div>

    <nav class="dashboard-quick-actions" aria-label="常用运维入口">
      <span class="dashboard-quick-label">快速操作</span>
      <router-link to="/services" class="dashboard-quick-link"><Boxes class="h-4 w-4" /><span>管理服务</span><ArrowRight class="dashboard-quick-arrow h-3.5 w-3.5" /></router-link>
      <router-link to="/compose" class="dashboard-quick-link"><FileCode2 class="h-4 w-4" /><span>编辑配置</span><ArrowRight class="dashboard-quick-arrow h-3.5 w-3.5" /></router-link>
      <router-link to="/logs" class="dashboard-quick-link"><ScrollText class="h-4 w-4" /><span>查看日志</span><ArrowRight class="dashboard-quick-arrow h-3.5 w-3.5" /></router-link>
      <router-link to="/agent" class="dashboard-quick-link"><Bot class="h-4 w-4" /><span>AI 助手</span><ArrowRight class="dashboard-quick-arrow h-3.5 w-3.5" /></router-link>
    </nav>

    <div v-if="loadError" class="alert-error flex items-center justify-between gap-3">
      <span>{{ loadError }}</span>
      <button class="btn-secondary px-2.5! py-1! text-xs" :disabled="loading" @click="load">重试</button>
    </div>

    <Skeleton v-if="loading && !hasLoaded" variant="cards" :rows="4" label="总览数据加载中" />

    <template v-else>
      <div class="metric-grid">
        <router-link to="/services" class="metric-tile hover:border-emerald-500/40" aria-label="查看全部项目">
          <span class="metric-icon text-blue-300"><Boxes class="h-5 w-5" /></span>
          <span><strong>{{ projectCount }}</strong><small>项目总数</small></span>
          <span class="metric-meta">健康 {{ healthyProjects }}</span>
        </router-link>
        <router-link to="/services" class="metric-tile hover:border-emerald-500/40" aria-label="查看容器状态">
          <span class="metric-icon text-emerald-300"><Container class="h-5 w-5" /></span>
          <span><strong>{{ containerCount }}</strong><small>容器总数</small></span>
          <span class="metric-meta">运行 {{ runningContainers }}</span>
        </router-link>
        <router-link to="/monitor" class="metric-tile hover:border-emerald-500/40" aria-label="查看 CPU 实时监控">
          <span class="metric-icon" :class="cpuTone"><Cpu class="h-5 w-5" /></span>
          <span><strong class="font-mono tabular-nums" :class="cpuTone">{{ cpu == null ? '—' : `${cpu}%` }}</strong><small>环境 CPU</small></span>
          <SparklineChart :cpu="monitorTrends.cpu" :mem="[]" :width="72" :height="20" />
          <span class="metric-meta">{{ cpuState }}</span>
        </router-link>
        <router-link to="/monitor" class="metric-tile hover:border-emerald-500/40" aria-label="查看内存实时监控">
          <span class="metric-icon" :class="memoryTone"><MemoryStick class="h-5 w-5" /></span>
          <span><strong class="font-mono tabular-nums" :class="memoryTone">{{ memory == null ? '—' : `${memory}%` }}</strong><small>环境内存</small></span>
          <SparklineChart :cpu="[]" :mem="monitorTrends.mem" :width="72" :height="20" />
          <span class="metric-meta">{{ memoryState }}</span>
        </router-link>
        <router-link to="/inspection" class="metric-tile hover:border-emerald-500/40" aria-label="查看巡检报告">
          <span class="metric-icon" :class="inspectionTone"><Gauge class="h-5 w-5" /></span>
          <span><strong class="font-mono tabular-nums" :class="inspectionTone">{{ inspectionScore }}</strong><small>巡检评分</small></span>
          <span class="metric-meta">{{ inspectionSummary }}</span>
        </router-link>
      </div>

      <section v-if="hasLoaded && !loadError && !projectCount" class="section-panel text-center">
        <EmptyState icon="Boxes" title="暂未发现 Compose 项目" description="可前往服务总览扫描项目,或从应用市场开始部署。" />
        <router-link to="/services" class="btn-secondary">查看服务</router-link>
        <router-link to="/marketplace" class="btn-primary ml-2">浏览应用市场</router-link>
      </section>

      <section v-if="attentionProjectList.length" class="section-panel dashboard-attention-panel">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <AlertTriangle class="h-4 w-4 text-amber-300" />
              <h3 class="font-semibold text-surface-100">需要处理</h3>
              <span class="count-badge text-amber-300">{{ attentionProjects }}</span>
            </div>
            <p class="mt-1 text-xs text-muted">优先处理异常项目，避免在多个页面之间来回寻找。</p>
          </div>
          <router-link to="/services" class="shrink-0 whitespace-nowrap text-xs text-accent hover:text-blue-300">查看全部 <ArrowRight class="inline h-3.5 w-3.5" /></router-link>
        </div>
        <div class="dashboard-attention-list">
          <div v-for="project in attentionProjectList" :key="project.id" class="dashboard-attention-row">
            <span class="status-dot" :class="project.status === 'running' ? 'bg-amber-400' : 'bg-rose-400'"></span>
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <span class="truncate text-sm font-medium text-surface-200">{{ project.projectName }}</span>
                <span class="count-badge hidden sm:inline-flex" :class="project.status === 'running' ? 'text-amber-300' : 'text-rose-300'">{{ project.status === 'running' ? '健康检查异常' : '未运行' }}</span>
              </div>
              <p class="mt-0.5 truncate text-xs text-muted">{{ project.containers.filter(c => c.health === 'unhealthy').length ? `${project.containers.filter(c => c.health === 'unhealthy').length} 个容器不健康` : `${project.containers.length} 个容器 · ${project.status}` }}</p>
            </div>
            <router-link :to="`/services?focus=${project.id}`" class="icon-btn" :aria-label="`打开 ${project.projectName}`" title="打开项目"><ArrowRight class="h-4 w-4" /></router-link>
            <router-link :to="`/agent?projectId=${project.id}`" class="icon-btn hidden sm:inline-grid" :aria-label="`让 Agent 诊断 ${project.projectName}`" title="让 Agent 诊断"><Bot class="h-4 w-4" /></router-link>
          </div>
        </div>
      </section>

      <section class="section-panel">
          <div class="mb-4 flex items-center justify-between">
            <h3 class="font-semibold text-surface-100">最近事件</h3>
            <router-link to="/events?tab=timeline" class="shrink-0 whitespace-nowrap text-xs text-emerald-400 hover:text-emerald-300">查看全部 →</router-link>
          </div>
          <div v-if="recentEvents.length" class="space-y-2">
            <div v-for="event in recentEvents" :key="event.key" class="flex items-center gap-3 rounded-lg border border-surface-800 bg-surface-900/60 px-3 py-2">
              <span class="h-2 w-2 shrink-0 rounded-full" :class="dotClass(event.level)"></span>
              <span class="count-badge shrink-0 text-[10px]" :class="sourceBadgeClass(event.source)">{{ sourceLabel(event.source) }}</span>
              <span class="min-w-0 flex-1 truncate text-sm text-surface-200">{{ event.title }}</span>
              <span class="shrink-0 font-mono text-[11px] tabular-nums text-surface-500">{{ formatTime(event.timestamp) }}</span>
            </div>
          </div>
          <EmptyState v-else compact icon="History" title="暂无事件记录" />
        </section>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { AlertTriangle, ArrowRight, Bot, Boxes, Container, Cpu, FileCode2, Gauge, MemoryStick, RefreshCw, ScrollText } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { useServicesStore } from '../stores/services.js';
import EmptyState from '../components/common/EmptyState.vue';
import Skeleton from '../components/common/Skeleton.vue';
import SparklineChart from '../components/common/SparklineChart.vue';
import { monitorTrends, pushMonitorTrend } from '../lib/monitor-trends.js';

const store = useServicesStore();
const metrics = ref(null);
const inspection = ref(null);
const recentEvents = ref([]);
const loading = ref(false);
const hasLoaded = ref(false);
const loadError = ref('');
const lastUpdated = ref('');
let requestId = 0;
let disposed = false;

const projectCount = computed(() => store.projects.length);
const containerCount = computed(() => store.projects.reduce((n, p) => n + (p.containers?.length || 0), 0));
const runningContainers = computed(() => store.projects.reduce((n, p) => n + (p.containers || []).filter(c => c.state === 'running').length, 0));
const attentionProjects = computed(() => store.projects.filter(p => p.status !== 'running' || (p.containers || []).some(c => c.health === 'unhealthy')).length);
const healthyProjects = computed(() => projectCount.value - attentionProjects.value);
const attentionProjectList = computed(() => [...store.projects]
  .filter((project) => project.status !== 'running' || (project.containers || []).some((container) => container.health === 'unhealthy'))
  .sort((a, b) => Number(b.status !== 'running') - Number(a.status !== 'running') || a.projectName.localeCompare(b.projectName))
  .slice(0, 5));

const cpu = computed(() => metrics.value?.host?.cpu?.percent ?? null);
const memory = computed(() => metrics.value?.host?.memory?.percent ?? null);
const cpuState = computed(() => cpu.value == null ? '暂无指标' : cpu.value > 80 ? '负载较高' : '运行正常');
const memoryState = computed(() => memory.value == null ? '暂无指标' : memory.value > 80 ? '内存偏高' : '资源充足');
const cpuTone = computed(() => cpu.value == null ? 'text-surface-400' : cpu.value > 80 ? 'text-amber-300' : 'text-emerald-300');
const memoryTone = computed(() => memory.value == null ? 'text-surface-400' : memory.value > 80 ? 'text-amber-300' : 'text-emerald-300');

const inspectionScore = computed(() => inspection.value?.latest?.score ?? '--');
const inspectionSummary = computed(() => inspection.value?.latest?.summary ?? '暂无巡检数据');
const inspectionTone = computed(() => {
  const score = inspection.value?.latest?.score;
  if (score == null) return 'text-surface-300';
  if (score >= 90) return 'text-emerald-300';
  if (score >= 70) return 'text-amber-300';
  return 'text-rose-300';
});

const SOURCE_LABELS = { operation: '操作', agent: 'Agent', alert: '告警', cron: '定时', gitops: 'GitOps' };
function sourceLabel(s) { return SOURCE_LABELS[s] || s; }
function sourceBadgeClass(s) {
  return { operation: 'text-blue-300', agent: 'text-emerald-300', alert: 'text-rose-300', cron: 'text-amber-300', gitops: 'text-violet-300' }[s] || 'text-surface-400';
}
function dotClass(l) {
  return { success: 'bg-emerald-400', info: 'bg-sky-400', warning: 'bg-amber-400', error: 'bg-rose-400' }[l] || 'bg-surface-500';
}
function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function parseTs(value) {
  if (!value) return 0;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}
function pushEvent(list, event) {
  if (!event || !event.timestamp) return;
  list.push({ key: `${event.source}-${event.id}-${event.timestamp}`, ts: parseTs(event.timestamp), ...event });
}
function actionLabel(action) {
  const labels = { 'compose.save': '保存配置', 'compose.restore': '恢复配置', 'projects.management': '更新纳管范围', 'projects.mounts': '更新目录范围', 'docker.prune': '清理 Docker 空间', 'images.check': '检查镜像更新', 'settings.import': '导入设置', up: '启动项目', restart: '重启项目', stop: '停止项目', pull: '拉取镜像', ps: '检查状态' };
  return labels[action] || labels[String(action).split('.').pop()] || action;
}
async function loadRecentEvents(errors) {
  const list = [];
  const [operationData, agentData, alertData, cronData] = await Promise.allSettled([
    api.getOperations(),
    api.getAgentExecutions(),
    api.getAlertEvents(20),
    api.getCronHistory(20),
  ]);
  if (operationData.status === 'fulfilled') {
    for (const op of operationData.value.operations || []) {
      pushEvent(list, { source: 'operation', id: op.id, timestamp: op.createdAt, level: op.status === 'success' ? 'success' : 'error', title: actionLabel(op.action), detail: op.detail || '', projectName: op.projectName || '' });
    }
  } else errors.push(operationData.reason);
  if (agentData.status === 'fulfilled') {
    for (const plan of agentData.value.plans || []) {
      pushEvent(list, { source: 'agent', id: plan.id, timestamp: plan.created_at || plan.executed_at, level: plan.status === 'completed' ? 'success' : plan.status === 'failed' ? 'error' : 'info', title: plan.user_message || 'Agent 执行', detail: '', projectName: '' });
    }
  } else errors.push(agentData.reason);
  if (alertData.status === 'fulfilled') {
    for (const ev of alertData.value.events || []) {
      pushEvent(list, { source: 'alert', id: ev.id, timestamp: ev.created_at, level: ev.priority === 'danger' ? 'error' : 'warning', title: ev.title, detail: ev.detail || '', projectName: ev.target || '' });
    }
  } else errors.push(alertData.reason);
  if (cronData.status === 'fulfilled') {
    for (const item of cronData.value.history || []) {
      pushEvent(list, { source: 'cron', id: item.id, timestamp: item.at, level: item.status === 'success' ? 'success' : 'error', title: `定时任务:${item.jobName || ''}`, detail: item.error || '', projectName: '' });
    }
  } else errors.push(cronData.reason);
  return list.sort((a, b) => b.ts - a.ts).slice(0, 6);
}

async function load() {
  if (loading.value || disposed) return;
  const currentRequest = ++requestId;
  loading.value = true;
  const errors = [];
  try {
    const [metricsRes, inspectionRes, eventsRes, projectsRes] = await Promise.allSettled([
      api.getMetrics(),
      api.getInspectionOverview(1),
      loadRecentEvents(errors),
      store.refresh(true),
    ]);
    if (disposed || currentRequest !== requestId) return;
    if (store.error) errors.push(new Error(store.error));
    if (projectsRes.status === 'rejected') errors.push(projectsRes.reason);
    if (eventsRes.status === 'fulfilled') recentEvents.value = eventsRes.value;
    else { recentEvents.value = []; errors.push(eventsRes.reason); }
    if (metricsRes.status === 'fulfilled') {
      metrics.value = metricsRes.value;
      const host = metricsRes.value?.host;
      const rx = metricsRes.value?.network?.rx || 0;
      if (host) pushMonitorTrend({ cpu: host.cpu?.percent, mem: host.memory?.percent, net: Math.max(0, Math.round((rx / 1024 / 1024) * 100) / 100) });
    } else { metrics.value = null; errors.push(metricsRes.reason); }
    if (inspectionRes.status === 'fulfilled') inspection.value = inspectionRes.value;
    else { inspection.value = null; errors.push(inspectionRes.reason); }
    loadError.value = errors.length ? `部分数据加载失败:${errors[0]?.message || '未知错误'}` : '';
    if (!errors.length) {
      lastUpdated.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }
  } catch (error) {
    if (disposed || currentRequest !== requestId) return;
    loadError.value = `总览数据加载失败:${error?.message || '未知错误'}`;
  } finally {
    if (!disposed && currentRequest === requestId) {
      loading.value = false;
      hasLoaded.value = true;
    }
  }
}

function onHostChanged() {
  requestId += 1;
  loading.value = false;
  hasLoaded.value = false;
  metrics.value = null;
  inspection.value = null;
  recentEvents.value = [];
  lastUpdated.value = '';
  loadError.value = '';
  void load();
}
onMounted(() => { window.addEventListener('composeops:host-changed', onHostChanged); void load(); });
onBeforeUnmount(() => { disposed = true; requestId += 1; window.removeEventListener('composeops:host-changed', onHostChanged); });
</script>
