<template>
  <div class="page-shell monitor-workspace">
    <div class="page-header">
      <div><h1 class="page-title">实时监控</h1><p class="page-subtitle">查看资源变化，沿着容器继续排查。</p></div>
      <div class="page-actions">
        <select v-model="hostFilter" class="input w-auto" aria-label="监控节点"><option value="">当前工作节点</option><option value="all">全部节点</option><option v-for="host in availableHosts" :key="host.id" :value="host.id">{{ host.name }}</option></select>
        <template v-if="tab === 'live'"><label class="toggle-label"><input v-model="autoRefresh" type="checkbox" />自动刷新</label><button class="btn-secondary" :disabled="loading" @click="refresh"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button></template>
      </div>
    </div>
    <div class="monitor-view-bar">
      <div class="tabs-segment" role="tablist" aria-label="监控视图" @keydown="handleTabKeydown">
        <button id="monitor-tab-live" data-tab="live" :class="{ active: tab === 'live' }" role="tab" aria-controls="monitor-panel" :aria-selected="tab === 'live'" :tabindex="tab === 'live' ? 0 : -1" @click="setTab('live')"><ChartNoAxesCombined class="h-4 w-4" />实时</button>
        <button id="monitor-tab-history" data-tab="history" :class="{ active: tab === 'history' }" role="tab" aria-controls="monitor-panel" :aria-selected="tab === 'history'" :tabindex="tab === 'history' ? 0 : -1" @click="setTab('history')"><Activity class="h-4 w-4" />历史指标</button>
      </div>
      <span v-if="tab === 'live'" class="monitor-refresh-state"><span class="status-dot" :class="autoRefresh ? 'bg-status-ok' : 'bg-surface-400'"></span>{{ autoRefresh ? '自动更新' : '已暂停自动刷新' }}<span v-if="lastUpdated"> · {{ lastUpdated }}</span></span>
    </div>
    <section id="monitor-panel" class="space-y-4" role="tabpanel" :aria-labelledby="`monitor-tab-${tab}`" tabindex="0">
      <template v-if="tab === 'live'">
        <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
        <section class="monitor-environment" :class="{ 'is-expanded': environmentExpanded }" aria-label="面板运行环境">
          <header class="monitor-section-heading"><div><h2 class="section-title"><Server class="h-4 w-4" />面板运行环境</h2><p class="text-muted mt-1">{{ scopeLabel }} · 固定来自面板所在环境，不随节点筛选切换</p></div><div class="flex items-center gap-3"><button v-if="data && environmentExpanded" class="text-link" @click="resetTrends">重置趋势</button><button class="btn-secondary btn-sm" :aria-expanded="environmentExpanded" aria-controls="panel-environment-metrics" @click="environmentExpanded = !environmentExpanded">{{ environmentExpanded ? '收起指标' : '展开指标' }}<ChevronDown class="h-3.5 w-3.5 monitor-disclosure" :class="{ 'rotate-180': environmentExpanded }"/></button></div></header>
          <div id="panel-environment-metrics" v-show="environmentExpanded">
          <Skeleton v-if="loading && !data" variant="cards" :rows="4" label="监控数据加载中" />
          <div v-if="data" class="grid grid-cols-2 xl:grid-cols-4 gap-3"><MetricTile title="环境 CPU" :value="`${data.host.cpu.percent}%`" :sub="`${data.host.cpu.cores} 核 · Load ${numberValue(data.host.cpu.loadavg?.[0]).toFixed(2)}`" tone="text-sky-400" :trend="trends.cpu"/><MetricTile title="环境内存" :value="formatBytes(data.host.memory.used)" :sub="`${data.host.memory.percent}% / ${formatBytes(data.host.memory.total)}`" tone="text-status-ok" :trend="trends.mem"/><MetricTile title="网络速率" :value="`↓ ${formatRate(data.network.rx)}`" :sub="`↑ ${formatRate(data.network.tx)}`" tone="text-violet-400" :trend="trends.net"/><MetricTile title="运行时间" :value="formatUptime(data.host.uptime)" sub="面板环境持续运行时长"/></div>
          <div v-if="data" class="monitor-thresholds"><span>环境阈值</span><span>CPU ≥ {{ alertThresholds.cpu }}%</span><span>内存 ≥ {{ alertThresholds.mem }}%</span><strong v-if="crossedThreshold" class="text-status-error">当前已超出阈值</strong></div>
          </div>
        </section>
        <section class="section-panel monitor-containers" aria-label="容器资源">
          <header class="monitor-section-heading"><div><h2 class="section-title"><Boxes class="h-4 w-4" />容器资源<span class="monitor-scope-label">{{ dockerScopeLabel }}</span></h2><p class="text-muted mt-1">CPU、内存与镜像 · 点击日志继续排查</p></div><span v-if="data || visibleContainers.length" class="count-badge">{{ visibleContainers.length }} 个容器<span v-if="!data"> · 指标加载中</span></span><span v-else class="count-badge" role="status">{{ loading ? '正在加载容器…' : '数据暂不可用' }}</span></header>
          <div class="monitor-toolbar"><label class="search-field"><Search class="h-4 w-4"/><input v-model="searchQuery" type="search" aria-label="搜索容器" placeholder="搜索名称、镜像或节点" /></label><select v-model="sortBy" class="input w-auto" aria-label="容器排序"><option value="memory">内存从高到低</option><option value="cpu">CPU 从高到低</option><option value="name">按容器名称</option></select><button v-if="searchQuery || route.query.containerId" class="btn-secondary btn-sm" @click="clearContainerFilter"><X class="h-3.5 w-3.5" />清除筛选</button></div>
          <div v-if="route.query.containerId" class="filter-summary mb-3">正在查看指定容器 <code>{{ String(route.query.containerId).slice(0, 12) }}</code></div>
          <EmptyState v-if="!visibleContainers.length && (data || searchQuery || route.query.containerId)" compact icon="Search" :title="searchQuery || route.query.containerId ? '没有匹配的容器' : '暂无容器指标'" :description="searchQuery || route.query.containerId ? '容器可能已停止或移除，也可以清除筛选查看其他容器。' : '当前范围暂无运行容器指标，可以前往服务页查看状态。'"><button v-if="searchQuery || route.query.containerId" class="btn-secondary btn-sm" @click="clearContainerFilter">查看全部容器</button><router-link v-else :to="servicesLink" class="btn-secondary btn-sm">查看服务</router-link></EmptyState>
          <div v-else class="table-wrap"><table class="data-table monitor-table"><thead><tr><th>容器 / 镜像</th><th class="text-right">CPU</th><th class="text-right">内存</th><th>内存占用</th><th class="text-right">继续排查</th></tr></thead><tbody><tr v-for="c in visibleContainers" :key="`${c.hostId}:${c.id}`">
            <td class="monitor-container-identity"><strong :title="c.name">{{ c.name }}</strong><span class="text-muted" :title="c.image">{{ c.image || '镜像未知' }}</span><div class="monitor-container-context"><span v-if="c.hostName" class="monitor-host-label">{{ c.hostName }}</span><SparklineChart v-if="histories[`${c.hostId}:${c.id}`]?.cpu.length > 1" :cpu="histories[`${c.hostId}:${c.id}`]?.cpu || []" :mem="histories[`${c.hostId}:${c.id}`]?.mem || []" :width="72" :height="20" /></div></td>
            <td class="monitor-number" data-label="CPU" :class="c.cpuPercent >= 85 ? 'text-status-error' : ''">{{ metricPercent(c, 'cpuPercent') }}</td>
            <td class="monitor-number" data-label="内存">{{ c.metricsPending || c.memUsage == null ? '—' : formatBytes(c.memUsage) }}</td>
            <td class="monitor-memory"><div class="progress" :class="c.memPercent >= 90 ? 'progress-danger' : 'progress-muted'"><span :style="{ width: `${c.metricsPending ? 0 : Math.max(0, Math.min(100, numberValue(c.memPercent)))}%` }"></span></div><span class="text-muted">{{ c.metricsPending ? '等待指标' : metricPercent(c, 'memPercent') }}</span></td>
            <td class="monitor-row-actions"><router-link v-if="projectFor(c)" :to="containerLink('/logs', c)" class="btn-secondary btn-sm" :aria-label="`查看 ${c.name} 日志`"><FileText class="h-3.5 w-3.5"/>日志</router-link><router-link v-else :to="containerLink('/services', c)" class="btn-secondary btn-sm" :aria-label="`查看 ${c.name} 所在节点服务`">服务</router-link><button class="icon-btn icon-btn-sm" :aria-label="`查看 ${c.name} 历史指标`" title="历史指标" @click="openHistory(c)"><ChartNoAxesCombined class="h-4 w-4"/></button></td>
          </tr></tbody></table></div>
        </section>
        <section v-if="usage" class="section-panel"><header class="monitor-section-heading"><div><h2 class="section-title"><HardDrive class="h-4 w-4"/>Docker 存储<span class="monitor-scope-label">{{ dockerScopeLabel }}</span></h2><p class="mt-1 text-muted">{{ hostFilter === 'all' ? '各节点存储用量相加，包含各自持有的镜像副本' : '所选 Docker 节点的镜像、缓存与可回收空间' }}</p></div><router-link :to="deepLink('/resources', { hostId: hostFilter === 'all' ? undefined : hostFilter, from: 'monitor' })" class="text-link">{{ hostFilter === 'all' ? '管理当前节点资源' : '管理资源' }}<ArrowUpRight class="h-3.5 w-3.5"/></router-link></header><p v-if="usage.unavailableHosts?.length" class="scope-callout mb-3" role="status">部分统计：{{ unavailableStorageNames }} 未返回数据，以下合计不包含这些节点。</p><div class="grid sm:grid-cols-3 gap-3"><MetricTile title="镜像" :value="formatBytes(usage.images.total)" :sub="`可回收 ${formatBytes(usage.images.reclaimable)}`"/><MetricTile title="构建缓存" :value="formatBytes(usage.buildCache.total)" :sub="`可回收 ${formatBytes(usage.buildCache.reclaimable)}`"/><MetricTile title="总计可回收" :value="formatBytes(usage.reclaimable)" sub="清理前可在资源页预览"/></div></section>
      </template>
      <template v-else>
        <p v-if="historyError" class="alert-error" role="alert">{{ historyError }}</p>
        <EmptyState v-if="hostFilter === 'all'" icon="Server" title="选择一个节点查看历史" description="历史曲线和告警按工作节点读取，请在上方选择具体节点。" />
        <EmptyState v-else-if="hostFilter && hostFilter !== hostsStore.activeHostId" icon="Activity" :title="`查看 ${dockerScopeLabel} 的历史指标`" description="历史曲线和告警需要进入该节点工作区。"><button class="btn-primary" :disabled="historySwitching" @click="activateHistoryHost">{{ historySwitching ? '正在切换…' : '切换工作节点并查看历史' }}</button></EmptyState>
        <template v-else><div class="scope-callout"><span class="scope-callout-dot"></span>历史指标与告警 · {{ hostsStore.active?.name || '当前工作节点' }}</div><ResourceMonitorView :key="hostsStore.activeHostId" embedded :initial-project-id="String(route.query.projectId || '')" :initial-container-id="String(route.query.containerId || '')" /></template>
      </template>
    </section>
  </div>
