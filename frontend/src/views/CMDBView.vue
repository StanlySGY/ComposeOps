<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">资产中心 (CMDB)</h1>
        <p class="page-subtitle">统一管理主机、项目、容器等资产及其依赖关系,作为知识图谱与事件中心的单一事实来源</p>
      </div>
      <div class="page-actions">
        <button class="btn-secondary" :disabled="syncing" @click="sync"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': syncing }" />{{ syncing ? '同步中…' : '同步资产' }}</button>
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <div class="tabs-segment" role="tablist" aria-label="资产中心视图">
      <button :class="{ active: tab === 'assets' }" role="tab" :aria-selected="tab === 'assets'" @click="setTab('assets')"><Server class="h-4 w-4" />资产清单</button>
      <button :class="{ active: tab === 'graph' }" role="tab" :aria-selected="tab === 'graph'" @click="setTab('graph')"><Waypoints class="h-4 w-4" />知识图谱</button>
    </div>

    <template v-if="tab === 'assets'">
    <p v-if="error" class="alert-error">{{ error }}</p>

    <!-- 概览统计 -->
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div class="section-panel flex items-center gap-3">
        <span class="grid h-10 w-10 place-items-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"><Server class="w-5 h-5" /></span>
        <div><p class="text-2xl font-semibold text-surface-100">{{ hosts.length }}</p><p class="text-xs text-surface-500">主机</p></div>
      </div>
      <div class="section-panel flex items-center gap-3">
        <span class="grid h-10 w-10 place-items-center rounded-xl border border-sky-500/30 bg-sky-500/10 text-sky-300"><Boxes class="w-5 h-5" /></span>
        <div><p class="text-2xl font-semibold text-surface-100">{{ projects.length }}</p><p class="text-xs text-surface-500">项目</p></div>
      </div>
      <div class="section-panel flex items-center gap-3">
        <span class="grid h-10 w-10 place-items-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300"><Container class="w-5 h-5" /></span>
        <div><p class="text-2xl font-semibold text-surface-100">{{ containers.length }}</p><p class="text-xs text-surface-500">容器</p></div>
      </div>
      <div class="section-panel flex items-center gap-3">
        <span class="grid h-10 w-10 place-items-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300"><Waypoints class="w-5 h-5" /></span>
        <div><p class="text-2xl font-semibold text-surface-100">{{ relations.length }}</p><p class="text-xs text-surface-500">依赖关系</p></div>
      </div>
    </div>

    <!-- 资产列表 -->
    <section class="section-panel">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><h2 class="section-title">资产清单</h2><p class="mt-1 text-muted">按类型过滤,查看资产状态与归属</p></div>
        <div class="flex flex-wrap gap-2">
          <button v-for="k in kinds" :key="k.value" class="btn-secondary px-3! py-1.5! text-xs" :class="{ 'border-accent! text-accent!': kindFilter === k.value }" @click="kindFilter = k.value">{{ k.label }}</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>资产</th><th>类型</th><th>状态</th><th>环境</th><th>负责人</th><th>来源</th><th></th></tr></thead>
          <tbody>
            <tr v-for="asset in filteredAssets" :key="asset.id" class="hover:bg-surface-800/25">
              <td class="font-medium text-surface-100">{{ asset.displayName || asset.name }}<span class="ml-2 font-mono text-[10px] text-surface-600">{{ asset.id }}</span></td>
              <td><span class="count-badge" :class="kindTone(asset.kind)">{{ kindLabel(asset.kind) }}</span></td>
              <td><span class="status-badge" :class="statusTone(asset.status)">{{ statusLabel(asset.status) }}</span></td>
              <td class="text-xs text-surface-400">{{ asset.environment || '—' }}</td>
              <td class="text-xs text-surface-400">{{ asset.owner || '—' }}</td>
              <td class="text-xs text-surface-500">{{ sourceLabel(asset.source) }}</td>
              <td><button class="icon-btn" title="删除资产" @click="deleteTarget = asset"><Trash2 class="w-4 h-4" /></button></td>
            </tr>
            <tr v-if="!filteredAssets.length"><td colspan="7" class="py-8 text-center text-sm text-surface-500">暂无资产,点击「同步资产」从 Docker 扫描重建</td></tr>
          </tbody>
        </table>
      </div>
    </section>
    </template>
    <KnowledgeGraphView v-else embedded />
    <ConfirmDialog :show="!!deleteTarget" title="删除资产" :message="`确认删除资产「${deleteTarget?.displayName || deleteTarget?.name}」?`" tone="danger" confirm-text="删除" @confirm="confirmRemove" @cancel="deleteTarget = null" />
  </div>
