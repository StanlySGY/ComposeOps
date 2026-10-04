<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">事件中心</h1>
        <p class="page-subtitle">统一汇聚告警、巡检、部署、Agent、操作与定时任务事件,支持状态流转与全量回溯</p>
      </div>
      <div class="page-actions">
        <template v-if="tab === 'events'">
          <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
          <button class="btn-secondary" @click="showPruneConfirm = true"><Trash2 class="w-4 h-4" />清理过期</button>
        </template>
      </div>
    </div>
    <ConfirmDialog :show="showPruneConfirm" title="清理过期事件" message="确认清理 30 天前的历史事件?该操作不可恢复。" tone="warning" confirm-text="清理" @confirm="prune" @cancel="showPruneConfirm = false" />

    <div class="tabs-segment" role="tablist" aria-label="事件中心视图">
      <button :class="{ active: tab === 'events' }" role="tab" :aria-selected="tab === 'events'" @click="setTab('events')"><BellRing class="h-4 w-4" />告警事件</button>
      <button :class="{ active: tab === 'timeline' }" role="tab" :aria-selected="tab === 'timeline'" @click="setTab('timeline')"><History class="h-4 w-4" />时间线</button>
      <button :class="{ active: tab === 'operations' }" role="tab" :aria-selected="tab === 'operations'" @click="setTab('operations')"><ListChecks class="h-4 w-4" />操作与任务</button>
    </div>

    <template v-if="tab === 'events'">
      <p v-if="error" class="alert-error">{{ error }}</p>

      <!-- 统计 -->
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div class="section-panel flex items-center gap-3">
          <span class="grid h-10 w-10 place-items-center rounded-xl border border-surface-700 bg-surface-900 text-surface-300"><Activity class="w-5 h-5" /></span>
          <div><p class="text-2xl font-semibold text-surface-100">{{ stats?.total || 0 }}</p><p class="text-xs text-surface-500">事件总数</p></div>
        </div>
        <div class="section-panel flex items-center gap-3">
          <span class="grid h-10 w-10 place-items-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300"><AlertTriangle class="w-5 h-5" /></span>
          <div><p class="text-2xl font-semibold text-surface-100">{{ stats?.open || 0 }}</p><p class="text-xs text-surface-500">待处理</p></div>
        </div>
        <div class="section-panel flex items-center gap-3">
          <span class="grid h-10 w-10 place-items-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300"><CircleAlert class="w-5 h-5" /></span>
          <div><p class="text-2xl font-semibold text-surface-100">{{ stats?.bySeverity?.danger || 0 }}</p><p class="text-xs text-surface-500">严重告警</p></div>
        </div>
        <div class="section-panel flex items-center gap-3">
          <span class="grid h-10 w-10 place-items-center rounded-xl border border-sky-500/30 bg-sky-500/10 text-sky-300"><Workflow class="w-5 h-5" /></span>
          <div><p class="text-2xl font-semibold text-surface-100">{{ stats?.byType?.workflow || 0 }}</p><p class="text-xs text-surface-500">工作流事件</p></div>
        </div>
      </div>

      <!-- 过滤 -->
      <div class="flex flex-wrap gap-2">
        <button v-for="t in typeFilters" :key="t.value" class="btn-secondary px-3! py-1.5! text-xs" :class="{ 'border-accent! text-accent!': typeFilter === t.value }" @click="typeFilter = t.value">{{ t.label }}</button>
      </div>

      <!-- 事件列表 -->
      <section class="section-panel">
        <div class="mb-4"><h2 class="section-title">事件流</h2><p class="mt-1 text-muted">点击状态可流转事件状态</p></div>
        <div class="space-y-2">
          <div v-for="event in events" :key="event.id" class="flex items-start gap-3 rounded-xl border border-surface-800 bg-surface-950/40 p-3">
            <span class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" :class="severityDot(event.severity)"></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="count-badge" :class="typeTone(event.eventType)">{{ typeLabel(event.eventType) }}</span>
                <span class="text-sm font-medium text-surface-100">{{ event.title }}</span>
                <span class="text-xs text-surface-600">{{ event.assetName || '' }}</span>
              </div>
              <p v-if="event.detail" class="mt-1 text-xs text-surface-400">{{ event.detail }}</p>
              <p class="mt-1 text-[11px] text-surface-600">{{ formatTime(event.createdAt) }} · {{ event.source }}</p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button class="btn-secondary px-2! py-1! text-xs" @click="setStatus(event, 'resolved')">解决</button>
              <button class="btn-secondary px-2! py-1! text-xs" @click="setStatus(event, 'closed')">关闭</button>
            </div>
          </div>
          <div v-if="!events.length" class="rounded-xl border border-dashed border-surface-700 p-8 text-center text-sm text-surface-500">暂无事件</div>
        </div>
      </section>
    </template>
    <EventTimeline v-else-if="tab === 'timeline'" />
    <OperationsView v-else embedded />
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Activity, AlertTriangle, BellRing, CircleAlert, History, ListChecks, RefreshCw, Trash2, Workflow } from 'lucide-vue-next';
import { useEventStore } from '../stores/events.js';
import { useToastStore } from '../stores/toast.js';
import EventTimeline from '../components/events/EventTimeline.vue';
import OperationsView from './OperationsView.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';

