<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">事件中心</h1>
        <p class="page-subtitle">把异常变成可追踪的处理记录。定位来源，确认处理，再回看结果。</p>
      </div>
      <div class="page-actions">
        <template v-if="tab === 'events'">
          <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
          <button class="btn-secondary" :disabled="pruning" @click="pruneError = ''; showPruneConfirm = true"><Trash2 class="w-4 h-4" />清理过期</button>
        </template>
      </div>
    </div>
    <ConfirmDialog :show="showPruneConfirm" title="清理过期事件" message="确认清理 30 天前的历史事件?该操作不可恢复。" tone="warning" confirm-text="清理" :busy="pruning" @confirm="prune" @cancel="showPruneConfirm = false">
      <p v-if="pruneError" class="alert-error" role="alert">{{ pruneError }}</p>
    </ConfirmDialog>

    <div class="tabs-segment" role="tablist" aria-label="事件中心视图" @keydown="handleTabKeydown">
      <button id="event-tab-events" data-tab="events" :class="{ active: tab === 'events' }" role="tab" aria-controls="event-center-panel" :aria-selected="tab === 'events'" :tabindex="tab === 'events' ? 0 : -1" @click="setTab('events')"><BellRing class="h-4 w-4" />告警事件</button>
      <button id="event-tab-timeline" data-tab="timeline" :class="{ active: tab === 'timeline' }" role="tab" aria-controls="event-center-panel" :aria-selected="tab === 'timeline'" :tabindex="tab === 'timeline' ? 0 : -1" @click="setTab('timeline')"><History class="h-4 w-4" />时间线</button>
      <button id="event-tab-operations" data-tab="operations" :class="{ active: tab === 'operations' }" role="tab" aria-controls="event-center-panel" :aria-selected="tab === 'operations'" :tabindex="tab === 'operations' ? 0 : -1" @click="setTab('operations')"><ListChecks class="h-4 w-4" />操作与任务</button>
      <button id="event-tab-state" data-tab="state" :class="{ active: tab === 'state' }" role="tab" aria-controls="event-center-panel" :aria-selected="tab === 'state'" :tabindex="tab === 'state' ? 0 : -1" @click="setTab('state')"><Gauge class="h-4 w-4" />状态历史</button>
    </div>

    <section class="space-y-4" id="event-center-panel" role="tabpanel" :aria-labelledby="`event-tab-${tab}`" tabindex="0">
    <template v-if="tab === 'events'">

      <section class="event-overview" aria-label="事件处理概览" :aria-busy="store.statsLoading">
        <div class="event-overview-copy">
          <span class="event-eyebrow"><span class="event-signal" :class="{ 'has-pending': stats?.open > 0 }"></span>处理概览</span>
          <h2>{{ !stats ? (store.statsError ? '处理概览暂不可用' : '正在读取事件概览') : stats.open ? `${stats.open} 项事件待处理` : '待处理事件已清零' }}</h2>
          <button v-if="stats?.open" class="event-focus-link" :aria-pressed="statusFilter === 'open'" @click="setFilter('status', statusFilter === 'open' ? '' : 'open')">{{ statusFilter === 'open' ? '查看全部状态' : '只看待处理' }}<ArrowRight class="h-3.5 w-3.5" /></button>
          <p v-else class="text-muted">{{ stats ? '已处理记录仍可随时回看。' : '列表与概览会分别加载。' }}</p>
        </div>
        <SceneIllustration class="event-scene" kind="events" :min-width="640" sizes="150px" eager />
        <dl class="event-overview-stats">
          <div><dt>全部事件</dt><dd>{{ stats?.total ?? '—' }}</dd></div>
          <div><dt>严重告警</dt><dd :class="{ 'text-status-error': stats?.bySeverity?.danger }">{{ stats ? (stats.bySeverity?.danger || 0) : '—' }}</dd></div>
          <div><dt>工作流事件</dt><dd>{{ stats ? (stats.byType?.workflow || 0) : '—' }}</dd></div>
        </dl>
        <div v-if="store.statsError" class="event-stats-error" role="status"><span>{{ stats ? '概览未更新，当前为上次统计。' : '概览暂不可用，仍可处理下方事件。' }}</span><button :disabled="store.statsLoading" @click="store.loadStats()">重试统计</button></div>
      </section>

      <div class="event-filter-bar">
        <div class="event-types" role="group" aria-label="筛选事件类型">
          <button v-for="t in typeFilters" :key="t.value" class="event-filter-chip" :aria-pressed="typeFilter === t.value" @click="setFilter('type', t.value)">{{ t.label }}</button>
        </div>
      </div>

      <div v-if="feedback" ref="feedbackEl" class="event-feedback" role="status" tabindex="-1"><CircleCheck class="h-4 w-4 shrink-0" /><span>{{ feedback }}</span><button class="icon-btn ml-auto shrink-0" aria-label="清除处理反馈" @click="feedback = ''"><X class="h-3.5 w-3.5" /></button></div>
      <p v-if="error" class="alert-error" role="alert">{{ error }}<span v-if="events.length">。列表保留了上次加载的数据。</span> <button class="underline" :disabled="loading" @click="load">重试加载</button></p>

      <!-- 事件列表 -->
      <section class="section-panel event-list" :aria-busy="loading">
        <div class="event-list-toolbar"><div><h2 class="section-title">事件流</h2><p class="mt-1 text-muted" role="status" aria-live="polite">{{ loading ? '正在更新记录…' : `显示 ${visibleEvents.length} / ${events.length} 条记录` }}<span v-if="!loading"> · 最近 200 条内检索</span></p></div><div class="event-search-actions"><div class="event-search"><Search class="h-4 w-4" /><input v-model="query" class="input" type="search" maxlength="200" placeholder="搜索标题、来源或详情" aria-label="搜索当前事件记录" /></div><select class="input event-status-filter" aria-label="筛选事件状态" :value="statusFilter" @change="setFilter('status', $event.target.value)"><option value="">全部状态</option><option value="open">待处理</option><option value="acknowledged">已确认</option><option value="resolved">已解决</option><option value="closed">已关闭</option></select><button v-if="hasFilters" class="btn-ghost shrink-0" @click="clearFilters">清除筛选</button></div></div>
        <Skeleton v-if="loading && !events.length" variant="table" :rows="5" label="正在加载事件记录" />
        <TransitionGroup v-else name="event-list" tag="div" class="space-y-2">
          <article v-for="event in visibleEvents" :key="event.id" class="event-row" :data-event-id="event.id" :data-status="event.status" :aria-labelledby="`event-title-${event.id}`" :aria-busy="pendingStatus.has(event.id)">
            <span class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" :class="severityDot(event.severity)"></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="count-badge" :class="typeTone(event.eventType)">{{ typeLabel(event.eventType) }}</span>
                <h3 :id="`event-title-${event.id}`" class="event-title">{{ event.title }}</h3>
                <span class="text-xs text-surface-400">{{ event.assetName || '' }}</span><span class="event-status" :data-status="event.status"><Loader2 v-if="pendingStatus.has(event.id)" class="h-3 w-3 animate-spin" />{{ statusLabel(event.status) }}</span>
              </div>
              <p v-if="event.detail" :id="`event-detail-${event.id}`" class="event-detail" :class="{ 'is-collapsed': longDetail(event) && !expandedDetails.has(event.id) }">{{ event.detail }}</p>
              <button v-if="longDetail(event)" class="event-detail-toggle" :aria-controls="`event-detail-${event.id}`" :aria-expanded="expandedDetails.has(event.id)" @click="toggleDetail(event.id)">{{ expandedDetails.has(event.id) ? '收起详情' : '展开完整详情' }}<ChevronDown class="h-3 w-3" :class="{ 'rotate-180': expandedDetails.has(event.id) }" /></button>
              <p class="mt-1 text-[11px] text-surface-400">{{ formatTime(event.createdAt) }} · {{ event.source }}</p>
            </div>
            <div class="event-actions">
              <div class="event-context-actions">
              <router-link v-if="eventDestination(event)" class="btn-ghost" :to="eventDestination(event)">查看来源</router-link>
              <router-link v-if="eventContainerLink(event, '/logs')" class="btn-ghost" :to="eventContainerLink(event, '/logs')">日志</router-link>
              <router-link v-if="eventContainerLink(event, '/monitor')" class="btn-ghost" :to="eventContainerLink(event, '/monitor')">监控</router-link>
              <router-link class="btn-ghost" :to="deepLink('/tickets', { create: 1, sourceType: 'event', sourceId: event.id, title: event.title, description: event.detail, projectId: event.payload?.projectId, from: 'events' })">建工单</router-link>
              </div>
              <div class="event-state-actions">
              <button v-if="event.status === 'open'" class="btn-ghost" :disabled="pendingStatus.has(event.id)" @click="setStatus(event, 'acknowledged')">确认</button>
              <button v-if="!['resolved', 'closed'].includes(event.status)" class="btn-secondary btn-sm" :disabled="pendingStatus.has(event.id)" @click="setStatus(event, 'resolved')">解决</button>
              <button v-if="event.status !== 'closed'" class="btn-secondary btn-sm" :disabled="pendingStatus.has(event.id)" @click="setStatus(event, 'closed')">关闭</button><button v-if="['resolved', 'closed'].includes(event.status)" class="btn-secondary btn-sm" :disabled="pendingStatus.has(event.id)" @click="setStatus(event, 'open')">重新打开</button>
              </div>
            </div>
          </article>
        </TransitionGroup>
        <EmptyState v-if="!visibleEvents.length && !error && !loading" compact icon="History" :title="hasFilters ? '没有匹配的事件' : '暂无事件'" :description="hasFilters ? '调整搜索、类型或状态，查看其它记录。' : '运行巡检或执行任务后，可在这里跟踪结果。'" :action-label="hasFilters ? '清除筛选' : '刷新事件'" @action="hasFilters ? clearFilters() : load()" />
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
import SceneIllustration from '../components/common/SceneIllustration.vue';
import { deepLink, eventDestination, eventContainerLink } from '../lib/deep-links.js';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useRoute, useRouter } from 'vue-router';
import { ArrowRight, BellRing, ChevronDown, CircleCheck, Gauge, History, ListChecks, Loader2, RefreshCw, Search, Trash2, X } from 'lucide-vue-next';
import { useEventStore } from '../stores/events.js';
import { useToastStore } from '../stores/toast.js';
import EventTimeline from '../components/events/EventTimeline.vue';
import StateHistoryPanel from '../components/events/StateHistoryPanel.vue';
import OperationsView from './OperationsView.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import { formatTimestamp } from '../lib/date-time.js';
import { handleTablistKeydown } from '../lib/tablist-keyboard.js';