</template>
<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'; import { useRoute, useRouter } from 'vue-router'; import { Activity, ArrowUpRight, Boxes, ChartNoAxesCombined, ChevronDown, FileText, HardDrive, RefreshCw, Search, Server, X } from 'lucide-vue-next'; import { api } from '../api/client.js'; import MetricTile from '../components/common/MetricTile.vue'; import SparklineChart from '../components/common/SparklineChart.vue'; import Skeleton from '../components/common/Skeleton.vue'; import EmptyState from '../components/common/EmptyState.vue'; import ResourceMonitorView from './ResourceMonitorView.vue'; import { monitorTrends, pushMonitorTrend, resetMonitorTrends } from '../lib/monitor-trends.js';
import { handleTablistKeydown } from '../lib/tablist-keyboard.js';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useServicesStore } from '../stores/services.js';
import { useHostsStore } from '../stores/hosts.js';
import { deepLink } from '../lib/deep-links.js';
const environmentExpanded = ref(false);
const route = useRoute();
const router = useRouter();
const tab = ref(route.query.tab === 'history' ? 'history' : 'live');
function handleTabKeydown(event) { handleTablistKeydown(event, setTab); }
function setTab(next) {
  tab.value = next;
  const query = { ...route.query };
  if (next === 'history') query.tab = 'history'; else delete query.tab;
  router.replace({ query });
}
watch(() => route.query.tab, (value) => { tab.value = value === 'history' ? 'history' : 'live'; });
const data = ref(null); const usage = ref(null); const capabilities = ref({}); const autoRefresh = ref(true); const error = ref(''); const loading = ref(false); const lastUpdated = ref(''); const intervalMs = ref(5000); const histories = ref({}); const trends = monitorTrends; const crossedThreshold = ref(false); let timer;
const hostFilter = computed({ get: () => String(route.query.hostId || ''), set: value => {
  const query = { ...route.query };
  if (value) query.hostId = value; else delete query.hostId;
  delete query.containerId; delete query.projectId;
  void router.replace({ query });
} });
const hostsStore = useHostsStore();
const servicesStore = useServicesStore();
const availableHosts = computed(() => hostsStore.hosts);
const selectedHostId = computed(() => hostFilter.value || hostsStore.activeHostId);
const dockerScopeLabel = computed(() => hostFilter.value === 'all' ? '全部节点' : availableHosts.value.find(h => h.id === selectedHostId.value)?.name || selectedHostId.value);
const unavailableStorageNames = computed(() => (usage.value?.unavailableHosts || []).map(id => availableHosts.value.find(h => h.id === id)?.name || id).join('、'));
const servicesLink = computed(() => deepLink('/services', { hostId: hostFilter.value === 'all' ? undefined : selectedHostId.value, from: 'monitor' }));
function queryModel(key, fallback = '') { return computed({ get: () => String(route.query[key] || fallback), set: value => { const query = { ...route.query }; if (value && value !== fallback) query[key] = value; else delete query[key]; void router.replace({ query }); } }); }
const searchQuery = queryModel('q');
const sortBy = queryModel('sort', 'memory');
const staticContainers = computed(() => servicesStore.projects
  .filter(project => selectedHostId.value === 'all' || (project.hostId || 'local') === selectedHostId.value)
  .flatMap(project => (project.containers || []).map(container => ({ ...container, hostId: project.hostId || 'local', hostName: project.hostName, metricsPending: true }))));
