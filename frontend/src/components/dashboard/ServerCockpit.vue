<template>
  <section ref="root" class="server-cockpit" :class="{ 'cockpit-fullscreen': fullscreen }" aria-label="服务器驾驶舱">
    <header class="cockpit-heading">
      <div><h2><Server :size="18" />服务器资源</h2><p>{{ selectedNode?.name || '节点概览' }} · {{ scopeLabel }}<span v-if="selectedNode?.host?.sampledAt"> · 采样于 {{ time(selectedNode.host.sampledAt) }}</span></p></div>
      <div class="cockpit-controls"><select v-model="hostId" class="input" aria-label="监控节点"><option v-for="host in hosts.hosts" :key="host.id" :value="host.id">{{ host.name }}</option><option value="all">全部节点</option></select><button class="btn-secondary btn-sm" :aria-pressed="fullscreen" @click="toggleFullscreen"><component :is="fullscreen ? Minimize : Maximize" :size="15" />{{ fullscreen ? '退出大屏' : '大屏' }}</button></div>
    </header>
    <p v-if="error" class="alert-error" role="alert">{{ error }}<button class="text-link ml-2" @click="refresh">重试</button></p>
    <div v-if="hostId === 'all'" class="cockpit-nodes">
      <button v-for="node in snapshot?.nodes || []" :key="node.hostId" class="cockpit-node" @click="hostId = node.hostId"><strong>{{ node.name }}</strong><span :class="node.status === 'ready' ? 'text-status-ok' : 'text-status-warn'">{{ node.status === 'ready' ? 'Docker 已连接' : node.status === 'pending' ? '等待采样' : node.status === 'unavailable' ? '节点不可达' : '数据陈旧' }}</span><small>CPU {{ metricValue(node.host?.cpu?.percent) }} · 内存 {{ metricValue(node.host?.memory?.percent) }}</small><small>{{ node.status === 'ready' && node.host?.status === 'ready' ? '宿主采集正常' : node.host?.reason || '宿主指标未接入' }}</small><span class="text-link">进入节点 →</span></button>
    </div>
    <template v-else>
      <p v-if="loading && !selectedNode" class="text-muted" role="status">正在读取采样…</p>
      <div v-if="selectedNode && !hostReady" class="scope-callout" role="status"><AlertTriangle :size="16" /><span>{{ selectedNode.status === 'stale' ? '节点连接中断，以下是最后一次采样。' : selectedNode.host?.reason || '宿主指标未接入。' }}<span v-if="selectedNode.host?.status === 'stale'"> 指标已陈旧。</span></span><router-link to="/settings?tab=hosts" class="text-link">节点设置</router-link></div>
      <div class="cockpit-metrics">
        <button v-for="tile in tiles" :key="tile.key" class="cockpit-metric" :class="{ 'is-warning': tile.warning }" :aria-pressed="metric === tile.key && (resource === 'host' || resource.startsWith('disk:'))" @click="selectMetric(tile.key)"><span><component :is="tile.icon" :size="16" />{{ tile.label }}</span><strong>{{ tile.value }}</strong><small>{{ tile.sub }}</small><span v-if="!hostReady" class="cockpit-stale">{{ selectedNode?.host?.sampledAt ? '最后采样' : '未接入' }}</span></button>
      </div>
      <section class="section-panel cockpit-detail" aria-label="资源指标详情"><header><h3>{{ detailTitle }}</h3><span>{{ resource === 'host' || resource.startsWith('disk:') ? '整机范围，不随项目分组筛选变化' : '所选服务范围' }}</span></header><p v-if="resourceMissing" role="status">该资源已不在当前节点采样中，历史趋势仍可查询。<button class="text-link ml-2" @click="selectMetric(metric)">查看宿主资源</button></p><dl v-else><div v-for="item in detailItems" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div></dl><p v-if="!resourceMissing">{{ detailNote }}</p></section>
      <div class="cockpit-middle">
        <section class="section-panel cockpit-chart"><header><div><h3>{{ chartLabel }}</h3><button v-if="resource !== 'host'" class="text-link text-xs" @click="selectMetric(metric)">返回宿主趋势</button></div><div class="cockpit-controls"><select v-if="directionOptions.length" v-model="direction" class="input" aria-label="趋势指标方向"><option v-for="option in directionOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select><select v-model="hours" class="input" aria-label="趋势时间范围"><option v-for="period in resourcePeriods" :key="period.value" :value="String(period.value)">{{ period.label }}</option></select></div></header><p v-if="historyError" class="alert-error" role="alert">{{ historyError }}<button class="text-link ml-2" :disabled="historyLoading" @click="loadHistory">重试趋势</button></p><p v-if="historyLoading" class="text-muted text-xs" role="status">更新趋势中…</p><ResourceTrend :points="history.points" :interval="history.interval" :start="history.start" :end="history.end" :label="chartLabel" :unit="chartUnit" /></section>
        <section class="section-panel cockpit-attention"><h3>资源关注</h3><div v-if="selectedNode?.alerts?.length" class="cockpit-alerts"><button v-for="alert in selectedNode.alerts" :key="alert.key" @click="selectAlert(alert)"><AlertTriangle :size="15" /><span><strong>{{ alert.title }}</strong><small>{{ alert.detail }} · {{ alert.sustained ? '持续超限，已进入事件中心' : '短时超限，持续观察' }}</small></span><ChevronRight :size="14" /></button></div><p v-else class="text-muted">{{ hostReady ? '当前没有资源阈值超限；服务故障见下方需要处理。' : '接入有效宿主采样后显示资源状态。' }}</p><div class="cockpit-facts"><span>Docker 容器 {{ runningCount }} / {{ selectedNode?.containers?.length ?? '—' }} 运行</span><span>容器内存小计 {{ bytes(containerMemory) }}</span><span v-if="selectedNode?.host?.memory">Swap {{ bytes(selectedNode.host.memory.swapUsed) }} / {{ bytes(selectedNode.host.memory.swapTotal) }}</span><small>容器小计不等于整机总用量</small></div></section>
      </div>
      <section ref="storageElement" v-if="metric === 'disk'" class="section-panel cockpit-storage">
        <header><h3><HardDrive :size="16" />文件系统与关联服务</h3><router-link :to="{ path: '/resources', query: { hostId, from: 'dashboard', returnTo: returnLocation } }" class="text-link">Docker 存储管理 →</router-link></header>
        <p class="text-muted text-xs mb-3">真实文件系统去重；容量与读写速率分别统计。共享卷与镜像不重复归属，挂载关联不代表该服务独占空间。</p>
        <p v-if="storageError" class="alert-error" role="alert">{{ storageError }}<button class="text-link ml-2" :disabled="loading" @click="refresh">重试</button></p>
        <p v-if="!disks.length" class="text-muted">暂无可读取的宿主文件系统数据。</p>
        <article v-for="disk in disks" :key="disk.device + disk.type" class="cockpit-disk"><div class="cockpit-disk-heading"><button class="text-link" @click="selectDisk(disk)">{{ disk.mountpoint }} · {{ disk.type }}</button><span>{{ bytes(disk.used) }} / {{ bytes(disk.total) }} · 可用 {{ bytes(disk.free) }}</span></div><div class="progress" :class="disk.percent >= 85 ? 'progress-danger' : 'progress-muted'"><span :style="{ width: `${Math.min(100, disk.percent || 0)}%` }"></span></div><div class="cockpit-disk-meta"><span>已用 {{ metricValue(disk.percent) }}</span><span>inode {{ metricValue(disk.inodePercent) }}</span><span>读 {{ rate(disk.readRate) }} · 写 {{ rate(disk.writeRate) }}</span></div><p v-if="disk.forecast" class="text-status-warn text-xs">估计约 {{ disk.forecast.hours }} 小时后耗尽 · {{ disk.forecast.label }}</p><details v-if="disk.services?.length"><summary>{{ disk.services.length }} 项挂载关联 · 查看服务</summary><div v-for="item in disk.services" :key="item.key" class="cockpit-mount"><span><strong>{{ item.volume || item.source }}</strong><small>{{ item.projectName || '独立容器' }} / {{ item.service || item.containerName }}</small></span><router-link :to="focusLink({ ...item, hostId })" class="text-link">定位服务 →</router-link></div></details><p v-else class="text-muted text-xs">未发现容器挂载关联；可能由系统或其他进程使用。</p></article>
      </section>
      <section class="section-panel cockpit-ranking" @mouseenter="freezeOrder" @mouseleave="unfreezeOrder" @focusin="freezeOrder" @focusout="releaseFocus">
        <header><div><h3>项目与服务资源</h3><p>{{ selectedNode?.status === 'stale' ? '最后一次采样（已陈旧）' : '当前采样' }} · CPU 按整机容量归一化 · 内存为实际工作集</p></div><div class="cockpit-controls"><label class="search-field"><Search :size="14" /><input v-model="query" type="search" aria-label="搜索资源排行" placeholder="搜索分组、项目或服务" /></label><select v-model="groupFilter" class="input" aria-label="资源项目分组"><option value="">全部分组</option><option value="ungrouped">未分组</option><option v-for="group in snapshot?.groups || []" :key="group.id" :value="group.id">{{ group.name }}</option></select><select v-model="managementScope" class="input" aria-label="资源纳管范围"><option value="all">全部发现</option><option value="managed">仅已纳管</option></select><select v-model="sort" class="input" aria-label="资源排行排序"><option value="cpu">CPU</option><option value="memory">内存</option><option value="network">网络接收</option><option value="disk">磁盘写入</option></select><button v-if="filtering" class="btn-ghost btn-sm" @click="clearFilters">清除筛选</button></div></header>
        <p v-if="!projects.length" class="text-muted py-4">{{ filtering ? '当前筛选下没有匹配的项目或服务，可清除筛选查看全部。' : '暂无容器数据；采样完成后显示资源排行。' }}</p>
        <ResourceHierarchy :projects="projects" :definitions="snapshot?.groups || []" :expanded="expanded" :collapsed-groups="collapsedGroups" :searching="!!query.trim()" :focus-link="focusLink" :log-link="logLink" @toggle-project="toggleProject" @toggle-group="toggleGroup" @trend="viewServiceHistory" />
      </section>
      <p class="cockpit-footer">{{ hostReady ? '宿主采集正常' : '宿主指标待确认' }} · 后台统一采样 · 切离页面暂停刷新<span v-if="orderFrozen"> · 操作期间保持排行顺序</span></p>
    </template>
  </section>
