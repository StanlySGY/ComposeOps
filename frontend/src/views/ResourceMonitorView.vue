<template>
  <div :class="embedded ? 'resource-monitor-view' : 'page-shell resource-monitor-view'">
    <!-- Header -->
    <div v-if="!embedded" class="page-header">
      <div>
        <h1 class="page-title">历史指标</h1>
        <p class="page-subtitle">查看容器资源趋势、异常点与告警规则</p>
      </div>
    </div>

    <!-- Container Selector -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label for="resource-monitor-project" class="mb-1.5 block text-xs font-medium text-surface-300">项目</label>
        <select id="resource-monitor-project" v-model="projectId" aria-label="选择监控项目" @change="onProjectChange" class="input">
          <option value="">选择项目</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
        </select>
      </div>
      <div>
        <label for="resource-monitor-container" class="mb-1.5 block text-xs font-medium text-surface-300">容器</label>
        <div class="flex gap-2">
          <select id="resource-monitor-container" v-model="containerId" aria-label="选择监控容器" @change="loadMetrics" :disabled="!projectId" class="input flex-1">
            <option value="">选择容器</option>
            <option v-for="c in containers" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <StatusBadge v-if="currentContainer" :status="currentContainer.state" :health="currentContainer.health" show-icon />
        </div>
      </div>
    </div>

    <div v-if="error" class="alert-error" role="alert">
      <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
      <span>{{ error }}</span>
    </div>
    <div v-if="loading" class="text-xs text-surface-400" role="status" aria-live="polite">正在加载指标…</div>

    <!-- Metrics Dashboard -->
    <div v-if="containerId && metricsData" class="min-w-0 space-y-4">
      <!-- Metric Cards -->
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <button v-for="m in metricTypes" :key="m.key" type="button"
          :aria-label="`选择${m.label}指标`" :aria-pressed="selectedMetric === m.key"
          @click="selectedMetric = m.key"
          :class="['metric-card', selectedMetric === m.key && 'metric-card-active']">
          <component :is="m.icon" :class="['h-5 w-5 shrink-0', m.color]" />
          <span class="min-w-0 flex-1">
            <span class="block text-xs font-medium text-surface-400">{{ m.label }}</span>
            <strong class="mt-1 block truncate text-lg font-semibold tabular-nums text-surface-100">{{ formatMetricValue(metricsData[m.key]) }}</strong>
            <span class="mt-1 flex items-center gap-1 text-xs">
              <TrendingUp v-if="metricsData[m.key]?.trend === 'increasing'" class="h-3 w-3 text-status-error" />
              <TrendingDown v-else-if="metricsData[m.key]?.trend === 'decreasing'" class="h-3 w-3 text-status-ok" />
              <Minus v-else class="h-3 w-3 text-surface-400" />
              <span :class="trendColor(metricsData[m.key]?.trend)">{{ metricsData[m.key]?.trend === 'stable' ? '稳定' : metricsData[m.key]?.trend === 'increasing' ? '上升' : '下降' }}</span>
            </span>
          </span>
        </button>
      </div>

      <!-- Chart -->
      <section class="history-chart-panel section-panel min-w-0">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <h2 class="section-title">{{ metricTypes.find(m => m.key === selectedMetric)?.label }}趋势</h2>
            <p class="mt-1 text-muted">{{ currentContainer?.name || '当前容器' }} · {{ periods.find(p => p.key === period)?.label }} · 异常点以阴影标记</p>
          </div>
          <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="历史指标时间范围">
            <button v-for="p in periods" :key="p.key"
                    type="button"
                    :aria-pressed="period === p.key"
                    @click="period = p.key; loadMetrics()"
                    :class="period === p.key ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'">
              {{ p.label }}
            </button>
          </div>
        </div>
        <EmptyState v-if="!loading && !chartData.length" compact icon="History" title="当前时间范围暂无历史数据" description="缩短时间范围或等待下一轮指标采集后再查看趋势。" />
        <div v-else class="history-chart-frame min-w-0 w-full">
          <InteractiveChart :data="chartData"
            :aria-label="`${currentContainer?.name || '当前容器'} 的${metricTypes.find(m => m.key === selectedMetric)?.label || ''}历史指标`"
            :color="metricTypes.find(m => m.key === selectedMetric)?.chartColor || '#38BDF8'"
            :unit="metricTypes.find(m => m.key === selectedMetric)?.unit || ''"
            :anomalies="chartAnomalies" :width="800" :height="300" />
        </div>
      </section>

    </div>

    <div v-else-if="!containerId" class="section-panel py-8">
      <EmptyState icon="Activity"
        :title="!projects.length ? '暂无已纳管项目' : projectId && !containers.length ? '当前项目没有可监控容器' : '选择一个容器查看历史指标'"
        :description="!projects.length ? '先在服务总览纳管一个 Compose 项目，再回来查看容器趋势。' : projectId && !containers.length ? '当前项目暂时没有可用容器，请选择其他项目或启动服务。' : '选择项目和容器后，这里会展示资源趋势、异常点与告警规则。'" />
    </div>

    <section v-if="currentContainer" class="section-panel alert-rules-panel" aria-label="容器告警规则" :aria-busy="alertsLoading">
      <header class="alert-rules-heading">
        <div class="flex min-w-0 items-start gap-3">
          <span class="alert-section-icon"><Bell class="h-4 w-4" /></span>
          <div class="min-w-0"><h2 class="section-title">告警规则 <span v-if="alertsLoaded" class="count-badge">{{ containerAlerts.length }}</span></h2><p class="mt-1 text-muted break-all">{{ currentContainer.name }} · 持续关注资源变化</p></div>
        </div>
        <div class="flex items-center gap-2">
          <button class="icon-btn" :disabled="alertsLoading || alertBusy" @click="loadAlerts" aria-label="刷新告警规则"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': alertsLoading }" /></button>
          <button class="btn-primary btn-sm" :disabled="alertBusy" @click="openAlertModal"><Plus class="h-4 w-4" />配置告警</button>
        </div>
      </header>
      <div v-if="alertFeedback" ref="alertFeedbackElement" class="alert-success mt-3" role="status" tabindex="-1"><CheckCircle2 class="h-4 w-4 shrink-0" /><span>{{ alertFeedback }}</span></div>
      <div v-if="alertsError" class="alert-error mt-3" role="alert"><span class="min-w-0 flex-1">{{ alertsError }}</span><button class="text-link shrink-0" :disabled="alertsLoading" @click="loadAlerts">重新读取规则</button></div>
      <div v-if="alertsLoading && !alertsLoaded" class="flex items-center gap-2 py-8 text-sm text-surface-400" role="status"><Loader2 class="h-4 w-4 animate-spin" />正在读取告警规则…</div>
      <EmptyState v-else-if="alertsLoaded && !containerAlerts.length && !alertsError" compact icon="Bell" title="暂无告警规则" description="为 CPU、内存或重启次数设定阈值，建议先从仅通知开始。" />
      <ul v-if="containerAlerts.length" class="mt-4 grid gap-2" aria-label="当前容器告警规则">
        <li v-for="alert in containerAlerts" :key="alert.id" class="alert-rule-card">
          <div class="flex min-w-0 items-start gap-3">
            <component :is="alert.metric === 'cpu' ? Cpu : alert.metric === 'memory' ? Database : RefreshCw" :class="['mt-0.5 h-4 w-4 shrink-0', getAlertColor(alert.metric)]" />
            <div class="min-w-0"><h3 class="text-sm font-medium text-surface-200">{{ alertMetricTypes.find(m => m.key === alert.metric)?.label || alert.metric }}</h3><p class="mt-1 text-xs text-surface-400 tabular-nums">阈值：{{ alert.threshold }}{{ alert.metric === 'cpu' || alert.metric === 'memory' ? '%' : ' 次' }}</p></div>
          </div>
          <span class="alert-action-label" :class="{ 'is-automatic': alert.action && alert.action !== 'notify' }"><Bell v-if="!alert.action || alert.action === 'notify'" class="h-3 w-3" /><Zap v-else class="h-3 w-3" />{{ actionLabel(alert.action) }}</span>
          <button class="btn-ghost btn-sm text-status-error" :disabled="alertBusy" :aria-label="`删除${alertMetricTypes.find(m => m.key === alert.metric)?.label || alert.metric}告警规则`" @click="selectDeleteAlert(alert)">删除</button>
        </li>
      </ul>
      <p class="mt-3 text-xs leading-relaxed text-surface-500">规则由后台持续检查。通知投递使用设置中的已启用渠道。</p>
    </section>

    <BaseModal :show="showAlertModal" title="配置告警规则" size-class="sm:max-w-md" body-class="p-4 space-y-4" :close-disabled="alertCreating" @close="closeAlertModal">
      <div class="alert-target-context"><span class="text-xs text-surface-400">应用到容器</span><strong class="mt-1 block break-all text-sm text-surface-100">{{ alertTarget?.containerName }}</strong><span class="mt-1 block break-all text-xs text-surface-400">{{ alertTarget?.projectName }}</span></div>
      <fieldset :disabled="alertCreating" class="space-y-4">
        <div><label for="resource-alert-metric" class="mb-1.5 block text-xs font-medium text-surface-300">指标类型</label><select id="resource-alert-metric" v-model="alertForm.metric" class="input"><option v-for="m in alertMetricTypes" :key="m.key" :value="m.key">{{ m.label }}</option></select></div>
        <div><label for="resource-alert-threshold" class="mb-1.5 block text-xs font-medium text-surface-300">阈值{{ alertForm.metric === 'restart_count' ? '（次）' : '（%）' }}</label><input id="resource-alert-threshold" v-model.number="alertForm.threshold" type="number" min="0" :max="alertForm.metric === 'restart_count' ? undefined : 100" step="any" class="input" placeholder="例如：80" aria-describedby="resource-alert-threshold-help" :aria-invalid="!validAlertForm" /><p id="resource-alert-threshold-help" class="mt-1.5 text-xs text-surface-400">{{ alertForm.metric === 'restart_count' ? '填写大于或等于 0 的重启次数。' : '填写 0–100 之间的百分比。' }}</p></div>
        <div><label for="resource-alert-action" class="mb-1.5 block text-xs font-medium text-surface-300">触发后执行</label><select id="resource-alert-action" v-model="alertForm.action" class="input"><option v-for="a in alertActionOptions" :key="a.key" :value="a.key">{{ a.label }}</option></select></div>
      </fieldset>
      <p class="alert-action-preview" :class="{ 'is-automatic': alertForm.action !== 'notify' }"><component :is="alertForm.action === 'notify' ? Bell : AlertTriangle" class="h-4 w-4 shrink-0" /><span>{{ alertForm.action === 'notify' ? '触发时记录告警并通过已启用渠道发送通知。' : alertForm.action === 'auto_restart' ? '触发时会自动重启匹配容器，可能短暂中断服务。' : '触发时会自动增加该服务的副本数，需要项目支持 Compose 编辑。' }}</span></p>
      <p v-if="alertCreateError" class="alert-error" role="alert">{{ alertCreateError }}</p>
      <template #footer><button class="btn-secondary" :disabled="alertCreating" @click="closeAlertModal">取消</button><button class="btn-primary" :disabled="alertCreating || !validAlertForm" :aria-busy="alertCreating" @click="createAlertRule"><Loader2 v-if="alertCreating" class="h-4 w-4 animate-spin" /><Plus v-else class="h-4 w-4" />创建规则</button></template>
    </BaseModal>
    <ConfirmDialog :show="!!deleteTarget" title="删除告警规则" :message="`确认删除 ${deleteTarget?.containerName || '当前容器'} 的${alertMetricTypes.find(m => m.key === deleteTarget?.metric)?.label || ''}规则？删除后该规则将停止检查。`" tone="danger" confirm-text="确认删除" :busy="alertDeleting" @cancel="closeDeleteAlert" @confirm="deleteAlertRule"><p v-if="alertDeleteError" class="text-status-error" role="alert">{{ alertDeleteError }}</p></ConfirmDialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
