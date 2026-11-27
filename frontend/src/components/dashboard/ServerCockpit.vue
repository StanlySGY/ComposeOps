<template>
  <section ref="root" class="server-cockpit" :class="{ 'cockpit-fullscreen': fullscreen }" aria-label="服务器驾驶舱">
    <header class="cockpit-heading">
      <div><h2><Server :size="18" />服务器资源</h2><p>{{ selectedNode?.name || '节点概览' }} · {{ scopeLabel }}<span v-if="selectedNode?.host?.sampledAt"> · 采样于 {{ time(selectedNode.host.sampledAt) }}</span></p></div>
      <div class="cockpit-controls"><select v-model="hostId" class="input" aria-label="监控节点"><option v-for="host in hosts.hosts" :key="host.id" :value="host.id">{{ host.name }}</option><option value="all">全部节点</option></select><button class="btn-secondary btn-sm" :aria-pressed="fullscreen" @click="toggleFullscreen"><component :is="fullscreen ? Minimize : Maximize" :size="15" />{{ fullscreen ? '退出大屏' : '大屏' }}</button></div>
    </header>
    <p v-if="error" class="alert-error" role="alert">{{ error }}<button class="text-link ml-2" @click="refresh">重试</button></p>
    <div v-if="hostId === 'all'" class="cockpit-nodes">
      <button v-for="node in snapshot?.nodes || []" :key="node.hostId" class="cockpit-node" @click="hostId = node.hostId"><strong>{{ node.name }}</strong><span :class="node.status === 'ready' ? 'text-status-ok' : 'text-status-warn'">{{ node.status === 'ready' ? 'Docker 已连接' : node.status === 'pending' ? '等待采样' : '数据陈旧' }}</span><small>CPU {{ metricValue(node.host?.cpu?.percent) }} · 内存 {{ metricValue(node.host?.memory?.percent) }}</small><small>{{ node.host?.status === 'ready' ? '宿主采集正常' : node.host?.reason || '宿主指标未接入' }}</small><span class="text-link">进入节点 →</span></button>
    </div>
    <template v-else>
      <p v-if="loading && !selectedNode" class="text-muted" role="status">正在读取采样…</p>
      <div v-if="selectedNode && !hostReady" class="scope-callout" role="status"><AlertTriangle :size="16" /><span>{{ selectedNode.status === 'stale' ? '节点连接中断，以下是最后一次采样。' : selectedNode.host?.reason || '宿主指标未接入。' }}<span v-if="selectedNode.host?.status === 'stale'"> 指标已陈旧。</span></span><router-link to="/settings?tab=hosts" class="text-link">节点设置</router-link></div>
      <div class="cockpit-metrics">
        <button v-for="tile in tiles" :key="tile.key" class="cockpit-metric" :class="{ 'is-warning': tile.warning }" :aria-pressed="metric === tile.key && (resource === 'host' || resource.startsWith('disk:'))" @click="selectMetric(tile.key)"><span><component :is="tile.icon" :size="16" />{{ tile.label }}</span><strong>{{ tile.value }}</strong><small>{{ tile.sub }}</small><span v-if="!hostReady" class="cockpit-stale">{{ selectedNode?.host?.sampledAt ? '最后采样' : '未接入' }}</span></button>
      </div>
      <div class="cockpit-middle">
        <section class="section-panel cockpit-chart"><header><div><h3>{{ chartLabel }}</h3><button v-if="resource !== 'host'" class="text-link text-xs" @click="selectMetric(metric)">返回宿主趋势</button></div><select v-model="hours" class="input" aria-label="趋势时间范围"><option v-for="period in resourcePeriods" :key="period.value" :value="String(period.value)">{{ period.label }}</option></select></header><p v-if="historyError" class="alert-error" role="alert">{{ historyError }}</p><p v-if="historyLoading" class="text-muted text-xs" role="status">更新趋势中…</p><ResourceTrend :points="history.points" :interval="history.interval" :start="history.start" :end="history.end" :label="chartLabel" :unit="chartUnit" /></section>
        <section class="section-panel cockpit-attention"><h3>资源关注</h3><div v-if="selectedNode?.alerts?.length" class="cockpit-alerts"><button v-for="alert in selectedNode.alerts" :key="alert.key" @click="selectAlert(alert)"><AlertTriangle :size="15" /><span><strong>{{ alert.title }}</strong><small>{{ alert.detail }} · {{ alert.sustained ? '持续超限，已进入事件中心' : '短时超限，持续观察' }}</small></span><ChevronRight :size="14" /></button></div><p v-else class="text-muted">{{ hostReady ? '当前没有资源阈值超限；服务故障见下方需要处理。' : '接入有效宿主采样后显示资源状态。' }}</p><div class="cockpit-facts"><span>Docker 容器 {{ runningCount }} / {{ selectedNode?.containers?.length ?? '—' }} 运行</span><span>容器内存小计 {{ bytes(containerMemory) }}</span><span v-if="selectedNode?.host?.memory">Swap {{ bytes(selectedNode.host.memory.swapUsed) }} / {{ bytes(selectedNode.host.memory.swapTotal) }}</span><small>容器小计不等于整机总用量</small></div></section>
      </div>
      <section ref="storageElement" v-if="metric === 'disk'" class="section-panel cockpit-storage">
        <header><h3><HardDrive :size="16" />文件系统与关联服务</h3><router-link :to="{ path: '/resources', query: { hostId, from: 'dashboard', returnTo: returnLocation } }" class="text-link">Docker 存储管理 →</router-link></header>
        <p class="text-muted text-xs mb-3">真实文件系统去重；容量与读写速率分别统计。共享卷与镜像不重复归属，挂载关联不代表该服务独占空间。</p>
        <p v-if="!disks.length" class="text-muted">暂无可读取的宿主文件系统数据。</p>
        <article v-for="disk in disks" :key="disk.device + disk.type" class="cockpit-disk"><div class="cockpit-disk-heading"><button class="text-link" @click="selectDisk(disk)">{{ disk.mountpoint }} · {{ disk.type }}</button><span>{{ bytes(disk.used) }} / {{ bytes(disk.total) }} · 可用 {{ bytes(disk.free) }}</span></div><div class="progress" :class="disk.percent >= 85 ? 'progress-danger' : 'progress-muted'"><span :style="{ width: `${Math.min(100, disk.percent || 0)}%` }"></span></div><div class="cockpit-disk-meta"><span>已用 {{ metricValue(disk.percent) }}</span><span>inode {{ metricValue(disk.inodePercent) }}</span><span>读 {{ rate(disk.readRate) }} · 写 {{ rate(disk.writeRate) }}</span></div><p v-if="disk.forecast" class="text-status-warn text-xs">估计约 {{ disk.forecast.hours }} 小时后耗尽 · {{ disk.forecast.label }}</p><details v-if="disk.services?.length"><summary>{{ disk.services.length }} 项挂载关联 · 查看服务</summary><div v-for="item in disk.services" :key="item.key" class="cockpit-mount"><span><strong>{{ item.volume || item.source }}</strong><small>{{ item.projectName || '独立容器' }} / {{ item.service || item.containerName }}</small></span><router-link :to="focusLink({ ...item, hostId })" class="text-link">定位服务 →</router-link></div></details><p v-else class="text-muted text-xs">未发现容器挂载关联；可能由系统或其他进程使用。</p></article>
      </section>
      <section class="section-panel cockpit-ranking" @mouseenter="freezeOrder" @mouseleave="unfreezeOrder" @focusin="freezeOrder" @focusout="releaseFocus">
        <header><div><h3>项目与服务资源</h3><p>当前采样 · CPU 按整机容量归一化 · 内存为实际工作集</p></div><div class="cockpit-controls"><label class="search-field"><Search :size="14" /><input v-model="query" type="search" aria-label="搜索资源排行" placeholder="搜索项目或服务" /></label><select v-model="sort" class="input" aria-label="资源排行排序"><option value="cpu">CPU</option><option value="memory">内存</option><option value="network">网络接收</option><option value="disk">磁盘写入</option></select></div></header>
        <p v-if="!projects.length" class="text-muted py-4">{{ query ? '没有匹配的项目或服务。' : '暂无容器数据；采样完成后显示资源排行。' }}</p>
        <div class="cockpit-rank-label" v-if="projects.length"><span>项目 / 服务</span><span>整机 CPU</span><span>内存</span><span>收 / 发</span><span>读 / 写</span><span>操作</span></div>
        <article v-for="project in projects" :key="project.id" class="cockpit-project"><button class="cockpit-project-summary" :aria-expanded="expanded.has(project.id)" @click="toggleProject(project.id)"><ChevronDown :size="15" :class="{ 'rotate-180': expanded.has(project.id) }" /><strong>{{ project.name }}</strong><span>{{ project.services.length }} 个服务</span><small>{{ projectMetric(project) }}</small></button><template v-if="expanded.has(project.id)"><div v-for="service in project.services" :key="service.key" class="cockpit-service"><div><router-link :to="focusLink(service)" class="cockpit-service-name">{{ service.name }}</router-link><small>{{ service.running }} / {{ service.total }} 运行<span v-if="service.cpuPercent != null"> · {{ (service.cpuPercent / 100).toFixed(2) }} 核</span></small></div><span data-label="CPU">{{ metricValue(service.cpuHostPercent) }}</span><span data-label="内存">{{ bytes(service.memUsage) }}</span><span data-label="网络">{{ rate(service.networkRx) }}<small>{{ rate(service.networkTx) }}</small></span><span data-label="磁盘 I/O">{{ rate(service.diskRead) }}<small>{{ rate(service.diskWrite) }}</small></span><div class="cockpit-row-actions"><router-link :to="focusLink(service)" class="text-link">定位</router-link><button class="text-link" @click="viewServiceHistory(service)">趋势</button></div><details v-if="service.containers.length" class="cockpit-replicas"><summary>{{ service.containers.length }} 个容器副本</summary><div v-for="container in service.containers" :key="container.id"><span>{{ container.name }} · {{ container.state === 'running' ? '运行中' : '已停止' }}</span><router-link :to="focusLink(container)" class="text-link">定位容器</router-link><router-link v-if="container.projectId" :to="logLink(container)" class="text-link">日志</router-link></div></details></div></template></article>
      </section>
      <p class="cockpit-footer">{{ hostReady ? '宿主采集正常' : '宿主指标待确认' }} · 后台统一采样 · 切离页面暂停刷新<span v-if="orderFrozen"> · 操作期间保持排行顺序</span></p>
    </template>
  </section>
