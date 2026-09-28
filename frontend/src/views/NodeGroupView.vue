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

    <p v-if="error" class="alert-error">{{ error }}</p>

    <!-- 舰队总览 -->
    <div class="metric-grid">
      <StatCard title="节点" :value="String(hosts.length)" :sub="`${onlineCount} 在线 · ${offlineCount} 离线`" tone="bg-sky-400" />
      <StatCard title="容器总数" :value="String(totalContainers)" :sub="`${totalRunning} 运行中`" tone="bg-emerald-400" />
      <StatCard title="巡检评分" :value="inspectionScore ?? '—'" :sub="inspectionScore ? '最近一次巡检' : '尚未巡检'" tone="bg-violet-400" />
    </div>

    <!-- 批量动作 -->
    <div class="section-panel py-3! flex flex-wrap items-center gap-2">
      <span class="text-xs font-medium text-surface-300">批量动作</span>
      <button class="btn-secondary py-1.5! text-xs" :disabled="batchBusy || !hosts.length" @click="pingAll">
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': batchBusy === 'ping' }" />探测全部节点
      </button>
      <button class="btn-secondary py-1.5! text-xs" :disabled="batchBusy || !hosts.length" @click="runBatchInspection">
        <ShieldCheck class="h-3.5 w-3.5" :class="{ 'animate-spin': batchBusy === 'inspection' }" />巡检(当前节点项目)
      </button>
      <button class="btn-secondary py-1.5! text-xs" :disabled="batchBusy || !hosts.length" @click="runBatchUpdateCheck">
        <SearchCheck class="h-3.5 w-3.5" :class="{ 'animate-spin': batchBusy === 'updates' }" />镜像更新检查(全部项目)
      </button>
      <span class="ml-auto text-xs text-surface-500">巡检作用于当前活跃节点:{{ activeHost?.name || '—' }}</span>
    </div>

    <!-- 节点组 -->
    <div class="grid gap-4 lg:grid-cols-3">
      <section v-for="group in groups" :key="group.id" class="section-panel">
        <div class="mb-4 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="grid h-8 w-8 place-items-center rounded-lg border" :class="group.tone">{{ group.icon }}</span>
            <div>
              <h2 class="section-title mb-0!">{{ group.label }}</h2>
              <p class="text-xs text-surface-500">{{ group.description }}</p>
            </div>
          </div>
          <span class="count-badge">{{ groupHosts(group.id).length }} 节点</span>
        </div>

        <div v-if="!groupHosts(group.id).length" class="rounded-xl border border-dashed border-surface-700 p-4 text-center text-sm text-surface-500">暂无节点</div>
        <div v-else class="space-y-2">
          <div v-for="host in groupHosts(group.id)" :key="host.id" class="flex items-center gap-3 rounded-xl border border-surface-800 bg-surface-950/40 p-3">
            <span class="h-2 w-2 shrink-0 rounded-full" :class="host.status === 'online' ? 'bg-emerald-400' : host.status === 'offline' ? 'bg-rose-400' : 'bg-surface-500'"></span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-surface-100">{{ host.name }}</p>
              <p class="truncate text-xs text-surface-500">{{ host.type === 'local' ? '本机 Docker' : `${host.type.toUpperCase()} · ${host.host}:${host.port}` }}</p>
            </div>
            <span class="count-badge">{{ host.runningCount ?? 0 }}/{{ host.containerCount ?? 0 }} 运行</span>
            <span v-if="host.latencyMs != null" class="count-badge" :class="host.latencyMs < 300 ? 'text-emerald-300' : 'text-amber-300'">{{ host.latencyMs }}ms</span>
            <span v-if="host.active" class="count-badge text-emerald-300">活跃</span>
            <button class="icon-btn" :title="host.active ? '当前活跃节点' : '切换到此节点'" :disabled="host.active || pinging === host.id" @click="switchHost(host)"><ArrowLeftRight class="w-4 h-4" /></button>
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
              <td class="font-medium text-surface-100">{{ host.name }}<span v-if="host.active" class="ml-2 count-badge text-emerald-300">活跃</span></td>
              <td><span class="count-badge text-sky-300">{{ host.type.toUpperCase() }}</span></td>
              <td class="font-mono text-xs text-surface-400">{{ host.type === 'local' ? '本机' : `${host.host}:${host.port}` }}</td>
              <td>
                <select class="input py-1! text-xs" :value="groupOf(host.id)" @change="assignGroup(host, $event.target.value)">
                  <option value="production">生产</option>
                  <option value="staging">测试</option>
                  <option value="edge">边缘</option>
                </select>
              </td>
              <td><span class="status-badge" :class="host.status === 'online' ? 'bg-emerald-500/10 text-emerald-400' : host.status === 'offline' ? 'bg-rose-500/10 text-rose-400' : 'bg-surface-800 text-surface-400'">{{ host.status === 'online' ? '在线' : host.status === 'offline' ? '离线' : '未知' }}</span></td>
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
import { computed, onMounted, ref } from 'vue';
import { ArrowLeftRight, RefreshCw, SearchCheck, ShieldCheck } from 'lucide-vue-next';
import { useHostsStore } from '../stores/hosts.js';
import { useToastStore } from '../stores/toast.js';
import { api } from '../api/client.js';
import StatCard from '../components/StatCard.vue';

