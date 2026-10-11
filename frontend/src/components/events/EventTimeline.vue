<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4">
    <p v-if="error" class="alert-error">{{ error }}</p>

    <!-- 摘要统计 -->
    <div class="metric-grid">
      <div class="metric-tile"><span class="metric-icon text-blue-300"><History class="h-5 w-5" /></span><span><strong>{{ events.length }}</strong><small>事件总数</small></span><span class="metric-meta">当前筛选范围</span></div>
      <div class="metric-tile"><span class="metric-icon text-rose-300"><CircleX class="h-5 w-5" /></span><span><strong>{{ errorCount }}</strong><small>异常事件</small></span><span class="metric-meta">失败 / 严重 / 告警</span></div>
      <div class="metric-tile"><span class="metric-icon text-emerald-300"><Bot class="h-5 w-5" /></span><span><strong>{{ sourceCount('agent') }}</strong><small>Agent 活动</small></span><span class="metric-meta">执行与巡检</span></div>
      <div class="metric-tile"><span class="metric-icon text-violet-300"><GitBranch class="h-5 w-5" /></span><span><strong>{{ sourceCount('gitops') }}</strong><small>GitOps 活动</small></span><span class="metric-meta">同步与漂移</span></div>
      <div class="metric-tile"><span class="metric-icon text-amber-300"><Clock3 class="h-5 w-5" /></span><span><strong>{{ sourceCount('cron') }}</strong><small>定时任务</small></span><span class="metric-meta">执行记录</span></div>
    </div>

    <!-- 过滤器 -->
    <div class="toolbar-panel flex flex-wrap items-center gap-2">
      <label class="search-field"><Search class="h-4 w-4" /><input v-model="query" placeholder="搜索事件标题、项目或详情" /></label>
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
      <span class="ml-auto whitespace-nowrap text-muted">显示 {{ filteredEvents.length }} / {{ events.length }}</span>
    </div>

    <!-- 时间轴 -->
    <Skeleton v-if="loading && !events.length" variant="table" :rows="6" label="事件加载中" class="flex-1" />
    <EmptyState v-else-if="!events.length" icon="History" title="暂无事件" description="执行操作、运行 Agent 或触发定时任务后,事件会出现在这里" />
    <EmptyState v-else-if="!filteredEvents.length" icon="Search" title="没有匹配的事件" description="调整筛选条件后重试" action-label="清除筛选" class="flex-1" @action="resetFilters" />
    <div v-else class="min-h-0 flex-1 overflow-y-auto pr-1">
      <div class="relative space-y-1">
        <div class="absolute left-[7px] top-2 bottom-2 w-px bg-surface-800"></div>
        <div v-for="event in filteredEvents" :key="event.key" class="relative flex gap-3 py-2 pl-0">
          <div class="relative z-10 mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
            <span class="h-3 w-3 rounded-full border-2" :class="dotClass(event.level)"></span>
          </div>
          <div class="min-w-0 flex-1 rounded-xl border border-surface-800 bg-surface-950/60 px-4 py-3 transition hover:border-surface-600">
            <div class="flex flex-wrap items-center gap-2">
              <span class="count-badge shrink-0" :class="sourceBadgeClass(event.source)">{{ sourceLabel(event.source) }}</span>
              <span class="count-badge shrink-0" :class="levelBadgeClass(event.level)">{{ levelLabel(event.level) }}</span>
              <span class="font-mono text-xs tabular-nums text-surface-400">{{ formatTime(event.timestamp) }}</span>
              <span v-if="event.projectName" class="ml-auto truncate text-xs text-surface-500">{{ event.projectName }}</span>
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
// 运维时间机器:客户端聚合操作/Agent/告警/定时/GitOps 五路事件的只读时间线,嵌入事件中心 tab
import { computed, onMounted, ref } from 'vue';
import { usePullRefresh } from '../../composables/usePullRefresh.js';
import { Bot, CircleX, Clock3, GitBranch, History, Search } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import Skeleton from '../common/Skeleton.vue';
import EmptyState from '../common/EmptyState.vue';