const route = useRoute();
const router = useRouter();
const store = useEventStore();
const toast = useToastStore();
const TABS = ['timeline', 'operations', 'state'];
const tab = ref(TABS.includes(route.query.tab) ? route.query.tab : 'events');
const typeFilter = computed(() => typeFilters.some(type => type.value === route.query.type) ? route.query.type : '');
const statusFilter = computed(() => ['open', 'acknowledged', 'resolved', 'closed'].includes(route.query.status) ? route.query.status : '');
const pendingStatus = ref(new Set());
const expandedDetails = ref(new Set());
const feedback = ref('');
const feedbackEl = ref(null);
const query = computed({
  get: () => typeof route.query.q === 'string' ? route.query.q : '',
  set: value => { const next = { ...route.query }; if (value) next.q = value; else delete next.q; void router.replace({ query: next }); },
});
const hasFilters = computed(() => !!(typeFilter.value || statusFilter.value || query.value));
const visibleEvents = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return needle ? events.value.filter(event => `${event.title} ${event.detail || ''} ${event.source || ''} ${event.assetName || ''}`.toLocaleLowerCase().includes(needle)) : events.value;
});
function longDetail(event) { return event.detail?.length > 180 || event.detail?.split('\n').length > 3; }
function toggleDetail(id) { if (expandedDetails.value.has(id)) expandedDetails.value.delete(id); else expandedDetails.value.add(id); }
function statusLabel(status) { return { open: '待处理', acknowledged: '已确认', resolved: '已解决', closed: '已关闭' }[status] || '状态未知'; }
function setFilter(key, value) {
  const query = { ...route.query };
  if (value) query[key] = value; else delete query[key];
  void router.push({ query });
}
function clearFilters() { const query = { ...route.query }; delete query.type; delete query.status; delete query.q; void router.push({ query }); }