const route = useRoute();
const router = useRouter();
const store = useEventStore();
const toast = useToastStore();
const tab = ref(['timeline', 'operations'].includes(route.query.tab) ? route.query.tab : 'events');
const typeFilter = ref('');

function setTab(next) {
  tab.value = next;
  const query = { ...route.query };
  if (next === 'events') delete query.tab; else query.tab = next;
  router.replace({ query });
  if (next === 'events') load();
}
watch(() => route.query.tab, (value) => { tab.value = ['timeline', 'operations'].includes(value) ? value : 'events'; });

const typeFilters = [
  { value: '', label: '全部' },
  { value: 'alert', label: '告警' },
  { value: 'inspection', label: '巡检' },
  { value: 'deployment', label: '部署' },
  { value: 'rollback', label: '回滚' },
  { value: 'agent', label: 'Agent' },
  { value: 'gitops', label: 'GitOps' },
  { value: 'workflow', label: '工作流' },
];

const events = computed(() => store.events);
const stats = computed(() => store.stats);
const loading = computed(() => store.loading);
const error = computed(() => store.error);

function typeLabel(type) {
  return { alert: '告警', inspection: '巡检', deployment: '部署', rollback: '回滚', agent: 'Agent', gitops: 'GitOps', workflow: '工作流', system: '系统' }[type] || type;
}
function typeTone(type) {
  return { alert: 'text-rose-300', inspection: 'text-sky-300', deployment: 'text-emerald-300', rollback: 'text-amber-300', agent: 'text-violet-300', gitops: 'text-cyan-300', workflow: 'text-indigo-300' }[type] || 'text-surface-300';
}
function severityDot(severity) {
  return { danger: 'bg-rose-400', warning: 'bg-amber-400', info: 'bg-sky-400' }[severity] || 'bg-surface-500';
}
function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts.replace(' ', 'T')).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function load() {
  await store.load({ eventType: typeFilter.value });
  await store.loadStats();
}
async function setStatus(event, status) {
  try {
    await store.update(event.id, { status });
    toast.success(`事件已标记为${status === 'resolved' ? '已解决' : '已关闭'}`);
  } catch (e) {
    toast.error(e.message);
  }
}
const showPruneConfirm = ref(false);
async function prune() {
  showPruneConfirm.value = false;
  try {
    await store.prune(30);
    toast.success('历史事件已清理');
  } catch (e) {
    toast.error(e.message);
  }
}

watch(typeFilter, load);
onMounted(() => { if (tab.value === 'events') load(); });
</script>