</template>

<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AlertTriangle, ChevronDown, ChevronRight, Cpu, HardDrive, Maximize, MemoryStick, Minimize, Network, Search, Server } from 'lucide-vue-next';
import { useEscapeKey } from '../../composables/useEscapeKey.js';
import { api } from '../../api/client.js';
import { useHostsStore } from '../../stores/hosts.js';
import { formatResourceBytes as bytes, metricValue, rankProjects, resourcePeriods, serviceFocusLocation } from '../../lib/infrastructure.js';
import ResourceTrend from './ResourceTrend.vue';

const route = useRoute(), router = useRouter(), hosts = useHostsStore();
const root = ref(null), storageElement = ref(null), fullscreen = ref(false), snapshot = ref(null), loading = ref(false), error = ref(''), historyError = ref(''), historyLoading = ref(false), storage = ref(null);
const history = ref({ points: [], start: Date.now() - 3600000, end: Date.now(), interval: 10000 });
function queryValue(key, fallback) { return computed({ get: () => {
  const defaultValue = typeof fallback === 'function' ? fallback() : fallback;
  const value = typeof route.query[key] === 'string' ? route.query[key] : defaultValue;
  const allowed = key === 'hours' ? resourcePeriods.map(p => String(p.value)) : ['metric', 'sort'].includes(key) ? ['cpu', 'memory', 'disk', 'network'] : null;
  return String(allowed && !allowed.includes(value) ? defaultValue : value);
}, set: value => { const query = { ...route.query }; query[key] = String(value); void router.replace({ query }); } }); }
const hostId = queryValue('hostId', () => hosts.activeHostId), metric = queryValue('metric', 'cpu'), hours = queryValue('hours', '1'), sort = queryValue('sort', 'cpu'), query = queryValue('q', ''), resource = queryValue('resource', 'host');
const returnLocation = computed(() => route.fullPath);
const selectedNode = computed(() => snapshot.value?.nodes.find(node => node.hostId === hostId.value));
const hostReady = computed(() => selectedNode.value?.status === 'ready' && selectedNode.value?.host?.status === 'ready');
const scopeLabel = computed(() => selectedNode.value?.host?.scope === 'wsl' ? 'WSL Linux 环境（不含 Windows 整机）' : selectedNode.value?.host?.scope === 'linux' ? 'Linux 宿主机' : '宿主采集待接入');
const disks = computed(() => storage.value?.hostId === hostId.value ? storage.value.disks : selectedNode.value?.host?.disks || []);
const worstDisk = computed(() => [...disks.value].sort((a, b) => (b.percent || 0) - (a.percent || 0))[0]);
const runningCount = computed(() => selectedNode.value?.containers.filter(c => c.state === 'running').length ?? 0);
const containerMemory = computed(() => { const list = selectedNode.value?.containers.filter(c => c.state === 'running') || []; return list.length && list.every(c => c.memUsage != null) ? list.reduce((n, c) => n + c.memUsage, 0) : null; });
const rate = value => metricValue(value, 'bytes/s');
const tiles = computed(() => { const host = selectedNode.value?.host; return [
  { key: 'cpu', icon: Cpu, label: 'CPU', value: metricValue(host?.cpu?.percent), sub: `${host?.cpu?.cores || selectedNode.value?.engine?.cpus || '—'} 核 · 整机占比`, warning: host?.cpu?.percent >= 90 },
  { key: 'memory', icon: MemoryStick, label: '内存', value: metricValue(host?.memory?.percent), sub: `${bytes(host?.memory?.used)} / ${bytes(host?.memory?.total)}`, warning: host?.memory?.percent >= 90 },
  { key: 'disk', icon: HardDrive, label: `磁盘 ${worstDisk.value?.mountpoint || ''}`, value: metricValue(worstDisk.value?.percent), sub: `可用 ${bytes(worstDisk.value?.free)} / ${bytes(worstDisk.value?.total)}`, warning: worstDisk.value?.percent >= 85 },
  { key: 'network', icon: Network, label: '网络', value: `↓ ${rate(host?.network?.rx)}`, sub: `↑ ${rate(host?.network?.tx)} · ${host?.network?.interfaces?.map(i => i.name).join(', ') || '—'}` },
]; });
const metricNames = { cpu: 'CPU', memory: '内存', disk: '磁盘', network: '网络接收' };
const chartLabel = computed(() => `${resource.value === 'host' ? '宿主' : resource.value.startsWith('disk:') ? (disks.value.find(d => `disk:${d.device}:${d.type}` === resource.value)?.mountpoint || '文件系统') : selectedNode.value?.services.find(s => s.key === resource.value)?.name || '服务'} · ${metricNames[metric.value] || 'CPU'}趋势`);
const chartMetric = computed(() => metric.value === 'network' ? 'rx' : metric.value === 'memory' ? resource.value === 'host' ? 'memory' : 'memoryUsed' : metric.value === 'disk' ? resource.value.startsWith('disk:') ? 'diskPercent' : 'writeRate' : 'cpu');
const chartUnit = computed(() => ['cpu', 'memory', 'diskPercent'].includes(chartMetric.value) ? '%' : chartMetric.value === 'memoryUsed' ? 'bytes' : 'bytes/s');
const expanded = ref(new Set()), orderFrozen = ref(false), frozenOrder = ref([]);
const ranked = computed(() => rankProjects(selectedNode.value?.services || [], sort.value, query.value));
const projects = computed(() => orderFrozen.value ? [...ranked.value].sort((a, b) => frozenOrder.value.indexOf(a.id) - frozenOrder.value.indexOf(b.id)).map(p => ({ ...p, services: [...p.services].sort((a, b) => frozenOrder.value.indexOf(a.key) - frozenOrder.value.indexOf(b.key)) })) : ranked.value);
function freezeOrder() { if (!orderFrozen.value) { frozenOrder.value = ranked.value.flatMap(p => [p.id, ...p.services.map(s => s.key)]); orderFrozen.value = true; } }
function unfreezeOrder() { if (!root.value?.querySelector('.cockpit-ranking')?.contains(document.activeElement)) orderFrozen.value = false; }
function releaseFocus(event) { if (!event.currentTarget.contains(event.relatedTarget)) orderFrozen.value = false; }
function toggleProject(id) { const next = new Set(expanded.value); if (next.has(id)) next.delete(id); else next.add(id); expanded.value = next; }
function projectMetric(project) { return sort.value === 'cpu' ? metricValue(project.value) : sort.value === 'memory' ? bytes(project.value) : rate(project.value); }
const focusLink = item => serviceFocusLocation({ ...item, hostId: item.hostId || hostId.value }, returnLocation.value);
const logLink = item => ({ path: '/logs', query: { hostId: item.hostId, projectId: item.projectId, containerId: item.id, from: 'dashboard', returnTo: returnLocation.value } });
function time(value) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }
function selectMetric(value) { const query = { ...route.query, metric: value, sort: value === 'memory' ? 'memory' : value === 'network' ? 'network' : value === 'disk' ? 'disk' : 'cpu', resource: 'host' }; if (value === 'disk' && worstDisk.value) query.resource = `disk:${worstDisk.value.device}:${worstDisk.value.type}`; void router.replace({ query }); }
function selectDisk(disk) { resource.value = `disk:${disk.device}:${disk.type}`; }
function selectAlert(alert) {
  const disk = disks.value.find(d => d.device === alert.disk);
  if (disk) void router.replace({ query: { ...route.query, metric: 'disk', sort: 'disk', resource: `disk:${disk.device}:${disk.type}` } });
  else selectMetric(alert.disk ? 'disk' : alert.key);
}
function viewServiceHistory(service) { resource.value = service.key; void nextTick(() => root.value?.querySelector('.cockpit-chart')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }
let pageActive = true, active = false, timer, request = 0, historyRequest = 0, controller, historyController, lastHistory = 0;
async function loadHistory() {
  if (!active || hostId.value === 'all') return;
  const version = ++historyRequest; historyController?.abort(); historyController = new AbortController(); historyLoading.value = true;
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
      const detail = await api.getInfrastructureStorage(target, controller.signal);
      if (active && version === request && target === hostId.value) storage.value = detail;
    }
    if (Date.now() - lastHistory >= 30000 && !historyLoading.value) void loadHistory();
  } catch (cause) { if (active && version === request && cause.name !== 'AbortError') { error.value = `资源采样读取失败：${cause.message}`; if (snapshot.value) snapshot.value = { ...snapshot.value, nodes: snapshot.value.nodes.map(n => ({ ...n, status: 'stale' })) }; } }
  finally { if (version === request) loading.value = false; }
}
function stop() { active = false; clearInterval(timer); timer = null; request++; historyRequest++; controller?.abort(); historyController?.abort(); loading.value = false; historyLoading.value = false; }
function start() { if (active || !pageActive || document.hidden) return; active = true; void refresh(); void loadHistory(); timer = setInterval(refresh, 5000); }
function visibility() { if (document.hidden) stop(); else start(); }
function hostChanged() { if (!route.query.hostId) changeScope(); }
function changeScope() { request++; controller?.abort(); loading.value = false; snapshot.value = null; storage.value = null; history.value = { ...history.value, points: [] }; expanded.value = new Set(); lastHistory = 0; void refresh(); void loadHistory(); }
watch(hostId, changeScope);
watch([metric, resource, hours], () => { history.value = { ...history.value, points: [] }; void loadHistory(); if (metric.value === 'disk') void refresh(); });
async function toggleFullscreen() { fullscreen.value = !fullscreen.value; if (fullscreen.value) { try { await root.value?.requestFullscreen?.(); } catch { /* CSS 大屏支持未允许原生全屏的嵌入环境。 */ } } else if (document.fullscreenElement === root.value) await document.exitFullscreen?.(); }
function fullscreenChange() { if (!document.fullscreenElement) fullscreen.value = false; }
useEscapeKey({ active: fullscreen, layer: 'drawer', lockBody: true, closeOnQueryChange: false, onClose: () => { fullscreen.value = false; if (document.fullscreenElement === root.value) void document.exitFullscreen?.(); } });
onMounted(() => { start(); document.addEventListener('visibilitychange', visibility); document.addEventListener('fullscreenchange', fullscreenChange); window.addEventListener('composeops:host-changed', hostChanged); });
onActivated(() => { pageActive = true; start(); });
onDeactivated(() => { pageActive = false; stop(); fullscreen.value = false; });
onBeforeUnmount(() => { stop(); document.removeEventListener('visibilitychange', visibility); document.removeEventListener('fullscreenchange', fullscreenChange); window.removeEventListener('composeops:host-changed', hostChanged); });
</script>