function handleTabKeydown(event) { handleTablistKeydown(event, setTab); }
function setTab(next) {
  tab.value = next;
  const query = { ...route.query };
  if (next === 'events') delete query.tab; else query.tab = next;
  router.push({ query });
}
watch(() => route.query.tab, (value) => { if (route.path !== '/events') return; tab.value = TABS.includes(value) ? value : 'events'; if (tab.value === 'events') void load(); });

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
function formatTime(ts) { return formatTimestamp(ts); }

async function load() {
  await Promise.all([store.load({ eventType: typeFilter.value, status: statusFilter.value }), store.loadStats()]);
}
async function setStatus(event, status) {
  if (pendingStatus.value.has(event.id)) return;
  const restoreFocus = document.activeElement?.closest('[data-event-id]')?.getAttribute('data-event-id') === String(event.id);
  pendingStatus.value.add(event.id);
  try {
    await store.update(event.id, { status });
    feedback.value = `「${event.title}」已标记为${statusLabel(status)}。${!visibleEvents.value.some(item => item.id === event.id) ? '该记录已移出当前筛选。' : ''}`;
    await nextTick();
    if (restoreFocus) {
      feedbackEl.value?.focus({ preventScroll: true });
      feedbackEl.value?.scrollIntoView?.({ block: 'nearest' });
    }
  } catch (e) {
    toast.error(e);
  } finally { pendingStatus.value.delete(event.id); }
}
const showPruneConfirm = ref(false);
const pruning = ref(false);
const pruneError = ref('');
async function prune() {
  if (pruning.value) return;
  pruning.value = true;
  pruneError.value = '';
  try {
    await store.prune(30);
    showPruneConfirm.value = false;
    toast.success('历史事件已清理');
  } catch (e) {
    pruneError.value = e.message || '清理失败，请重试';
    toast.error(e);
  } finally { pruning.value = false; }
}

