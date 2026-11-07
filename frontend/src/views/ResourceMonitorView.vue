<template>
  <div :class="embedded ? 'resource-monitor-view' : 'page-shell resource-monitor-view'">
    <!-- Header -->
    <div v-if="!embedded" class="page-header">
      <div>
        <h1 class="page-title">历史指标</h1>
        <p class="page-subtitle">查看容器资源趋势、异常点与告警规则</p>
      </div>
      <div class="page-actions">
        <button ref="alertModalTrigger" class="btn-primary" @click="showAlertModal = true"><Bell class="h-4 w-4" />配置告警</button>
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
            :color="metricTypes.find(m => m.key === selectedMetric)?.chartColor || '#38BDF8'"
            :unit="metricTypes.find(m => m.key === selectedMetric)?.unit || ''"
            :anomalies="chartAnomalies" :width="800" :height="300" />
        </div>
      </section>

      <!-- Alerts -->
      <section class="section-panel">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div><h2 class="section-title">告警规则</h2><p class="mt-1 text-muted">只展示当前选中容器的规则</p></div>
          <button class="icon-btn" :disabled="loading" @click="loadAlerts" aria-label="刷新告警规则">
            <RefreshCw class="h-4 w-4" />
          </button>
        </div>
        <p v-if="alertsError" class="alert-error" role="alert">{{ alertsError }}</p>
        <EmptyState v-else-if="containerAlerts.length === 0" compact icon="Bell" title="暂无告警规则" description="为当前容器配置 CPU、内存或重启次数告警。" />
        <div v-else class="space-y-2">
          <div v-for="alert in containerAlerts" :key="alert.id"
               class="panel-card flex flex-wrap items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-3">
              <AlertTriangle :class="['h-4 w-4', getAlertColor(alert.metric)]" />
              <div class="min-w-0">
                <div class="truncate text-sm font-medium text-surface-200">{{ alertMetricTypes.find(m => m.key === alert.metric)?.label || alert.metric }}</div>
                <div class="mt-0.5 text-xs text-surface-400">阈值：{{ alert.threshold }}{{ alert.metric === 'cpu' || alert.metric === 'memory' ? '%' : ' 次' }}</div>
              </div>
            </div>
            <button @click="deleteAlertRule(alert.id)" class="btn-ghost text-status-error hover:text-status-error btn-sm">删除</button>
          </div>
        </div>
      </section>
    </div>

    <div v-else-if="!containerId" class="section-panel py-8">
      <EmptyState icon="Activity"
        :title="!projects.length ? '暂无已纳管项目' : projectId && !containers.length ? '当前项目没有可监控容器' : '选择一个容器查看历史指标'"
        :description="!projects.length ? '先在服务总览纳管一个 Compose 项目，再回来查看容器趋势。' : projectId && !containers.length ? '当前项目暂时没有可用容器，请选择其他项目或启动服务。' : '选择项目和容器后，这里会展示资源趋势、异常点与告警规则。'" />
    </div>

    <!-- Alert Config Modal -->
    <div v-if="showAlertModal" class="modal-overlay" @click.self="closeAlertModal" @keydown="trapAlertModalTab">
      <div ref="alertModalElement" class="modal-content" role="dialog" aria-modal="true" aria-labelledby="resource-alert-modal-title" tabindex="-1">
        <div class="mb-4 flex items-center justify-between">
          <h3 id="resource-alert-modal-title" class="text-lg font-semibold text-surface-100">配置告警规则</h3>
          <button @click="closeAlertModal" class="icon-btn" aria-label="关闭告警规则配置">
            <X class="h-5 w-5" />
          </button>
        </div>
        <div class="space-y-3">
          <div>
            <label for="resource-alert-metric" class="mb-1 block text-sm text-surface-300">指标类型</label>
            <select id="resource-alert-metric" v-model="alertForm.metric" class="input">
              <option v-for="m in alertMetricTypes" :key="m.key" :value="m.key">{{ m.label }}</option>
            </select>
          </div>
          <div>
            <label for="resource-alert-threshold" class="mb-1 block text-sm text-surface-300">阈值</label>
            <input id="resource-alert-threshold" v-model.number="alertForm.threshold" type="number" class="input" placeholder="例如: 80" />
          </div>
          <div>
            <label for="resource-alert-action" class="mb-1 block text-sm text-surface-300">动作</label>
            <select id="resource-alert-action" v-model="alertForm.action" class="input">
              <option v-for="a in alertActionOptions" :key="a.key" :value="a.key">{{ a.label }}</option>
            </select>
          </div>
        </div>
        <div class="mt-4 flex gap-2">
          <button @click="createAlertRule" :disabled="!alertForm.metric || alertForm.threshold == null || !Number.isFinite(Number(alertForm.threshold))" class="btn-primary flex-1">
            创建规则
          </button>
          <button @click="closeAlertModal" class="btn-secondary flex-1">
            取消
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
// embedded 模式供 MonitorView 的「历史指标」tab 复用,隐藏独立页头
const props = defineProps({ embedded: { type: Boolean, default: false }, initialProjectId: { type: String, default: '' }, initialContainerId: { type: String, default: '' } });
import { AlertTriangle, Bell, Cpu, Database, HardDrive, Minus, Network, RefreshCw, TrendingDown, TrendingUp, X } from 'lucide-vue-next';
import { api, metricsApi } from '../api/client.js';
import { useToastStore } from '../stores/toast.js';
import StatusBadge from '../components/common/StatusBadge.vue';
import EmptyState from '../components/common/EmptyState.vue';
import InteractiveChart from '../components/charts/InteractiveChart.vue';
import { useEscapeKey } from '../composables/useEscapeKey.js';

