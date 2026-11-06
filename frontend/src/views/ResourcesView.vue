<template>
  <div class="page-shell resource-workspace">
    <div class="page-header">
      <div><h1 class="page-title">存储清理</h1><p class="page-subtitle">看清资源引用，再按需清理。未被引用的数据卷也可能保存着重要数据。</p></div>
      <button class="btn-secondary" :disabled="loading || busy" title="刷新清单" @click="refresh"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新清单</button>
    </div>

    <div v-if="error" class="alert-error flex items-center justify-between gap-3" role="alert"><span>{{ error }}</span><button class="btn-secondary shrink-0" :disabled="busy || loading" @click="refresh">重试</button></div>
    <p v-if="flash" class="alert-info" role="status" aria-live="polite">{{ flash }}</p>
    <div v-if="failures.length" class="alert-error" role="alert">
      <p class="font-medium">{{ failures.length }} 项删除未完成，请核对原因后重试</p>
      <ul class="mt-2 space-y-1 text-xs"><li v-for="item in failures" :key="item.key" class="break-all">{{ item.primary }}：{{ item.message }}</li></ul>
    </div>

    <div v-if="data" class="resource-overview" aria-label="资源概览">
      <button v-for="card in summaryCards" :key="card.key" class="resource-summary" :class="{ 'is-active': activeTab === card.key && filterStatus === 'deletable' }" :disabled="busy" :aria-pressed="activeTab === card.key && filterStatus === 'deletable'" @click="showCandidates(card.key)">
        <div class="flex items-center gap-2 text-xs text-surface-400"><component :is="card.icon" class="h-4 w-4" />{{ card.label }}<ArrowUpRight class="ml-auto h-3.5 w-3.5" /></div>
        <div class="my-2 flex items-baseline gap-2"><strong class="text-2xl font-semibold tabular-nums text-surface-100">{{ card.free }}</strong><span class="text-xs text-surface-400">项未引用 <span class="text-surface-500">/ 共 {{ card.total }} 项</span></span></div>
        <p class="text-xs text-surface-500">{{ card.note }}</p>
      </button>
    </div>

    <div class="resource-tabs" role="tablist" aria-label="存储资源类型" @keydown="handleTabKeydown">
      <button v-for="tab in tabs" :id="`resources-tab-${tab.key}`" :key="tab.key" role="tab" :data-tab="tab.key" :aria-controls="`resources-panel-${tab.key}`" :aria-selected="activeTab === tab.key" :tabindex="activeTab === tab.key ? 0 : -1" :disabled="busy" :class="{ active: activeTab === tab.key }" @click="switchTab(tab.key)">
        {{ tab.label }}<span v-if="tab.key !== 'backups' && data" class="count-badge">{{ data[tab.key]?.length || 0 }}</span>
      </button>
    </div>

    <section :id="`resources-panel-${activeTab}`" role="tabpanel" :aria-labelledby="`resources-tab-${activeTab}`" :aria-busy="loading || busy" tabindex="0" class="resource-panel">
      <VolumeBackupPanel v-if="activeTab === 'backups'" />
      <template v-else>
        <div class="resource-toolbar">
          <label class="resource-search"><Search class="h-4 w-4 shrink-0 text-surface-500" /><input v-model="searchQuery" :disabled="busy" type="search" aria-label="搜索存储资源" placeholder="搜索名称、ID 或驱动…" /></label>
          <select v-model="filterStatus" class="input resource-filter" :disabled="busy" aria-label="按资源状态筛选">
            <option value="">全部状态</option><option value="deletable">未被引用</option>
            <option v-for="status in statusOptions" :key="status.value" :value="status.value">{{ status.label }}</option>
          </select>
          <button v-if="hasFilters" class="btn-ghost" :disabled="busy" @click="clearFilters"><X class="h-3.5 w-3.5" />重置筛选</button>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 px-4 pb-3 text-xs text-surface-500">
          <span>显示 {{ filteredRows.length }} / {{ rows.length }} 项<span v-if="deletableRows.length"> · {{ deletableRows.length }} 项未被引用</span></span>
          <span v-if="data">{{ data.hostName || data.hostId }} · {{ formatTime(data.checkedAt) }} 更新</span>
        </div>

        <div v-if="selected.length || busy" class="resource-selection" role="status" aria-live="polite">
          <div class="min-w-0 flex-1"><p class="text-sm font-medium">{{ busy ? `正在删除 ${batchProgress.done} / ${batchProgress.total}` : `已选择 ${selected.length} 项` }}<span v-if="hiddenSelected && !busy" class="ml-2 text-xs text-amber-200">含 {{ hiddenSelected }} 项被筛选隐藏</span></p><p v-if="busy" class="mt-1 truncate text-xs text-surface-400">{{ batchProgress.current }}</p></div>
          <button class="btn-ghost" :disabled="busy" @click="selected = []">取消选择</button>
          <button class="btn-danger" :disabled="busy" @click="prepareRemoval(selectedRows)"><Trash2 class="h-4 w-4" />批量删除 ({{ selected.length }})</button>
          <div v-if="busy" class="progress w-full"><span :style="{ width: `${batchProgress.total ? batchProgress.done / batchProgress.total * 100 : 0}%` }"></span></div>
        </div>

        <Skeleton v-if="loading && !data" variant="table" :rows="5" label="资源清单加载中" />
        <EmptyState v-else-if="!filteredRows.length" :icon="hasFilters ? 'Search' : 'Boxes'" :title="hasFilters ? '没有匹配的资源' : `当前节点还没有${tabLabel}`" :description="hasFilters ? '试试其他关键词，或重置筛选查看全部资源。' : '创建服务后，这里会显示资源及其引用状态。'" :action-label="hasFilters ? '重置筛选' : ''" @action="clearFilters" />
        <div v-else class="resource-table-wrap">
          <table class="data-table resource-table">
            <caption class="sr-only">{{ tabLabel }}资源清单</caption>
            <thead><tr>
              <th class="w-12"><label class="resource-check"><input type="checkbox" :checked="allSelected" :indeterminate="someSelected" :disabled="busy || !deletableRows.length" aria-label="全选可删除资源" @change="toggleAll" /></label></th>
              <th>{{ activeTab === 'volumes' ? '卷名' : tabLabel }}</th><th>引用状态</th><th>创建时间</th><th>{{ activeTab === 'networks' ? '驱动' : '大小' }}</th><th class="text-right">操作</th>
            </tr></thead>
            <tbody><tr v-for="row in filteredRows" :key="row.key" :class="{ 'is-selected': selected.includes(row.key) }">
              <td class="resource-select-cell"><label v-if="row.deletable" class="resource-check"><input type="checkbox" :checked="selected.includes(row.key)" :disabled="busy" :aria-label="`选择资源 ${row.primary}`" @change="toggleRow(row.key)" /></label><LockKeyhole v-else class="mx-auto h-3.5 w-3.5 text-surface-600" aria-hidden="true" /></td>
              <td class="resource-name"><button class="resource-detail-link" :aria-label="`查看资源 ${row.primary}`" @click="detailRow = row">{{ row.primary }}</button><p class="mt-1 truncate text-[11px] text-surface-500" :title="row.secondary">{{ row.secondary }}</p></td>
              <td class="resource-status"><span class="rounded-full border px-2 py-1 text-[11px]" :class="TONE[row.deletable ? 'amber' : 'slate']">{{ row.statusLabel }}</span></td>
              <td class="resource-created text-xs text-surface-500" data-label="创建">{{ formatTime(row.createdAt) }}</td>
              <td class="resource-size whitespace-nowrap font-mono text-xs" :data-label="activeTab === 'networks' ? '驱动' : '大小'">{{ activeTab === 'networks' ? row.driver : formatBytes(row.size) }}</td>
              <td class="resource-actions text-right"><button v-if="row.deletable" class="btn-ghost text-rose-300!" :disabled="busy || selected.length > 0 || loading" :aria-label="`删除资源 ${row.primary}`" @click="prepareRemoval([row])"><Trash2 class="h-3.5 w-3.5" />删除</button><span v-else class="text-xs text-surface-500">{{ row.undeletableReason }}</span></td>
            </tr></tbody>
          </table>
        </div>
        <p v-if="activeTab === 'volumes'" class="border-t border-surface-800 px-4 py-3 text-xs leading-5 text-surface-500">“未引用”仅表示没有容器挂载。删除数据卷会同时删除其中的数据，请先在“卷备份”中核对备份。</p>
        <p v-if="data?.warnings?.length" class="alert-info m-4">{{ data.warnings.join('；') }}</p>
      </template>
    </section>

    <ConfirmDialog :show="!!removalPlan" :title="removalPlan?.rows.length > 1 ? '批量删除资源' : '删除资源'" :message="`确认从 ${removalPlan?.hostName || ''} 删除以下 ${removalPlan?.rows.length || 0} 项资源？删除后无法恢复。`" tone="danger" confirm-text="确认删除" size-class="sm:max-w-xl" @confirm="performRemoval" @cancel="removalPlan = null">
      <p v-if="removalPlan?.kind === 'volume'" class="text-xs text-amber-300">这会永久删除卷中的数据。未被引用不代表数据不再需要。</p>
      <ul class="my-3 max-h-56 space-y-2 overflow-y-auto rounded-lg border border-surface-700 p-3" aria-label="待删除资源">
        <li v-for="row in removalPlan?.rows || []" :key="row.key"><p class="break-all font-mono text-xs text-surface-200">{{ row.primary }}</p><p v-if="row.id !== row.primary" class="mt-0.5 break-all font-mono text-[10px] text-surface-500">{{ row.id }}</p></li>
      </ul>
    </ConfirmDialog>
    <BaseModal :show="!!detailRow" title="资源详情" @close="detailRow = null">
      <dl v-if="detailRow" class="space-y-4 text-sm">
        <div v-for="[label, value] in detailFields" :key="label"><dt class="mb-1 text-xs text-surface-500">{{ label }}</dt><dd class="whitespace-pre-wrap break-all font-mono text-surface-200">{{ value }}</dd></div>
      </dl>
    </BaseModal>
  </div>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowUpRight, Boxes, Database, LockKeyhole, Network, RefreshCw, Search, Trash2, X } from 'lucide-vue-next';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { handleTablistKeydown } from '../lib/tablist-keyboard.js';
