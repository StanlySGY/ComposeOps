<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4">
    <p v-if="error" class="alert-error" role="alert">{{ error }}<button class="text-link ml-2" :disabled="loading" @click="load">重新读取</button></p>
    <p class="text-xs text-surface-400">仅汇总各来源最近返回的记录；时间范围和搜索只筛选已加载记录，不代表完整历史。</p>

    <!-- 摘要统计 -->
    <div class="metric-grid">
      <MetricTile title="事件总数" :value="filteredEvents.length" sub="当前筛选范围" :icon="History" tone="text-blue-300" />
      <MetricTile title="异常事件" :value="errorCount" sub="失败 / 严重 / 告警" :icon="CircleX" tone="text-status-error" />
      <MetricTile title="Agent 活动" :value="sourceCount('agent')" sub="执行与巡检" :icon="Bot" tone="text-status-ok" />
      <MetricTile title="GitOps 活动" :value="sourceCount('gitops')" sub="同步与回滚" :icon="GitBranch" tone="text-violet-300" />
      <MetricTile title="定时任务" :value="sourceCount('cron')" sub="执行记录" :icon="Clock3" tone="text-status-warn" />
    </div>

    <!-- 过滤器 -->
    <div class="toolbar-panel flex flex-wrap items-center gap-2">
      <label class="search-field"><Search class="h-4 w-4" /><input v-model="query" aria-label="搜索事件标题、项目或详情" placeholder="搜索事件标题、项目或详情" /></label>
      <select v-model="sourceFilter" class="input sm:w-40" aria-label="来源筛选">
        <option value="all">全部来源</option>
        <option value="operation">操作记录</option>
        <option value="agent">Agent 活动</option>
        <option value="alert">告警事件</option>
        <option value="cron">定时任务</option>
        <option value="gitops">GitOps</option>
      </select>
      <select v-model="levelFilter" class="input sm:w-36" aria-label="级别筛选">
        <option value="all">全部级别</option>
        <option value="success">成功</option>
        <option value="info">提示</option>
        <option value="warning">关注</option>
        <option value="error">异常</option>
      </select>
      <select v-model="rangeFilter" class="input sm:w-40" aria-label="时间范围">
        <option value="1h">最近 1 小时</option>
        <option value="24h">最近 24 小时</option>
        <option value="7d">最近 7 天</option>
        <option value="all">全部时间</option>
      </select>
      <span class="ml-auto whitespace-nowrap text-muted" role="status" aria-live="polite" aria-atomic="true">显示 {{ filteredEvents.length }} / {{ events.length }}</span>
    </div>

    <HistoryControls v-model:page="page" v-model:sort-key="sortKey" v-model:descending="descending" :total="total" :page-size="pageSize" :options="sortOptions" label="事件时间线" />
    <!-- 时间轴 -->
    <Skeleton v-if="loading && !events.length" variant="table" :rows="6" label="事件加载中" class="flex-1" />
    <EmptyState v-else-if="!events.length && !error" icon="History" title="暂无事件" description="执行操作、运行 Agent 或触发定时任务后,事件会出现在这里" />
    <EmptyState v-else-if="!filteredEvents.length && !error" icon="Search" title="没有匹配的事件" description="调整筛选条件后重试" action-label="清除筛选" class="flex-1" @action="resetFilters" />
    <div v-else class="min-h-0 flex-1 overflow-y-auto pr-1">
      <div class="relative space-y-1">
        <div class="absolute left-[7px] top-2 bottom-2 w-px bg-surface-800"></div>
        <div v-for="event in pagedRows" :key="event.key" class="relative flex gap-3 py-2 pl-0">
          <div class="relative z-10 mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
            <span class="h-3 w-3 rounded-full border-2" :class="dotClass(event.level)"></span>
          </div>
          <div class="min-w-0 flex-1 rounded-xl border border-surface-800 bg-surface-950/60 px-4 py-3 transition hover:border-surface-600">
            <div class="flex flex-wrap items-center gap-2">
              <span class="count-badge shrink-0" :class="sourceBadgeClass(event.source)">{{ sourceLabel(event.source) }}</span>
              <span class="count-badge shrink-0" :class="levelBadgeClass(event.level)">{{ levelLabel(event.level) }}</span>
              <span class="font-mono text-xs tabular-nums text-surface-400">{{ formatTime(event.timestamp) }}</span>
              <span v-if="event.projectName" class="ml-auto truncate text-xs text-surface-400">{{ event.projectName }}</span>
            </div>
            <p class="mt-1.5 text-sm font-medium text-surface-100">{{ event.title }}</p>
            <p v-if="event.detail" class="mt-1 line-clamp-2 text-xs leading-5 text-surface-400">{{ event.detail }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import MetricTile from '../common/MetricTile.vue';
import { usePagedRows } from '../../composables/usePagedRows.js';
import HistoryControls from '../../components/common/HistoryControls.vue';
// 运维时间机器:客户端聚合操作/Agent/告警/定时/GitOps 五路事件的只读时间线,嵌入事件中心 tab
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { usePullRefresh } from '../../composables/usePullRefresh.js';
import { Bot, CircleX, Clock3, GitBranch, History, Search } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import Skeleton from '../common/Skeleton.vue';
import EmptyState from '../common/EmptyState.vue';
import { formatTimestamp, parseTimestamp } from '../../lib/date-time.js';
import { onAuthEpochChange } from '../../lib/auth-context.js';

const loading = ref(false);
const error = ref('');
const events = ref([]);
const query = ref('');
const sourceFilter = ref('all');
const levelFilter = ref('all');
const rangeFilter = ref('24h');
let active = false, disposed = false, generation = 0, controller;
const observedAt = ref(Date.now());

const SOURCE_LABELS = { operation: '操作', agent: 'Agent', alert: '告警', cron: '定时任务', gitops: 'GitOps' };
const LEVEL_LABELS = { success: '成功', info: '提示', warning: '关注', error: '异常' };

function sourceLabel(s) { return SOURCE_LABELS[s] || s; }
function levelLabel(l) { return LEVEL_LABELS[l] || l; }
function sourceBadgeClass(s) {
  return { operation: 'text-blue-300', agent: 'text-status-ok', alert: 'text-status-error', cron: 'text-status-warn', gitops: 'text-violet-300' }[s] || 'text-surface-400';
}
function levelBadgeClass(l) {
  return { success: 'text-status-ok', info: 'text-sky-300', warning: 'text-status-warn', error: 'text-status-error' }[l] || 'text-surface-400';
}
function dotClass(l) {
  return { success: 'border-status-ok bg-status-ok', info: 'border-sky-400 bg-sky-400', warning: 'border-status-warn bg-status-warn', error: 'border-status-error bg-status-error' }[l] || 'border-surface-500 bg-surface-500';
}

const errorCount = computed(() => filteredEvents.value.filter((e) => e.level === 'error' || e.level === 'warning').length);
function sourceCount(s) { return filteredEvents.value.filter((e) => e.source === s).length; }

const filteredEvents = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const since = rangeMs(rangeFilter.value);
  return events.value
    .filter((e) => (sourceFilter.value === 'all' || e.source === sourceFilter.value))
    .filter((e) => (levelFilter.value === 'all' || e.level === levelFilter.value))
    .filter((e) => (since == null || e.ts >= since))
    .filter((e) => !needle || `${e.title} ${e.detail || ''} ${e.projectName || ''}`.toLowerCase().includes(needle));
});

