<template>
  <div class="page-shell ops-command-center" :aria-busy="loading">
    <div class="page-header">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="page-title">任务中心</h1>
          <span class="rounded-full border border-status-ok/25 bg-status-ok/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-status-ok">运行与审批</span>
        </div>
        <p class="page-subtitle">统一查看任务、事件、人工审批与执行结果；每条记录都能追溯到原始来源。</p>
      </div>
      <div class="page-actions flex-wrap">
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button>
        <button class="btn-secondary" @click="router.push('/maintenance-plan')"><CalendarClock class="h-4 w-4" />计划编排</button>
        <button class="btn-primary" @click="router.push('/agent')"><Bot class="h-4 w-4" />打开 Agent</button>
      </div>
    </div>

    <section class="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="运行态势">
      <MetricTile interactive title="等待你决策" :value="approvalCount" sub="工作流审批与 Agent 确认" :icon="ShieldAlert" tone="text-status-warn" :active="tab === 'approvals'" @click="setTab('approvals')" />
      <MetricTile interactive title="正在运行" :value="activeCount" sub="排队与执行中的任务" :icon="Activity" :active="tab === 'tasks' && taskTab === 'active'" @click="setTab('tasks', 'active')" />
      <MetricTile interactive title="需要核对" :value="reviewCount" sub="失败或结果不确定" :icon="TriangleAlert" tone="text-status-error" :active="tab === 'review'" @click="setTab('review')" />
      <MetricTile interactive title="待处理事件" :value="openEventCount" :sub="`${events.length} 条已汇聚事件`" :icon="BellRing" :active="tab === 'events'" @click="setTab('events')" />
    </section>

    <div v-if="sourceErrors.length" class="space-y-2" role="status" aria-live="polite">
      <div v-for="issue in sourceErrors" :key="issue.source" class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-status-warn/20 bg-status-warn/5 px-3 py-2 text-xs text-status-warn">
        <span>{{ issue.source }}读取失败：{{ issue.message }}。其他数据源仍正常显示。</span>
        <button class="font-semibold underline underline-offset-2" @click="load">重试</button>
      </div>
    </div>

    <div class="tabs-segment" role="tablist" aria-label="统一运维视图" @keydown="handleTabKeydown">
      <button v-for="item in tabs" :key="item.id" :id="'ops-tab-' + item.id" :data-tab="item.id" role="tab"
        :aria-controls="'ops-panel-' + item.id" :aria-selected="tab === item.id"
        :tabindex="tab === item.id ? 0 : -1" :class="{ active: tab === item.id }" @click="setTab(item.id)">
        <component :is="item.icon" class="h-4 w-4" />{{ item.label }}<span>{{ item.count }}</span>
      </button>
    </div>

    <section v-if="tab === 'tasks' || tab === 'approvals' || tab === 'review'" :id="'ops-panel-' + tab" role="tabpanel" :aria-labelledby="'ops-tab-' + tab" tabindex="0" class="ops-workspace">
      <div class="ops-list-pane">
        <div class="ops-list-toolbar">
          <label class="search-field min-w-0 flex-1">
            <Search class="h-4 w-4" />
            <input v-model="query" aria-label="搜索任务" placeholder="搜索任务、项目或 ID..." />
          </label>
          <select v-if="tab === 'tasks'" v-model="statusFilter" class="input w-full sm:w-auto sm:min-w-32" aria-label="按状态筛选任务">
            <option value="all">全部状态</option>
            <option value="pending">待执行</option>
            <option value="running">执行中</option>
            <option value="waiting_approval">待审批</option>
            <option value="outcome_unknown">结果待核对</option>
            <option value="failed">失败</option>
            <option value="success">已完成</option>
            <option value="cancelled">已取消</option>
          </select>
          <select v-if="tab === 'tasks'" v-model="sourceFilter" class="input w-full sm:w-auto sm:min-w-36" aria-label="按来源筛选任务">
            <option value="all">全部来源</option>
            <option value="agent-plan">Agent 计划</option>
            <option value="agent-task">Agent 后台任务</option>
            <option value="workflow">工作流</option>
            <option value="batch-job">批量任务</option>
          </select>
          <button v-if="query || statusFilter !== 'all' || sourceFilter !== 'all'" class="btn-secondary btn-sm" @click="resetFilters">清除筛选</button>
          <span class="ops-result-count">{{ currentList.length }} 条</span>
        </div>

        <div v-if="currentList.length" class="ops-record-list">
          <button v-for="item in currentList" :key="item.id" class="ops-record" :class="{ selected: selectedTaskId === item.id }" @click="selectTask(item)">
            <span class="ops-record-icon" :class="'source-' + item.source">
              <Bot v-if="item.source === 'agent-plan' || item.source === 'agent-task'" class="h-4 w-4" />
              <Workflow v-else-if="item.source === 'workflow'" class="h-4 w-4" />
              <Layers3 v-else class="h-4 w-4" />
            </span>
            <span class="ops-record-main">
              <span class="ops-record-top">
                <strong>{{ item.sourceLabel }}</strong>
                <span :class="'ops-status is-' + taskStatusTone(item.status)">{{ taskStatusLabel(item.status) }}</span>
              </span>
              <span class="ops-record-title">{{ item.title }}</span>
              <span class="ops-record-meta">
                <span v-if="item.projectName">{{ item.projectName }}</span>
                <span v-else>{{ item.subtitle || item.sourceId }}</span>
                <span>{{ formatTime(item.updatedAt || item.createdAt) }}</span>
              </span>
              <span v-if="item.status === 'outcome_unknown'" class="ops-record-warning"><AlertCircle class="h-3 w-3" />需要先核对真实环境，禁止自动重试</span>
              <span v-else-if="item.status === 'waiting_approval'" class="ops-record-approval"><ShieldCheck class="h-3 w-3" />等待人工决策</span>
            </span>
            <ChevronRight class="ops-record-chevron h-4 w-4" />
          </button>
        </div>
        <div v-else class="ops-empty">
          <EmptyState :icon="tab === 'approvals' ? 'ShieldCheck' : tab === 'review' ? 'Search' : 'ListChecks'" :title="emptyTitle" :description="emptyDescription" />
          <button v-if="tab !== 'tasks' || query || statusFilter !== 'all' || sourceFilter !== 'all'" class="btn-secondary mt-3" @click="resetFilters">清除筛选</button>
        </div>
      </div>

      <aside class="ops-detail-pane">
        <template v-if="selectedTask">
          <div class="ops-detail-head">
            <div class="flex flex-wrap items-center gap-2">
              <span class="ops-source-pill">{{ selectedTask.sourceLabel }}</span>
              <span :class="'ops-status is-' + taskStatusTone(selectedTask.status)">{{ taskStatusLabel(selectedTask.status) }}</span>
            </div>
            <h2>{{ selectedTask.title }}</h2>
            <p>{{ selectedTask.subtitle || selectedTask.sourceId }}</p>
            <div class="ops-detail-meta"><span>ID · {{ selectedTask.sourceId }}</span><span v-if="selectedTask.projectName">{{ selectedTask.projectName }}</span><span>{{ formatTime(selectedTask.createdAt) }}</span></div>
          </div>

          <div v-if="selectedTask.status === 'outcome_unknown'" class="ops-review-warning" role="alert">
            <TriangleAlert class="h-4 w-4 shrink-0" />
            <div><strong>执行结果待核对</strong><p>系统无法确认之前的副作用是否完成。先核查真实服务、容器和数据状态，不要直接重放或自动重试。</p></div>
          </div>

          <div v-if="selectedTask.source === 'workflow' && workflowDetail?.context?.pendingApprovalIntent" class="ops-approval-intent">
            <div class="flex items-center gap-2 text-status-warn"><ShieldAlert class="h-4 w-4" /><strong>工作流审批意图</strong></div>
            <p>{{ selectedTask.approvalSummary || '后端已冻结审批意图，展开查看具体上下文。' }}</p>
            <pre>{{ prettyJson(workflowDetail.context.pendingApprovalIntent) }}</pre>
          </div>

          <div v-if="selectedTask.source === 'agent-task' && taskDetail?.output" class="ops-output-section">
            <div class="ops-section-heading"><h3>后台任务输出</h3><span>{{ formatBytes(taskDetail.outputBytes) }}</span></div>
            <pre>{{ taskDetail.output }}</pre>
          </div>

          <div v-if="selectedTask.source === 'batch-job' && jobDetail?.items?.length" class="ops-output-section">
            <div class="ops-section-heading"><h3>项目执行明细</h3><span>{{ jobDetail.completed || 0 }} / {{ jobDetail.total || 0 }}</span></div>
            <div v-for="item in jobDetail.items" :key="item.id" class="ops-job-item">
              <div><strong>{{ item.projectName || item.projectId }}</strong><span>{{ item.status }}</span></div>
              <pre v-if="item.output || item.error">{{ item.error || item.output }}</pre>
            </div>
          </div>

          <div v-if="selectedTask.source === 'agent-plan'" class="ops-detail-actions">
            <button class="btn-secondary" @click="openAgentHistory"><History class="h-4 w-4" />Agent 执行历史</button>
            <button v-if="selectedTask.sessionId" class="btn-secondary" @click="openAgentSession"><MessageSquare class="h-4 w-4" />打开原会话</button>
          </div>
          <div v-else-if="selectedTask.source === 'workflow'" class="ops-detail-actions">
            <button v-if="selectedTask.status === 'waiting_approval' && workflowDetail?.context?.pendingApprovalIntent" class="btn-primary" :disabled="detailLoading" @click="requestAction('workflow-approve', selectedTask)"><ShieldCheck class="h-4 w-4" />审批通过</button>
            <button v-if="selectedTask.status === 'waiting_approval'" class="btn-secondary" :disabled="detailLoading" @click="requestAction('workflow-reject', selectedTask)">拒绝审批</button>
            <button v-if="['pending','running','waiting_approval'].includes(selectedTask.status)" class="btn-secondary" :disabled="detailLoading" @click="requestAction('workflow-cancel', selectedTask)"><X class="h-4 w-4" />取消实例</button>
            <button class="btn-secondary" @click="router.push('/workflows')"><Workflow class="h-4 w-4" />工作流中心</button>
          </div>
          <div v-else-if="selectedTask.source === 'agent-task'" class="ops-detail-actions">
            <button v-if="['queued','running'].includes(selectedTask.status)" class="btn-secondary" @click="requestAction('agent-task-stop', selectedTask)"><Square class="h-4 w-4" />请求停止</button>
            <button class="btn-secondary" @click="openAgentSession" :disabled="!selectedTask.sessionId"><MessageSquare class="h-4 w-4" />打开原会话</button>
          </div>
          <div v-else-if="selectedTask.source === 'batch-job'" class="ops-detail-actions">
            <button class="btn-secondary" @click="router.push({ path: '/events', query: { tab: 'operations', job: selectedTask.sourceId } })"><ExternalLink class="h-4 w-4" />操作明细页</button>
          </div>

          <div class="ops-thread">
            <div class="ops-section-heading"><div><h3>执行时间线</h3><p>仅展示有明确关联依据的事件与执行记录</p></div><span>{{ selectedTimeline.length }}</span></div>
            <div v-if="detailLoading" class="ops-inline-loading"><RefreshCw class="h-4 w-4 animate-spin" />正在读取原始执行详情…</div>
            <div v-else-if="selectedTimeline.length" class="ops-timeline">
              <div v-for="entry in selectedTimeline" :key="entry.id" class="ops-timeline-item">
                <span class="ops-timeline-dot" :class="'tone-' + entry.tone"></span>
                <div><strong>{{ entry.label }}</strong><p>{{ entry.detail || '—' }}</p><time>{{ formatTime(entry.at) }}</time></div>
              </div>
            </div>
            <EmptyState v-else compact icon="History" title="暂无可确认的关联时间线" description="仅展示来源明确的关联记录；可切换其他任务查看。" />
          </div>
        </template>
        <div v-else class="ops-detail-placeholder">
          <div class="ops-detail-placeholder-icon"><Activity class="h-6 w-6" /></div>
          <h2>选择一条任务记录</h2>
          <p>在这里查看来源、执行输出、审批意图，以及由明确 ID 或项目关系串联的时间线。</p>
        </div>
      </aside>
    </section>

    <section v-else-if="tab === 'events'" id="ops-panel-events" role="tabpanel" aria-labelledby="ops-tab-events" tabindex="0" class="ops-events-layout">
      <div class="ops-list-pane">
        <div class="ops-list-toolbar">
          <label class="search-field min-w-0 flex-1"><Search class="h-4 w-4" /><input v-model="query" aria-label="搜索事件" placeholder="搜索事件、来源或资产..." /></label>
          <select v-model="eventStatusFilter" class="input w-full sm:w-auto" aria-label="按状态筛选事件">
            <option value="all">全部状态</option><option value="open">待处理</option><option value="acknowledged">已接手</option><option value="resolved">已解决</option><option value="closed">已关闭</option>
          </select>
        </div>
        <div class="ops-record-list">
          <button v-for="event in filteredEvents" :key="event.id" class="ops-record" :class="{ selected: selectedEventId === String(event.id) }" @click="selectedEventId = String(event.id)">
            <span class="ops-record-icon source-event"><BellRing class="h-4 w-4" /></span>
            <span class="ops-record-main">
              <span class="ops-record-top"><strong>{{ event.eventType }} · {{ event.source }}</strong><span :class="'ops-status is-' + (event.severity === 'danger' ? 'danger' : event.status === 'open' ? 'warning' : 'neutral')">{{ event.status }}</span></span>
              <span class="ops-record-title">{{ event.title }}</span>
              <span class="ops-record-meta"><span>{{ event.assetName || event.source }}</span><span>{{ formatTime(event.createdAt) }}</span></span>
            </span>
            <ChevronRight class="ops-record-chevron h-4 w-4" />
          </button>
          <div v-if="!filteredEvents.length" class="ops-empty"><EmptyState icon="BellRing" title="没有匹配事件" description="更改搜索关键词或状态筛选。" /></div>
        </div>
      </div>
      <aside class="ops-detail-pane" v-if="selectedEvent">
        <div class="ops-detail-head">
          <span class="ops-source-pill">OBSERVE · 事件只读观察</span>
          <h2>{{ selectedEvent.title }}</h2>
          <p>{{ selectedEvent.detail || '暂无事件描述' }}</p>
          <div class="ops-detail-meta"><span>{{ selectedEvent.eventType }}</span><span>{{ selectedEvent.source }}</span><span>{{ formatTime(selectedEvent.createdAt) }}</span></div>
        </div>
        <div class="ops-review-warning" v-if="selectedEvent.status === 'open'"><Eye class="h-4 w-4 shrink-0" /><div><strong>事件不会自动授权操作</strong><p>事件内容、日志和外部消息只作为观察证据。任何修复或执行都需要单独的人工授权。</p></div></div>
        <div class="ops-output-section"><div class="ops-section-heading"><h3>事件上下文</h3><span>原始来源</span></div><pre>{{ prettyJson(selectedEvent.payload || {}) }}</pre></div>
        <div class="ops-detail-actions">
          <router-link v-if="eventDestination(selectedEvent)" class="btn-ghost" :to="eventDestination(selectedEvent)">查看来源</router-link>
          <button class="btn-secondary" @click="createTicketFromEvent(selectedEvent)">创建长期任务</button>
          <button v-if="selectedEvent.status === 'open'" class="btn-secondary" @click="setEventStatus(selectedEvent, 'acknowledged')">确认接手</button>
          <button v-if="['open','acknowledged'].includes(selectedEvent.status)" class="btn-primary" @click="setEventStatus(selectedEvent, 'resolved')">标记解决</button>
          <button v-if="selectedEvent.status !== 'closed'" class="btn-secondary" @click="setEventStatus(selectedEvent, 'closed')">关闭事件</button>
        </div>
        <p class="ops-thread-empty">Observe → Suggest → Approval → Execute。此页的事件操作只改变事件状态，不会触发部署、重启或其他系统变更。</p>
      </aside>
      <aside v-else class="ops-detail-pane ops-detail-placeholder"><div class="ops-detail-placeholder-icon"><Eye class="h-6 w-6" /></div><h2>选择一个事件</h2><p>查看来源、严重程度、原始关联 ID 和处理状态。</p></aside>
    </section>

    <section v-else id="ops-panel-timeline" role="tabpanel" aria-labelledby="ops-tab-timeline" tabindex="0" class="ops-global-timeline">
      <div class="ops-list-toolbar">
        <label class="search-field min-w-0 flex-1"><Search class="h-4 w-4" /><input v-model="query" aria-label="搜索全局时间线" placeholder="搜索事件、操作、Agent 或工作流..." /></label>
        <span class="ops-result-count">{{ globalTimeline.length }} 条</span>
      </div>
      <div v-if="filteredGlobalTimeline.length" class="ops-global-timeline-list">
        <button v-for="entry in filteredGlobalTimeline" :key="entry.id" class="ops-global-entry" @click="openTimelineEntry(entry)">
          <span class="ops-timeline-dot" :class="'tone-' + entry.tone"></span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2"><strong>{{ entry.label }}</strong><span class="ops-source-pill">{{ entry.sourceLabel }}</span></div>
            <p>{{ entry.detail || '—' }}</p>
            <time>{{ formatTime(entry.at) }}</time>
          </div>
          <ChevronRight class="h-4 w-4 shrink-0 text-surface-400" />
        </button>
      </div>
      <div v-else class="ops-empty"><EmptyState icon="History" title="暂无时间线记录" description="事件、工具执行、工作流步骤和操作审计会逐步出现在这里。" /></div>
    </section>

    <ConfirmDialog
      :show="!!pendingAction"
      :title="actionDialogTitle"
      :message="actionDialogMessage"
      :tone="pendingAction?.type === 'workflow-approve' ? 'warning' : 'danger'"
      :confirm-text="actionConfirmText"
      @confirm="performAction"
      @cancel="pendingAction = null"
    />
  </div>