watch([typeFilter, statusFilter], () => { if (route.path === '/events' && tab.value === 'events') void load(); });
// 只在「告警事件」tab 响应下拉刷新:时间线、状态历史与操作 tab 分别由 EventTimeline、StateHistoryPanel、OperationsView 负责,避免一次下拉发两遍请求。
usePullRefresh(load, { enabled: () => tab.value === 'events' });
onMounted(() => { if (tab.value === 'events') load(); });
</script>

<style scoped>
@reference '../style.css';
.event-overview { display: grid; grid-template-columns: minmax(0, 1fr) 150px minmax(290px, .9fr); align-items: center; gap: 20px; padding: 18px 22px; border: 1px solid var(--color-surface-800); border-radius: 16px; background: radial-gradient(ellipse at 0 0, rgba(52,211,153,.035), transparent 65%), var(--color-surface-900); }
.event-overview-copy { min-width: 0; }
.event-eyebrow { @apply flex items-center gap-2 text-xs text-surface-400; }
.event-signal { width: 6px; height: 6px; border-radius: 50%; background: var(--color-status-ok); box-shadow: 0 0 10px rgba(110,231,183,.18); }
.event-signal.has-pending { background: var(--color-status-warn); box-shadow: 0 0 10px rgba(251,191,36,.18); }
.event-overview-copy h2 { @apply my-2 text-xl font-semibold tracking-tight text-surface-100; }
.event-focus-link { @apply inline-flex min-h-8 items-center gap-2 text-xs text-emerald-300 transition-colors hover:text-emerald-200; }
.event-scene { width: 150px; }
.event-overview-stats { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 16px; padding-left: 20px; border-left: 1px solid var(--color-surface-800); }
.event-overview-stats dt { @apply text-xs text-surface-400; }
.event-overview-stats dd { @apply mt-2 text-2xl font-semibold tabular-nums; }
.event-stats-error { @apply col-span-full flex flex-wrap items-center gap-3 border-t border-surface-800 pt-3 text-xs text-amber-300; }
.event-stats-error button { @apply min-h-8 underline underline-offset-4; }
.event-filter-bar { @apply flex flex-wrap items-center justify-between gap-3; }
.event-types { @apply flex flex-wrap gap-1; }
.event-filter-chip { @apply min-h-10 rounded-lg border border-transparent px-3 text-sm text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-100; }
.event-filter-chip[aria-pressed="true"] { @apply border-emerald-400/25 bg-emerald-400/10 text-emerald-300; }
.event-status-filter { min-height: 40px; }
.event-list-toolbar { @apply mb-4 flex flex-wrap items-center justify-between gap-3; }
.event-search-actions { @apply flex flex-wrap items-center gap-2; }
.event-search { @apply relative min-w-0; }
.event-search > svg { @apply pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-surface-500; }
.event-search input { width: 260px; max-width: 100%; padding-left: 36px; min-height: 40px; }
.event-feedback { @apply flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-2 text-sm text-emerald-200; }
.event-feedback span { min-width: 0; overflow-wrap: anywhere; }
.event-row { @apply grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3 rounded-xl border border-surface-800 bg-surface-950/40 p-4 transition-colors; }
.event-row:hover, .event-row:focus-within { border-color: var(--color-surface-700); }
.event-row[data-status="resolved"], .event-row[data-status="closed"] { background: rgba(110,231,183,.015); }
.event-title { @apply text-sm font-medium text-surface-100; overflow-wrap: anywhere; }
.event-detail { @apply mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-surface-400; overflow-wrap: anywhere; }
.event-detail.is-collapsed { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.event-detail-toggle { @apply mt-1 inline-flex min-h-8 items-center gap-1 text-xs text-surface-400 hover:text-surface-200; }
.event-detail-toggle svg { transition: transform 160ms ease; }
.event-status { @apply inline-flex items-center gap-1 rounded-full border border-surface-700 px-2 py-0.5 text-xs text-surface-400; }
.event-status[data-status="open"] { @apply border-amber-400/25 bg-amber-400/10 text-amber-300; }
.event-status[data-status="acknowledged"] { @apply border-sky-400/25 bg-sky-400/10 text-sky-300; }
.event-status[data-status="resolved"] { @apply border-emerald-400/25 bg-emerald-400/10 text-emerald-300; }
.event-actions { @apply col-start-2 flex flex-wrap items-center justify-between gap-3 border-t border-surface-800/60 pt-3; }
.event-context-actions, .event-state-actions { @apply flex flex-wrap items-center gap-1.5; }
.event-actions a, .event-actions button { min-height: 36px; }
.event-list-enter-active, .event-list-leave-active { transition: opacity 160ms ease, transform 160ms ease; }
.event-list-enter-from, .event-list-leave-to { opacity: 0; transform: translateY(4px); }
@media (min-width: 640px) and (max-width: 1100px) {
 .event-overview { grid-template-columns: minmax(0,1fr) 130px; }
 .event-scene { width: 130px; }
 .event-overview-stats { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--color-surface-800); padding: 14px 0 0; }
}
@media (max-width: 639px) {
 .event-overview { grid-template-columns: 1fr; gap: 14px; padding: 16px; }
 .event-overview-copy { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 0 8px; }
 .event-eyebrow { grid-column: 1 / -1; }
 .event-overview-copy h2 { font-size: 18px; }
 .event-overview-copy > p { grid-column: 1 / -1; }
 .event-scene { display: none; }
 .event-overview-stats { border-left: 0; border-top: 1px solid var(--color-surface-800); padding: 14px 0 0; gap: 8px; }
 .event-overview-stats dd { margin-top: 4px; font-size: 20px; }
 .event-focus-link { min-height: 40px; }
 .event-list { @apply p-3; }
 .event-search-actions { display: grid; grid-template-columns: minmax(0,1fr) 120px; width: 100%; }
 .event-search-actions > button { grid-column: 1 / -1; justify-self: start; }
 .event-search, .event-search input { width: 100%; }
 .event-types { flex-wrap: nowrap; width: 100%; overflow-x: auto; padding-bottom: 2px; }
 .event-filter-chip { flex-shrink: 0; }
 .event-row { @apply p-3; }
 .event-filter-chip, .event-actions a, .event-actions button, .event-detail-toggle { min-height: 44px; }
 .event-actions { grid-column: 1 / -1; }
 .event-state-actions { margin-left: auto; }
 .event-status-filter { min-height: 44px; width: 120px; }
}
@media (prefers-reduced-motion: reduce) {
 .event-detail-toggle svg, .event-list-enter-active, .event-list-leave-active { transition: none; }
}
</style>