// embedded 模式供 MonitorView 的「历史指标」tab 复用,隐藏独立页头
const props = defineProps({ embedded: { type: Boolean, default: false }, initialProjectId: { type: String, default: '' }, initialContainerId: { type: String, default: '' } });
import { AlertTriangle, Bell, Cpu, Database, HardDrive, Minus, Network, RefreshCw, TrendingDown, TrendingUp, Plus, Loader2, CheckCircle2, Zap } from 'lucide-vue-next';
import { api, metricsApi } from '../api/client.js';
import { useToastStore } from '../stores/toast.js';
import StatusBadge from '../components/common/StatusBadge.vue';
import EmptyState from '../components/common/EmptyState.vue';
import InteractiveChart from '../components/charts/InteractiveChart.vue';
import BaseModal from '../components/common/BaseModal.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';

const projects = ref([]);
const projectId = ref('');
const containerId = ref('');
const selectedMetric = ref('cpu');
const period = ref('5m');
const metricsData = ref(null);
const alerts = ref([]);
const showAlertModal = ref(false);
const alertTarget = ref(null);
const deleteTarget = ref(null);
const alertCreating = ref(false);
const alertDeleting = ref(false);
const alertBusy = computed(() => alertCreating.value || alertDeleting.value);
const alertCreateError = ref('');
const alertDeleteError = ref('');
const alertsLoading = ref(false);
const alertsLoaded = ref(false);
const alertFeedback = ref('');
const alertFeedbackElement = ref(null);
let alertContextVersion = 0;
let createRequestId = 0;
let deleteRequestId = 0;
const loading = ref(false);
const error = ref('');
const alertsError = ref('');
const historySeries = ref([]);
const anomalies = ref([]);
let metricsRequestId = 0;
let projectsRequestId = 0;
let alertsRequestId = 0;
let disposed = false;
let initialSelectionApplied = false;