<style scoped>
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
.cockpit-ranking>header { margin-bottom:16px; }.cockpit-ranking .search-field { width:210px; min-width:0; }.cockpit-rank-label,.cockpit-service { display:grid; grid-template-columns:minmax(120px,1fr) 80px 90px 100px 100px 70px; gap:12px; align-items:center; }.cockpit-rank-label { color:var(--text-soft); font-size:11px; padding:10px; border-bottom:1px solid var(--line-subtle); }.cockpit-rank-label>span:not(:first-child) { text-align:right; }
.cockpit-project-summary { display:flex; width:100%; text-align:left; align-items:center; gap:8px; padding:15px 8px; border-bottom:1px solid var(--line-subtle); }.cockpit-project-summary strong { font-size:13px; overflow-wrap:anywhere; }.cockpit-project-summary span { color:var(--text-soft); font-size:11px; white-space:nowrap; }.cockpit-project-summary small { margin-left:auto; white-space:nowrap; font-variant-numeric:tabular-nums; }
.cockpit-service { padding:12px 10px; border-bottom:1px solid var(--line-subtle); font-size:12px; }.cockpit-service>span { text-align:right; font-variant-numeric:tabular-nums; }.cockpit-service small { display:block; margin-top:4px; color:var(--text-soft); font-size:11px; }.cockpit-service-name { color:var(--text-strong); overflow-wrap:anywhere; }.cockpit-service-name:hover { color:var(--color-link); }.cockpit-row-actions { display:flex; justify-content:flex-end; gap:10px; }.cockpit-replicas { grid-column:1/-1; font-size:11px; color:var(--text-soft); }.cockpit-replicas summary { cursor:pointer; }.cockpit-replicas>div { display:flex; padding:10px 0; gap:12px; flex-wrap:wrap; }.cockpit-replicas>div>span { flex:1; overflow-wrap:anywhere; }
.cockpit-footer { color:var(--text-soft); font-size:11px; }.cockpit-nodes { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }.cockpit-node { display:grid; gap:8px; padding:16px; border:1px solid var(--line-subtle); background:var(--panel-surface); border-radius:10px; text-align:left; }.cockpit-node small { color:var(--text-soft); }
.cockpit-disk { padding-block:16px; border-top:1px solid var(--line-subtle); }.cockpit-disk-heading,.cockpit-disk-meta,.cockpit-mount { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; font-size:12px; }.cockpit-disk .progress { margin-block:12px; }.cockpit-disk-meta { color:var(--text-soft); font-size:11px; }.cockpit-disk details { margin-top:12px; font-size:12px; }.cockpit-disk summary { cursor:pointer; }.cockpit-mount { padding-top:12px; }.cockpit-mount strong,.cockpit-mount small { display:block; overflow-wrap:anywhere; }.cockpit-mount small { color:var(--text-soft); }.cockpit-fullscreen { position:fixed; inset:0; z-index:54; overflow:auto; padding:24px; background:var(--app-bg,var(--color-surface-950)); }.server-cockpit:fullscreen { overflow:auto; padding:24px; background:var(--app-bg,var(--color-surface-950)); }
@media(max-width:1100px) { .cockpit-rank-label,.cockpit-service { grid-template-columns:minmax(110px,1fr) 65px 80px 90px 90px 60px; gap:8px; }.cockpit-middle { grid-template-columns:minmax(0,1.5fr) minmax(200px,1fr); } }
@media(max-width:850px) { .cockpit-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }.cockpit-middle { grid-template-columns:1fr; }.cockpit-rank-label { display:none; }.cockpit-service { grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }.cockpit-service>div:first-child { grid-column:1/-1; }.cockpit-service>span { text-align:left; }.cockpit-service>span:before { content:attr(data-label); display:block; color:var(--text-soft); font-size:11px; margin-bottom:4px; }.cockpit-row-actions { grid-column:1/-1; justify-content:flex-start; }.cockpit-row-actions>* { min-height:36px; }.cockpit-attention { order:-1; } }
@media(max-width:480px) { .cockpit-controls { width:100%; }.cockpit-controls .search-field { flex:1; width:auto; }.cockpit-metric { padding:12px; }.cockpit-fullscreen { padding:12px; }.cockpit-project-summary { flex-wrap:wrap; }.cockpit-heading .input { flex:1; max-width:none; }.cockpit-row-actions>* { min-height:44px; } }
</style>
