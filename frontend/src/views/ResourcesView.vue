<template>
  <div class="page-shell page-shell-workspace">
    <div class="page-header">
      <div><h1 class="page-title">存储清理</h1><p class="page-subtitle">批量清理悬空镜像、孤儿卷与闲置网络</p></div>
      <div class="page-actions">
        <button v-if="selected.length > 0" class="btn-danger" :disabled="busy" @click="batchRemove"><Trash2 class="w-4 h-4" />批量删除 ({{ selected.length }})</button>
        <button class="btn-secondary" :disabled="loading" @click="refresh"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>
    <p v-if="flash" class="alert-info">{{ flash }}</p>

    <!-- 批量删除进度:逐项删除可能较慢,实时显示已完成数与当前目标 -->
    <section v-if="busy && batchProgress.total > 0" class="section-panel py-3!">
      <div class="flex items-center justify-between gap-3 text-sm">
        <span class="text-surface-200">正在批量删除 <b class="text-sky-300 tabular-nums">{{ batchProgress.done }}</b> / {{ batchProgress.total }}</span>
        <span class="min-w-0 flex-1 truncate text-right font-mono text-xs text-surface-500">{{ batchProgress.current }}</span>
      </div>
      <div class="progress mt-2"><span :style="{ width: Math.round(batchProgress.done / batchProgress.total * 100) + '%' }"></span></div>
    </section>

    <div class="flex flex-wrap items-center gap-2 text-xs text-surface-400">
      <span v-if="data" class="rounded-sm border border-surface-800 bg-surface-950/50 px-2 py-0.5">悬空镜像 <b class="text-amber-300">{{ data.counts.danglingImages }}</b></span>
      <span v-if="data" class="rounded-sm border border-surface-800 bg-surface-950/50 px-2 py-0.5">孤儿卷 <b class="text-amber-300">{{ data.counts.orphanVolumes }}</b></span>
      <span v-if="data" class="rounded-sm border border-surface-800 bg-surface-950/50 px-2 py-0.5">闲置网络 <b class="text-amber-300">{{ data.counts.unusedNetworks }}</b></span>
    </div>

    <div class="flex items-center justify-between gap-3 border-b border-surface-800 pb-0">
      <div class="flex items-center gap-1">
        <button v-for="tab in tabs" :key="tab.key" class="nav-link flex-none! px-3 py-2 text-sm" :class="{ 'nav-link-active': activeTab === tab.key }" @click="switchTab(tab.key)">{{ tab.label }}<span v-if="tab.countKey !== '__none__'" class="ml-2 count-badge">{{ (data?.counts?.[tab.countKey] ?? 0) }}</span></button>
      </div>
      <div class="flex items-center gap-2 pb-2">
        <span v-if="searchQuery || filterStatus" class="text-xs text-surface-400">显示 <b class="text-sky-300">{{ filteredRows.length }}</b> / {{ rows.length }}</span>
        <input v-model="searchQuery" type="text" class="input py-1! text-sm! w-48" placeholder="搜索..." />
        <select v-model="filterStatus" class="input py-1! text-sm! w-32">
          <option value="">全部状态</option>
          <option v-for="status in statusOptions" :key="status.value" :value="status.value">{{ status.label }}</option>
        </select>
      </div>
    </div>

    <Skeleton v-if="loading && !data && activeTab !== 'backups'" variant="table" :rows="6" label="资源清单加载中" />

    <section v-if="activeTab === 'backups'" class="section-panel flex-1 mt-4">
      <VolumeBackupPanel />
    </section>

    <section v-if="data && activeTab !== 'backups'" class="section-panel flex-1 mt-4">
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th class="w-12">
                <input type="checkbox" :checked="allSelected" :indeterminate="someSelected" @change="toggleAll" class="checkbox" />
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
                {{ (searchQuery || filterStatus) ? '未找到匹配的资源' : (activeTab === 'networks' ? '没有可清理的网络' : `没有${tabLabel}可清理,系统很干净`) }}
              </td>
            </tr>
            <tr v-for="row in filteredRows" :key="row.key" class="hover:bg-surface-800/25">
              <td class="text-center">
                <input v-if="row.deletable" type="checkbox" :checked="selected.includes(row.key)" @change="toggleRow(row.key)" class="checkbox" />
              </td>
              <td class="max-w-xs truncate font-mono tabular-nums" :title="row.title">{{ row.primary }}<span v-if="row.note" class="ml-2 text-muted text-xs">{{ row.note }}</span></td>
              <td><span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium" :class="row.toneCls">{{ row.statusLabel }}</span></td>
              <td class="text-muted text-sm">{{ row.createdAt ? formatTime(row.createdAt) : '—' }}</td>
              <td class="text-right font-mono tabular-nums whitespace-nowrap">{{ formatBytes(row.size) }}</td>
              <td class="text-right">
                <button v-if="row.deletable" :class="pendingKey === row.key ? 'btn-danger' : 'btn-secondary'" :disabled="busy" @click="confirmRemove(row)">{{ pendingKey === row.key ? '确认删除?' : '删除' }}</button>
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
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RefreshCw, Trash2 } from 'lucide-vue-next';
import { api } from '../api/client.js';
import Skeleton from '../components/common/Skeleton.vue';
import VolumeBackupPanel from '../components/resources/VolumeBackupPanel.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';

const data = ref(null);
const loading = ref(false);
const error = ref('');
const flash = ref('');
const activeTab = ref('images');
const pendingKey = ref('');
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

// 状态徽章的调色板:tone -> tailwind 类(与 StatusBadge 的语义色对齐)
const TONE = {
  amber: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
  sky: 'text-sky-300 border-sky-500/30 bg-sky-500/10',
  green: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
  slate: 'text-surface-400 border-surface-600/40 bg-surface-800/40',
};

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
      toneCls: TONE[img.dangling ? 'amber' : img.inUse ? 'sky' : 'green'],
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
      toneCls: TONE[vol.orphan ? 'amber' : 'green'],
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
    toneCls: TONE[net.unused ? 'amber' : net.builtin ? 'slate' : 'green'],
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

  // 先刷新再写汇总:refresh 会清空 flash/error,顺序反了汇总会被立即吃掉
  await refresh();

  if (errors.length > 0) {
    error.value = `成功 ${successCount} 项,失败 ${errors.length} 项:\n${errors.join('\n')}`;
    flash.value = '';
  } else {
    flash.value = `已成功删除 ${successCount} 项`;
    error.value = '';
  }
}

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  pendingKey.value = '';
  flash.value = '';
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
    flash.value = `已删除 ${row.primary}`;
  } catch (e) {
    flash.value = '';
    error.value = `删除失败:${e.message}`;
  } finally {
    busy.value = false;
    pendingKey.value = '';
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