const visibleContainers = computed(() => (data.value?.containers || staticContainers.value)
  .filter(c => (!route.query.containerId || c.id === route.query.containerId) && `${c.name} ${c.image || ''} ${c.hostName || ''}`.toLocaleLowerCase().includes(searchQuery.value.trim().toLocaleLowerCase()))
  .slice().sort((a, b) => sortBy.value === 'name' ? String(a.name).localeCompare(String(b.name), 'zh-CN') : numberValue(b[sortBy.value === 'cpu' ? 'cpuPercent' : 'memUsage']) - numberValue(a[sortBy.value === 'cpu' ? 'cpuPercent' : 'memUsage'])));
function clearContainerFilter() { const query = { ...route.query }; delete query.q; delete query.containerId; delete query.projectId; void router.replace({ query }); }
function metricPercent(container, key) { return container.metricsPending || !Number.isFinite(container[key]) ? '—' : `${container[key]}%`; }
function projectFor(container) { return servicesStore.projects.find(p => p.managed !== false && (p.hostId || 'local') === (container.hostId || selectedHostId.value) && p.containers?.some(c => c.id === container.id)); }
function containerLink(path, container) { const project = projectFor(container); return deepLink(path, { hostId: container.hostId || selectedHostId.value, projectId: project?.id, containerId: path === '/logs' ? container.id : undefined, from: 'monitor' }); }
function openHistory(container) { void router.replace({ query: { ...route.query, tab: 'history', hostId: container.hostId || selectedHostId.value, projectId: projectFor(container)?.id, containerId: container.id } }); }
const historySwitching = ref(false);
const historyError = ref('');
async function activateHistoryHost() {
  if (historySwitching.value || !hostFilter.value || hostFilter.value === 'all') return;
  historySwitching.value = true; historyError.value = '';
  try { await hostsStore.switchHost(hostFilter.value); }
  catch (cause) { historyError.value = cause.message; }
  finally { historySwitching.value = false; }
}
watch(hostFilter, onHostChanged);
const alertThresholds = { cpu: 85, mem: 90 };
let mounted = false;
let requestId = 0;
const scopeLabel = computed(() => capabilities.value.hostMetricsScope === 'host' ? '面板所在宿主机' : 'ComposeOps 运行环境');
async function refresh() {
  if (!mounted || tab.value !== 'live' || loading.value) return;
  const currentRequest = ++requestId;
  loading.value = true;
  const errors = [];
  const isCurrent = () => mounted && currentRequest === requestId;
  const metricRequest = api.getMetrics(hostFilter.value).then(result => {
    if (!isCurrent()) return;
    data.value = result;
    const unavailable = (result.hosts || []).filter(host => !host.ok);
    if (unavailable.length) errors.push(`节点暂不可达：${unavailable.map(host => host.name).join('、')}`);
    accumulate();
    lastUpdated.value = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  }).catch(cause => {
    if (!isCurrent()) return;
    data.value = null; lastUpdated.value = ''; crossedThreshold.value = false;
    errors.push(`实时指标加载失败：${cause?.message || '请重试'}`);
  }).finally(() => { if (isCurrent()) error.value = errors.join('；'); });
  const usageRequest = api.getDockerUsage(hostFilter.value).then(result => { if (isCurrent()) usage.value = result; }).catch(cause => {
    if (!isCurrent()) return;
    usage.value = null;
    errors.push(`Docker 存储加载失败：${cause?.message || '请重试'}`);
  }).finally(() => { if (isCurrent()) error.value = errors.join('；'); });
  await Promise.allSettled([metricRequest, usageRequest]);
  if (isCurrent()) loading.value = false;
}