</template>

<script setup>
import MetricTile from '../components/common/MetricTile.vue';
import { eventDestination } from '../lib/deep-links.js';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { computed, onActivated, onDeactivated, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Activity, AlertCircle, BellRing, Bot, CalendarClock, ChevronRight, ExternalLink, Eye, History, Layers3, ListChecks, MessageSquare, RefreshCw, Search, ShieldAlert, ShieldCheck, Square, TriangleAlert, Workflow, X } from 'lucide-vue-next';
import { api } from '../api/client.js';
import EmptyState from '../components/common/EmptyState.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import {
  auditEventLabel, buildTaskTimeline, buildUnifiedTasks,
  pendingAgentApprovals, taskMatchesFilter, taskStatusLabel, taskStatusTone, timestampValue,
} from '../lib/ops-command-center.js';
import { handleTablistKeydown } from '../lib/tablist-keyboard.js';

const router = useRouter();
const route = useRoute();
const loading = ref(false);
const detailLoading = ref(false);
const query = ref('');
const tab = ref(['tasks','approvals','review','events','timeline'].includes(route.query.view) ? String(route.query.view) : 'tasks');
const taskTab = ref('all');
const statusFilter = ref('all');
const sourceFilter = ref('all');
const eventStatusFilter = ref('all');
const selectedTaskId = ref('');
const selectedEventId = ref('');
const raw = ref({ plans: [], backgroundTasks: [], workflows: [], jobs: [], events: [], operations: [], executions: [], audits: [] });
const detail = ref(null);
const sourceErrors = ref([]);
const pendingAction = ref(null);
const lastLoadedAt = ref(0);
let loadSequence = 0;
let detailLoadSequence = 0;