const alertForm = ref({
  metric: 'cpu',
  threshold: 80,
  action: 'notify'
});

// 告警可选指标:与统一告警引擎(alert-monitor)支持的口径一致。
const alertMetricTypes = [
  { key: 'cpu', label: 'CPU 占用(%)' },
  { key: 'memory', label: '内存占用(%)' },
  { key: 'restart_count', label: '重启次数' }
];

const alertActionOptions = [
  { key: 'notify', label: '仅通知' },
  { key: 'auto_restart', label: '自动重启容器' },
  { key: 'scale', label: '自动扩容 (+1 副本)' }
];

const validAlertForm = computed(() => {
  const { metric, threshold, action } = alertForm.value;
  const value = Number(threshold);
  return alertMetricTypes.some(item => item.key === metric) && alertActionOptions.some(item => item.key === action)
    && threshold !== null && String(threshold).trim() !== '' && Number.isFinite(value) && value >= 0
    && (metric === 'restart_count' || value <= 100);
});
function actionLabel(action) {
  return alertActionOptions.find(item => item.key === (action === 'restart' ? 'auto_restart' : action))?.label || '仅通知';
}
function alertContext() {
  return { version: alertContextVersion, projectId: projectId.value, containerId: containerId.value,
    containerName: currentContainer.value?.name || containerId.value,
    projectName: projects.value.find(item => item.id === projectId.value)?.projectName || projectId.value };
}
function isAlertContextCurrent(context) {
  return !disposed && context?.version === alertContextVersion && context.projectId === projectId.value && context.containerId === containerId.value;
}
function invalidateAlertActions() {
  alertContextVersion += 1;
  createRequestId += 1;
  deleteRequestId += 1;
  showAlertModal.value = false;
  alertTarget.value = null;
  deleteTarget.value = null;
  alertCreating.value = false;
  alertDeleting.value = false;
  alertCreateError.value = '';
  alertDeleteError.value = '';
  alertFeedback.value = '';
}
function openAlertModal() {
  if (!currentContainer.value || alertBusy.value) return;
  alertTarget.value = alertContext();
  alertForm.value = { metric: 'cpu', threshold: 80, action: 'notify' };
  alertCreateError.value = '';
  showAlertModal.value = true;
}
function closeAlertModal() {
  if (!alertCreating.value) showAlertModal.value = false;
}
function selectDeleteAlert(rule) {
  if (alertBusy.value) return;
  deleteTarget.value = { ...rule, ...alertContext() };
  alertDeleteError.value = '';
}
function closeDeleteAlert() {
  if (!alertDeleting.value) deleteTarget.value = null;
}
async function showAlertFeedback(message, context) {
  if (!isAlertContextCurrent(context)) return;
  alertFeedback.value = message;
  await nextTick();
  if (isAlertContextCurrent(context)) {
    alertFeedbackElement.value?.focus({ preventScroll: true });
    alertFeedbackElement.value?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
}

const metricTypes = [
  { key: 'cpu', label: 'CPU', icon: Cpu, color: 'text-cyan-400', chartColor: '#06B6D4', unit: '%' },
  { key: 'memory', label: '内存', icon: Database, color: 'text-status-ok', chartColor: '#10B981', unit: '%' },
  { key: 'network', label: '网络', icon: Network, color: 'text-status-warn', chartColor: '#F59E0B', unit: 'bytes' },
  { key: 'disk', label: '磁盘 I/O', icon: HardDrive, color: 'text-status-error', chartColor: '#EF4444', unit: 'bytes' }
];

const periods = [
  { key: '1m', label: '1分钟' },
  { key: '5m', label: '5分钟' },
  { key: '1h', label: '1小时' },
  { key: '1d', label: '1天' }
];

const containers = computed(() => projects.value.find(p => p.id === projectId.value)?.containers || []);
const currentContainer = computed(() => containers.value.find(c => c.id === containerId.value));

const containerAlerts = computed(() => alerts.value.filter(a => a.containerId === containerId.value));

const chartData = computed(() => {
  return historySeries.value;
});

const chartAnomalies = computed(() => {
  if (!historySeries.value.length) return [];
  const interval = historySeries.value.length > 1
    ? Math.max(1000, historySeries.value[1].timestamp - historySeries.value[0].timestamp)
    : 1000;
  return anomalies.value.map((item) => ({
    start: Number(item.timestamp) - interval / 2,
    end: Number(item.timestamp) + interval / 2,
  }));
});

function formatMetricValue(metric) {
  if (!metric) return '-';
  if (typeof metric.current === 'number') {
    return `${metric.current.toFixed(1)}${metric.unit}`;
  }
  if (metric.current?.rx !== undefined) {
    return `收 ${metric.current.rx} · 发 ${metric.current.tx}`;
  }
  if (metric.current?.read !== undefined) {
    return `读 ${metric.current.read} · 写 ${metric.current.write}`;
  }
  return '-';
}

function backendMetric(metric) {
  if (metric === 'network') return 'network_rx';
  if (metric === 'disk') return 'disk_read';
  return metric;
}

function periodMs(value) {
  const match = String(value).match(/^(\d+)(m|h|d)$/);
  if (!match) return 5 * 60 * 1000;
  const amount = Number(match[1]);
  return amount * ({ m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2]]);
}

