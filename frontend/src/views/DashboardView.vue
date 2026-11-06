<template>
  <div class="page-shell dashboard-view">
    <div class="page-header">
      <div>
        <p class="overview-eyebrow">工作台 / 环境概况</p>
        <h1 class="page-title">运维总览</h1>
        <p class="page-subtitle">从运行状态开始，快速找到下一步。</p>
      </div>
      <div class="page-actions">
        <span v-if="lastUpdated" class="text-muted">更新于 {{ lastUpdated }}</span>
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <div v-if="loadError" class="alert-error flex items-center justify-between gap-3" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn-secondary px-2.5! py-1! text-xs" :disabled="loading" @click="load">重试</button>
    </div>
    <Skeleton v-if="loading && !hasLoaded" variant="cards" :rows="4" label="总览数据加载中" />
    <template v-else>
      <div class="overview-metrics">
        <router-link to="/services" class="overview-metric" aria-label="查看全部项目">
          <span class="overview-metric-label">Compose 项目<Boxes class="h-4 w-4" /></span>
          <strong>{{ projectCount }}<small>个项目</small></strong>
          <span class="overview-metric-detail"><span class="status-dot" :class="attentionProjects ? 'bg-amber-400' : 'bg-emerald-400'"></span>{{ healthyProjects }} 个健康<span v-if="attentionProjects" class="text-amber-300"> · {{ attentionProjects }} 个需关注</span></span>
          <span class="overview-meter" aria-hidden="true"><i :style="{ width: percentWidth(projectCount ? healthyProjects / projectCount * 100 : 0) }"></i></span>
        </router-link>
        <router-link to="/services" class="overview-metric" aria-label="查看容器状态">
          <span class="overview-metric-label">运行中容器<Container class="h-4 w-4" /></span>
          <strong>{{ runningContainers }}<small>/ {{ containerCount }}</small></strong>
          <span class="overview-metric-detail">{{ containerCount - runningContainers }} 个未运行 · 查看全部容器<ArrowUpRight class="h-3.5 w-3.5" /></span>
          <span class="overview-meter" aria-hidden="true"><i :style="{ width: percentWidth(containerCount ? runningContainers / containerCount * 100 : 0) }"></i></span>
        </router-link>
        <router-link to="/monitor" class="overview-metric" aria-label="查看 CPU 实时监控">
          <span class="overview-metric-label">环境 CPU<Cpu class="h-4 w-4" /></span>
          <strong>{{ cpu == null ? '—' : `${cpu}%` }}</strong>
          <span class="overview-metric-detail" :class="cpuTone">{{ cpuState }}<ArrowUpRight class="h-3.5 w-3.5" /></span>
          <span class="overview-meter" :class="{ 'is-warning': cpu > 80 }" aria-hidden="true"><i :style="{ width: percentWidth(cpu) }"></i></span>
        </router-link>
        <router-link to="/monitor" class="overview-metric" aria-label="查看内存实时监控">
          <span class="overview-metric-label">环境内存<MemoryStick class="h-4 w-4" /></span>
          <strong>{{ memory == null ? '—' : `${memory}%` }}</strong>
          <span class="overview-metric-detail" :class="memoryTone">{{ memoryState }}<ArrowUpRight class="h-3.5 w-3.5" /></span>
          <span class="overview-meter" :class="{ 'is-warning': memory > 80 }" aria-hidden="true"><i :style="{ width: percentWidth(memory) }"></i></span>
        </router-link>
      </div>

      <div class="overview-columns">
        <div class="overview-primary">
          <section class="section-panel overview-attention" :class="{ 'has-attention': attentionProjects }" aria-labelledby="attention-heading">
            <div class="overview-section-heading">
              <div><h2 id="attention-heading"><span class="overview-section-icon" :class="attentionProjects ? 'text-amber-300' : 'text-emerald-300'"><component :is="attentionProjects ? AlertTriangle : CircleCheckBig" class="h-4 w-4" /></span>需要处理<span class="count-badge">{{ attentionProjects }}</span></h2><p>停止、部分运行或健康检查异常的项目</p></div>
              <router-link to="/services?filter=attention" class="overview-text-link">查看全部<ArrowRight class="h-3.5 w-3.5" /></router-link>
            </div>
            <div v-if="attentionProjectList.length" class="overview-attention-list">
              <article v-for="project in attentionProjectList" :key="project.id" class="overview-project">
                <div class="overview-project-info">
                  <span class="overview-project-icon"><Boxes class="h-5 w-5" /></span>
                  <div class="min-w-0"><router-link :to="{ path: '/services', query: { focus: project.id } }" class="overview-project-name" :aria-label="`打开 ${project.projectName}`">{{ project.projectName }}<ArrowUpRight class="h-3.5 w-3.5" /></router-link><p>{{ projectAttention(project).detail }}</p></div>
                  <span class="overview-state" :class="project.status === 'running' || project.status === 'partial' ? 'is-warning' : 'is-danger'">{{ projectAttention(project).label }}</span>
                </div>
                <div class="overview-project-actions">
                  <router-link v-if="project.managed" :to="projectLogTarget(project)" class="btn-secondary" :aria-label="`查看 ${project.projectName} 异常日志`"><ScrollText class="h-3.5 w-3.5" />查看日志</router-link>
                  <router-link :to="{ path: '/services', query: { focus: project.id } }" class="btn-ghost">管理项目<ArrowRight class="h-3.5 w-3.5" /></router-link>
                </div>
              </article>
            </div>
            <div v-else-if="loadError" class="overview-calm-state"><AlertTriangle class="h-6 w-6 text-amber-300" /><div><strong>状态待确认</strong><p>部分数据未能加载，请重试后查看完整状态。</p></div></div>
            <div v-else-if="projectCount" class="overview-calm-state"><CircleCheckBig class="h-7 w-7 text-emerald-400" /><div><strong>当前项目状态正常</strong><p>未发现停止或健康检查异常的项目。</p></div></div>
            <div v-else class="overview-empty"><EmptyState compact icon="Boxes" title="暂未发现 Compose 项目" description="扫描已有项目，或从应用市场开始部署。" /><router-link to="/services" class="btn-secondary">查看服务</router-link><router-link to="/marketplace" class="btn-primary ml-2">浏览应用市场</router-link></div>
          </section>

          <section class="section-panel overview-activity" aria-labelledby="activity-heading">
            <div class="overview-section-heading"><div><h2 id="activity-heading"><History class="h-4 w-4 text-surface-400" />最近事件</h2><p>配置变更、告警与执行记录</p></div><router-link to="/events?tab=timeline" class="overview-text-link">查看全部<ArrowRight class="h-3.5 w-3.5" /></router-link></div>
            <ol v-if="recentEvents.length" class="overview-timeline">
              <li v-for="event in recentEvents" :key="event.key">
                <router-link :to="eventTarget(event)" class="overview-event" :aria-label="`查看${sourceLabel(event.source)}记录：${event.title}`">
                  <span class="overview-event-dot" :class="dotClass(event.level)"></span>
                  <span class="overview-event-main"><span class="overview-event-title">{{ event.title }}</span><span class="overview-event-meta"><span :class="sourceBadgeClass(event.source)">{{ sourceLabel(event.source) }}</span><span v-if="event.projectName">{{ event.projectName }}</span></span></span>
                  <time :datetime="event.timestamp" class="overview-event-time">{{ formatTime(event.timestamp) }}</time><ArrowUpRight class="overview-event-arrow h-3.5 w-3.5" />
                </router-link>
              </li>
            </ol>
            <EmptyState v-else compact icon="History" title="暂无事件记录" />
          </section>
        </div>

        <div class="overview-secondary">
          <router-link to="/inspection" class="section-panel overview-inspection" aria-label="查看巡检报告">
            <div class="overview-section-heading"><h2><ShieldCheck class="h-4 w-4 text-surface-400" />最近巡检</h2><ArrowUpRight class="h-4 w-4 text-surface-400" /></div>
            <div class="overview-score"><strong :class="inspectionTone">{{ inspectionScore }}</strong><span>/ 100<small>巡检评分</small></span></div>
            <p class="overview-inspection-summary">{{ inspectionSummary }}</p>
            <span class="overview-text-link">查看报告与建议<ArrowRight class="h-3.5 w-3.5" /></span>
          </router-link>
          <nav class="section-panel overview-shortcuts" aria-label="常用运维入口">
            <div class="overview-section-heading"><h2>常用操作</h2></div>
            <router-link v-for="action in quickActions" :key="action.to" :to="action.to" class="overview-shortcut"><span class="overview-shortcut-icon"><component :is="action.icon" class="h-4 w-4" /></span><span><strong>{{ action.label }}</strong><small>{{ action.description }}</small></span><ArrowUpRight class="h-4 w-4" /></router-link>
          </nav>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { AlertTriangle, ArrowRight, ArrowUpRight, Bot, Boxes, CircleCheckBig, Container, Cpu, FileCode2, History, MemoryStick, RefreshCw, ScrollText, ShieldCheck } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { useServicesStore } from '../stores/services.js';
