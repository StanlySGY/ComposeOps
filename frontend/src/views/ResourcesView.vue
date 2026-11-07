<template>
  <div class="page-shell page-shell-workspace">
    <div class="page-header">
      <div><h1 class="page-title">存储资源</h1><p class="page-subtitle">批量清理悬空镜像、孤儿卷与闲置网络</p></div>
      <div class="page-actions">
        <button v-if="selected.length > 0" class="btn-danger" :disabled="busy" @click="batchRemove"><Trash2 class="w-4 h-4" />批量删除 ({{ selected.length }})</button>
        <button class="btn-secondary" :disabled="loading" @click="refresh"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>

    <!-- 批量删除进度:逐项删除可能较慢,实时显示已完成数与当前目标 -->
    <section v-if="busy && batchProgress.total > 0" class="section-panel py-3" role="status" aria-live="polite" aria-atomic="true">
      <div class="flex items-center justify-between gap-3 text-sm">
        <span class="text-surface-200">正在批量删除 <b class="text-sky-300 tabular-nums">{{ batchProgress.done }}</b> / {{ batchProgress.total }}</span>
        <span class="min-w-0 flex-1 truncate text-right font-mono text-xs text-surface-400">{{ batchProgress.current }}</span>
      </div>
      <div class="progress mt-2"><span :style="{ width: Math.round(batchProgress.done / batchProgress.total * 100) + '%' }"></span></div>
    </section>

    <section v-if="data" class="grid gap-3 sm:grid-cols-3" aria-label="可清理资源概况">
      <MetricTile title="悬空镜像" :value="data.counts.danglingImages" :icon="Layers" sub="没有标签的镜像" />
      <MetricTile title="孤儿卷" :value="data.counts.orphanVolumes" :icon="Database" sub="未被容器引用" />
      <MetricTile title="闲置网络" :value="data.counts.unusedNetworks" :icon="Network" sub="没有容器接入" />
    </section>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="tabs-segment" role="tablist" aria-label="资源类型" @keydown="handleTablistKeydown($event, switchTab)">
        <button v-for="tab in tabs" :id="`resource-tab-${tab.key}`" :key="tab.key" :data-tab="tab.key" :class="{ active: activeTab === tab.key }" role="tab" :aria-selected="activeTab === tab.key" :tabindex="activeTab === tab.key ? 0 : -1" aria-controls="resource-panel" :disabled="busy" @click="switchTab(tab.key)">{{ tab.label }}<span v-if="tab.countKey !== '__none__'" class="count-badge">{{ data?.counts?.[tab.countKey] ?? 0 }}</span></button>
      </div>
      <div v-if="activeTab !== 'backups'" class="flex min-w-0 flex-wrap items-center gap-2">
        <input v-model="searchQuery" type="search" class="input input-sm w-48 max-w-full" aria-label="搜索存储资源" placeholder="搜索名称或标签…" />
        <select v-model="filterStatus" class="input input-sm w-32" aria-label="按资源状态筛选"><option value="">全部状态</option><option v-for="status in statusOptions" :key="status.value" :value="status.value">{{ status.label }}</option></select>
      </div>
    </div>

    <Skeleton v-if="loading && !data && activeTab !== 'backups'" variant="table" :rows="6" label="资源清单加载中" />

    <section id="resource-panel" role="tabpanel" :aria-labelledby="`resource-tab-${activeTab}`" v-if="activeTab === 'backups'" class="section-panel flex-1 mt-4">
      <VolumeBackupPanel :initial-project-id="String(route.query.projectId || '')" />
    </section>

    <section id="resource-panel" role="tabpanel" :aria-labelledby="`resource-tab-${activeTab}`" v-if="data && activeTab !== 'backups'" class="section-panel flex-1 mt-4">
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th class="w-12">
                <input type="checkbox" :checked="allSelected" :indeterminate="someSelected" @change="toggleAll" class="checkbox" aria-label="全选可删除资源" />
              </th>
              <th v-if="activeTab === 'images'">镜像</th>
              <th v-else-if="activeTab === 'volumes'">卷名</th>
              <th v-else>网络</th>
              <th>状态</th>
              <th>创建时间</th>
              <th class="text-right">大小</th>
              <th class="text-right min-w-24">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!filteredRows.length">
              <td :colspan="7" class="text-center text-muted py-6">
                <EmptyState compact icon="CircleCheckBig" :title="searchQuery || filterStatus ? '未找到匹配资源' : `当前没有${tabLabel}可清理`" :description="searchQuery || filterStatus ? '清除筛选，查看当前节点的所有资源。' : '使用中的资源会受到保护，可刷新列表检查最新状态。'" :action-label="searchQuery || filterStatus ? '清除筛选' : '刷新列表'" @action="searchQuery || filterStatus ? (searchQuery = '', filterStatus = '') : refresh()" />
              </td>
            </tr>
            <tr v-for="row in filteredRows" :key="row.key" class="hover:bg-surface-800/25">
              <td class="text-center">
                <input v-if="row.deletable" type="checkbox" :checked="selected.includes(row.key)" :aria-label="`选择资源 ${row.primary}`" @change="toggleRow(row.key)" class="checkbox" />
              </td>
              <td class="max-w-xs truncate font-mono tabular-nums" :title="row.title">{{ row.primary }}<span v-if="row.note" class="ml-2 text-muted text-xs">{{ row.note }}</span></td>
              <td><StatusBadge :status="row.statusValue" :label="row.statusLabel" /></td>
              <td class="text-muted text-sm">{{ row.createdAt ? formatTime(row.createdAt) : '—' }}</td>
              <td class="text-right font-mono tabular-nums whitespace-nowrap">{{ formatBytes(row.size) }}</td>
              <td class="text-right">
                <button v-if="row.deletable" class="btn-secondary btn-sm" :disabled="busy" @click="confirmRemove(row)">删除</button>
                <span v-else class="text-muted text-xs">{{ row.undeletableReason }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <ConfirmDialog :show="bulkDeleteOpen" title="批量删除资源" :message="`确认批量删除 ${selected.length} 项资源?删除后无法恢复。`" tone="danger" confirm-text="批量删除" @confirm="performBatchRemove" @cancel="bulkDeleteOpen = false" />
    <ConfirmDialog :show="!!removeTarget" title="删除资源" :message="`确认删除 ${removeTarget?.primary || ''}?删除后无法恢复。`" tone="danger" confirm-text="删除" @confirm="performRemove" @cancel="removeTarget = null" />
  </div>
</template>

<script setup>
import MetricTile from '../components/common/MetricTile.vue';
import EmptyState from '../components/common/EmptyState.vue';
import StatusBadge from '../components/common/StatusBadge.vue';
import { useToastStore } from '../stores/toast.js';
import { handleTablistKeydown } from '../lib/tablist-keyboard.js';
import { useRoute } from 'vue-router';
const route = useRoute();
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { RefreshCw, Trash2, Layers, Database, Network } from 'lucide-vue-next';
import { api } from '../api/client.js';
import Skeleton from '../components/common/Skeleton.vue';
import VolumeBackupPanel from '../components/resources/VolumeBackupPanel.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';

const data = ref(null);
const loading = ref(false);
const error = ref('');
const toast = useToastStore();
const activeTab = ref(['images', 'volumes', 'networks', 'backups'].includes(route.query.tab) ? route.query.tab : 'images');
watch(() => route.query.tab, value => { if (['images', 'volumes', 'networks', 'backups'].includes(value)) switchTab(value); });
const busy = ref(false);
const selected = ref([]);
const batchProgress = ref({ total: 0, done: 0, current: '' });
const searchQuery = ref('');
const filterStatus = ref('');
const bulkDeleteOpen = ref(false);
const removeTarget = ref(null);

const tabs = [
  { key: 'images', label: '镜像', countKey: 'images' },
  { key: 'volumes', label: '卷', countKey: 'volumes' },
  { key: 'networks', label: '网络', countKey: 'networks' },
  { key: 'backups', label: '卷备份', countKey: '__none__' },
];
const tabLabel = computed(() => tabs.find((t) => t.key === activeTab.value)?.label || '');

const statusOptions = computed(() => {
  if (activeTab.value === 'images') {
    return [
      { value: 'dangling', label: '悬空' },
      { value: 'inUse', label: '使用中' },
      { value: 'unused', label: '未使用' },
    ];
  }
  if (activeTab.value === 'volumes') {
    return [
      { value: 'orphan', label: '孤儿' },
      { value: 'referenced', label: '被引用' },
    ];
  }
  return [
    { value: 'builtin', label: '内置' },
    { value: 'unused', label: '闲置' },
    { value: 'attached', label: '已接入' },
  ];
});

const images = computed(() => data.value?.images || []);
const volumes = computed(() => data.value?.volumes || []);
const networks = computed(() => data.value?.networks || []);

const rows = computed(() => {
  if (activeTab.value === 'images') {
    return images.value.map((img) => ({
      key: `image:${img.id}`,
      primary: img.tags[0] || (img.id || '').slice(0, 12),
      title: img.tags.join('\n') || img.id,
      note: img.tags.length > 1 ? `+${img.tags.length - 1}` : '',
      tone: img.dangling ? 'amber' : img.inUse ? 'sky' : 'green',

      statusLabel: img.dangling ? '悬空' : img.inUse ? '使用中' : '未使用',
      statusValue: img.dangling ? 'dangling' : img.inUse ? 'inUse' : 'unused',
      size: img.size,
      createdAt: img.created,
      deletable: !img.inUse,
      undeletableReason: img.inUse ? '被容器引用' : '',
    })).sort((a, b) => (a.deletable === b.deletable ? b.size - a.size : a.deletable ? -1 : 1));
  }
  if (activeTab.value === 'volumes') {
    return volumes.value.map((vol) => ({
      key: `volume:${vol.name}`,
      primary: vol.name,
      title: `driver=${vol.driver} scope=${vol.scope}\nmountpoint=${vol.mountpoint}`,
      tone: vol.orphan ? 'amber' : 'green',

      statusLabel: vol.orphan ? '孤儿' : `被引用 ×${vol.refCount}`,
      statusValue: vol.orphan ? 'orphan' : 'referenced',
      size: vol.size,
      createdAt: vol.createdAt,
      deletable: vol.orphan,
      undeletableReason: '被容器挂载',
    })).sort((a, b) => (a.deletable === b.deletable ? b.size - a.size : a.deletable ? -1 : 1));
  }
  return networks.value.map((net) => ({
    key: `network:${net.id}`,
    primary: net.name,
    title: `driver=${net.driver} scope=${net.scope}${net.internal ? ' internal' : ''}`,
    tone: net.unused ? 'amber' : net.builtin ? 'slate' : 'green',

    statusLabel: net.builtin ? '内置' : net.unused ? '闲置' : `接入 ${net.attached}`,
    statusValue: net.builtin ? 'builtin' : net.unused ? 'unused' : 'attached',
    size: 0,
    createdAt: net.createdAt,
    deletable: net.unused,
    undeletableReason: net.builtin ? 'Docker 内置' : `被 ${net.attached} 个容器使用`,
  })).sort((a, b) => Number(a.deletable) - Number(b.deletable));
});

const filteredRows = computed(() => {
  let result = rows.value;
  
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    result = result.filter(row => 
      row.primary.toLowerCase().includes(query) || 
      row.title.toLowerCase().includes(query)
    );
  }
  
  if (filterStatus.value) {
    result = result.filter(row => row.statusValue === filterStatus.value);
  }
  
  return result;
});