const loading = ref(false);
const error = ref('');
const events = ref([]);
const query = ref('');
const sourceFilter = ref('all');
const levelFilter = ref('all');
const rangeFilter = ref('24h');

const SOURCE_LABELS = { operation: '操作', agent: 'Agent', alert: '告警', cron: '定时任务', gitops: 'GitOps' };
const LEVEL_LABELS = { success: '成功', info: '提示', warning: '关注', error: '异常' };

function sourceLabel(s) { return SOURCE_LABELS[s] || s; }
function levelLabel(l) { return LEVEL_LABELS[l] || l; }
function sourceBadgeClass(s) {
  return { operation: 'text-blue-300', agent: 'text-emerald-300', alert: 'text-rose-300', cron: 'text-amber-300', gitops: 'text-violet-300' }[s] || 'text-surface-400';
}
function levelBadgeClass(l) {
  return { success: 'text-emerald-300', info: 'text-sky-300', warning: 'text-amber-300', error: 'text-rose-300' }[l] || 'text-surface-400';
}
function dotClass(l) {
  return { success: 'border-emerald-400 bg-emerald-400', info: 'border-sky-400 bg-sky-400', warning: 'border-amber-400 bg-amber-400', error: 'border-rose-400 bg-rose-400' }[l] || 'border-surface-500 bg-surface-500';
}

const errorCount = computed(() => events.value.filter((e) => e.level === 'error' || e.level === 'warning').length);
function sourceCount(s) { return events.value.filter((e) => e.source === s).length; }

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
  const now = Date.now();
  if (range === '1h') return now - 3600 * 1000;
  if (range === '24h') return now - 24 * 3600 * 1000;
  if (range === '7d') return now - 7 * 24 * 3600 * 1000;
  return null;
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function resetFilters() { query.value = ''; sourceFilter.value = 'all'; levelFilter.value = 'all'; rangeFilter.value = '24h'; }

function parseTs(value) {
  if (!value) return 0;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function pushEvent(list, event) {
  if (!event || !event.timestamp) return;
  list.push({ key: `${event.source}-${event.id}-${event.timestamp}`, ts: parseTs(event.timestamp), ...event });
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  const list = [];
  try {
    const [operationData, agentData, alertData, cronData, gitopsData] = await Promise.allSettled([
      api.getOperations(),
      api.getAgentExecutions(),
      api.getAlertEvents(50),
      api.getCronHistory(50),
      fetch('/api/v1/gitops').then((res) => (res.ok ? res.json() : null)),
    ]);

    // 操作记录
    if (operationData.status === 'fulfilled') {
      for (const op of operationData.value.operations || []) {
        pushEvent(list, {
          source: 'operation', id: op.id, timestamp: op.createdAt,
          level: op.status === 'success' ? 'success' : 'error',
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

    // GitOps 同步历史
    if (gitopsData.status === 'fulfilled' && gitopsData.value) {
      const repos = gitopsData.value.repositories || [];
      for (const repo of repos) {
        if (repo.lastSync) {
          pushEvent(list, {
            source: 'gitops', id: repo.id, timestamp: repo.lastSync,
            level: repo.status === 'error' ? 'error' : 'success',
            title: `GitOps 同步:${repo.name || ''}`, detail: repo.url || '',
            projectName: repo.name || '',
          });
        }
      }
    }

    events.value = list.sort((a, b) => b.ts - a.ts);
  } catch (e) {
    error.value = e.message || '事件加载失败';
  } finally {
    loading.value = false;
  }
}

function actionLabel(action) {
  const labels = { 'compose.save': '保存配置', 'compose.restore': '恢复配置', 'projects.management': '更新纳管范围', 'projects.mounts': '更新目录范围', 'docker.prune': '清理 Docker 空间', 'images.check': '检查镜像更新', 'settings.import': '导入设置', up: '启动项目', restart: '重启项目', stop: '停止项目', pull: '拉取镜像', ps: '检查状态' };
  return labels[action] || labels[String(action).split('.').pop()] || action;
}
function agentStatusLabel(status) {
  return ({ pending: '待执行', pending_confirmation: '待确认', executing: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[status] || status;
}

usePullRefresh(load);
onMounted(load);
</script>