function accumulate() {
  const next = {};
  for (const c of data.value?.containers || []) {
    const prev = histories.value[`${c.hostId}:${c.id}`] || { cpu: [], mem: [] };
    prev.cpu = [...prev.cpu, c.cpuPercent].slice(-96);
    prev.mem = [...prev.mem, c.memPercent].slice(-96);
    next[`${c.hostId}:${c.id}`] = prev;
  }
  histories.value = next;
  if (data.value) {
    const rx = data.value.network?.rx || 0;
    pushMonitorTrend({ cpu: data.value.host.cpu.percent, mem: data.value.host.memory.percent, net: Math.max(0, Math.round((rx / 1024 / 1024) * 100) / 100) });
    crossedThreshold.value = data.value.host.cpu.percent >= alertThresholds.cpu || data.value.host.memory.percent >= alertThresholds.mem;
  }
}
function setTimer() {
  clearInterval(timer);
  timer = undefined;
  if (mounted && tab.value === 'live' && autoRefresh.value) timer = setInterval(refresh, intervalMs.value);
}
function numberValue(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; } function formatBytes(value = 0) { const units = ['B','KB','MB','GB','TB']; let n = numberValue(value), i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${units[i]}`; } function formatRate(n) { return `${formatBytes(n)}/s`; } function formatUptime(s) { const d = Math.floor(numberValue(s) / 86400), h = Math.floor((numberValue(s) % 86400) / 3600), m = Math.floor((numberValue(s) % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
watch([autoRefresh, intervalMs], setTimer);
function invalidateRequest() { requestId += 1; loading.value = false; }
function onHostChanged() {
  invalidateRequest();
  data.value = null;
  usage.value = null;
  lastUpdated.value = '';
  error.value = '';
  historyError.value = '';
  crossedThreshold.value = false;
  histories.value = {};
  resetMonitorTrends();
  void refresh();
}
function resetTrends() { resetMonitorTrends(); }
async function loadPreferences() {
  const [caps, prefs] = await Promise.allSettled([api.getCapabilities(), api.getPreferences()]);
  if (!mounted) return;
  if (caps.status === 'fulfilled') capabilities.value = caps.value;
  const seconds = prefs.status === 'fulfilled' ? Number(prefs.value?.refreshInterval) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) intervalMs.value = Math.max(1, seconds) * 1000;
}
// 只在「实时」tab 响应:历史指标 tab 由嵌入的 ResourceMonitorView 自己刷新。
usePullRefresh(refresh, { enabled: () => tab.value === 'live' });
onMounted(() => {
  mounted = true;
  window.addEventListener('composeops:host-changed', onHostChanged);
  if (!servicesStore.lastLoadedAt) void servicesStore.refresh();
  if (!hostsStore.hosts.length) void hostsStore.load();
  void loadPreferences();
  void refresh();
  setTimer();
});
watch(tab, () => {
  invalidateRequest();
  setTimer();
  void refresh();
});
onUnmounted(() => { mounted = false; invalidateRequest(); clearInterval(timer); window.removeEventListener('composeops:host-changed', onHostChanged); });
</script>