const projects = ref([]);
const projectId = ref('');
const containerId = ref('');
const selectedMetric = ref('cpu');
const period = ref('5m');
const metricsData = ref(null);
const alerts = ref([]);
const showAlertModal = ref(false);
const alertModalTrigger = ref(null);
const alertModalElement = ref(null);
let previousAlertModalFocus = null;
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

const ALERT_MODAL_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
function getAlertModalFocusable() {
  return [...(alertModalElement.value?.querySelectorAll(ALERT_MODAL_FOCUSABLE) || [])]
    .filter((element) => !element.closest('[hidden]') && element.getAttribute('aria-hidden') !== 'true');
}
function closeAlertModal() {
  showAlertModal.value = false;
}
function trapAlertModalTab(event) {
  if (event.key !== 'Tab') return;
  const dialog = alertModalElement.value;
  if (!dialog) return;
  const focusable = getAlertModalFocusable();
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
    event.preventDefault();
    first.focus();
  }
}
useEscapeKey({ active: showAlertModal, onClose: closeAlertModal, layer: 'modal', lockBody: true });
watch(showAlertModal, async (visible) => {
  if (visible) {
    previousAlertModalFocus = document.activeElement;
    await nextTick();
    const dialog = alertModalElement.value;
    if (!dialog) return;
    const focusable = getAlertModalFocusable();
    (focusable[0] || dialog).focus({ preventScroll: true });
    return;
  }
  await nextTick();
  const target = previousAlertModalFocus?.isConnected ? previousAlertModalFocus : alertModalTrigger.value;
  previousAlertModalFocus = null;
  target?.focus?.({ preventScroll: true });
});

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
    historySeries.value = (seriesResult.metrics || []).map((item) => ({ timestamp: Number(item.timestamp), value: Number(item.value) })).filter((item) => Number.isFinite(item.timestamp) && Number.isFinite(item.value));
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
  try {
    const res = await metricsApi.getAlerts();
    if (disposed || requestId !== alertsRequestId) return;
    alerts.value = res.alerts || [];
    alertsError.value = '';
  } catch (err) {
    if (!disposed && requestId === alertsRequestId) alertsError.value = `加载告警失败：${err.message}`;
  }
}

async function createAlertRule() {
  if (!containerId.value || !alertForm.value.metric || alertForm.value.threshold == null || !Number.isFinite(Number(alertForm.value.threshold))) return;
  try {
    await metricsApi.createAlert({
      container: containerId.value,
      ...alertForm.value
    });
    showAlertModal.value = false;
    await loadAlerts();
    useToastStore().success('告警规则已创建');
  } catch (err) {
    useToastStore().error(`创建告警规则失败：${err.message}`);
  }
}

async function deleteAlertRule(ruleId) {
  try {
    await metricsApi.deleteAlert(ruleId);
    await loadAlerts();
    useToastStore().success('告警规则已删除');
  } catch (err) {
    useToastStore().error(`删除告警失败：${err.message}`);
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
  projectsRequestId += 1;
  alertsRequestId += 1;
  invalidateMetrics();
  window.removeEventListener('composeops:host-changed', onHostChanged);
});

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

.modal-overlay {
  position: fixed;
  inset: 0;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  backdrop-filter: blur(4px);
}

.modal-content {
  width: 100%;
  max-width: 28rem;
  max-height: min(85vh, 42rem);
  overflow-y: auto;
  background: var(--color-surface-950);
  border: 1px solid var(--color-surface-800);
  border-radius: 0.75rem;
  padding: 1.5rem;
  color: var(--color-surface-100);
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
}

@media (max-width: 639px) {
  .metric-card { gap: .55rem; padding: .7rem; }
  .modal-content { padding: 1rem; }
}
</style>