function rangeMs(range) {
  const now = observedAt.value;
  if (range === '1h') return now - 3600 * 1000;
  if (range === '24h') return now - 24 * 3600 * 1000;
  if (range === '7d') return now - 7 * 24 * 3600 * 1000;
  return null;
}

function formatTime(value) { return formatTimestamp(value); }

function resetFilters() { query.value = ''; sourceFilter.value = 'all'; levelFilter.value = 'all'; rangeFilter.value = '24h'; }

function parseTs(value) { return parseTimestamp(value)?.getTime() || 0; }

function pushEvent(list, event) {
  if (!event || !event.timestamp) return;
  list.push({ key: `${event.source}-${event.id}-${event.timestamp}`, ts: parseTs(event.timestamp), ...event });
}

async function load() {
  if (!active || disposed || loading.value) return;
  const request = ++generation; controller = new AbortController();
  observedAt.value = Date.now();
  loading.value = true;
  error.value = '';
  const list = [];
  try {
    const [operationData, agentData, alertData, cronData, gitopsData] = await Promise.allSettled([
      api.getOperations({ force: true, signal: controller.signal }),
      api.getAgentExecutions('', 100, controller.signal),
      api.getAlertEvents(50, controller.signal),
      api.getCronHistory(50, controller.signal),
      api.getEvents({ eventType: 'gitops', limit: 100 }, true, controller.signal),
    ]);
    if (!active || disposed || request !== generation) return;
    const failedSources = [
      ['操作记录', operationData], ['Agent 活动', agentData], ['告警事件', alertData],
      ['定时任务', cronData], ['GitOps 历史', gitopsData],
    ].filter(([, result]) => result.status === 'rejected').map(([label]) => label);
    if (failedSources.length) {
      error.value = '部分事件加载失败：' + failedSources.join('、') + '。已尽可能显示其他来源的数据。';
    }

    // 操作记录
    if (operationData.status === 'fulfilled') {
      for (const op of operationData.value.operations || []) {
        pushEvent(list, {
          source: 'operation', id: op.id, timestamp: op.createdAt,
          level: op.status === 'success' ? 'success' : op.status === 'failed' ? 'error' : 'info',
          title: actionLabel(op.action), detail: op.detail || '',
          projectName: op.projectName || '',
        });
      }
    }

    // Agent 执行
    if (agentData.status === 'fulfilled') {
      for (const plan of agentData.value.plans || []) {
        const status = plan.status;
        pushEvent(list, {
          source: 'agent', id: plan.id, timestamp: plan.created_at || plan.executed_at,
          level: status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'info',
          title: plan.user_message || 'Agent 执行', detail: `状态:${agentStatusLabel(status)}`,
          projectName: '',
        });
      }
    }

    // 告警事件
    if (alertData.status === 'fulfilled') {
      for (const ev of alertData.value.events || []) {
        pushEvent(list, {
          source: 'alert', id: ev.id, timestamp: ev.created_at,
          level: ev.priority === 'danger' ? 'error' : 'warning',
          title: ev.title, detail: ev.detail || '', projectName: ev.target || '',
        });
      }
    }

    // 定时任务历史
    if (cronData.status === 'fulfilled') {
      for (const item of cronData.value.history || []) {
        pushEvent(list, {
          source: 'cron', id: item.id, timestamp: item.at,
          level: item.status === 'success' ? 'success' : 'error',
          title: `定时任务:${item.jobName || ''}`, detail: item.error || `${item.durationMs || 0}ms`,
          projectName: '',
        });
      }
    }

    // 已持久化的事件是历史事实；仓库当前状态无法还原历次同步或失败。
    if (gitopsData.status === 'fulfilled') {
      for (const event of gitopsData.value.events || []) {
        pushEvent(list, {
          source: 'gitops', id: event.id, timestamp: event.createdAt,
          level: event.severity === 'danger' ? 'error' : event.severity === 'warning' ? 'warning' : ['resolved', 'closed'].includes(event.status) ? 'success' : 'info',
          title: event.title, detail: event.detail || '', projectName: event.assetName || '',
        });
      }
    }

    events.value = list.sort((a, b) => b.ts - a.ts);
  } catch (e) {
    if (active && request === generation) error.value = e.message || '事件加载失败';
  } finally {
    if (request === generation) loading.value = false;
  }
}

