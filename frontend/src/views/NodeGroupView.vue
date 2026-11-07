<template>
  <div class="page-shell node-workspace">
    <div class="page-header">
      <div><h1 class="page-title">节点组管理</h1><p class="page-subtitle">从节点状态出发，查看指标、进入服务，再回到当前分组。</p></div>
      <div class="page-actions">
        <router-link :to="deepLink('/monitor', { hostId: 'all', from: 'node-groups' })" class="btn-secondary"><Activity class="h-4 w-4" />全部节点监控</router-link>
        <router-link to="/settings?tab=hosts&from=node-groups" class="btn-primary"><Plus class="h-4 w-4" />添加节点</router-link>
        <button class="btn-secondary" :disabled="loading || batchBusy" @click="load"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
    <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <MetricTile title="已连接节点" :value="String(hosts.length)" sub="按生产、测试与边缘环境分组" />
      <MetricTile title="在线节点" :value="String(onlineCount)" :sub="`${offlineCount} 离线 · ${unknownCount} 待确认`" tone="text-status-ok" />
      <MetricTile title="运行容器" :value="knownHosts.length ? String(totalRunning) : '—'" :sub="knownHosts.length ? `共 ${totalContainers} 个 · ${knownHosts.length}/${hosts.length} 节点已统计` : '等待节点探测'" />
      <MetricTile title="最近巡检" :value="inspectionScore ?? '—'" :sub="inspectionScore != null ? '全局最近报告 · 未按节点筛选' : '尚无巡检报告'" tone="text-status-info" />
    </div>
    <section class="section-panel node-toolbar" aria-label="节点筛选与操作">
      <label class="search-field"><Search class="h-4 w-4" /><input :value="searchQuery" type="search" aria-label="搜索节点" placeholder="搜索节点名称或地址" @input="setFilter('q', $event.target.value)" /></label>
      <select class="input w-auto" aria-label="节点状态筛选" :value="statusFilter" @change="setFilter('status', $event.target.value)"><option value="">全部状态</option><option value="online">在线</option><option value="offline">离线</option><option value="unknown">待确认</option></select>
      <button v-if="searchQuery || statusFilter" class="btn-secondary btn-sm" @click="clearFilters">清除筛选</button>
      <span class="node-toolbar-spacer"></span>
      <button class="btn-secondary btn-sm" :disabled="!!batchBusy || loading || !hosts.length" @click="pingAll"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': batchBusy === 'ping' }" />探测全部节点</button>
    </section>
    <Skeleton v-if="loading && !hosts.length" variant="cards" :rows="3" label="正在加载节点" />
    <EmptyState v-else-if="!hosts.length && !error" icon="Server" title="连接你的第一个节点" description="添加 Docker 节点后，在这里查看状态并进入服务工作区。"><router-link to="/settings?tab=hosts&from=node-groups" class="btn-primary">添加节点</router-link></EmptyState>
    <EmptyState v-else-if="hosts.length && !filteredHosts.length" icon="Search" title="没有匹配的节点" description="试试其他名称、地址，或清除状态筛选。"><button class="btn-secondary" @click="clearFilters">清除筛选</button></EmptyState>
    <section v-for="group in visibleGroups" :key="group.id" class="node-group" :aria-label="group.label">
      <header class="node-group-heading"><span class="node-group-icon" :class="group.tone"><component :is="group.icon" class="h-4 w-4" /></span><h2>{{ group.label }}</h2><span class="count-badge">{{ group.hosts.length }}</span><span class="text-muted">{{ group.description }}</span></header>
      <div class="node-card-grid">
        <article v-for="host in group.hosts" :key="host.id" class="node-card" :class="{ 'node-card-active': host.id === hostsStore.activeHostId }" :aria-label="`节点 ${host.name}`">
          <div class="node-card-heading"><span class="node-card-mark"><Server class="h-5 w-5" /></span><div class="min-w-0 flex-1"><h3 class="truncate" :title="host.name">{{ host.name }}</h3><p class="truncate text-muted" :title="hostAddress(host)">{{ hostAddress(host) }}</p></div><span class="status-badge" :class="statusTone(host)"><span class="status-dot bg-current"></span>{{ statusLabel(host) }}</span></div>
          <div class="node-card-stats"><div><span>运行 / 总容器</span><strong>{{ hasCounts(host) ? `${host.runningCount} / ${host.containerCount}` : '—' }}</strong></div><div><span>响应延迟</span><strong>{{ host.status === 'online' && host.latencyMs != null ? `${host.latencyMs} ms` : '—' }}</strong></div></div>
          <p v-if="host.status === 'offline'" class="node-card-notice">节点暂不可达，可以重新探测或检查连接配置。</p>
          <p v-else-if="!hasCounts(host)" class="node-card-notice">{{ probing.has(host.id) ? '正在读取节点状态…' : '尚无容器统计，点击探测获取。' }}</p>
          <div class="node-card-context"><span v-if="host.id === hostsStore.activeHostId" class="text-status-ok"><CircleCheck class="h-3.5 w-3.5" />当前工作节点</span><button v-else class="text-link" :disabled="!!switchingHost || batchBusy === 'inspection'" @click="switchHost(host)">{{ switchingHost === host.id ? '正在切换…' : '设为工作节点' }}</button><button class="icon-btn icon-btn-sm" :aria-label="`探测节点 ${host.name}`" :disabled="probing.has(host.id)" @click="probe(host)"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': probing.has(host.id) }" /></button></div>
          <footer class="node-card-footer"><router-link :to="deepLink('/monitor', { hostId: host.id, from: 'node-groups' })" class="btn-secondary btn-sm"><Activity class="h-3.5 w-3.5" />监控<ArrowUpRight class="node-action-arrow h-3.5 w-3.5" /></router-link><router-link :to="deepLink('/services', { hostId: host.id, from: 'node-groups' })" class="btn-secondary btn-sm"><Boxes class="h-3.5 w-3.5" />服务<ArrowUpRight class="node-action-arrow h-3.5 w-3.5" /></router-link><select class="input input-sm" :value="host.group || 'production'" :disabled="assigning.has(host.id)" :aria-label="`设置节点 ${host.name} 的分组`" @change="assignGroup(host, $event.target)"><option value="production">生产组</option><option value="staging">测试组</option><option value="edge">边缘组</option></select></footer>
        </article>
      </div>
    </section>
    <section v-if="hosts.length" class="section-panel node-current-actions" aria-label="维护与检查">
      <div><h2 class="section-title">维护与检查</h2><p class="text-muted mt-1">巡检：{{ activeHost?.name || '当前节点' }} 与面板环境 · 镜像检查：全部可编辑项目</p></div>
      <button class="btn-secondary btn-sm" :disabled="!!batchBusy || !!switchingHost" @click="runBatchInspection"><ShieldCheck class="h-4 w-4" />{{ batchBusy === 'inspection' ? '巡检中…' : '运行巡检' }}</button><ImageUpdatePanel />
      <router-link to="/inspection?from=node-groups" class="text-link">查看巡检报告<ArrowUpRight class="h-3.5 w-3.5" /></router-link>
    </section>
  </div>