</template>

<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AlertTriangle, ChevronRight, Cpu, HardDrive, Maximize, MemoryStick, Minimize, Network, Search, Server } from 'lucide-vue-next';
import { useEscapeKey } from '../../composables/useEscapeKey.js';
import { api } from '../../api/client.js';
import { useHostsStore } from '../../stores/hosts.js';
import { formatResourceBytes as bytes, metricValue, rankProjects, resourcePeriods, serviceFocusLocation } from '../../lib/infrastructure.js';
import ResourceTrend from './ResourceTrend.vue';
import ResourceHierarchy from './ResourceHierarchy.vue';
import { useResourceTree } from '../../composables/useResourceTree.js';

const route = useRoute(), router = useRouter(), hosts = useHostsStore();
const root = ref(null), storageElement = ref(null), fullscreen = ref(false), snapshot = ref(null), loading = ref(false), error = ref(''), historyError = ref(''), historyLoading = ref(false), storage = ref(null), storageError = ref('');
const history = ref({ points: [], start: Date.now() - 3600000, end: Date.now(), interval: 10000 });
function queryValue(key, fallback) { return computed({ get: () => {
  const defaultValue = typeof fallback === 'function' ? fallback() : fallback;
  const value = typeof route.query[key] === 'string' ? route.query[key] : defaultValue;
  const allowed = key === 'hours' ? resourcePeriods.map(p => String(p.value)) : ['metric', 'sort'].includes(key) ? ['cpu', 'memory', 'disk', 'network'] : null;
  return String(allowed && !allowed.includes(value) ? defaultValue : value);
}, set: value => { const query = { ...route.query }; query[key] = String(value); void router.replace({ query }); } }); }
const hostId = queryValue('hostId', () => hosts.activeHostId), metric = queryValue('metric', 'cpu'), hours = queryValue('hours', '1'), sort = queryValue('sort', 'cpu'), query = queryValue('q', ''), resource = queryValue('resource', 'host');
const groupFilter = queryValue('group', ''), managementScope = queryValue('scope', 'all');
const { expanded, collapsedGroups, toggleProject, toggleGroup } = useResourceTree(hostId, 'dashboard');
const returnLocation = computed(() => route.fullPath);
const selectedNode = computed(() => snapshot.value?.nodes.find(node => node.hostId === hostId.value));
const hostReady = computed(() => selectedNode.value?.status === 'ready' && selectedNode.value?.host?.status === 'ready');
const scopeLabel = computed(() => selectedNode.value?.host?.scope === 'wsl' ? 'WSL Linux 环境（不含 Windows 整机）' : selectedNode.value?.host?.scope === 'linux' ? 'Linux 宿主机' : '宿主采集待接入');
const disks = computed(() => (selectedNode.value?.host?.disks || []).map(disk => ({ ...disk, forecast: !storageError.value && storage.value?.hostId === hostId.value ? storage.value.disks.find(d => d.device === disk.device && d.type === disk.type)?.forecast : null })));
const worstDisk = computed(() => [...disks.value].sort((a, b) => (b.percent || 0) - (a.percent || 0))[0]);
const runningCount = computed(() => selectedNode.value?.containers.filter(c => c.state === 'running').length ?? 0);
const containerMemory = computed(() => { const list = selectedNode.value?.containers.filter(c => c.state === 'running') || []; return list.length && list.every(c => c.memUsage != null) ? list.reduce((n, c) => n + c.memUsage, 0) : null; });
const rate = value => metricValue(value, 'bytes/s');
const tiles = computed(() => { const host = selectedNode.value?.host; return [
  { key: 'cpu', icon: Cpu, label: 'CPU', value: metricValue(host?.cpu?.percent), sub: `${host?.cpu?.cores || selectedNode.value?.engine?.cpus || '—'} 核 · 整机占比`, warning: host?.cpu?.percent >= 90 },
  { key: 'memory', icon: MemoryStick, label: '内存', value: metricValue(host?.memory?.percent), sub: `${bytes(host?.memory?.used)} / ${bytes(host?.memory?.total)} · 可用 ${bytes(host?.memory?.available)}`, warning: host?.memory?.percent >= 90 },
  { key: 'disk', icon: HardDrive, label: `磁盘 ${worstDisk.value?.mountpoint || ''}`, value: metricValue(worstDisk.value?.percent), sub: `可用 ${bytes(worstDisk.value?.free)} / ${bytes(worstDisk.value?.total)}`, warning: worstDisk.value?.percent >= 85 },
  { key: 'network', icon: Network, label: '网络', value: `↓ ${rate(host?.network?.rx)}`, sub: `↑ ${rate(host?.network?.tx)} · ${host?.network?.interfaces?.map(i => i.name).join(', ') || '—'}` },
]; });
const directionOptions = computed(() => metric.value === 'network' ? [{ value: 'rx', label: '网络接收' }, { value: 'tx', label: '网络发送' }] : metric.value === 'disk' ? [...(resource.value.startsWith('disk:') ? [{ value: 'diskPercent', label: '容量使用率' }] : []), { value: 'readRate', label: '磁盘读取' }, { value: 'writeRate', label: '磁盘写入' }] : []);
const direction = computed({ get: () => directionOptions.value.some(o => o.value === route.query.direction) ? route.query.direction : directionOptions.value[0]?.value || '', set: value => { void router.replace({ query: { ...route.query, direction: value } }); } });
const chartMetric = computed(() => ['network', 'disk'].includes(metric.value) ? direction.value : metric.value === 'memory' ? resource.value === 'host' ? 'memory' : 'memoryUsed' : 'cpu');
const selectedService = computed(() => selectedNode.value?.services.find(s => s.key === resource.value));
const selectedDisk = computed(() => disks.value.find(d => `disk:${d.device}:${d.type}` === resource.value));
const resourceName = computed(() => resource.value === 'host' ? '宿主' : selectedDisk.value ? selectedDisk.value.mountpoint : selectedService.value ? `${selectedService.value.projectName || '独立容器'} / ${selectedService.value.name}` : resource.value.startsWith('disk:') ? '文件系统' : '服务');
const resourceMissing = computed(() => selectedNode.value && resource.value !== 'host' && !selectedService.value && !selectedDisk.value);
const metricLabel = computed(() => ({ cpu: 'CPU', memory: '内存', memoryUsed: '内存工作集', rx: '网络接收', tx: '网络发送', diskPercent: '容量使用率', readRate: '磁盘读取', writeRate: '磁盘写入' })[chartMetric.value] || '资源');
const chartLabel = computed(() => `${resourceName.value} · ${metricLabel.value}趋势`);
const chartUnit = computed(() => ['cpu', 'memory', 'diskPercent'].includes(chartMetric.value) ? '%' : chartMetric.value === 'memoryUsed' ? 'bytes' : 'bytes/s');
const detailTitle = computed(() => `${resourceName.value} · ${metric.value === 'cpu' ? 'CPU' : metric.value === 'memory' ? '内存' : metric.value === 'disk' ? '磁盘' : '网络'}详情`);
const detailItems = computed(() => {
  if (resourceMissing.value) return [];
  const host = selectedNode.value?.host, service = selectedService.value, disk = selectedDisk.value || worstDisk.value;
  if (service) return [{ label: '运行副本', value: `${service.running} / ${service.total}` }, { label: '整机 CPU / 使用核数', value: `${metricValue(service.cpuHostPercent)} / ${service.cpuPercent == null ? '—' : (service.cpuPercent / 100).toFixed(2) + ' 核'}` }, { label: '内存工作集', value: bytes(service.memUsage) }, { label: '网络接收 / 发送', value: `${rate(service.networkRx)} / ${rate(service.networkTx)}` }, { label: '磁盘读取 / 写入', value: `${rate(service.diskRead)} / ${rate(service.diskWrite)}` }];
  if (metric.value === 'cpu') return [{ label: '逻辑核数', value: host?.cpu?.cores ? `${host.cpu.cores} 核` : '—' }, { label: '当前占用核数', value: host?.cpu?.percent == null ? '—' : `${(host.cpu.percent * host.cpu.cores / 100).toFixed(2)} 核` }, { label: '负载 · 1 / 5 / 15 分钟', value: host?.cpu?.loadavg?.map(v => Number.isFinite(v) ? v.toFixed(2) : '—').join(' / ') || '—' }];
  if (metric.value === 'memory') return [{ label: '可用内存', value: bytes(host?.memory?.available) }, { label: '缓存', value: bytes(host?.memory?.cached) }, { label: 'Swap 已用 / 总量', value: `${bytes(host?.memory?.swapUsed)} / ${bytes(host?.memory?.swapTotal)}` }];
  if (metric.value === 'disk') return [{ label: '已用 / 总量', value: `${bytes(disk?.used)} / ${bytes(disk?.total)}` }, { label: '可用空间 / inode 已用', value: `${bytes(disk?.free)} / ${metricValue(disk?.inodePercent)}` }, { label: '读取 / 写入', value: `${rate(disk?.readRate)} / ${rate(disk?.writeRate)}` }];
  return [{ label: '统计接口', value: host?.network?.interfaces?.map(i => i.name).join(', ') || '—' }, { label: '接收速率', value: rate(host?.network?.rx) }, { label: '发送速率', value: rate(host?.network?.tx) }];
});
const detailNote = computed(() => selectedService.value ? '资源限制、健康检查、累计重启与 OOM 标记可在下方容器详情查看。' : metric.value === 'cpu' ? '100% 表示整机 CPU 容量；负载不是百分比，需结合核数和持续时间判断。' : metric.value === 'memory' ? '已用 = 总量 − 可用量；缓存不全是不可回收内存，容器工作集小计不等于宿主用量。' : metric.value === 'network' ? '默认路由接口的实时速率；切换接收 / 发送查看对应历史。' : '容量与 I/O 速率分别统计；挂载关联不代表某个服务独占该文件系统。');
const orderFrozen = ref(false), frozenOrder = ref([]);
const ranked = computed(() => rankProjects((selectedNode.value?.services || []).filter(s => (managementScope.value !== 'managed' || s.managed) && (!groupFilter.value || (groupFilter.value === 'ungrouped' ? !s.groupId : s.groupId === groupFilter.value))), sort.value, query.value));
const projects = computed(() => orderFrozen.value ? [...ranked.value].sort((a, b) => frozenOrder.value.indexOf(a.id) - frozenOrder.value.indexOf(b.id)).map(p => ({ ...p, services: [...p.services].sort((a, b) => frozenOrder.value.indexOf(a.key) - frozenOrder.value.indexOf(b.key)) })) : ranked.value);
function freezeOrder() { if (!orderFrozen.value) { frozenOrder.value = ranked.value.flatMap(p => [p.id, ...p.services.map(s => s.key)]); orderFrozen.value = true; } }
function unfreezeOrder() { if (!root.value?.querySelector('.cockpit-ranking')?.contains(document.activeElement)) orderFrozen.value = false; }
function releaseFocus(event) { if (!event.currentTarget.contains(event.relatedTarget)) orderFrozen.value = false; }
const focusLink = item => serviceFocusLocation({ ...item, hostId: item.hostId || hostId.value }, returnLocation.value);
const filtering = computed(() => !!query.value || !!groupFilter.value || managementScope.value !== 'all');
function clearFilters() { const next = { ...route.query }; for (const key of ['q', 'group', 'scope']) delete next[key]; void router.replace({ query: next }); }
const logLink = item => ({ path: '/logs', query: { hostId: item.hostId, projectId: item.projectId, containerId: item.id, from: 'dashboard', returnTo: returnLocation.value } });
function time(value) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }
function selectMetric(value) { const query = { ...route.query, metric: value, sort: value === 'memory' ? 'memory' : value === 'network' ? 'network' : value === 'disk' ? 'disk' : 'cpu', resource: 'host', direction: value === 'network' ? 'rx' : value === 'disk' ? 'diskPercent' : '' }; if (value === 'disk' && worstDisk.value) query.resource = `disk:${worstDisk.value.device}:${worstDisk.value.type}`; void router.replace({ query }); }
function selectDisk(disk) { resource.value = `disk:${disk.device}:${disk.type}`; }
function selectAlert(alert) {
  const disk = disks.value.find(d => d.device === alert.disk);
  if (disk) void router.replace({ query: { ...route.query, metric: 'disk', sort: 'disk', resource: `disk:${disk.device}:${disk.type}` } });
  else selectMetric(alert.disk ? 'disk' : alert.key);
}
function viewServiceHistory(service) { void router.replace({ query: { ...route.query, resource: service.key, direction: metric.value === 'disk' ? 'writeRate' : direction.value } }); void nextTick(() => root.value?.querySelector('.cockpit-chart')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }
let pageActive = true, active = false, timer, request = 0, historyRequest = 0, controller, historyController, lastHistory = 0;
async function loadHistory() {
  const version = ++historyRequest; historyController?.abort(); historyLoading.value = false;
  if (!active || hostId.value === 'all') return;
  historyController = new AbortController(); historyLoading.value = true;
  try { const result = await api.getInfrastructureHistory({ hostId: hostId.value, resource: resource.value, metric: chartMetric.value, hours: hours.value }, historyController.signal); if (active && version === historyRequest) { history.value = result; historyError.value = ''; lastHistory = Date.now(); } }
  catch (cause) { if (active && version === historyRequest && cause.name !== 'AbortError') historyError.value = `趋势读取失败：${cause.message}`; }
  finally { if (version === historyRequest) historyLoading.value = false; }
}
async function refresh() {
  if (!active || loading.value) return;
  const version = ++request, target = hostId.value; controller = new AbortController(); loading.value = true;
  try {
    const result = await api.getInfrastructure(target, controller.signal);
    if (!active || version !== request || target !== hostId.value) return;
    snapshot.value = result; error.value = '';
    if (metric.value === 'disk' && target !== 'all') {
      try {
        const detail = await api.getInfrastructureStorage(target, controller.signal);
        if (active && version === request && target === hostId.value) { storage.value = detail; storageError.value = ''; }
      } catch (cause) { if (active && version === request && cause.name !== 'AbortError') storageError.value = `磁盘容量预测读取失败：${cause.message}。当前文件系统采样仍可查看。`; }
    }
    if (Date.now() - lastHistory >= 30000 && !historyLoading.value) void loadHistory();
  } catch (cause) { if (active && version === request && cause.name !== 'AbortError') { error.value = `资源采样读取失败：${cause.message}`; if (snapshot.value) snapshot.value = { ...snapshot.value, nodes: snapshot.value.nodes.map(n => ({ ...n, status: 'stale' })) }; } }
  finally { if (version === request) loading.value = false; }
}
function stop() { active = false; clearInterval(timer); timer = null; request++; historyRequest++; controller?.abort(); historyController?.abort(); loading.value = false; historyLoading.value = false; }
function start() { if (active || !pageActive || document.hidden) return; active = true; void refresh(); void loadHistory(); timer = setInterval(refresh, 5000); }
function visibility() { if (document.hidden) stop(); else start(); }
function hostChanged() { if (!route.query.hostId) changeScope(); }
function changeScope() { request++; controller?.abort(); loading.value = false; snapshot.value = null; storage.value = null; error.value = ''; storageError.value = ''; historyError.value = ''; history.value = { ...history.value, points: [] }; orderFrozen.value = false; lastHistory = 0; void refresh(); void loadHistory(); }
watch(hostId, changeScope);
watch([metric, resource, hours, direction], () => { historyError.value = ''; history.value = { ...history.value, points: [] }; void loadHistory(); if (metric.value === 'disk') void refresh(); });
async function toggleFullscreen() { fullscreen.value = !fullscreen.value; if (fullscreen.value) { try { await root.value?.requestFullscreen?.(); } catch { /* CSS 大屏支持未允许原生全屏的嵌入环境。 */ } } else if (document.fullscreenElement === root.value) await document.exitFullscreen?.(); }
function fullscreenChange() { if (!document.fullscreenElement) fullscreen.value = false; }
useEscapeKey({ active: fullscreen, layer: 'drawer', lockBody: true, closeOnQueryChange: false, onClose: () => { fullscreen.value = false; if (document.fullscreenElement === root.value) void document.exitFullscreen?.(); } });
onMounted(() => { start(); document.addEventListener('visibilitychange', visibility); document.addEventListener('fullscreenchange', fullscreenChange); window.addEventListener('composeops:host-changed', hostChanged); });
onActivated(() => { pageActive = true; start(); });
onDeactivated(() => { pageActive = false; stop(); fullscreen.value = false; });
onBeforeUnmount(() => { stop(); document.removeEventListener('visibilitychange', visibility); document.removeEventListener('fullscreenchange', fullscreenChange); window.removeEventListener('composeops:host-changed', hostChanged); });
</script>

<style scoped>
.cockpit-detail header{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.cockpit-detail h3{font-size:14px;font-weight:600}.cockpit-detail header span,.cockpit-detail p{font-size:11px;color:var(--text-soft)}.cockpit-detail dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:14px 0}.cockpit-detail dt{font-size:12px;color:var(--text-soft)}.cockpit-detail dd{margin-top:4px;font-size:13px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}


.server-cockpit { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.cockpit-heading,.cockpit-controls,.cockpit-chart header,.cockpit-storage>header,.cockpit-ranking>header { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.cockpit-heading h2,.cockpit-storage h3 { display:flex; align-items:center; gap:8px; font-weight:600; }
.cockpit-heading p,.cockpit-ranking header p { margin-top:5px; font-size:12px; color:var(--text-soft); }
.cockpit-controls .input,.cockpit-chart .input { width:auto; max-width:220px; font-size:12px; }
.cockpit-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
.cockpit-metric { display:flex; position:relative; flex-direction:column; gap:10px; text-align:left; padding:16px; border:1px solid var(--line-subtle); border-radius:10px; background:var(--panel-surface); min-width:0; }
.cockpit-metric[aria-pressed=true] { border-color:var(--color-link); background:color-mix(in srgb,var(--color-link) 8%,var(--panel-surface)); }
.cockpit-metric>span:first-child { display:flex; gap:8px; align-items:center; color:var(--text-soft); font-size:12px; overflow-wrap:anywhere; }
.cockpit-metric strong { font-size:clamp(20px,2vw,29px); font-variant-numeric:tabular-nums; font-weight:600; overflow-wrap:anywhere; }
.cockpit-metric small { color:var(--text-soft); font-size:11px; overflow-wrap:anywhere; }.cockpit-metric.is-warning strong { color:var(--color-status-warn); }.cockpit-stale { color:var(--color-status-warn);font-size:11px; }
.cockpit-middle { display:grid; grid-template-columns:minmax(0,1.8fr) minmax(220px,1fr); gap:16px; }.cockpit-chart,.cockpit-attention { min-width:0; }.cockpit-chart header { margin-bottom:12px; }.cockpit-chart h3,.cockpit-attention h3,.cockpit-ranking h3 { font-size:14px; font-weight:600; }
.cockpit-attention>p { font-size:12px; line-height:1.8; margin-block:14px; }.cockpit-alerts button { display:flex; align-items:flex-start; width:100%; gap:10px; padding:12px 0; text-align:left; border-bottom:1px solid var(--line-subtle); color:var(--color-status-warn); }.cockpit-alerts button span { flex:1; min-width:0; }.cockpit-alerts strong { font-size:12px; font-weight:500; }.cockpit-alerts small { display:block; margin-top:4px; color:var(--text-soft); font-size:11px; }.cockpit-facts { display:grid; gap:8px; font-size:12px; color:var(--text-soft); margin-top:16px; }.cockpit-facts small { font-size:11px; }
.cockpit-ranking>header { margin-bottom:16px; }.cockpit-ranking .search-field { width:210px; min-width:0; }
.cockpit-footer { color:var(--text-soft); font-size:11px; }.cockpit-nodes { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }.cockpit-node { display:grid; gap:8px; padding:16px; border:1px solid var(--line-subtle); background:var(--panel-surface); border-radius:10px; text-align:left; }.cockpit-node small { color:var(--text-soft); }
.cockpit-disk { padding-block:16px; border-top:1px solid var(--line-subtle); }.cockpit-disk-heading,.cockpit-disk-meta,.cockpit-mount { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; font-size:12px; }.cockpit-disk .progress { margin-block:12px; }.cockpit-disk-meta { color:var(--text-soft); font-size:11px; }.cockpit-disk details { margin-top:12px; font-size:12px; }.cockpit-disk summary { cursor:pointer; }.cockpit-mount { padding-top:12px; }.cockpit-mount strong,.cockpit-mount small { display:block; overflow-wrap:anywhere; }.cockpit-mount small { color:var(--text-soft); }.cockpit-fullscreen { position:fixed; inset:0; z-index:54; overflow:auto; padding:24px; background:var(--app-bg,var(--color-surface-950)); }.server-cockpit:fullscreen { overflow:auto; padding:24px; background:var(--app-bg,var(--color-surface-950)); }
.cockpit-ranking>header{align-items:flex-start;gap:14px}.cockpit-ranking .cockpit-controls{justify-content:flex-end;max-width:100%;flex-wrap:wrap}.cockpit-ranking .search-field{flex:1 1 210px}.cockpit-ranking .cockpit-controls .input{flex:0 1 auto}.cockpit-ranking>header>div:first-child{flex:1 1 250px}.cockpit-ranking>header>.cockpit-controls{flex:1 1 540px}
@media(max-width:1100px){.cockpit-middle{grid-template-columns:minmax(0,1.5fr) minmax(200px,1fr)}}
@media(max-width:850px){.cockpit-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.cockpit-middle{grid-template-columns:1fr}.cockpit-attention{order:-1}}
@media(max-width:480px){.cockpit-controls{width:100%;flex-wrap:wrap}.cockpit-controls .search-field{flex:1 1 100%;width:auto}.cockpit-metric{padding:12px}.cockpit-fullscreen{padding:12px}.cockpit-heading .input{flex:1;max-width:none}}
</style>
