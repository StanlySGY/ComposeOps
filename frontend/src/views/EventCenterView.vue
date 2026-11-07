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

    <div class="tabs-segment" role="tablist" aria-label="事件中心视图" @keydown="handleTabKeydown">
      <button id="event-tab-events" data-tab="events" :class="{ active: tab === 'events' }" role="tab" aria-controls="event-center-panel" :aria-selected="tab === 'events'" :tabindex="tab === 'events' ? 0 : -1" @click="setTab('events')"><BellRing class="h-4 w-4" />告警事件</button>
      <button id="event-tab-timeline" data-tab="timeline" :class="{ active: tab === 'timeline' }" role="tab" aria-controls="event-center-panel" :aria-selected="tab === 'timeline'" :tabindex="tab === 'timeline' ? 0 : -1" @click="setTab('timeline')"><History class="h-4 w-4" />时间线</button>
      <button id="event-tab-operations" data-tab="operations" :class="{ active: tab === 'operations' }" role="tab" aria-controls="event-center-panel" :aria-selected="tab === 'operations'" :tabindex="tab === 'operations' ? 0 : -1" @click="setTab('operations')"><ListChecks class="h-4 w-4" />操作与任务</button>
      <button id="event-tab-state" data-tab="state" :class="{ active: tab === 'state' }" role="tab" aria-controls="event-center-panel" :aria-selected="tab === 'state'" :tabindex="tab === 'state' ? 0 : -1" @click="setTab('state')"><Gauge class="h-4 w-4" />状态历史</button>
    </div>

    <section class="space-y-4" id="event-center-panel" role="tabpanel" :aria-labelledby="`event-tab-${tab}`" tabindex="0">
    <template v-if="tab === 'events'">
      <p v-if="error" class="alert-error" role="alert">{{ error }}</p>

      <!-- 统计 -->
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile title="事件总数" :value="stats?.total ?? '—'" :icon="Activity" />
        <MetricTile title="待处理" :value="stats?.open ?? '—'" :icon="AlertTriangle" tone="text-status-warn" />
        <MetricTile title="严重告警" :value="stats?.bySeverity?.danger ?? '—'" :icon="CircleAlert" tone="text-status-error" />
        <MetricTile title="工作流事件" :value="stats?.byType?.workflow ?? '—'" :icon="Workflow" />
      </div>

      <!-- 过滤 -->
      <div class="flex flex-wrap gap-2">
        <button v-for="t in typeFilters" :key="t.value" class="btn-secondary btn-sm" :class="{ 'border-accent! text-status-info!': typeFilter === t.value }" @click="typeFilter = t.value">{{ t.label }}</button>
      </div>

      <!-- 事件列表 -->
      <Skeleton v-if="loading && !events.length" variant="table" :rows="5" label="正在加载事件记录" />
      <section v-else class="section-panel">
        <div class="mb-4"><h2 class="section-title">事件流</h2><p class="mt-1 text-muted">点击状态可流转事件状态</p></div>
        <div class="space-y-2">
          <div v-for="event in events" :key="event.id" class="flex items-start gap-3 rounded-xl border border-surface-800 bg-surface-950/40 p-3">
            <span class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" :class="severityDot(event.severity)"></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="count-badge" :class="typeTone(event.eventType)">{{ typeLabel(event.eventType) }}</span>
                <span class="text-sm font-medium text-surface-100">{{ event.title }}</span>
                <span class="text-xs text-surface-400">{{ event.assetName || '' }}</span>
              </div>
              <p v-if="event.detail" class="mt-1 text-xs text-surface-400">{{ event.detail }}</p>
              <p class="mt-1 text-[11px] text-surface-400">{{ formatTime(event.createdAt) }} · {{ event.source }}</p>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              <router-link v-if="eventDestination(event)" class="btn-ghost" :to="eventDestination(event)">查看来源</router-link>
              <router-link v-if="eventContainerLink(event, '/logs')" class="btn-ghost" :to="eventContainerLink(event, '/logs')">日志</router-link>
              <router-link v-if="eventContainerLink(event, '/monitor')" class="btn-ghost" :to="eventContainerLink(event, '/monitor')">监控</router-link>
              <router-link class="btn-ghost" :to="deepLink('/tickets', { create: 1, sourceType: 'event', sourceId: event.id, title: event.title, description: event.detail, projectId: event.payload?.projectId, from: 'events' })">建工单</router-link>
              <button class="btn-secondary btn-sm" @click="setStatus(event, 'resolved')">解决</button>
              <button class="btn-secondary btn-sm" @click="setStatus(event, 'closed')">关闭</button>
            </div>
          </div>
          <EmptyState v-if="!events.length" compact icon="History" title="暂无事件" description="运行巡检或执行任务后，可在这里跟踪结果。" action-label="刷新事件" @action="load" />
        </div>
      </section>
    </template>
    <EventTimeline v-else-if="tab === 'timeline'" />
    <StateHistoryPanel v-else-if="tab === 'state'" />
    <OperationsView v-else embedded />
    </section>
  </div>