const deletableRows = computed(() => filteredRows.value.filter(r => r.deletable));
const allSelected = computed(() => deletableRows.value.length > 0 && selected.value.length === deletableRows.value.length);
const someSelected = computed(() => selected.value.length > 0 && selected.value.length < deletableRows.value.length);

function switchTab(key) {
  if (busy.value) return;
  activeTab.value = key;
  selected.value = [];
  searchQuery.value = '';
  filterStatus.value = '';
}

function toggleAll() {
  if (allSelected.value) {
    selected.value = [];
  } else {
    selected.value = deletableRows.value.map(r => r.key);
  }
}

function toggleRow(key) {
  const idx = selected.value.indexOf(key);
  if (idx > -1) {
    selected.value.splice(idx, 1);
  } else {
    selected.value.push(key);
  }
}

async function batchRemove() {
  if (selected.value.length === 0) return;
  bulkDeleteOpen.value = true;
}

async function performBatchRemove() {
  bulkDeleteOpen.value = false;
  busy.value = true;
  const kinds = { images: 'image', volumes: 'volume', networks: 'network' };
  const errors = [];
  let successCount = 0;
  batchProgress.value = { total: selected.value.length, done: 0, current: '' };

  for (const key of selected.value) {
    const row = rows.value.find(r => r.key === key);
    if (!row) continue;
    batchProgress.value = { ...batchProgress.value, current: row.primary };

    try {
      const id = activeTab.value === 'images' ? rowRemaining(row) : row.primary;
      await api.removeStorageResource(kinds[activeTab.value], id);
      successCount++;
    } catch (e) {
      errors.push(`${row.primary}: ${e.message}`);
    }
    batchProgress.value = { ...batchProgress.value, done: batchProgress.value.done + 1 };
  }

  busy.value = false;
  batchProgress.value = { total: 0, done: 0, current: '' };
  selected.value = [];

  // 刷新列表后给出批量结果摘要
  await refresh();

  if (errors.length > 0) {
    error.value = `成功 ${successCount} 项,失败 ${errors.length} 项:\n${errors.join('\n')}`;
  } else {
    toast.success(`已成功删除 ${successCount} 项`);
    error.value = '';
  }
}

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  try {
    data.value = await api.getStorageResources(true);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function confirmRemove(row) {
  removeTarget.value = row;
}

async function performRemove() {
  const row = removeTarget.value;
  removeTarget.value = null;
  if (row) await remove(row);
}

async function remove(row) {
  busy.value = true;
  const kinds = { images: 'image', volumes: 'volume', networks: 'network' };
  try {
    await api.removeStorageResource(kinds[activeTab.value], row.primary ? (activeTab.value === 'images' ? rowRemaining(row) : row.primary) : '');
    toast.success(`已删除 ${row.primary}`);
  } catch (e) {
    toast.error(e);
  } finally {
    busy.value = false;
    await refresh();
  }
}

/** 镜像删除键是 Id 而非显示名;从 key 还原。 */
function rowRemaining(row) {
  return row.key.split(':').slice(1).join(':');
}

function formatBytes(value = 0) {
  if (!value) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function formatTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

watch(activeTab, () => {
  selected.value = [];
});

usePullRefresh(refresh, { keepAlive: true });
onMounted(refresh);
let activatedOnce = false;
onActivated(() => { if (activatedOnce) void refresh(); activatedOnce = true; });

function onHostChanged() {
  data.value = null;
  selected.value = [];
  void refresh();
}
onMounted(() => window.addEventListener('composeops:host-changed', onHostChanged));
onBeforeUnmount(() => window.removeEventListener('composeops:host-changed', onHostChanged));
</script>