const hostsStore = useHostsStore();
const toast = useToastStore();
const loading = ref(false);
const error = ref('');
const groupAssignments = ref({});
const batchBusy = ref('');
const inspectionScore = ref(null);

const groups = [
  { id: 'production', label: '生产组', description: '正式环境节点', icon: '生', tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
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
  return groupAssignments.value[hostId] || 'production';
}
function assignGroup(host, groupId) {
  groupAssignments.value = { ...groupAssignments.value, [host.id]: groupId };
  try { localStorage.setItem('composeops:node-groups', JSON.stringify(groupAssignments.value)); } catch {
    // 节点分组仍保留在当前会话,仅无法持久化到下次访问。
  }
  toast.success(`已将节点 ${host.name} 加入${groups.find((g) => g.id === groupId)?.label}`);
}
function switchHost(host) {
  if (host.active) return;
  hostsStore.switchHost(host.id).then(() => {
    toast.success(`已切换到节点 ${host.name}`);
  }).catch((e) => toast.error(e.message));
}

/** 并行探测全部节点:刷新容器数/运行数/延迟/在线状态(舰队视图数据源)。 */
async function pingAll() {
  if (batchBusy.value) return;
  batchBusy.value = 'ping';
  try {
    await Promise.allSettled(hosts.value.map((host) => hostsStore.ping(host.id)));
    toast.success(`已探测 ${hosts.value.length} 个节点:${onlineCount.value} 在线`);
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
    toast.success(`巡检完成:${report?.summary || ''}(评分 ${report?.score ?? '—'})`);
  } catch (e) {
    toast.error(`巡检失败:${e.message}`);
  } finally {
    batchBusy.value = '';
  }
}

async function runBatchUpdateCheck() {
  if (batchBusy.value) return;
  batchBusy.value = 'updates';
  try {
    const result = await api.checkAllUpdates();
    const projects = result?.projects || [];
    const withUpdate = projects.filter((project) => project.hasUpdate).length;
    const unreachable = projects.reduce((sum, project) => sum + (project.images || []).filter((image) => image.reachable === false).length, 0);
    toast.success(`镜像检查完成:${projects.length} 个项目,${withUpdate} 个有更新${unreachable ? `,${unreachable} 个仓库不可达` : ''}`);
  } catch (e) {
    toast.error(`镜像检查失败:${e.message}`);
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
    try {
      const saved = JSON.parse(localStorage.getItem('composeops:node-groups') || '{}');
      groupAssignments.value = saved;
    } catch {
      // 分组记忆损坏时回退到默认生产组。
    }
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

onMounted(load);
</script>