function trendColor(trend) {
  if (trend === 'increasing') return 'text-status-error';
  if (trend === 'decreasing') return 'text-status-ok';
  return 'text-surface-400';
}

function getAlertColor(metric) {
  const colors = {
    cpu: 'text-cyan-400',
    memory: 'text-status-ok',
    restart_count: 'text-status-warn'
  };
  return colors[metric] || 'text-surface-400';
}

function invalidateMetrics() {
  metricsRequestId += 1;
  loading.value = false;
  metricsData.value = null;
  historySeries.value = [];
  anomalies.value = [];
}

function onProjectChange() {
  containerId.value = '';
  invalidateMetrics();
  error.value = '';
}

async function loadProjects() {
  const requestId = ++projectsRequestId;
  try {
    const response = await api.getProjects();
    if (disposed || requestId !== projectsRequestId) return;
    const nextProjects = (response.projects || []).filter(p => p.managed);
    projects.value = nextProjects;
    if (!initialSelectionApplied) {
      initialSelectionApplied = true;
      const initial = nextProjects.find(p => (!props.initialProjectId || p.id === props.initialProjectId)
        && p.containers?.some(c => c.id === props.initialContainerId));
      if (initial) {
        projectId.value = initial.id;
        containerId.value = props.initialContainerId;
        void loadMetrics();
      } else if (props.initialProjectId || props.initialContainerId) {
        projectId.value = nextProjects.find(p => p.id === props.initialProjectId)?.id || '';
        error.value = '指定容器在当前节点不可用，请重新选择项目与容器。';
      }
    }
    if (projectId.value && !nextProjects.some((project) => project.id === projectId.value)) {
      projectId.value = '';
      containerId.value = '';
      invalidateMetrics();
    }
    if (nextProjects.length === 1 && !projectId.value) {
      projectId.value = nextProjects[0].id;
    }
  } catch (err) {
    if (!disposed && requestId === projectsRequestId) error.value = `加载项目失败：${err.message}`;
  }
}