import { api } from '../api/client.js';
import Skeleton from '../components/common/Skeleton.vue';
import EmptyState from '../components/common/EmptyState.vue';
import VolumeBackupPanel from '../components/resources/VolumeBackupPanel.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import BaseModal from '../components/common/BaseModal.vue';

const route = useRoute();
const router = useRouter();
const tabs = [{ key: 'images', label: '镜像' }, { key: 'volumes', label: '卷' }, { key: 'networks', label: '网络' }, { key: 'backups', label: '卷备份' }];
const validTab = (value) => tabs.some(tab => tab.key === value) ? value : 'images';
const activeTab = ref(validTab(route.query.tab));
const data = ref(null);
const loading = ref(false);
const error = ref('');
const flash = ref('');
const failures = ref([]);
const busy = ref(false);
const selected = ref([]);
const searchQuery = ref('');
const filterStatus = ref('');
const removalPlan = ref(null);
const detailRow = ref(null);
const batchProgress = ref({ total: 0, done: 0, current: '' });
let requestGeneration = 0;
let contextGeneration = 0;
let active = true;
const TONE = { amber: 'text-amber-300 border-amber-500/25 bg-amber-500/10', slate: 'text-surface-400 border-surface-700 bg-surface-800/40' };
const tabLabel = computed(() => tabs.find(tab => tab.key === activeTab.value)?.label || '');
const hasFilters = computed(() => !!(searchQuery.value || filterStatus.value));
const summaryCards = computed(() => [
  { key: 'images', label: '镜像', icon: Boxes, total: data.value?.images.length || 0, free: data.value?.images.filter(i => !i.inUse).length || 0, note: '核对标签与版本，清理不再需要的镜像' },
  { key: 'volumes', label: '数据卷', icon: Database, total: data.value?.volumes.length || 0, free: data.value?.volumes.filter(v => v.orphan).length || 0, note: '保留数据有价值的卷，删除前先备份' },
  { key: 'networks', label: '网络', icon: Network, total: data.value?.networks.length || 0, free: data.value?.networks.filter(n => n.unused).length || 0, note: '检查容器引用，保留 Docker 内置网络' },
]);
const statusOptions = computed(() => activeTab.value === 'images' ? [{ value: 'dangling', label: '悬空镜像' }, { value: 'inUse', label: '使用中' }, { value: 'unused', label: '未使用（有标签）' }] : activeTab.value === 'volumes' ? [{ value: 'referenced', label: '被引用' }] : [{ value: 'builtin', label: 'Docker 内置' }, { value: 'attached', label: '被引用' }]);
const rows = computed(() => {
  let result;
  if (activeTab.value === 'images') result = (data.value?.images || []).map(img => ({
    key: `image:${img.id}`, id: img.id, primary: img.tags[0] || img.id.replace(/^sha256:/, '').slice(0, 12), secondary: img.tags.length > 1 ? `另有 ${img.tags.length - 1} 个标签 · ${img.id}` : img.id,
    extra: img.tags.join('\n'), statusLabel: img.inUse ? `被 ${img.containers} 个容器引用` : img.dangling ? '悬空' : '未使用', statusValue: img.inUse ? 'inUse' : img.dangling ? 'dangling' : 'unused', size: img.size, createdAt: img.created, deletable: !img.inUse, undeletableReason: '被容器引用',
  }));
  else if (activeTab.value === 'volumes') result = (data.value?.volumes || []).map(vol => ({
    key: `volume:${vol.name}`, id: vol.name, primary: vol.name, secondary: `${vol.driver} · ${vol.scope}`, extra: vol.mountpoint, statusLabel: vol.orphan ? '未引用' : `被 ${vol.refCount} 个容器引用`, statusValue: vol.orphan ? 'orphan' : 'referenced', size: vol.size, createdAt: vol.createdAt, deletable: vol.orphan, undeletableReason: '被容器挂载',
  }));
  else result = (data.value?.networks || []).map(net => ({
    key: `network:${net.id}`, id: net.id, primary: net.name, secondary: `${net.driver} · ${net.scope}${net.internal ? ' · 内部网络' : ''}`, extra: net.id, driver: net.driver, statusLabel: net.builtin ? 'Docker 内置' : net.unused ? '闲置' : `被 ${net.attached} 个容器引用`, statusValue: net.builtin ? 'builtin' : net.unused ? 'unused' : 'attached', size: null, createdAt: net.createdAt, deletable: net.unused, undeletableReason: net.builtin ? '内置网络' : '被容器引用',
  }));
  return result.sort((a, b) => Number(b.deletable) - Number(a.deletable) || (b.size || 0) - (a.size || 0) || a.primary.localeCompare(b.primary));
});
const filteredRows = computed(() => rows.value.filter(row => {
  const query = searchQuery.value.trim().toLowerCase();
  return (!query || `${row.primary} ${row.id} ${row.secondary} ${row.extra}`.toLowerCase().includes(query)) && (!filterStatus.value || (filterStatus.value === 'deletable' ? row.deletable : row.statusValue === filterStatus.value));
}));
const deletableRows = computed(() => filteredRows.value.filter(row => row.deletable));
const selectedRows = computed(() => rows.value.filter(row => row.deletable && selected.value.includes(row.key)));
const visibleSelected = computed(() => deletableRows.value.filter(row => selected.value.includes(row.key)).length);
const allSelected = computed(() => deletableRows.value.length > 0 && visibleSelected.value === deletableRows.value.length);
const someSelected = computed(() => visibleSelected.value > 0 && !allSelected.value);
const hiddenSelected = computed(() => selectedRows.value.length - visibleSelected.value);
const detailFields = computed(() => detailRow.value ? [['名称', detailRow.value.primary], ['资源 ID', detailRow.value.id], ['引用状态', detailRow.value.statusLabel], ['创建时间', formatTime(detailRow.value.createdAt)], ['标签 / 驱动 / 路径', detailRow.value.extra || detailRow.value.secondary]] : []);
function clearFilters() { searchQuery.value = ''; filterStatus.value = ''; }
function applyTab(key) {
  if (key === activeTab.value) return;
  if (busy.value) {
    invalidateContext();
    flash.value = '资源类型已切换，剩余删除已停止；已发出的请求会继续完成。';
  }
  activeTab.value = key;
  selected.value = [];
  removalPlan.value = null;
  detailRow.value = null;
  clearFilters();
}
function switchTab(key) {
  if (busy.value || key === activeTab.value) return;
  applyTab(key);
  void router.push({ query: { ...route.query, tab: key } });
}
function showCandidates(key) { switchTab(key); filterStatus.value = 'deletable'; }
function handleTabKeydown(event) { if (!busy.value) handleTablistKeydown(event, switchTab); }
function toggleAll() {
  if (busy.value) return;
  const visibleKeys = new Set(deletableRows.value.map(row => row.key));
  selected.value = allSelected.value ? selected.value.filter(key => !visibleKeys.has(key)) : [...new Set([...selected.value, ...visibleKeys])];
}
function toggleRow(key) {
  if (!busy.value) selected.value = selected.value.includes(key) ? selected.value.filter(id => id !== key) : [...selected.value, key];
}
function prepareRemoval(targets) {
  if (busy.value || loading.value || !data.value?.hostId || !targets.length) return;
  removalPlan.value = { kind: { images: 'image', volumes: 'volume', networks: 'network' }[activeTab.value], hostId: data.value.hostId, hostName: data.value.hostName || data.value.hostId, generation: contextGeneration, rows: targets.filter(row => row.deletable).map(row => ({ ...row })) };
}
async function performRemoval() {
  const plan = removalPlan.value;
  removalPlan.value = null;
  if (!plan || busy.value || plan.generation !== contextGeneration) return;
  busy.value = true;
  failures.value = [];
  flash.value = '';
  let succeeded = 0;
  const failed = [];
  batchProgress.value = { total: plan.rows.length, done: 0, current: '' };
  try {
    for (const [index, row] of plan.rows.entries()) {
      if (!active || contextGeneration !== plan.generation) break;
      batchProgress.value.current = row.primary;
      try {
        await api.removeStorageResource(plan.kind, row.id, plan.hostId);
        succeeded++;
        selected.value = selected.value.filter(key => key !== row.key);
      } catch (e) {
        failed.push({ ...row, message: e.message });
        if (e.code === 'resource_host_changed') {
          failed.push(...plan.rows.slice(index + 1).map(item => ({ ...item, message: '未执行：节点已切换，请刷新后重新选择' })));
          break;
        }
      }
      batchProgress.value.done++;
    }
    if (active && contextGeneration === plan.generation) {
      selected.value = failed.map(row => row.key);
      await refresh();
      if (active && contextGeneration === plan.generation) {
        failures.value = failed;
        flash.value = `已删除 ${succeeded} 项资源${failed.length ? `，${failed.length} 项未完成` : ''}（${plan.hostName}）。`;
      }
    }
  } finally { busy.value = false; }
}
async function refresh() {
  if (!active) return;
  const generation = ++requestGeneration;
  loading.value = true;
  error.value = '';
  try {
    const result = await api.getStorageResources(true);
    if (!active || generation !== requestGeneration) return;
    data.value = result;
    const available = new Set(rows.value.filter(row => row.deletable).map(row => row.key));
    selected.value = selected.value.filter(key => available.has(key));
  } catch (e) { if (active && generation === requestGeneration) error.value = e.message; }
  finally { if (generation === requestGeneration) loading.value = false; }
}
function invalidateContext() {
  requestGeneration++;
  contextGeneration++;
  loading.value = false;
  removalPlan.value = null;
  detailRow.value = null;
  selected.value = [];
}
function onHostChanged() {
  invalidateContext();
  data.value = null;
  failures.value = [];
  flash.value = busy.value ? '节点已切换，剩余删除已停止；已发出的请求会在原节点完成。' : '';
  if (active) void refresh();
}
function formatBytes(value) {
  if (value == null || value < 0) return '未统计';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function formatTime(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '—';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
watch(() => route.query.tab, value => { if (active) applyTab(validTab(value)); });
usePullRefresh(refresh, { keepAlive: true });
onMounted(() => { window.addEventListener('composeops:host-changed', onHostChanged); void refresh(); });
let activatedOnce = false;
onActivated(() => { active = true; applyTab(validTab(route.query.tab)); if (activatedOnce) void refresh(); activatedOnce = true; });
onDeactivated(() => { active = false; invalidateContext(); if (busy.value) flash.value = '已离开资源页，剩余删除已停止；已发出的请求会继续完成。'; });
onBeforeUnmount(() => { active = false; invalidateContext(); window.removeEventListener('composeops:host-changed', onHostChanged); });
</script>

<style scoped>
.resource-workspace { gap: 1.25rem; }
.resource-overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; }
.resource-summary { text-align: left; border: 1px solid var(--color-surface-800); border-radius: .75rem; padding: 1rem; background: linear-gradient(135deg, var(--color-surface-900), transparent); transition: border-color .15s, background .15s; }
.resource-summary:hover, .resource-summary.is-active { border-color: var(--color-emerald-700); background-color: color-mix(in srgb, var(--color-emerald-500) 5%, transparent); }
.resource-tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--color-surface-800); }
.resource-tabs button { display: flex; align-items: center; gap: .5rem; padding: .75rem 1rem; border-bottom: 2px solid transparent; color: var(--color-surface-400); font-size: .875rem; white-space: nowrap; }
.resource-tabs button.active { color: var(--color-emerald-300); border-color: var(--color-emerald-400); }
.resource-panel { min-width: 0; border: 1px solid var(--color-surface-800); border-radius: .75rem; background: var(--color-surface-900); overflow: clip; }
.resource-toolbar { display: flex; flex-wrap: wrap; gap: .75rem; padding: 1rem; }
.resource-search { display: flex; align-items: center; gap: .5rem; flex: 1 1 14rem; min-width: 0; padding: .625rem .75rem; border: 1px solid var(--color-surface-700); border-radius: .5rem; background: var(--color-surface-950); }
.resource-search:focus-within { outline: 2px solid var(--color-emerald-500); outline-offset: 2px; }
.resource-search input { min-width: 0; width: 100%; background: transparent; outline: none; font-size: .875rem; }
.resource-filter { width: auto; min-width: 10rem; }
.resource-selection { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .75rem 1rem; background: color-mix(in srgb, var(--color-emerald-500) 10%, transparent); border-block: 1px solid color-mix(in srgb, var(--color-emerald-500) 25%, transparent); }
.resource-table-wrap { overflow-x: auto; }
.resource-table { width: 100%; }
.resource-table td { padding-block: .75rem; }
.resource-table tr.is-selected { background: color-mix(in srgb, var(--color-emerald-500) 5%, transparent); }
.resource-name { max-width: 23rem; }
.resource-detail-link { text-align: left; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: .8125rem; color: var(--color-surface-200); }
.resource-detail-link:hover { color: var(--color-emerald-300); text-decoration: underline; }
.resource-check { display: flex; min-width: 36px; min-height: 36px; align-items: center; justify-content: center; cursor: pointer; }
.resource-check input { width: 16px; height: 16px; accent-color: var(--color-emerald-500); }
@media (max-width: 640px) {
  .resource-workspace { gap: .75rem; }
  .resource-workspace > .page-header { position: relative; padding-right: 3.25rem; }
  .resource-workspace > .page-header > button { position: absolute; right: 0; top: 0; width: 44px; height: 44px; padding: 0; font-size: 0; gap: 0; }
  .resource-overview { gap: .5rem; }
  .resource-summary { padding: .625rem; }
  .resource-summary p, .resource-summary .text-surface-500, .resource-summary svg:last-child { display: none; }
  .resource-summary .my-2 { align-items: start; flex-direction: column; gap: .25rem; margin-bottom: 0; }
  .resource-tabs { justify-content: space-between; gap: 0; }
  .resource-tabs button { gap: .25rem; padding: .75rem .5rem; font-size: .8125rem; }
  .resource-toolbar { gap: .5rem; }
  .resource-filter { flex: 1; }
  .resource-selection > div:first-child { flex-basis: 100%; }
  .resource-table, .resource-table tbody { display: block; min-width: 0; }
  .resource-table thead { display: block; }
  .resource-table thead tr { display: flex; align-items: center; padding-left: .5rem; }
  .resource-table thead th:not(:first-child) { display: none; }
  .resource-table thead tr::after { content: '选择当前筛选内的可删除资源'; font-size: .75rem; color: var(--color-surface-500); }
  .resource-table tbody tr { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: .5rem; padding: 1rem .75rem; border-top: 1px solid var(--color-surface-800); }
  .resource-table tbody td { height: auto; padding: 0; border: 0; }
  .resource-select-cell { grid-row: 1; }
  .resource-name { grid-column: 2 / 4; max-width: none; }
  .resource-status { grid-column: 2; grid-row: 2; }
  .resource-size { grid-column: 3; grid-row: 2; text-align: right; }
  .resource-created { grid-column: 2; grid-row: 3; }
  .resource-created::before { content: attr(data-label) ' '; }
  .resource-actions { grid-column: 3; grid-row: 3; }
  .resource-actions button, .resource-check { min-height: 44px; }
}
</style>