function handleTabKeydown(event) {
  handleTablistKeydown(event, (nextTab) => setTab(nextTab));
}

const tabs = computed(() => [
  { id: 'tasks', label: '全部任务', icon: ListChecks, count: tasks.value.length },
  { id: 'approvals', label: '待你审批', icon: ShieldCheck, count: approvalCount.value },
  { id: 'review', label: '结果待核对', icon: TriangleAlert, count: reviewCount.value },
  { id: 'events', label: '事件观察', icon: BellRing, count: events.value.length },
  { id: 'timeline', label: '全局时间线', icon: History, count: globalTimeline.value.length },
]);

const tasks = computed(() => buildUnifiedTasks({
  plans: raw.value.plans, backgroundTasks: raw.value.backgroundTasks,
  workflows: raw.value.workflows, jobs: raw.value.jobs,
}));
const events = computed(() => raw.value.events);
const audits = computed(() => raw.value.audits);
const agentApprovalTasks = computed(() => pendingAgentApprovals(audits.value).map((approval) => {
  const plan = raw.value.plans.find((item) => item.id === approval.planId);
  return {
    id: 'agent-approval:' + approval.executionId,
    source: 'agent-plan',
    sourceId: String(approval.planId || ''),
    title: approval.event.toolName || 'Agent 工具调用',
    subtitle: '等待在 Agent 会话中作出确认',
    sourceLabel: 'Agent 会话确认',
    status: 'waiting_approval',
    sessionId: plan?.session_id == null ? null : String(plan.session_id),
    payload: approval,
    createdAt: approval.event.createdAt,
    updatedAt: approval.event.createdAt,
    updatedMs: timestampValue(approval.event.createdAt),
  };
}));
const workflowApprovalItems = computed(() => tasks.value.filter((task) => task.source === 'workflow' && task.status === 'waiting_approval'));
const approvalCount = computed(() => workflowApprovalItems.value.length + agentApprovalTasks.value.length);
const activeCount = computed(() => tasks.value.filter((task) => ['pending','running'].includes(task.status)).length);
const reviewCount = computed(() => tasks.value.filter((task) => ['outcome_unknown','failed'].includes(task.status)).length);
const openEventCount = computed(() => events.value.filter((event) => event.status === 'open').length);
const selectedTask = computed(() => tasks.value.find((task) => task.id === selectedTaskId.value)
  || agentApprovalTasks.value.find((task) => task.id === selectedTaskId.value) || null);
