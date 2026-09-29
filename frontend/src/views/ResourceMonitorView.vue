<template>
  <div :class="embedded ? 'resource-monitor-view' : 'page-shell resource-monitor-view'">
    <!-- Header -->
    <div v-if="!embedded" class="mb-4 flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-zinc-100">历史指标</h1>
        <p class="mt-1 text-sm text-zinc-400">实时容器资源使用情况与告警配置</p>
      </div>
      <button @click="showAlertModal = true" class="btn-primary">
        <Bell class="h-4 w-4" />
        配置告警
      </button>
    </div>

    <!-- Container Selector -->
    <div class="mb-4 grid grid-cols-2 gap-3">
      <div>
        <label class="mb-1 block text-sm font-medium text-zinc-300">项目</label>
        <select v-model="projectId" @change="onProjectChange" class="input">
          <option value="">选择项目</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
        </select>
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium text-zinc-300">容器</label>
        <div class="flex gap-2">
          <select v-model="containerId" @change="loadMetrics" :disabled="!projectId" class="input flex-1">
            <option value="">选择容器</option>
            <option v-for="c in containers" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <StatusBadge v-if="currentContainer" :status="currentContainer.state" :health="currentContainer.health" show-icon />
        </div>
      </div>
    </div>

    <div v-if="error" class="mb-4 flex items-start gap-2 rounded-md border border-rose-900/50 bg-rose-950/20 p-3 text-sm text-rose-300">
      <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
      <span>{{ error }}</span>
    </div>
    <div v-if="loading" class="mb-4 text-sm text-zinc-500">正在加载指标...</div>

    <!-- Metrics Dashboard -->
    <div v-if="containerId && metricsData" class="space-y-4">
      <!-- Metric Cards -->
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div v-for="m in metricTypes" :key="m.key" 
             @click="selectedMetric = m.key"
             :class="['metric-card', selectedMetric === m.key && 'metric-card-active']">
          <component :is="m.icon" :class="['h-5 w-5', m.color]" />
          <div class="mt-2">
            <div class="text-xs text-zinc-400">{{ m.label }}</div>
            <div class="mt-1 text-lg font-semibold text-zinc-100">
              {{ formatMetricValue(metricsData[m.key]) }}
            </div>
            <div class="mt-1 flex items-center gap-1 text-xs">
              <TrendingUp v-if="metricsData[m.key]?.trend === 'increasing'" class="h-3 w-3 text-rose-400" />
              <TrendingDown v-else-if="metricsData[m.key]?.trend === 'decreasing'" class="h-3 w-3 text-emerald-400" />
              <Minus v-else class="h-3 w-3 text-zinc-500" />
              <span :class="trendColor(metricsData[m.key]?.trend)">
                {{ metricsData[m.key]?.trend === 'stable' ? '稳定' : metricsData[m.key]?.trend === 'increasing' ? '上升' : '下降' }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Chart -->
      <div class="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/80 p-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="font-semibold text-zinc-100 whitespace-nowrap">{{ metricTypes.find(m => m.key === selectedMetric)?.label }}趋势</h2>
          <div class="flex flex-nowrap gap-2 overflow-x-auto">
            <button v-for="p in periods" :key="p.key"
                    @click="period = p.key; loadMetrics()"
                    :class="['px-3 py-1 text-xs rounded-md transition-colors', 
                             period === p.key ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700']">
              {{ p.label }}
            </button>
          </div>
        </div>
          <div class="min-w-[560px]">
            <InteractiveChart
              :data="chartData"
              :color="metricTypes.find(m => m.key === selectedMetric)?.chartColor || '#38BDF8'"
              :unit="metricTypes.find(m => m.key === selectedMetric)?.unit || ''"
              :anomalies="chartAnomalies"
              :width="800"
              :height="300"
            />
          </div>
      </div>

      <!-- Alerts -->
      <div class="rounded-lg border border-zinc-800 bg-zinc-950/80 p-4">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="font-semibold text-zinc-100">告警规则</h2>
          <button @click="loadAlerts" class="text-xs text-zinc-400 hover:text-zinc-300">
            <RefreshCw class="h-3 w-3" />
          </button>
        </div>
        <div v-if="alerts.length === 0" class="py-6 text-center text-sm text-zinc-500">
          暂无告警规则
        </div>
        <div v-else class="space-y-2">
          <div v-for="alert in containerAlerts" :key="alert.id" 
               class="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/50 p-3">
            <div class="flex items-center gap-3">
              <AlertTriangle :class="['h-4 w-4', getAlertColor(alert.metric)]" />
              <div>
                <div class="text-sm font-medium text-zinc-200">{{ alertMetricTypes.find(m => m.key === alert.metric)?.label || alert.metric }}</div>
                <div class="mt-0.5 text-xs text-zinc-400">阈值: {{ alert.threshold }}{{ alert.metric === 'cpu' || alert.metric === 'memory' ? '%' : ' 次' }}</div>
              </div>
            </div>
            <button @click="deleteAlertRule(alert.id)" class="text-xs text-rose-400 hover:text-rose-300">
              删除
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="!containerId" class="py-12 text-center text-zinc-500">
      <Activity class="mx-auto h-12 w-12 opacity-50" />
      <p class="mt-3">请选择项目和容器查看监控数据</p>
    </div>

    <!-- Alert Config Modal -->
    <div v-if="showAlertModal" class="modal-overlay" @click.self="showAlertModal = false">
      <div class="modal-content">
        <div class="mb-4 flex items-center justify-between">
          <h3 class="text-lg font-semibold text-zinc-100">配置告警规则</h3>
          <button @click="showAlertModal = false" class="text-zinc-400 hover:text-zinc-300">
            <X class="h-5 w-5" />
          </button>
        </div>
        <div class="space-y-3">
          <div>
            <label class="mb-1 block text-sm text-zinc-300">指标类型</label>
            <select v-model="alertForm.metric" class="input">
              <option v-for="m in alertMetricTypes" :key="m.key" :value="m.key">{{ m.label }}</option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-sm text-zinc-300">阈值</label>
            <input v-model.number="alertForm.threshold" type="number" class="input" placeholder="例如: 80" />
          </div>
          <div>
            <label class="mb-1 block text-sm text-zinc-300">动作</label>
            <select v-model="alertForm.action" class="input">
              <option v-for="a in alertActionOptions" :key="a.key" :value="a.key">{{ a.label }}</option>
            </select>
          </div>
        </div>
        <div class="mt-4 flex gap-2">
          <button @click="createAlertRule" :disabled="!alertForm.metric || alertForm.threshold == null || !Number.isFinite(Number(alertForm.threshold))" class="btn-primary flex-1">
            创建规则
          </button>
          <button @click="showAlertModal = false" class="btn-secondary flex-1">
            取消
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
// embedded 模式供 MonitorView 的「历史指标」tab 复用,隐藏独立页头
defineProps({ embedded: { type: Boolean, default: false } });
import { Activity, AlertTriangle, Bell, Cpu, Database, HardDrive, Minus, Network, RefreshCw, TrendingDown, TrendingUp, X } from 'lucide-vue-next';
import { api, metricsApi } from '../api/client.js';
import { useToastStore } from '../stores/toast.js';
import StatusBadge from '../components/common/StatusBadge.vue';
import InteractiveChart from '../components/charts/InteractiveChart.vue';

const projects = ref([]);
const projectId = ref('');
const containerId = ref('');
const selectedMetric = ref('cpu');
const period = ref('5m');
const metricsData = ref(null);
const alerts = ref([]);
const showAlertModal = ref(false);
const loading = ref(false);
const error = ref('');
const historySeries = ref([]);
const anomalies = ref([]);
let metricsRequestId = 0;

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

const metricTypes = [
  { key: 'cpu', label: 'CPU', icon: Cpu, color: 'text-cyan-400', chartColor: '#06B6D4', unit: '%' },
  { key: 'memory', label: '内存', icon: Database, color: 'text-emerald-400', chartColor: '#10B981', unit: '%' },
  { key: 'network', label: '网络', icon: Network, color: 'text-amber-400', chartColor: '#F59E0B', unit: 'bytes' },
  { key: 'disk', label: '磁盘 I/O', icon: HardDrive, color: 'text-rose-400', chartColor: '#EF4444', unit: 'bytes' }
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
  if (trend === 'increasing') return 'text-rose-400';
  if (trend === 'decreasing') return 'text-emerald-400';
  return 'text-zinc-500';
}

function getAlertColor(metric) {
  const colors = {
    cpu: 'text-cyan-400',
    memory: 'text-emerald-400',
    restart_count: 'text-amber-400'
  };
  return colors[metric] || 'text-zinc-400';
}

function onProjectChange() {
  containerId.value = '';
  metricsData.value = null;
  historySeries.value = [];
  anomalies.value = [];
  error.value = '';
}

async function loadProjects() {
  try {
    projects.value = ((await api.getProjects()).projects || []).filter(p => p.managed);
    if (projects.value.length === 1 && !projectId.value) {
      projectId.value = projects.value[0].id;
    }
  } catch (err) {
    error.value = `加载项目失败: ${err.message}`;
  }
}

async function loadMetrics() {
  if (!containerId.value) return;
  const requestId = ++metricsRequestId;
  loading.value = true;
  error.value = '';
  try {
    const endTime = Date.now();
    const startTime = endTime - periodMs(period.value);
    const results = await Promise.all(
      metricTypes.map(m => metricsApi.getContainerMetrics(containerId.value, m.key, period.value))
    );
    const [seriesResult, anomalyResult] = await Promise.all([
      metricsApi.getHistoricalMetrics({ containerId: containerId.value, metricType: backendMetric(selectedMetric.value), startTime, endTime, aggregation: 'auto' }),
      metricsApi.detectAnomalies({ containerId: containerId.value, metricType: backendMetric(selectedMetric.value), startTime, endTime }),
    ]);
    if (requestId !== metricsRequestId) return;
    metricsData.value = {};
    metricTypes.forEach((m, i) => {
      metricsData.value[m.key] = results[i].data;
    });
    historySeries.value = (seriesResult.metrics || []).map((item) => ({ timestamp: Number(item.timestamp), value: Number(item.value) })).filter((item) => Number.isFinite(item.timestamp) && Number.isFinite(item.value));
    anomalies.value = anomalyResult.anomalies || [];
  } catch (err) {
    if (requestId === metricsRequestId) {
      historySeries.value = [];
      anomalies.value = [];
      error.value = `加载指标失败: ${err.message}`;
    }
  } finally {
    if (requestId === metricsRequestId) loading.value = false;
  }
}

async function loadAlerts() {
  try {
    const res = await metricsApi.getAlerts();
    alerts.value = res.alerts || [];
  } catch (err) {
    error.value = `加载告警失败: ${err.message}`;
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
    useToastStore().error(`创建告警规则失败:${err.message}`);
  }
}

async function deleteAlertRule(ruleId) {
  try {
    await metricsApi.deleteAlert(ruleId);
    await loadAlerts();
    useToastStore().success('告警规则已删除');
  } catch (err) {
    useToastStore().error(`删除告警失败:${err.message}`);
  }
}

onMounted(async () => {
  await loadProjects();
  await loadAlerts();
  window.addEventListener('composeops:host-changed', onHostChanged);
});

function onHostChanged() {
  projectId.value = '';
  containerId.value = '';
  metricsData.value = null;
  historySeries.value = [];
  anomalies.value = [];
  alerts.value = [];
  void loadProjects();
  void loadAlerts();
}

onBeforeUnmount(() => window.removeEventListener('composeops:host-changed', onHostChanged));

watch(selectedMetric, () => { if (containerId.value) void loadMetrics(); });
</script>

<style scoped>
 .resource-monitor-view { min-height: 0; }

.metric-card {
  padding: 1rem;
  background: #09090b;
  border: 1px solid #27272a;
  border-radius: 0.75rem;
  cursor: pointer;
  transition: all 0.2s;
}

.metric-card:hover {
  border-color: #3f3f46;
  background: #18181b;
}

.metric-card-active {
  border-color: #10b981;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.05), rgba(6, 182, 212, 0.05));
}

.chart-container {
  height: 300px;
  background: #09090b;
  border-radius: 0.5rem;
  padding: 1rem;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  backdrop-filter: blur(4px);
}

.modal-content {
  width: 100%;
  max-width: 28rem;
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 0.75rem;
  padding: 1.5rem;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
}
</style>