function actionLabel(action) {
  const labels = { 'compose.save': '保存配置', 'compose.restore': '恢复配置', 'projects.management': '更新纳管范围', 'projects.mounts': '更新目录范围', 'docker.prune': '清理 Docker 空间', 'images.check': '检查镜像更新', 'settings.import': '导入设置', up: '启动项目', restart: '重启项目', stop: '停止项目', pull: '拉取镜像', ps: '检查状态' };
  return labels[action] || labels[String(action).split('.').pop()] || action;
}
function agentStatusLabel(status) {
  return ({ pending: '待执行', pending_confirmation: '待确认', executing: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[status] || status;
}

function stop(clear = false) {
  active = false; generation++; controller?.abort(); controller = null; loading.value = false;
  if (clear) { events.value = []; error.value = ''; }
}
function start() { if (active || disposed) return; active = true; void load(); }
function hostChanged() { const visible = active; stop(true); if (visible) start(); }
const stopAuthListener = onAuthEpochChange((_epoch, { identityChanged = true } = {}) => {
  const visible = active; stop(identityChanged);
  if (!identityChanged && visible) start();
});
window.addEventListener('composeops:host-changed', hostChanged);
usePullRefresh(load, { keepAlive: true });
onMounted(start); onActivated(start); onDeactivated(() => stop());
onBeforeUnmount(() => { disposed = true; stop(); stopAuthListener(); window.removeEventListener('composeops:host-changed', hostChanged); });

const { rows: pagedRows, page, pageSize, total, sortKey, descending } = usePagedRows(filteredEvents, { time: item => item.ts, source: item => item.source, level: item => item.level }, 'time');
const sortOptions = [{ key: 'time', label: '事件时间' }, { key: 'source', label: '事件来源' }, { key: 'level', label: '级别' }];
</script>