</template>

<script setup>
import EmptyState from '../components/common/EmptyState.vue';
import Skeleton from '../components/common/Skeleton.vue';
import MetricTile from '../components/common/MetricTile.vue';
import { deepLink, eventDestination, eventContainerLink } from '../lib/deep-links.js';
import { computed, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useRoute, useRouter } from 'vue-router';
import { Activity, AlertTriangle, BellRing, CircleAlert, Gauge, History, ListChecks, RefreshCw, Trash2, Workflow } from 'lucide-vue-next';
import { useEventStore } from '../stores/events.js';
import { useToastStore } from '../stores/toast.js';
import EventTimeline from '../components/events/EventTimeline.vue';
import StateHistoryPanel from '../components/events/StateHistoryPanel.vue';
import OperationsView from './OperationsView.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import { handleTablistKeydown } from '../lib/tablist-keyboard.js';

const route = useRoute();
const router = useRouter();
const store = useEventStore();
const toast = useToastStore();
const TABS = ['timeline', 'operations', 'state'];
const tab = ref(TABS.includes(route.query.tab) ? route.query.tab : 'events');
const typeFilter = ref('');

function handleTabKeydown(event) { handleTablistKeydown(event, setTab); }
function setTab(next) {
  tab.value = next;
  const query = { ...route.query };
  if (next === 'events') delete query.tab; else query.tab = next;
  router.replace({ query });
  if (next === 'events') load();
}
watch(() => route.query.tab, (value) => { tab.value = TABS.includes(value) ? value : 'events'; });

const typeFilters = [
  { value: '', label: '全部' },
  { value: 'alert', label: '告警' },
  { value: 'inspection', label: '巡检' },
  { value: 'deployment', label: '部署' },
  { value: 'rollback', label: '回滚' },
  { value: 'agent', label: 'Agent' },
  { value: 'gitops', label: 'GitOps' },
  { value: 'workflow', label: '工作流' }, { value: 'cron', label: '定时任务' }, { value: 'backup', label: '备份' },
];

const events = computed(() => store.events);
const stats = computed(() => store.stats);
const loading = computed(() => store.loading);
const error = computed(() => store.error);

function typeLabel(type) {
  return { alert: '告警', inspection: '巡检', deployment: '部署', rollback: '回滚', agent: 'Agent', gitops: 'GitOps', workflow: '工作流', system: '系统', cron: '定时任务', backup: '备份' }[type] || type;
}
function typeTone(type) {
  return { alert: 'text-status-error', inspection: 'text-sky-300', deployment: 'text-status-ok', rollback: 'text-status-warn', agent: 'text-violet-300', gitops: 'text-cyan-300', workflow: 'text-indigo-300' }[type] || 'text-surface-300';
}
function severityDot(severity) {
  return { danger: 'bg-status-error', warning: 'bg-status-warn', info: 'bg-sky-400' }[severity] || 'bg-surface-500';
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
    toast.error(e);
  }
}
const showPruneConfirm = ref(false);
async function prune() {
  showPruneConfirm.value = false;
  try {
    await store.prune(30);
    toast.success('历史事件已清理');
  } catch (e) {
    toast.error(e);
  }
}

watch(typeFilter, load);
// 只在「告警事件」tab 响应下拉刷新:时间线、状态历史与操作 tab 分别由 EventTimeline、StateHistoryPanel、OperationsView 负责,避免一次下拉发两遍请求。
usePullRefresh(load, { enabled: () => tab.value === 'events' });
onMounted(() => { if (tab.value === 'events') load(); });
</script>