import EmptyState from '../components/common/EmptyState.vue';
import Skeleton from '../components/common/Skeleton.vue';
import { pushMonitorTrend } from '../lib/monitor-trends.js';

import { projectAttention, projectLogTarget } from '../lib/project-health.js';

const quickActions = [
  { to: '/services', icon: Boxes, label: '管理服务', description: '查看项目与容器状态' },
  { to: '/compose', icon: FileCode2, label: '编辑配置', description: '检查、保存与部署 Compose' },
  { to: '/logs', icon: ScrollText, label: '查看日志', description: '追踪输出，定位异常' },
  { to: '/agent', icon: Bot, label: 'AI 助手', description: '结合上下文分析问题' },
];
function percentWidth(value) { return `${Math.min(100, Math.max(0, Number(value) || 0))}%`; }
function eventTarget(event) {
  return { operation: '/events?tab=operations', agent: '/agent/history', alert: '/events', cron: '/cron' }[event.source] || '/events?tab=timeline';
}

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
usePullRefresh(load);
onMounted(() => { window.addEventListener('composeops:host-changed', onHostChanged); void load(); });
onBeforeUnmount(() => { disposed = true; requestId += 1; window.removeEventListener('composeops:host-changed', onHostChanged); });
</script>

<style scoped>
.overview-eyebrow { margin-bottom: 8px; color: var(--color-surface-500); font-size: 11px; letter-spacing: .08em; }
.overview-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.overview-metric { display: flex; min-width: 0; flex-direction: column; gap: 16px; padding: 20px; border: 1px solid var(--line-subtle); border-radius: 12px; background: var(--panel-surface); transition: border-color 160ms, background-color 160ms; }
.overview-metric:hover { border-color: var(--line-hover); background: var(--panel-raised); }
.overview-metric-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--color-surface-400); font-size: 12px; }
.overview-metric-label svg { flex-shrink: 0; color: var(--color-surface-500); }
.overview-metric strong { font-size: clamp(26px, 2.3vw, 36px); font-weight: 600; letter-spacing: -.035em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.overview-metric strong small { margin-left: 8px; font-size: 13px; font-weight: 400; color: var(--color-surface-400); letter-spacing: 0; }
.overview-metric-detail { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; color: var(--color-surface-400); font-size: 11px; line-height: 1.7; }
.overview-metric-detail > svg { margin-left: auto; }
.overview-meter { height: 3px; margin-top: auto; border-radius: 4px; overflow: hidden; background: var(--color-surface-800); }
.overview-meter i { display: block; height: 100%; background: #4cb996; border-radius: inherit; transition: width 240ms; }
.overview-meter.is-warning i { background: #e6b75a; }
.overview-columns { display: grid; grid-template-columns: minmax(0, 1fr) 300px; align-items: start; gap: 20px; }
.overview-primary, .overview-secondary { display: flex; min-width: 0; flex-direction: column; gap: 20px; }
.overview-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
.overview-section-heading h2 { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--color-surface-100); }
.overview-section-heading p { margin-top: 6px; color: var(--color-surface-500); font-size: 12px; line-height: 1.7; }
.overview-section-icon { display: inline-flex; }
.overview-text-link { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; flex-shrink: 0; color: var(--color-link); font-size: 12px; white-space: nowrap; }
.overview-text-link:hover { color: #d2e2ff; }
.overview-attention.has-attention { border-top: 2px solid color-mix(in srgb, var(--warn) 45%, var(--line-subtle)); }
.overview-project { padding: 16px 0; border-top: 1px solid var(--line-subtle); }
.overview-project:last-child { padding-bottom: 0; }
.overview-project-info { display: flex; min-width: 0; align-items: center; gap: 12px; }
.overview-project-icon { display: grid; width: 40px; height: 40px; flex-shrink: 0; place-items: center; border: 1px solid var(--line-subtle); border-radius: 10px; color: var(--color-surface-300); background: var(--panel-raised); }
.overview-project-name { display: flex; align-items: center; gap: 7px; width: fit-content; max-width: 100%; color: var(--color-surface-100); font-size: 14px; font-weight: 550; overflow-wrap: anywhere; }
.overview-project-name svg { flex-shrink: 0; color: var(--color-surface-500); }
.overview-project-name:hover { color: var(--color-link); }
.overview-project-info p { margin-top: 5px; font-size: 12px; line-height: 1.7; color: var(--color-surface-400); }
.overview-state { flex-shrink: 0; margin-left: auto; padding: 3px 8px; border-radius: 6px; font-size: 11px; }
.overview-state.is-warning { color: #edc97e; background: rgba(251, 191, 36, .08); }
.overview-state.is-danger { color: #fda4af; background: rgba(251, 113, 133, .08); }
.overview-project-actions { display: flex; align-items: center; gap: 6px; margin: 14px 0 0 52px; }
.overview-project-actions .btn-secondary, .overview-project-actions .btn-ghost { min-height: 34px; padding: 6px 10px; font-size: 12px; }
.overview-calm-state { display: flex; align-items: center; gap: 16px; padding: 24px 8px; }
.overview-calm-state > svg { flex-shrink: 0; }
.overview-calm-state strong { font-weight: 500; font-size: 14px; }
.overview-calm-state p { margin-top: 6px; color: var(--color-surface-400); font-size: 12px; line-height: 1.7; }
.overview-empty { padding-bottom: 4px; text-align: center; }
.overview-timeline { list-style: none; }
.overview-timeline li + li { border-top: 1px solid var(--line-subtle); }
.overview-event { display: flex; align-items: center; gap: 12px; min-height: 70px; margin-inline: -8px; padding: 12px 8px; border-radius: 8px; transition: background-color 140ms; }
.overview-event:hover { background: var(--panel-raised); }
.overview-event-dot { width: 7px; height: 7px; flex-shrink: 0; border-radius: 50%; }
.overview-event-main { min-width: 0; flex: 1; }
.overview-event-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--color-surface-200); }
.overview-event-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 5px; color: var(--color-surface-500); font-size: 11px; overflow-wrap: anywhere; }
.overview-event-time { flex-shrink: 0; font-size: 11px; color: var(--color-surface-500); font-variant-numeric: tabular-nums; }
.overview-event-arrow { flex-shrink: 0; color: var(--color-surface-500); transition: transform 140ms; }
.overview-event:hover .overview-event-arrow { transform: translate(1px, -1px); color: var(--color-link); }
.overview-inspection { display: block; transition: border-color 160ms; }
.overview-inspection:hover { border-color: var(--line-hover); }
.overview-score { display: flex; gap: 12px; align-items: center; margin: 4px 0 16px; }
.overview-score strong { font-size: 44px; line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.04em; }
.overview-score > span { color: var(--color-surface-400); font-size: 12px; }
.overview-score small { display: block; margin-top: 4px; font-size: 11px; }
.overview-inspection-summary { margin-bottom: 10px; color: var(--color-surface-300); font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.overview-shortcuts .overview-section-heading { margin-bottom: 10px; }
.overview-shortcut { display: flex; gap: 12px; align-items: center; margin-inline: -8px; padding: 12px 8px; border-radius: 8px; transition: background-color 140ms; }
.overview-shortcut:hover { background: var(--panel-raised); }
.overview-shortcut-icon { display: grid; width: 32px; height: 32px; flex-shrink: 0; place-items: center; color: var(--color-link); background: rgba(96, 165, 250, .07); border-radius: 8px; }
.overview-shortcut > span:nth-child(2) { min-width: 0; }
.overview-shortcut strong { display: block; color: var(--color-surface-200); font-weight: 500; font-size: 12px; }
.overview-shortcut small { display: block; margin-top: 4px; font-size: 11px; color: var(--color-surface-500); }
.overview-shortcut > svg { margin-left: auto; flex-shrink: 0; color: var(--color-surface-500); }
@media (min-width: 1800px) { .overview-columns { grid-template-columns: minmax(0, 1fr) 360px; } }
@media (max-width: 1199px) {
  .overview-columns { grid-template-columns: minmax(0, 1fr); }
  .overview-secondary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
  .overview-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 639px) {
  .overview-eyebrow { display: none; }
  .overview-metrics { gap: 10px; }
  .overview-metric { padding: 12px; gap: 10px; }
  .overview-metric-label { font-size: 11px; }
  .overview-metric strong { font-size: 28px; }
  .overview-metric strong small { font-size: 11px; margin-left: 5px; }
  .overview-metric-detail { font-size: 11px; align-content: start; }
  .overview-metric-detail > svg { display: none; }
  .overview-columns, .overview-primary, .overview-secondary { gap: 15px; }
  .overview-secondary { grid-template-columns: minmax(0, 1fr); }
  .overview-section-heading { align-items: start; gap: 8px; margin-bottom: 14px; }
  .overview-section-heading p { font-size: 11px; }
  .overview-section-heading > .overview-text-link { font-size: 11px; }
  .overview-project-info { flex-wrap: wrap; gap: 10px; }
  .overview-project-info > div { flex: 1; }
  .overview-project-icon { width: 32px; height: 32px; }
  .overview-state { margin-left: 42px; }
  .overview-project-actions { margin-left: 0; margin-top: 12px; }
  .overview-project-actions > a { flex: 1; min-height: 40px !important; }
  .overview-event { flex-wrap: wrap; gap: 8px; }
  .overview-event-time { margin-left: 15px; font-size: 10px; }
  .overview-event-main { flex-basis: calc(100% - 20px); }
  .overview-event-arrow { margin-left: auto; }
  .overview-shortcut { min-height: 64px; }
}
@media (prefers-reduced-motion: reduce) {
  .overview-metric, .overview-meter i, .overview-event, .overview-event-arrow, .overview-inspection, .overview-shortcut { transition: none; }
}
</style>