async function loadMetrics() {
  if (!containerId.value) {
    invalidateMetrics();
    return;
  }
  const requestId = ++metricsRequestId;
  const context = { containerId: containerId.value, metric: selectedMetric.value, period: period.value };
  loading.value = true;
  error.value = '';
  try {
    const endTime = Date.now();
    const startTime = endTime - periodMs(context.period);
    const results = await Promise.all(
      metricTypes.map(m => metricsApi.getContainerMetrics(context.containerId, m.key, context.period))
    );
    if (disposed || requestId !== metricsRequestId || containerId.value !== context.containerId || selectedMetric.value !== context.metric || period.value !== context.period) return;
    const [seriesResult, anomalyResult] = await Promise.all([
      metricsApi.getHistoricalMetrics({ containerId: context.containerId, metricType: backendMetric(context.metric), startTime, endTime, aggregation: 'auto' }),
      metricsApi.detectAnomalies({ containerId: context.containerId, metricType: backendMetric(context.metric), startTime, endTime }),
    ]);
    if (disposed || requestId !== metricsRequestId || containerId.value !== context.containerId || selectedMetric.value !== context.metric || period.value !== context.period) return;
    metricsData.value = {};
    metricTypes.forEach((m, i) => {
      metricsData.value[m.key] = results[i].data;
    });
    historySeries.value = (seriesResult.metrics || []).map((item) => ({ ...item, timestamp: Number(item.timestamp), value: Number(item.value) })).filter((item) => Number.isFinite(item.timestamp) && Number.isFinite(item.value));
    anomalies.value = anomalyResult.anomalies || [];
  } catch (err) {
    if (!disposed && requestId === metricsRequestId) {
      historySeries.value = [];
      anomalies.value = [];
      error.value = `加载指标失败: ${err.message}`;
    }
  } finally {
    if (!disposed && requestId === metricsRequestId) loading.value = false;
  }
}