const selectedEvent = computed(() => events.value.find((event) => String(event.id) === selectedEventId.value) || null);
const workflowDetail = computed(() => detail.value?.workflow || null);
const taskDetail = computed(() => detail.value?.task || null);
const jobDetail = computed(() => detail.value?.job || null);

const currentList = computed(() => {
  if (tab.value === 'approvals') return workflowApprovalItems.value.filter((task) => taskMatchesFilter(task, { query: query.value }))
    .concat(agentApprovalTasks.value.filter((task) => taskMatchesFilter(task, { query: query.value })));
  const selectedTab = tab.value === 'review' ? 'review' : taskTab.value;
  return tasks.value.filter((task) => taskMatchesFilter(task, {
    tab: selectedTab, status: statusFilter.value, source: sourceFilter.value, query: query.value,
  }));
});

const filteredEvents = computed(() => events.value.filter((event) => {
  if (eventStatusFilter.value !== 'all' && event.status !== eventStatusFilter.value) return false;
  const needle = query.value.trim().toLowerCase();
  return !needle || [event.title, event.detail, event.source, event.eventType, event.assetName, event.id].some((v) => String(v || '').toLowerCase().includes(needle));
}));

const selectedTimeline = computed(() => {
  if (!selectedTask.value) return [];
  return buildTaskTimeline(selectedTask.value, {
    events: events.value, operations: raw.value.operations, audits: detail.value?.audits || audits.value,
    workflowDetail: detail.value?.workflow, taskDetail: detail.value?.task,
    jobDetail: detail.value?.job, executions: detail.value?.executions || [],
  });
});