</template>
<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Activity, ArrowUpRight, Boxes, CircleCheck, FlaskConical, Globe, Plus, RefreshCw, Search, Server, ShieldCheck } from 'lucide-vue-next';
import EmptyState from '../components/common/EmptyState.vue';
import Skeleton from '../components/common/Skeleton.vue';
import MetricTile from '../components/common/MetricTile.vue';
import ImageUpdatePanel from '../components/services/ImageUpdatePanel.vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useHostsStore } from '../stores/hosts.js';
import { useToastStore } from '../stores/toast.js';
import { deepLink } from '../lib/deep-links.js';
import { api } from '../api/client.js';
const route = useRoute();
const router = useRouter();
const hostsStore = useHostsStore();
const toast = useToastStore();
const loading = ref(false);
const error = ref('');
const batchBusy = ref('');
const switchingHost = ref('');
const inspectionScore = ref(null);
const probing = ref(new Set());
const assigning = ref(new Set());
let disposed = false;
let overviewRequest = 0;
const groups = [
  { id: 'production', label: '生产组', description: '正式环境', icon: Server, tone: 'text-status-ok' },
  { id: 'staging', label: '测试组', description: '预发布与测试', icon: FlaskConical, tone: 'text-status-info' },
  { id: 'edge', label: '边缘组', description: '边缘计算', icon: Globe, tone: 'text-violet-300' },
];
const hosts = computed(() => hostsStore.hosts);
const activeHost = computed(() => hostsStore.active);
const onlineCount = computed(() => hosts.value.filter(h => h.status === 'online').length);
const offlineCount = computed(() => hosts.value.filter(h => h.status === 'offline').length);
const unknownCount = computed(() => hosts.value.length - onlineCount.value - offlineCount.value);
const hasCounts = host => host.status === 'online' && Number.isFinite(host.containerCount) && Number.isFinite(host.runningCount);
const knownHosts = computed(() => hosts.value.filter(hasCounts));
const totalContainers = computed(() => knownHosts.value.reduce((sum, h) => sum + h.containerCount, 0));
const totalRunning = computed(() => knownHosts.value.reduce((sum, h) => sum + h.runningCount, 0));
const searchQuery = computed(() => String(route.query.q || ''));
const statusFilter = computed(() => ['online', 'offline', 'unknown'].includes(route.query.status) ? route.query.status : '');
const filteredHosts = computed(() => hosts.value.filter(host => {
  const matches = `${host.name} ${host.host || ''}`.toLocaleLowerCase().includes(searchQuery.value.trim().toLocaleLowerCase());
  return matches && (!statusFilter.value || (['online', 'offline'].includes(host.status) ? host.status : 'unknown') === statusFilter.value);
}));
const visibleGroups = computed(() => groups.map(group => ({ ...group, hosts: filteredHosts.value.filter(h => (h.group || 'production') === group.id) })).filter(g => g.hosts.length));
function setFilter(key, value) { const query = { ...route.query }; if (value) query[key] = value; else delete query[key]; void router.replace({ query }); }
function clearFilters() { const query = { ...route.query }; delete query.q; delete query.status; void router.replace({ query }); }
function hostAddress(host) { return host.type === 'local' ? '本机 Docker' : `${host.type.toUpperCase()} · ${host.host}:${host.port}`; }
function statusLabel(host) { return host.status === 'online' ? '在线' : host.status === 'offline' ? '离线' : '待确认'; }
function statusTone(host) { return host.status === 'online' ? 'bg-status-ok/10 text-status-ok' : host.status === 'offline' ? 'bg-status-error/10 text-status-error' : 'bg-surface-800 text-surface-400'; }
async function assignGroup(host, select) {
  if (assigning.value.has(host.id)) return;
  const previous = host.group || 'production';
  assigning.value.add(host.id);
  try { await hostsStore.assignGroup(host.id, select.value); }
  catch (cause) { select.value = previous; toast.error(cause); }
  finally { assigning.value.delete(host.id); }
}
async function switchHost(host) {
  if (switchingHost.value || host.id === hostsStore.activeHostId) return;
  switchingHost.value = host.id;
  try { await hostsStore.switchHost(host.id); toast.success(`已切换到节点 ${host.name}`); }
  catch (cause) { toast.error(cause); }
  finally { switchingHost.value = ''; }
}
async function probe(host, quiet = false) {
  if (probing.value.has(host.id)) return hostsStore.ping(host.id);
  probing.value.add(host.id);
  try {
    const result = await hostsStore.ping(host.id);
    if (!quiet && !disposed && !result?.ok) toast.error(`节点 ${host.name} 暂不可达，请检查连接配置`);
    return result;
  }
  catch (cause) { if (!quiet) { if (!disposed) toast.error(cause); return null; } throw cause; }
  finally { probing.value.delete(host.id); }
}
async function pingAll() {
  if (batchBusy.value) return;
  batchBusy.value = 'ping';
  try {
    const results = await Promise.allSettled(hosts.value.map(host => probe(host, true)));
    if (disposed) return;
    const failures = results.filter(result => result.status === 'rejected' || result.value?.ok === false).length;
    if (failures) toast.error(`${failures} 个节点探测未完成，请检查连接后重试`);
    else toast.success(`探测完成：${onlineCount.value} 在线，${offlineCount.value} 离线`);
  } finally { batchBusy.value = ''; }
}
async function loadOverview() {
  const request = ++overviewRequest;
  const hostId = hostsStore.activeHostId;
  inspectionScore.value = null;
  try { const result = await api.getInspectionOverview(1); if (!disposed && request === overviewRequest && hostId === hostsStore.activeHostId) inspectionScore.value = result?.latest?.score ?? null; }
  catch { /* 巡检缺失不妨碍节点导航。 */ }
}
async function runBatchInspection() {
  if (batchBusy.value) return;
  batchBusy.value = 'inspection';
  const hostId = hostsStore.activeHostId;
  try {
    const report = await api.runInspection();
    if (disposed || hostId !== hostsStore.activeHostId) return;
    inspectionScore.value = report?.score ?? null;
    toast.success(`巡检完成：评分 ${report?.score ?? '—'}，可查看巡检报告`);
  } catch (cause) { if (!disposed) toast.error(cause); }
  finally { batchBusy.value = ''; }
}
async function load() {
  if (loading.value) return;
  loading.value = true; error.value = '';
  try {
    await hostsStore.load(true);
    if (disposed) return;
    error.value = hostsStore.error;
    if (!error.value) { void Promise.allSettled(hosts.value.map(host => probe(host, true))); void loadOverview(); }
  } catch (cause) { if (!disposed) error.value = cause.message; }
  finally { loading.value = false; }
}
usePullRefresh(load);
onMounted(() => { void load(); window.addEventListener('composeops:host-changed', loadOverview); });
onBeforeUnmount(() => { disposed = true; overviewRequest += 1; window.removeEventListener('composeops:host-changed', loadOverview); });
</script>