async function loadAlerts() {
  const requestId = ++alertsRequestId;
  alertsLoading.value = true;
  alertsError.value = '';
  try {
    const res = await metricsApi.getAlerts();
    if (disposed || requestId !== alertsRequestId) return;
    alerts.value = res.alerts || [];
    alertsLoaded.value = true;
  } catch (err) {
    if (!disposed && requestId === alertsRequestId) alertsError.value = `加载告警失败：${err.message}`;
  } finally {
    if (!disposed && requestId === alertsRequestId) {
      alertsLoading.value = false;
      await nextTick();
      if (!disposed && requestId === alertsRequestId && alertFeedbackElement.value === document.activeElement) {
        alertFeedbackElement.value?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    }
  }
}

async function createAlertRule() {
  const context = alertTarget.value;
  if (alertCreating.value || !validAlertForm.value || !isAlertContextCurrent(context)) return;
  const requestId = ++createRequestId;
  const payload = { container: context.containerId, ...alertForm.value };
  alertCreating.value = true;
  alertCreateError.value = '';
  try {
    const result = await metricsApi.createAlert(payload);
    if (requestId !== createRequestId || !isAlertContextCurrent(context)) return;
    // Apply acknowledged writes before refreshing; an unavailable list must not erase success.
    alertsRequestId += 1;
    if (result.rule) {
      alerts.value = [...alerts.value.filter(item => item.id !== result.rule.id), result.rule];
      alertsLoaded.value = true;
    }
    showAlertModal.value = false;
    alertCreating.value = false;
    useToastStore().success('告警规则已创建');
    await showAlertFeedback(`已为 ${context.containerName} 创建告警规则。`, context);
    if (requestId === createRequestId && isAlertContextCurrent(context)) void loadAlerts();
  } catch (err) {
    if (requestId === createRequestId && isAlertContextCurrent(context)) alertCreateError.value = `创建告警规则失败：${err.message}`;
  } finally {
    if (requestId === createRequestId) alertCreating.value = false;
  }
}

async function deleteAlertRule() {
  const context = deleteTarget.value;
  if (alertDeleting.value || !context || !isAlertContextCurrent(context)) return;
  const requestId = ++deleteRequestId;
  alertDeleting.value = true;
  alertDeleteError.value = '';
  try {
    await metricsApi.deleteAlert(context.id);
    if (requestId !== deleteRequestId || !isAlertContextCurrent(context)) return;
    alertsRequestId += 1;
    alerts.value = alerts.value.filter(item => item.id !== context.id);
    deleteTarget.value = null;
    alertDeleting.value = false;
    useToastStore().success('告警规则已删除');
    await showAlertFeedback(`已删除 ${context.containerName} 的告警规则。`, context);
    if (requestId === deleteRequestId && isAlertContextCurrent(context)) void loadAlerts();
  } catch (err) {
    if (requestId === deleteRequestId && isAlertContextCurrent(context)) alertDeleteError.value = `删除告警失败：${err.message}`;
  } finally {
    if (requestId === deleteRequestId) alertDeleting.value = false;
  }
}

// 只作为实时监控的「历史指标」tab 嵌入;父页面只在「实时」tab 响应,两者不重复发请求。
usePullRefresh(async () => {
  await loadProjects();
  await loadAlerts();
  await loadMetrics();
});
onMounted(async () => {
  disposed = false;
  window.addEventListener('composeops:host-changed', onHostChanged);
  await loadProjects();
  if (disposed) return;
  await loadAlerts();
});

function onHostChanged() {
  invalidateAlertActions();
  alertsLoaded.value = false;
  projectsRequestId += 1;
  alertsRequestId += 1;
  invalidateMetrics();
  projectId.value = '';
  containerId.value = '';
  projects.value = [];
  alerts.value = [];
  alertsError.value = '';
  error.value = '';
  void loadProjects();
  void loadAlerts();
}

onBeforeUnmount(() => {
  disposed = true;
  invalidateAlertActions();
  projectsRequestId += 1;
  alertsRequestId += 1;
  invalidateMetrics();
  window.removeEventListener('composeops:host-changed', onHostChanged);
});

watch([projectId, containerId], invalidateAlertActions, { flush: 'sync' });
watch(selectedMetric, () => { if (containerId.value) void loadMetrics(); });
</script>

<style scoped>
 .resource-monitor-view { min-width: 0; min-height: 0; }

.metric-card {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: flex-start;
  gap: .75rem;
  padding: .85rem;
  border: 1px solid var(--color-surface-800);
  border-radius: .85rem;
  background: color-mix(in srgb, var(--color-surface-950) 88%, transparent);
  color: var(--color-surface-100);
  text-align: left;
  transition: border-color .18s, background .18s, transform .18s;
}

.metric-card:hover {
  border-color: var(--color-surface-600);
  background: var(--color-surface-900);
}

.metric-card-active {
  border-color: rgb(52 211 153 / 55%);
  background: linear-gradient(135deg, rgb(16 185 129 / 10%), rgb(6 182 212 / 5%));
  box-shadow: inset 0 0 0 1px rgb(52 211 153 / 12%);
}

.metric-card:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.alert-rules-panel { margin-top: 1rem; }
.alert-rules-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .85rem; }
.alert-section-icon { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; flex-shrink: 0; border: 1px solid rgb(52 211 153 / 20%); border-radius: .75rem; color: var(--color-accent); background: rgb(16 185 129 / 8%); }
.alert-rule-card { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: .8rem; padding: .85rem; border: 1px solid var(--color-surface-800); border-radius: .75rem; background: color-mix(in srgb, var(--color-surface-950) 80%, transparent); transition: border-color .18s, background .18s; }
.alert-rule-card:hover, .alert-rule-card:focus-within { border-color: var(--color-surface-600); background: var(--color-surface-900); }
.alert-action-label { display: inline-flex; align-items: center; gap: .35rem; font-size: .7rem; color: var(--color-surface-400); }
.alert-action-label.is-automatic { color: var(--color-status-warn); }
.alert-target-context { border-left: 2px solid var(--color-accent); padding: .5rem .75rem; background: rgb(16 185 129 / 5%); border-radius: 0 .5rem .5rem 0; }
#resource-alert-metric, #resource-alert-threshold, #resource-alert-action { width: 100%; }
.alert-action-preview { display: flex; align-items: flex-start; gap: .65rem; padding: .8rem; border-radius: .6rem; background: var(--color-surface-900); font-size: .75rem; line-height: 1.7; color: var(--color-surface-400); }
.alert-action-preview.is-automatic { background: rgb(245 158 11 / 8%); color: var(--color-status-warn); }
@media (max-width: 639px) {
  .metric-card { gap: .55rem; padding: .7rem; }
  .alert-rule-card { grid-template-columns: minmax(0, 1fr) auto; }
  .alert-action-label { grid-column: 1; padding-left: 1.75rem; }
  .alert-rule-card > button { grid-column: 2; grid-row: 1 / 3; }
  .alert-rules-heading > div:last-child { margin-left: auto; }
}
@media (prefers-reduced-motion: reduce) { .alert-rule-card, .metric-card { transition: none; } }
</style>