const globalTimeline = computed(() => {
  const rows = [];
  const add = (row) => { if (row.at) rows.push({ ...row, ms: timestampValue(row.at) }); };
  for (const event of events.value) add({ id: 'event:' + event.id, source: 'event', sourceLabel: '事件', label: event.title || '事件', detail: event.detail || event.source, at: event.createdAt, tone: event.severity === 'danger' ? 'danger' : 'warning', taskId: findTaskForEvent(event)?.id || '' });
  for (const operation of raw.value.operations) add({ id: 'operation:' + operation.id, source: 'operation', sourceLabel: '操作审计', label: operation.action, detail: [operation.projectName, operation.detail].filter(Boolean).join(' · '), at: operation.createdAt, tone: operation.status === 'failed' ? 'danger' : 'success', taskId: findTaskForOperation(operation)?.id || '' });
  for (const audit of audits.value) add({ id: audit.id, source: 'agent-audit', sourceLabel: 'Agent 审计', label: auditEventLabel(audit.eventType), detail: [audit.toolName, audit.decision].filter(Boolean).join(' · '), at: audit.createdAt, tone: ['denied','blocked','failed'].includes(audit.decision) ? 'danger' : 'info', taskId: tasks.value.find((task) => task.source === 'agent-plan' && task.sourceId === String(audit.planId))?.id || '' });
  for (const task of tasks.value) add({ id: 'task:' + task.id, source: 'task', sourceLabel: task.sourceLabel, label: task.title, detail: taskStatusLabel(task.status), at: task.updatedAt || task.createdAt, tone: task.status === 'failed' || task.status === 'outcome_unknown' ? 'danger' : task.status === 'success' ? 'success' : 'info', taskId: task.id });
  return rows.sort((a,b) => b.ms - a.ms).slice(0, 160);
});
const filteredGlobalTimeline = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return globalTimeline.value.filter((item) => !needle || [item.label,item.detail,item.sourceLabel].some((value) => String(value || '').toLowerCase().includes(needle)));
});

const emptyTitle = computed(() => tab.value === 'approvals' ? '目前没有待审批项目' : tab.value === 'review' ? '没有待核对或失败任务' : '没有匹配任务');
const emptyDescription = computed(() => tab.value === 'approvals' ? '有工作流进入审批节点时会出现在这里；Agent 工具确认仍在原会话中完成。' : tab.value === 'review' ? '不确定结果不会被自动重试。新的执行记录会继续在这里跟踪。' : '更改搜索条件或来源筛选，也可以从 Agent 工作台发起新任务。');

function findTaskForEvent(event) { return tasks.value.find((task) => taskMatchesEvent(event, task)); }
function taskMatchesEvent(event, task) {
  const payload = event.payload || {};
  return (payload.instanceId && task.source === 'workflow' && String(payload.instanceId) === task.sourceId)
    || (payload.planId && task.source === 'agent-plan' && String(payload.planId) === task.sourceId);
}
function findTaskForOperation(operation) {
  return tasks.value.find((task) => (task.projectId && String(operation.projectId || '') === task.projectId)
    || (task.projectName && operation.projectName && task.projectName === operation.projectName));
}

function setTab(next, nextTaskTab = 'all') {
  tab.value = next;
  taskTab.value = nextTaskTab;
  if (next === 'tasks' && nextTaskTab === 'active') { statusFilter.value = 'all'; sourceFilter.value = 'all'; }
  router.replace({ query: { ...route.query, view: next, ...(next === 'tasks' ? { taskFilter: nextTaskTab } : {}) } });
}
function resetFilters() { query.value = ''; statusFilter.value = 'all'; sourceFilter.value = 'all'; eventStatusFilter.value = 'all'; }

async function load({ preserveSelection = true } = {}) {
  if (loading.value) return;
  loading.value = true;
  const sequence = ++loadSequence;
  const sources = [
    ['Agent 后台任务', () => api.getAgentTasks(100), 'backgroundTasks', 'tasks'],
    ['工作流实例', () => api.getWorkflowInstances({ limit: 200 }, true), 'workflows', 'instances'],
    ['统一事件', () => api.getEvents({ limit: 200 }), 'events', 'events'],
    ['操作记录', () => api.getOperations(), 'operations', 'operations'],
    ['批量任务', () => api.listJobs(100), 'jobs', 'jobs'],
    ['Agent 执行计划', () => api.getAgentExecutions('', 250), 'plans', 'plans'],
    ['Agent 审计轨迹', () => api.getAgentAuditEvents(200), 'audits', 'events'],
  ];
  const results = await Promise.allSettled(sources.map(([, request]) => request()));
  if (sequence !== loadSequence) return;
  const errors = [];
  results.forEach((result, index) => {
    const [label, , key, field] = sources[index];
    if (result.status === 'rejected') { errors.push({ source: label, message: result.reason?.message || '请求失败' }); return; }
    raw.value[key] = result.value?.[field] || [];
  });
  sourceErrors.value = errors;
  lastLoadedAt.value = Date.now();
  loading.value = false;

  if (!preserveSelection || !tasks.value.some((task) => task.id === selectedTaskId.value)) {
    const preferred = ['waiting_approval', 'outcome_unknown', 'running', 'failed']
      .map((status) => currentList.value.find((task) => task.status === status))
      .find(Boolean) || currentList.value[0] || tasks.value[0];
    selectedTaskId.value = preferred?.id || '';
  }
  if (selectedTaskId.value) await loadTaskDetail(selectedTask.value);
}
async function loadTaskDetail(task) {
  const requestId = ++detailLoadSequence;
  if (!task) {
    detail.value = null;
    detailLoading.value = false;
    return;
  }
  const key = task.id;
  detailLoading.value = true;
  detail.value = null;
  sourceErrors.value = sourceErrors.value.filter((issue) => issue.source !== '任务详情');
  try {
    if (task.source === 'workflow') {
      const result = await api.getWorkflowInstance(task.sourceId);
      if (requestId === detailLoadSequence && selectedTaskId.value === key) detail.value = { workflow: result.instance || result };
    } else if (task.source === 'agent-task') {
      const result = await api.getAgentTask(task.sourceId);
      if (requestId === detailLoadSequence && selectedTaskId.value === key) detail.value = { task: result.task || result };
    } else if (task.source === 'batch-job') {
      const result = await api.getJob(task.sourceId);
      if (requestId === detailLoadSequence && selectedTaskId.value === key) detail.value = { job: result.job || result };
    } else if (task.source === 'agent-plan') {
      const [planResult, auditResult] = await Promise.allSettled([
        api.getAgentExecutions(task.sourceId, 250),
        api.getAgentAuditEvents(200, { planId: task.sourceId }),
      ]);
      if (requestId === detailLoadSequence && selectedTaskId.value === key) detail.value = {
        plan: planResult.status === 'fulfilled' ? planResult.value?.plan : null,
        executions: planResult.status === 'fulfilled' ? (planResult.value?.executions || []) : [],
        audits: auditResult.status === 'fulfilled' ? (auditResult.value?.events || []) : [],
      };
    }
  } catch (error) {
    if (requestId === detailLoadSequence && selectedTaskId.value === key) sourceErrors.value = [...sourceErrors.value, { source: '任务详情', message: error.message || '读取失败' }];
  } finally {
    if (requestId === detailLoadSequence) detailLoading.value = false;
  }
}
watch(currentList, (list) => {
  if (selectedTaskId.value && list.some((task) => task.id === selectedTaskId.value)) return;
  const next = list[0] || null;
  selectedTaskId.value = next?.id || '';
  if (next) void loadTaskDetail(next);
  else void loadTaskDetail(null);
}, { flush: 'post' });
async function selectTask(task) {
  selectedTaskId.value = task.id;
  router.replace({ query: { ...route.query, view: tab.value, task: task.id } });
  await loadTaskDetail(task);
}
function openTimelineEntry(entry) {
  if (entry.taskId) {
    const task = tasks.value.find((item) => item.id === entry.taskId);
    if (!task) return;
    setTab('tasks');
    void selectTask(task);
  } else if (entry.source === 'event') {
    setTab('events');
    selectedEventId.value = entry.id.replace(/^event:/, '');
  }
}
const selectedTaskPlanSession = computed(() => selectedTask.value?.source === 'agent-plan'
  ? (selectedTask.value.sessionId || null) : selectedTask.value?.source === 'agent-task' ? selectedTask.value.sessionId : null);
