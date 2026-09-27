<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">节点组管理</h1>
        <p class="page-subtitle">将 Docker 节点分组管理,支持批量部署、巡检与更新</p>
      </div>
      <div class="page-actions">
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>

    <!-- 节点组 -->
    <div class="grid gap-4 lg:grid-cols-3">
      <section v-for="group in groups" :key="group.id" class="section-panel">
        <div class="mb-4 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="grid h-8 w-8 place-items-center rounded-lg border" :class="group.tone">{{ group.icon }}</span>
            <div>
              <h2 class="section-title !mb-0">{{ group.label }}</h2>
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
            <span v-if="host.active" class="count-badge text-emerald-300">活跃</span>
            <button class="icon-btn" :title="host.active ? '当前活跃节点' : '切换到此节点'" :disabled="host.active" @click="switchHost(host)"><ArrowLeftRight class="w-4 h-4" /></button>
          </div>
        </div>

        <div class="mt-4 flex gap-2 border-t border-surface-800 pt-3">
          <button class="btn-secondary flex-1 !px-2 !py-1.5 text-xs" :disabled="!groupHosts(group.id).length" @click="batchAction(group.id, 'inspection')"><ShieldCheck class="w-3.5 h-3.5" />巡检</button>
          <button class="btn-secondary flex-1 !px-2 !py-1.5 text-xs" :disabled="!groupHosts(group.id).length" @click="batchAction(group.id, 'updates')"><RefreshCw class="w-3.5 h-3.5" />检查更新</button>
        </div>
      </section>
    </div>

    <!-- 节点列表 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">全部节点</h2><p class="mt-1 text-muted">管理所有 Docker 节点及其分组</p></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>节点</th><th>类型</th><th>地址</th><th>分组</th><th>状态</th><th>延迟</th></tr></thead>
          <tbody>
            <tr v-for="host in hosts" :key="host.id" class="hover:bg-surface-800/25">
              <td class="font-medium text-surface-100">{{ host.name }}<span v-if="host.active" class="ml-2 count-badge text-emerald-300">活跃</span></td>
              <td><span class="count-badge text-sky-300">{{ host.type.toUpperCase() }}</span></td>
              <td class="font-mono text-xs text-surface-400">{{ host.type === 'local' ? '本机' : `${host.host}:${host.port}` }}</td>
              <td>
                <select class="input !py-1 text-xs" :value="groupOf(host.id)" @change="assignGroup(host, $event.target.value)">
                  <option value="production">生产</option>
                  <option value="staging">测试</option>
                  <option value="edge">边缘</option>
                </select>
              </td>
              <td><span class="status-badge" :class="host.status === 'online' ? 'bg-emerald-500/10 text-emerald-400' : host.status === 'offline' ? 'bg-rose-500/10 text-rose-400' : 'bg-surface-800 text-surface-400'">{{ host.status === 'online' ? '在线' : host.status === 'offline' ? '离线' : '未知' }}</span></td>
              <td class="font-mono text-xs text-surface-400">{{ host.latencyMs ? `${host.latencyMs}ms` : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ArrowLeftRight, RefreshCw, ShieldCheck } from 'lucide-vue-next';
import { useHostsStore } from '../stores/hosts.js';
import { useToastStore } from '../stores/toast.js';

const hostsStore = useHostsStore();
const toast = useToastStore();
const loading = ref(false);
const error = ref('');
const groupAssignments = ref({});

const groups = [
  { id: 'production', label: '生产组', description: '正式环境节点', icon: '生', tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
  { id: 'staging', label: '测试组', description: '预发布与测试节点', icon: '测', tone: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
  { id: 'edge', label: '边缘组', description: '边缘计算节点', icon: '边', tone: 'border-violet-500/40 bg-violet-500/10 text-violet-300' },
];

const hosts = computed(() => hostsStore.hosts);
function groupHosts(groupId) {
  return hosts.value.filter((h) => groupOf(h.id) === groupId);
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
function batchAction(groupId, action) {
  const groupHostsList = groupHosts(groupId);
  const names = groupHostsList.map((h) => h.name).join('、');
  toast.info(`${groups.find((g) => g.id === groupId)?.label}(${names}) 已发起${action === 'inspection' ? '巡检' : '更新检查'}`);
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
  } catch (e) {
    error.value = e.message || '节点加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>
