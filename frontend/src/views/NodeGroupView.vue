<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">节点组管理</h1>
        <p class="page-subtitle">多节点舰队视图:按组归置节点,批量巡检与镜像检查</p>
      </div>
      <div class="page-actions">
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>

    <!-- 舰队总览 -->
    <div class="metric-grid">
      <MetricTile title="节点" :value="String(hosts.length)" :sub="`${onlineCount} 在线 · ${offlineCount} 离线`" tone="text-sky-400" />
      <MetricTile title="容器总数" :value="String(totalContainers)" :sub="`${totalRunning} 运行中`" tone="text-status-ok" />
      <MetricTile title="巡检评分" :value="inspectionScore ?? '—'" :sub="inspectionScore ? '最近一次巡检' : '尚未巡检'" tone="text-violet-400" />
    </div>

    <!-- 批量动作 -->
    <div class="section-panel py-3 flex flex-wrap items-center gap-2">
      <span class="text-xs font-medium text-surface-300">批量动作</span>
      <button class="btn-secondary btn-sm" :disabled="batchBusy || !hosts.length" @click="pingAll">
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': batchBusy === 'ping' }" />探测全部节点
      </button>
      <button class="btn-secondary btn-sm" :disabled="batchBusy || !hosts.length" @click="runBatchInspection">
        <ShieldCheck class="h-3.5 w-3.5" :class="{ 'animate-spin': batchBusy === 'inspection' }" />巡检(当前节点项目)
      </button>
      <ImageUpdatePanel />
      <span class="ml-auto text-xs text-surface-400">巡检作用于当前活跃节点:{{ activeHost?.name || '—' }}</span>
    </div>

    <!-- 节点组 -->
    <div class="grid gap-4 lg:grid-cols-3">
      <section v-for="group in groups" :key="group.id" class="section-panel">
        <div class="mb-4 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="grid h-8 w-8 place-items-center rounded-lg border" :class="group.tone">{{ group.icon }}</span>
            <div>
              <h2 class="section-title mb-0!">{{ group.label }}</h2>
              <p class="text-xs text-surface-400">{{ group.description }}</p>
            </div>
          </div>
          <span class="count-badge">{{ groupHosts(group.id).length }} 节点</span>
        </div>

        <EmptyState v-if="!groupHosts(group.id).length" compact title="此分组暂无节点" description="在节点管理中添加连接，或调整已有节点的分组。"><router-link to="/settings?tab=hosts&from=node-groups" class="btn-secondary btn-sm">管理节点</router-link></EmptyState>
        <div v-else class="space-y-2">
          <div v-for="host in groupHosts(group.id)" :key="host.id" class="flex items-center gap-3 rounded-xl border border-surface-800 bg-surface-950/40 p-3">
            <span class="h-2 w-2 shrink-0 rounded-full" :class="host.status === 'online' ? 'bg-status-ok' : host.status === 'offline' ? 'bg-status-error' : 'bg-surface-500'"></span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-surface-100">{{ host.name }}</p>
              <p class="truncate text-xs text-surface-400">{{ host.type === 'local' ? '本机 Docker' : `${host.type.toUpperCase()} · ${host.host}:${host.port}` }}</p>
            </div>
            <span class="count-badge">{{ host.runningCount ?? 0 }}/{{ host.containerCount ?? 0 }} 运行</span>
            <span v-if="host.latencyMs != null" class="count-badge" :class="host.latencyMs < 300 ? 'text-status-ok' : 'text-status-warn'">{{ host.latencyMs }}ms</span>
            <span v-if="host.active" class="count-badge text-status-ok">活跃</span>
            <button class="icon-btn" :title="host.active ? '当前活跃节点' : '切换到此节点'" :aria-label="host.active ? '当前活跃节点' : `切换到节点 ${host.name}`" :disabled="host.active || pinging === host.id" @click="switchHost(host)"><ArrowLeftRight class="w-4 h-4" /></button>
          </div>
        </div>
      </section>
    </div>

    <!-- 节点列表 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">全部节点</h2><p class="mt-1 text-muted">管理所有 Docker 节点及其分组</p></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>节点</th><th>类型</th><th>地址</th><th>分组</th><th>状态</th><th>容器</th><th>延迟</th></tr></thead>
          <tbody>
            <tr v-for="host in hosts" :key="host.id" class="hover:bg-surface-800/25">
              <td class="font-medium text-surface-100">{{ host.name }}<span v-if="host.active" class="ml-2 count-badge text-status-ok">活跃</span></td>
              <td><span class="count-badge text-sky-300">{{ host.type.toUpperCase() }}</span></td>
              <td class="font-mono text-xs text-surface-400">{{ host.type === 'local' ? '本机' : `${host.host}:${host.port}` }}</td>
              <td>
                <select class="input input-sm" :value="groupOf(host.id)" :aria-label="`设置节点 ${host.name} 的分组`" @change="assignGroup(host, $event.target.value)">
                  <option value="production">生产</option>
                  <option value="staging">测试</option>
                  <option value="edge">边缘</option>
                </select>
              </td>
              <td><span class="status-badge" :class="host.status === 'online' ? 'bg-status-ok/10 text-status-ok' : host.status === 'offline' ? 'bg-status-error/10 text-status-error' : 'bg-surface-800 text-surface-400'">{{ host.status === 'online' ? '在线' : host.status === 'offline' ? '离线' : '未知' }}</span></td>
              <td class="font-mono text-xs text-surface-400">{{ host.runningCount ?? 0 }}/{{ host.containerCount ?? 0 }}</td>
              <td class="font-mono text-xs text-surface-400">{{ host.latencyMs != null ? `${host.latencyMs}ms` : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup>
import EmptyState from '../components/common/EmptyState.vue';
import { computed, onMounted, ref } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { ArrowLeftRight, RefreshCw, ShieldCheck } from 'lucide-vue-next';
import { useHostsStore } from '../stores/hosts.js';
import { useToastStore } from '../stores/toast.js';
import { api } from '../api/client.js';
import MetricTile from '../components/common/MetricTile.vue';
import ImageUpdatePanel from '../components/services/ImageUpdatePanel.vue';

const hostsStore = useHostsStore();
const toast = useToastStore();
const loading = ref(false);
const error = ref('');
const batchBusy = ref('');
const inspectionScore = ref(null);

const groups = [
  { id: 'production', label: '生产组', description: '正式环境节点', icon: '生', tone: 'border-status-ok/40 bg-status-ok/10 text-status-ok' },
  { id: 'staging', label: '测试组', description: '预发布与测试节点', icon: '测', tone: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
  { id: 'edge', label: '边缘组', description: '边缘计算节点', icon: '边', tone: 'border-violet-500/40 bg-violet-500/10 text-violet-300' },
];

const hosts = computed(() => hostsStore.hosts);
const activeHost = computed(() => hostsStore.active);
const pinging = computed(() => hostsStore.pinging);
const onlineCount = computed(() => hosts.value.filter((host) => host.status === 'online').length);
const offlineCount = computed(() => hosts.value.filter((host) => host.status === 'offline').length);
const totalContainers = computed(() => hosts.value.reduce((sum, host) => sum + (Number(host.containerCount) || 0), 0));
const totalRunning = computed(() => hosts.value.reduce((sum, host) => sum + (Number(host.runningCount) || 0), 0));

function groupHosts(groupId) {
  return hosts.value.filter((host) => groupOf(host.id) === groupId);
}
function groupOf(hostId) {
  return hosts.value.find(host => host.id === hostId)?.group || 'production';
}
async function assignGroup(host, groupId) {
  try {
    await hostsStore.assignGroup(host.id, groupId);
    toast.success(`已将节点 ${host.name} 加入${groups.find(g => g.id === groupId)?.label}`);
  } catch (e) { toast.error(`分组保存失败：${e.message}`); }
}
function switchHost(host) {
  if (host.active) return;
  hostsStore.switchHost(host.id).then(() => {
    toast.success(`已切换到节点 ${host.name}`);
  }).catch((e) => toast.error(e));
}

/** 并行探测全部节点:刷新容器数/运行数/延迟/在线状态(舰队视图数据源)。 */
async function pingAll() {
  if (batchBusy.value) return;
  batchBusy.value = 'ping';
  try {
    await Promise.allSettled(hosts.value.map((host) => hostsStore.ping(host.id)));
    toast.success(`已探测 ${hosts.value.length} 个节点：${onlineCount.value} 在线`);
  } finally {
    batchBusy.value = '';
  }
}

async function runBatchInspection() {
  if (batchBusy.value) return;
  batchBusy.value = 'inspection';
  try {
    const report = await api.runInspection();
    inspectionScore.value = report?.score ?? null;
    toast.success(`巡检完成：${report?.summary || ''}(评分 ${report?.score ?? '—'})`);
  } catch (e) {
    toast.error(`巡检失败：${e.message}`);
  } finally {
    batchBusy.value = '';
  }
}



async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    await hostsStore.load(true);
    // 静默并行探测一次,填充容器数/延迟(不阻塞页面)。
    Promise.allSettled(hosts.value.map((host) => hostsStore.ping(host.id))).then(async () => {
      try {
        const overview = await api.getInspectionOverview(1);
        inspectionScore.value = overview?.latest?.score ?? null;
      } catch { /* 巡检数据缺失不影响页面 */ }
    });
  } catch (e) {
    error.value = e.message || '节点加载失败';
  } finally {
    loading.value = false;
  }
}

usePullRefresh(load);
onMounted(load);
</script>