function openAgentHistory() { router.push('/agent/history'); }
function openAgentSession() {
  if (selectedTaskPlanSession.value) router.push({ path: '/agent', query: { sessionId: selectedTaskPlanSession.value } });
}

const actionDialogTitle = computed(() => ({
  'workflow-approve': '确认通过工作流审批',
  'workflow-reject': '拒绝工作流审批',
  'workflow-cancel': '取消工作流实例',
  'agent-task-stop': '请求停止 Agent 后台任务',
})[pendingAction.value?.type] || '确认操作');
const actionDialogMessage = computed(() => {
  const item = pendingAction.value?.task;
  if (!item) return '';
  if (pendingAction.value.type === 'workflow-approve') return '你将批准「' + item.title + '」冻结的执行意图。只有当前等待审批且意图快照有效时，后端才会继续执行。';
  if (pendingAction.value.type === 'workflow-reject') return '拒绝后将取消工作流实例，不会继续执行后续节点。';
  if (pendingAction.value.type === 'workflow-cancel') return '确认取消该工作流实例？正在运行的步骤可能需要另行核对执行结果。';
  return '向后台任务发送停止请求。停止能力取决于执行方式；如果后端无法确认进程已终止，状态仍会保持待核对。';
});
const actionConfirmText = computed(() => ({ 'workflow-approve': '通过并继续', 'workflow-reject': '拒绝', 'workflow-cancel': '取消实例', 'agent-task-stop': '发送停止请求' })[pendingAction.value?.type] || '确认');
function requestAction(type, task) { pendingAction.value = { type, task }; }
async function performAction() {
  const current = pendingAction.value;
  pendingAction.value = null;
  if (!current) return;
  try {
    if (current.type === 'workflow-approve') await api.approveWorkflowInstance(current.task.sourceId, { approved: true });
    else if (current.type === 'workflow-reject') await api.approveWorkflowInstance(current.task.sourceId, { approved: false });
    else if (current.type === 'workflow-cancel') await api.cancelWorkflowInstance(current.task.sourceId);
    else if (current.type === 'agent-task-stop') await api.stopAgentTask(current.task.sourceId);
    await load();
  } catch (error) {
    sourceErrors.value = [...sourceErrors.value, { source: '操作失败', message: error.message || '请求失败' }];
  }
}
function createTicketFromEvent(event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
  const description = [
    '来源事件 ID：' + event.id,
    '事件类型：' + (event.eventType || 'unknown'),
    '事件来源：' + (event.source || 'unknown'),
    event.detail ? '观察摘要：' + event.detail : '',
    '以下原始事件载荷仅作为观察证据，不构成任何执行授权：',
    JSON.stringify(payload, null, 2).slice(0, 5000),
  ].filter(Boolean).join('\n');
  router.push({ path: '/tickets', query: { create: '1', sourceType: 'event', sourceId: String(event.id), title: String(event.title || '事件跟进任务'), description, projectId } });
}

async function setEventStatus(event, status) {
  try {
    await api.updateEvent(event.id, { status });
    const result = await api.getEvents({ limit: 200 });
    raw.value.events = result.events || [];
    selectedEventId.value = String(event.id);
  } catch (error) {
    sourceErrors.value = [...sourceErrors.value, { source: '事件状态更新失败', message: error.message || '请求失败' }];
  }
}
function formatTime(value) {
  const ms = timestampValue(value);
  return ms ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}
function prettyJson(value) { try { return JSON.stringify(value ?? {}, null, 2); } catch { return '{}'; } }
function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
watch(() => route.query.view, (value) => {
  if (['tasks','approvals','review','events','timeline'].includes(value) && value !== tab.value) tab.value = value;
});
watch(() => route.query.task, async (value) => {
  if (!value || value === selectedTaskId.value) return;
  const task = tasks.value.find((item) => item.id === String(value));
  if (task) { selectedTaskId.value = task.id; await loadTaskDetail(task); }
});
watch(selectedEventId, () => {
  if (selectedEventId.value && route.query.event !== selectedEventId.value) router.replace({ query: { ...route.query, event: selectedEventId.value, view: 'events' } });
});