</template>

<script setup>
import { computed, onActivated, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Boxes, Container, RefreshCw, Server, Trash2, Waypoints } from 'lucide-vue-next';
import { useCmdbStore } from '../stores/cmdb.js';
import { useToastStore } from '../stores/toast.js';
import KnowledgeGraphView from './KnowledgeGraphView.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';

const route = useRoute();
const router = useRouter();
const tab = ref(route.query.tab === 'graph' ? 'graph' : 'assets');
function setTab(next) {
  tab.value = next;
  const query = { ...route.query };
  if (next === 'graph') query.tab = 'graph'; else delete query.tab;
  router.replace({ query });
}
watch(() => route.query.tab, (value) => { tab.value = value === 'graph' ? 'graph' : 'assets'; });

const cmdb = useCmdbStore();
const toast = useToastStore();
const kindFilter = ref('');

const kinds = [
  { value: '', label: '全部' },
  { value: 'host', label: '主机' },
  { value: 'project', label: '项目' },
  { value: 'container', label: '容器' },
  { value: 'volume', label: '卷' },
  { value: 'network', label: '网络' },
];

const hosts = computed(() => cmdb.hosts);
const projects = computed(() => cmdb.projects);
const containers = computed(() => cmdb.containers);
const relations = computed(() => cmdb.relations);
const loading = computed(() => cmdb.loading);
const syncing = computed(() => cmdb.syncing);
const error = computed(() => cmdb.error);

const filteredAssets = computed(() => {
  if (!kindFilter.value) return cmdb.assets;
  return cmdb.assets.filter((a) => a.kind === kindFilter.value);
});

function kindLabel(kind) {
  return { host: '主机', project: '项目', container: '容器', volume: '卷', network: '网络', service: '服务' }[kind] || kind;
}
function kindTone(kind) {
  return { host: 'text-emerald-300', project: 'text-sky-300', container: 'text-violet-300', volume: 'text-amber-300', network: 'text-rose-300' }[kind] || 'text-surface-300';
}
function statusLabel(status) {
  return { online: '在线', offline: '离线', running: '运行中', stopped: '已停止', partial: '部分', unknown: '未知' }[status] || status;
}
function statusTone(status) {
  // 与 StatusBadge 语义对齐:stopped 是正常态用中性灰,offline(宿主不可达)才是异常红。
  if (['online', 'running'].includes(status)) return 'bg-emerald-500/10 text-emerald-400';
  if (status === 'stopped') return 'bg-surface-800/40 text-surface-400';
  if (status === 'offline') return 'bg-rose-500/10 text-rose-400';
  if (status === 'partial') return 'bg-amber-500/10 text-amber-400';
  return 'bg-surface-800 text-surface-400';
}
function sourceLabel(source) {
  return { manual: '手动', scanner: '扫描', docker: 'Docker' }[source] || source;
}

async function load() {
  await cmdb.loadTopology();
}
async function sync() {
  try {
    await cmdb.sync();
    toast.success('资产同步完成');
  } catch (e) {
    toast.error(e.message);
  }
}
const deleteTarget = ref(null);
async function confirmRemove() {
  const asset = deleteTarget.value;
  deleteTarget.value = null;
  if (!asset) return;
  try {
    await cmdb.remove(asset.id);
    toast.success('资产已删除');
  } catch (e) {
    toast.error(e.message);
  }
}

onMounted(load);
let activatedOnce = false;
onActivated(() => { if (activatedOnce) void load(); activatedOnce = true; });

</script>