onMounted(async () => {
  if (route.query.taskFilter === 'active') taskTab.value = 'active';
  await load({ preserveSelection: false });
  const eventId = route.query.event;
  if (eventId) { tab.value = 'events'; selectedEventId.value = String(eventId); }
  if (route.query.task) {
    const requested = tasks.value.find((task) => task.id === String(route.query.task));
    if (requested) { selectedTaskId.value = requested.id; await loadTaskDetail(requested); }
  }
});
usePullRefresh(load, { keepAlive: true });
onDeactivated(() => { loadSequence += 1; detailLoadSequence += 1; loading.value = false; detailLoading.value = false; });
onActivated(() => { if (!lastLoadedAt.value || Date.now() - lastLoadedAt.value > 15000) void load(); });
onBeforeUnmount(() => { loadSequence++; detailLoadSequence++; });
</script>

<style scoped>
.ops-command-center { min-width: 0; gap: 1.1rem; }
.ops-command-center .page-header { align-items: flex-start; }
.ops-workspace,.ops-events-layout { display:grid; grid-template-columns:minmax(0,1fr) minmax(21rem,.85fr); gap:.9rem; min-width:0; align-items:start; }
.ops-list-pane,.ops-detail-pane { min-width:0; overflow:hidden; border:1px solid rgba(82,82,91,.32); border-radius:1rem; background:rgba(16,20,27,.72); }
.ops-list-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:.55rem; padding:.8rem; border-bottom:1px solid rgba(82,82,91,.23); }
.ops-list-toolbar .search-field { min-height:2.35rem; }
.ops-list-toolbar .input { min-height:2.35rem; }
.ops-result-count { margin-left:auto; color:#71717a; font-size:.7rem; white-space:nowrap; }
.ops-record-list { display:grid; max-height:68vh; overflow:auto; padding:.4rem; }
.ops-record { display:flex; align-items:flex-start; gap:.7rem; min-width:0; padding:.8rem .65rem; border:1px solid transparent; border-radius:.8rem; text-align:left; transition:background .15s,border-color .15s; }
.ops-record:hover { background:rgba(63,63,70,.2); }
.ops-record.selected { border-color:rgba(52,211,153,.32); background:rgba(16,185,129,.07); }
.ops-record-icon { display:grid; width:2.05rem; height:2.05rem; flex:0 0 auto; place-items:center; border:1px solid rgba(82,82,91,.4); border-radius:.7rem; color:#a1a1aa; background:rgba(39,39,42,.28); }
.ops-record-icon.source-agent-plan,.ops-record-icon.source-agent-task { color:#a78bfa; border-color:rgba(167,139,250,.23); background:rgba(139,92,246,.07); }
.ops-record-icon.source-workflow { color:#60a5fa; border-color:rgba(96,165,250,.23); background:rgba(59,130,246,.07); }
.ops-record-icon.source-event { color:#fbbf24; border-color:rgba(251,191,36,.23); background:rgba(245,158,11,.07); }
.ops-record-main { display:grid; min-width:0; flex:1; gap:.32rem; }
.ops-record-top { display:flex; align-items:center; justify-content:space-between; gap:.5rem; }
.ops-record-top strong { color:#a1a1aa; font-size:.65rem; font-weight:600; }
.ops-record-title { display:-webkit-box; overflow:hidden; color:#e4e4e7; font-size:.82rem; font-weight:600; line-height:1.45; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
.ops-record-meta { display:flex; flex-wrap:wrap; gap:.25rem .65rem; color:#71717a; font-size:.66rem; }
.ops-record-warning,.ops-record-approval { display:flex; align-items:center; gap:.28rem; color:#fbbf24; font-size:.65rem; }
.ops-record-chevron { align-self:center; flex:0 0 auto; color:#52525b; }
.ops-status { display:inline-flex; align-items:center; flex:0 0 auto; padding:.2rem .42rem; border:1px solid transparent; border-radius:999px; font-size:.62rem; line-height:1.2; white-space:nowrap; }
.ops-status.is-neutral { color:#a1a1aa; border-color:rgba(113,113,122,.24); background:rgba(113,113,122,.08); }
.ops-status.is-info { color:#7dd3fc; border-color:rgba(56,189,248,.22); background:rgba(56,189,248,.07); }
.ops-status.is-warning { color:#fcd34d; border-color:rgba(251,191,36,.25); background:rgba(245,158,11,.07); }
.ops-status.is-danger { color:#fda4af; border-color:rgba(251,113,133,.25); background:rgba(244,63,94,.07); }
.ops-status.is-success { color:#6ee7b7; border-color:rgba(52,211,153,.25); background:rgba(16,185,129,.07); }
.ops-detail-pane { min-height:32rem; padding:1rem; }
.ops-detail-head { display:grid; gap:.5rem; padding-bottom:.9rem; border-bottom:1px solid rgba(82,82,91,.25); }
.ops-source-pill { display:inline-flex; width:max-content; max-width:100%; padding:.2rem .45rem; border:1px solid rgba(82,82,91,.35); border-radius:999px; color:#a1a1aa; background:rgba(63,63,70,.12); font-size:.62rem; font-weight:650; letter-spacing:.04em; }
.ops-detail-head h2 { overflow-wrap:anywhere; color:#f4f4f5; font-size:1.05rem; font-weight:650; line-height:1.45; }
.ops-detail-head p { color:#a1a1aa; font-size:.75rem; line-height:1.5; }
.ops-detail-meta { display:flex; flex-wrap:wrap; gap:.3rem .75rem; color:#71717a; font-size:.65rem; }
.ops-review-warning { display:flex; gap:.6rem; margin-top:.85rem; padding:.75rem; border:1px solid rgba(251,191,36,.23); border-radius:.8rem; color:#fcd34d; background:rgba(245,158,11,.055); }
.ops-review-warning strong { font-size:.75rem; }
.ops-review-warning p { margin-top:.2rem; color:#a1a1aa; font-size:.69rem; line-height:1.5; }
.ops-approval-intent,.ops-output-section { display:grid; gap:.55rem; margin-top:.9rem; padding:.75rem; border:1px solid rgba(82,82,91,.25); border-radius:.8rem; background:rgba(9,12,18,.35); }
.ops-approval-intent p { color:#d4d4d8; font-size:.75rem; }
.ops-output-section pre,.ops-approval-intent pre { max-height:18rem; overflow:auto; color:#a1a1aa; font-family:ui-monospace,monospace; font-size:.65rem; white-space:pre-wrap; overflow-wrap:anywhere; }
.ops-section-heading { display:flex; align-items:center; justify-content:space-between; gap:.7rem; }
.ops-section-heading h3 { color:#e4e4e7; font-size:.78rem; font-weight:650; }
.ops-section-heading p,.ops-section-heading span { color:#71717a; font-size:.63rem; }
.ops-job-item { padding:.6rem 0; border-top:1px solid rgba(82,82,91,.2); }
.ops-job-item>div { display:flex; align-items:center; justify-content:space-between; gap:.5rem; color:#d4d4d8; font-size:.7rem; }
.ops-job-item>div span { color:#a1a1aa; font-size:.63rem; }
.ops-job-item pre { max-height:8rem; overflow:auto; margin-top:.35rem; color:#a1a1aa; font-size:.63rem; white-space:pre-wrap; }
.ops-detail-actions { display:flex; flex-wrap:wrap; gap:.45rem; margin-top:.9rem; }
.ops-detail-actions .btn-primary,.ops-detail-actions .btn-secondary { min-height:2.15rem; padding:.45rem .65rem; font-size:.7rem; }
.ops-thread { margin-top:1.1rem; }
.ops-thread .ops-section-heading { margin-bottom:.8rem; }
.ops-thread-empty { margin-top:.75rem; padding:.7rem; border:1px dashed rgba(82,82,91,.35); border-radius:.7rem; color:#71717a; font-size:.68rem; line-height:1.55; }
.ops-inline-loading { display:flex; align-items:center; gap:.5rem; color:#a1a1aa; font-size:.72rem; }
.ops-timeline { display:grid; gap:.8rem; padding-left:.15rem; }
.ops-timeline-item { position:relative; display:grid; grid-template-columns:.7rem minmax(0,1fr); gap:.6rem; }
.ops-timeline-item:not(:last-child)::after { position:absolute; top:.8rem; bottom:-.9rem; left:.27rem; width:1px; background:rgba(82,82,91,.42); content:''; }
.ops-timeline-dot { position:relative; z-index:1; width:.55rem; height:.55rem; margin-top:.18rem; border-radius:50%; background:#71717a; box-shadow:0 0 0 3px rgba(82,82,91,.16); }
.ops-timeline-dot.tone-success { background:#34d399; box-shadow:0 0 0 3px rgba(16,185,129,.12); }
.ops-timeline-dot.tone-info { background:#60a5fa; box-shadow:0 0 0 3px rgba(59,130,246,.12); }
.ops-timeline-dot.tone-warning { background:#fbbf24; box-shadow:0 0 0 3px rgba(245,158,11,.12); }
.ops-timeline-dot.tone-danger { background:#fb7185; box-shadow:0 0 0 3px rgba(244,63,94,.12); }
.ops-timeline-item strong,.ops-global-entry strong { color:#d4d4d8; font-size:.72rem; font-weight:600; }
.ops-timeline-item p,.ops-global-entry p { margin-top:.12rem; color:#a1a1aa; font-size:.67rem; line-height:1.5; overflow-wrap:anywhere; }
.ops-timeline-item time,.ops-global-entry time { display:block; margin-top:.2rem; color:#71717a; font-size:.62rem; font-variant-numeric:tabular-nums; }
.ops-detail-placeholder { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:32rem; text-align:center; }
.ops-detail-placeholder-icon { display:grid; width:3rem; height:3rem; margin-bottom:.8rem; place-items:center; border:1px solid rgba(52,211,153,.2); border-radius:1rem; color:#6ee7b7; background:rgba(16,185,129,.07); }
.ops-detail-placeholder h2 { color:#e4e4e7; font-size:.95rem; font-weight:650; }
.ops-detail-placeholder p { max-width:18rem; margin-top:.4rem; color:#71717a; font-size:.72rem; line-height:1.55; }
.ops-empty { display:grid; min-height:18rem; place-items:center; padding:1rem; }
.ops-global-timeline { overflow:hidden; border:1px solid rgba(82,82,91,.32); border-radius:1rem; background:rgba(16,20,27,.72); }
.ops-global-timeline-list { display:grid; max-height:70vh; overflow:auto; padding:.5rem 1rem; }
.ops-global-entry { display:flex; align-items:flex-start; gap:.75rem; padding:.85rem .35rem; border-bottom:1px solid rgba(82,82,91,.18); text-align:left; }
.ops-global-entry:last-child { border-bottom:0; }
.ops-global-entry:hover { background:rgba(63,63,70,.12); }
@media (max-width: 1023px) {
  .ops-workspace,.ops-events-layout { grid-template-columns:minmax(0,1fr); }
  .ops-detail-pane { min-height:unset; }
  .ops-record-list { max-height:48vh; }
  .ops-detail-placeholder { min-height:16rem; }
}
@media (max-width: 639px) {
  .ops-command-center .page-header { gap:.7rem; }
  .ops-command-center .page-actions { width:100%; }
  .ops-command-center .page-actions button { flex:1; justify-content:center; min-width:0; padding:.55rem .45rem; font-size:.7rem; }
  .ops-tabs button { padding:.5rem .62rem; font-size:.7rem; }
  .ops-list-toolbar { align-items:stretch; }
  .ops-list-toolbar .search-field { flex-basis:100%; }
  .ops-result-count { margin-left:0; }
  .ops-record-list { max-height:44vh; }
  .ops-detail-pane { padding:.8rem; }
}
</style>
