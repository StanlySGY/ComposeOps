<template>
  <div class="page-shell page-shell-workspace">
    <div class="page-header">
      <div>
        <h1 class="page-title">Agent 执行历史</h1>
        <p class="page-subtitle">查看最近 100 个计划；展开后读取该计划最多 500 条工具调用</p>
      </div>
      <div class="flex items-center gap-3">
        <button class="btn-secondary" :disabled="loading" @click="load">
          <RefreshCw :class="{ 'animate-spin': loading }" class="h-4 w-4" />刷新
        </button>
      </div>
    </div>

    <div v-if="error" class="card flex flex-wrap items-center gap-3 border-status-error/20 bg-status-error/5 p-4 text-status-error" role="alert">
      <span class="min-w-0 flex-1">{{ error }}{{ executions.length ? '；以下保留上次读取的历史。' : '' }}</span>
      <button class="btn-secondary btn-sm" :disabled="loading" @click="load">重新读取历史</button>
    </div>
    <div v-if="usageError" class="card flex flex-wrap items-center gap-3 p-4 text-status-warn" role="alert">
      <span class="min-w-0 flex-1">用量读取失败：{{ usageError }}{{ usage ? '；以下用量为上次读取结果。' : '' }}</span>
      <button class="btn-secondary btn-sm" :disabled="loading" @click="load">重新读取用量</button>
    </div>
    <p v-if="loading" class="text-sm text-surface-400" role="status">正在读取执行历史与用量…</p>

    <section v-if="usage" class="space-y-3">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile title="总 token" :value="formatNumber(usage.totals?.total_tokens)" :sub="`最近 ${usage.days} 天`" />
        <MetricTile title="LLM 调用" :value="formatNumber(usage.totals?.calls)" sub="Tool Loop 轮次" />
        <MetricTile title="输入 token" :value="formatNumber(usage.totals?.prompt_tokens)" sub="上下文与工具结果" />
        <MetricTile title="输出 token" :value="formatNumber(usage.totals?.completion_tokens)" sub="模型生成内容" />
      </div>

      <div v-if="usage.byModel?.length" class="card p-4">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-sm font-medium text-surface-200">模型用量</h2>
          <span class="text-xs text-surface-400">按总 token 排序</span>
        </div>
        <div class="mt-3 grid gap-2 md:grid-cols-2">
          <div v-for="model in usage.byModel" :key="model.model" class="flex items-center justify-between gap-3 rounded-sm border border-surface-800 bg-surface-900/40 px-3 py-2 text-xs">
            <span class="min-w-0 truncate font-mono text-surface-300">{{ model.model }}</span>
            <span class="shrink-0 text-surface-400">{{ formatNumber(model.total_tokens) }} · {{ formatNumber(model.calls) }} 次</span>
          </div>
        </div>
      </div>
    </section>

    <section v-if="executions.length" class="card p-3">
      <div class="flex flex-wrap items-center gap-2">
        <label class="search-field min-h-9 min-w-48 flex-1">
          <Search class="h-3.5 w-3.5" />
          <input v-model="searchQuery" class="py-1 text-xs" placeholder="搜索任务内容或计划 ID" aria-label="搜索 Agent 执行历史" />
        </label>
        <select v-model="statusFilter" class="input w-full sm:w-36 input-sm" aria-label="按执行状态筛选">
          <option value="all">全部状态</option>
          <option value="executing">执行中</option>
          <option value="pending_confirmation">待确认</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
          <option value="outcome_unknown">结果待核对</option>
          <option value="pending">待执行</option>
        </select>
        <select v-model="roleFilter" class="input w-full sm:w-40 input-sm" aria-label="按 Worker 筛选">
          <option value="all">全部 Worker</option>
          <option value="planner">运维规划师</option>
          <option value="executor">执行者</option>
          <option value="validator">只读验证者</option>
          <option value="incident_responder">应急响应者</option>
        </select>
        <button v-if="searchQuery || statusFilter !== 'all' || roleFilter !== 'all'" class="btn-secondary btn-sm" @click="resetFilters">清除筛选</button>
      </div>
      <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-surface-400">
        <span>显示 {{ filteredExecutions.length }} / {{ executions.length }} 次执行</span>
        <span>按计划记录聚合 · 展开查看步骤、结果与轨迹</span>
      </div>
    </section>

    <HistoryControls v-if="executions.length" v-model:page="page" v-model:sort-key="sortKey" v-model:descending="descending" :total="total" :page-size="pageSize" :options="sortOptions" label="执行历史" />
    <div v-if="loaded && !loading && !error && !executions.length" class="card p-8">
      <EmptyState icon="history" title="暂无执行记录" description="Agent 工作流执行后会在此显示" />
    </div>

    <div v-else-if="executions.length && !filteredExecutions.length" class="card p-8 text-center">
      <EmptyState icon="search" title="没有符合条件的执行记录" description="尝试缩短关键词，或清除状态和 Worker 筛选。" />
      <button class="btn-secondary mx-auto mt-3" @click="resetFilters">清除筛选</button>
    </div>

    <div v-else-if="filteredExecutions.length" class="space-y-3">
      <div v-for="exec in pagedRows" :key="exec.planId" class="card p-4">
        <div class="mb-3 flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="mb-1 flex flex-wrap items-center gap-2">
              <h3 class="min-w-0 break-words text-base font-semibold text-surface-200">{{ exec.message || '工作流执行' }}</h3>
              <span :class="statusClass(exec.status)" class="status-badge">{{ statusLabel(exec.status) }}</span>
            </div>
            <p class="text-sm text-surface-400">计划 ID: {{ exec.planId }}</p>
            <div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-surface-400">
              <span>角色: {{ roleLabel(exec.role) }}</span>
              <span>已载入工具调用: {{ exec.results.length }}</span>
              <span v-if="exec.createdAt">创建: {{ formatTime(exec.createdAt) }}</span>
              <span v-if="exec.executedAt">执行: {{ formatTime(exec.executedAt) }}</span>
            </div>
          </div>
          <button class="btn-secondary btn-sm shrink-0" :aria-expanded="expandedPlan === exec.planId" :aria-controls="`agent-plan-detail-${exec.planId}`" @click="toggleDetail(exec.planId)">
            <ChevronDown :class="{ 'rotate-180': expandedPlan === exec.planId }" class="h-3.5 w-3.5 transition-transform" />
            {{ expandedPlan === exec.planId ? '收起' : '详情' }}
          </button>
        </div>

        <div v-if="expandedPlan === exec.planId" :id="`agent-plan-detail-${exec.planId}`" class="space-y-4 border-t border-surface-800 pt-4" :aria-busy="detailLoading">
          <p v-if="detailLoading" class="text-sm text-surface-400" role="status">正在读取该计划的工具调用…</p>
          <div v-else-if="detailError" class="flex flex-wrap items-center gap-3 text-sm text-status-error" role="alert">
            <span class="min-w-0 flex-1">{{ detailError }}</span>
            <button class="btn-secondary btn-sm" @click="loadDetail(exec.planId)">重试详情</button>
          </div>
          <template v-else>
          <p class="text-xs text-surface-400">按调用顺序展示该计划前 500 条工具记录；历史列表中的数量可能因读取上限而不完整。</p>
          <p v-if="!exec.steps.length && !exec.results.length && !exec.thoughts.length" class="text-sm text-surface-400">此计划尚无工具调用记录。</p>
          <!-- 工作流步骤 -->
          <div v-if="exec.steps && exec.steps.length">
            <h4 class="mb-2 text-sm font-medium text-surface-300">工作流步骤</h4>
            <div class="space-y-2">
              <div v-for="(step, idx) in exec.steps" :key="idx" class="rounded-sm border border-surface-800 bg-surface-900/40 p-3">
                <div class="mb-2 flex items-start justify-between">
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-800 text-xs font-medium text-surface-400">{{ idx + 1 }}</span>
                    <span class="break-all font-mono text-sm text-surface-300">{{ step.tool }}</span>
                    <RiskBadge v-if="step.risk" :risk="step.risk" />
                  </div>
                  <span v-if="step.confirmationRequired" class="text-xs text-status-warn">需确认</span>
                </div>
                <div v-if="step.reason" class="mb-2 text-xs text-surface-400">{{ step.reason }}</div>
                <div v-if="step.params && Object.keys(step.params).length" class="text-xs">
                  <span class="text-surface-400">参数:</span>
                  <code class="ml-2 break-all rounded-sm bg-surface-800 px-1.5 py-0.5 font-mono text-surface-300">{{ formatParams(step.params) }}</code>
                </div>
              </div>
            </div>
          </div>

          <!-- 执行结果 -->
          <div v-if="exec.results && exec.results.length">
            <h4 class="mb-2 text-sm font-medium text-surface-300">执行结果</h4>
            <div class="space-y-2">
              <div v-for="(result, idx) in exec.results" :key="idx" class="rounded-sm border p-3" :class="resultBorderClass(result.status)">
                <div class="mb-2 flex flex-wrap items-start justify-between gap-2">
                  <div class="flex min-w-0 flex-1 items-start gap-2">
                    <component :is="resultIcon(result.status)" :class="resultIconClass(result.status)" class="mt-0.5 h-4 w-4 shrink-0" />
                    <span class="min-w-0 break-all font-mono text-sm text-surface-300">{{ result.tool }}</span>
                  </div>
                  <span v-if="result.durationMs != null" class="shrink-0 text-xs text-surface-400">{{ result.durationMs }}ms</span>
                </div>
                <div v-if="result.error" class="mb-2 break-words text-sm text-status-error">{{ result.error }}</div>
                <div v-if="result.result != null && result.result !== ''" class="max-h-32 overflow-auto rounded-sm bg-surface-900 p-2 text-xs">
                  <pre class="whitespace-pre-wrap break-all text-surface-400">{{ stringifyResult(result.result) }}</pre>
                </div>
              </div>
            </div>
          </div>

          <!-- 执行轨迹 -->
          <div v-if="exec.thoughts && exec.thoughts.length">
            <h4 class="mb-2 text-sm font-medium text-surface-300">执行轨迹</h4>
            <div class="space-y-1.5">
              <div v-for="(thought, idx) in exec.thoughts" :key="idx" class="flex gap-3 text-xs">
                <span :class="phaseColor(thought.phase)" class="w-16 shrink-0 font-medium">{{ phaseLabel(thought.phase) }}</span>
                <span class="min-w-0 flex-1 break-words text-surface-400">{{ thought.content }}</span>
              </div>
            </div>
          </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import RiskBadge from '../components/common/RiskBadge.vue';
import { usePagedRows } from '../composables/usePagedRows.js';
import HistoryControls from '../components/common/HistoryControls.vue';
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { api } from '../api/client.js';
import { RefreshCw, ChevronDown, CircleCheck, CircleX, Clock, AlertCircle, Search } from 'lucide-vue-next';
import MetricTile from '../components/common/MetricTile.vue';
import EmptyState from '../components/common/EmptyState.vue';
import { onAuthEpochChange } from '../lib/auth-context.js';
import { formatTimestamp, parseTimestamp } from '../lib/date-time.js';

const loading = ref(false);
const error = ref('');
const usageError = ref('');
const loaded = ref(false);
const executions = ref([]);
const usage = ref(null);
const expandedPlan = ref(null);
const detailLoading = ref(false);
const detailError = ref('');
let active = false, generation = 0, detailGeneration = 0;
let loadController = null, detailController = null;
const searchQuery = ref('');
const statusFilter = ref('all');
const roleFilter = ref('all');
const filteredExecutions = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  return executions.value.filter((exec) => {
    if (statusFilter.value !== 'all' && exec.status !== statusFilter.value) return false;
    if (roleFilter.value !== 'all' && exec.role !== roleFilter.value) return false;
    if (!query) return true;
    return [exec.message, exec.planId, roleLabel(exec.role)].some((value) => String(value || '').toLocaleLowerCase().includes(query));
  });
});
function resetFilters() {
  searchQuery.value = '';
  statusFilter.value = 'all';
  roleFilter.value = 'all';
}

async function load() {
  if (!active) return;
  invalidate();
  const current = generation;
  const controller = loadController = new AbortController();
  loading.value = true;
  error.value = '';
  usageError.value = '';
  try {
    const [executionResult, usageResult] = await Promise.allSettled([
      api.getAgentExecutions('', 500, controller.signal),
      api.getAgentUsage(30, controller.signal),
    ]);
    if (!active || current !== generation || controller.signal.aborted) return;
    if (usageResult.status === 'fulfilled') usage.value = usageResult.value;
    else usageError.value = usageResult.reason?.message || '暂时无法读取模型用量';
    if (executionResult.status === 'rejected') throw executionResult.reason;
    const response = executionResult.value;
    const rowsByPlan = new Map();
    for (const row of response.executions || []) {
      const rows = rowsByPlan.get(row.plan_id) || [];
      rows.push(row);
      rowsByPlan.set(row.plan_id, rows);
    }
    executions.value = (response.plans || []).map((plan) => mapPlan(plan, rowsByPlan.get(plan.id) || []));
    loaded.value = true;
  } catch (e) {
    if (active && current === generation && !controller.signal.aborted) error.value = e.message || '暂时无法读取执行历史';
  } finally {
    if (current === generation) { loading.value = false; loadController = null; }
  }
}

function cancelDetail() {
  detailGeneration++;
  detailController?.abort(); detailController = null;
  detailLoading.value = false; detailError.value = ''; expandedPlan.value = null;
}
function invalidate(clearData = false) {
  generation++;
  loadController?.abort(); loadController = null;
  loading.value = false;
  cancelDetail();
  if (clearData) { executions.value = []; usage.value = null; error.value = ''; usageError.value = ''; loaded.value = false; resetFilters(); }
}

async function loadDetail(planId) {
  if (!active || expandedPlan.value !== planId) return;
  detailController?.abort();
  const current = ++detailGeneration, context = generation;
  const controller = detailController = new AbortController();
  detailLoading.value = true; detailError.value = '';
  try {
    const result = await api.getAgentExecutions(planId, 500, controller.signal);
    if (!active || current !== detailGeneration || context !== generation || controller.signal.aborted) return;
    if (!result?.plan || String(result.plan.id) !== String(planId)) throw new Error('执行计划已不可用，请刷新历史后核对。');
    executions.value = executions.value.map(item => item.planId === planId ? mapPlan(result.plan, result.executions || []) : item);
  } catch (e) {
    if (active && current === detailGeneration && context === generation && !controller.signal.aborted) detailError.value = e.message || '暂时无法读取详情';
  } finally {
    if (current === detailGeneration) { detailLoading.value = false; detailController = null; }
  }
}

function formatNumber(value) {
  return (Number(value) || 0).toLocaleString('zh-CN');
}

function toggleDetail(planId) {
  const close = expandedPlan.value === planId;
  cancelDetail();
  if (!close) { expandedPlan.value = planId; void loadDetail(planId); }
}

function formatTime(isoString) {
  return formatTimestamp(isoString);
}

function formatParams(params) {
  return Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
    .join(' ');
}

function stringifyResult(result) {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapPlan(plan, rows) {
  const planData = parseJson(plan.plan_json, {});
  const resultData = parseJson(plan.result_json, {});
  const steps = Array.isArray(planData.steps) ? planData.steps.map((step) => ({
    tool: step.tool || step.toolName || '未知工具',
    params: step.params || step.parameters || {},
    reason: step.reason,
    risk: step.risk,
    confirmationRequired: Boolean(step.confirmationRequired),
  })) : [];
  const results = rows.map((row) => ({
    tool: row.tool_name,
    status: row.status,
    result: parseJson(row.result, row.result),
    error: row.error,
    durationMs: row.duration_ms,
  }));
  const trace = Array.isArray(resultData.messages)
    ? resultData.messages.filter((item) => item.role === 'tool').map((item) => ({ phase: 'executing', content: `${item.tool_call_id || '工具'} 已返回结果` }))
    : [];
  return {
    planId: plan.id,
    message: plan.user_message,
    role: planData.role || 'planner',
    status: plan.status,
    stepCount: steps.length || results.length,
    createdAt: plan.created_at,
    executedAt: plan.executed_at,
    steps,
    results,
    thoughts: trace,
  };
}

function statusLabel(status) {
  const labels = {
    pending: '待执行',
    pending_confirmation: '待确认',
    executing: '执行中',
    outcome_unknown: '结果待核对',
    completed: '已完成',
    failed: '失败',
  };
  return labels[status] || status;
}

function statusClass(status) {
  if (status === 'completed') return 'bg-status-ok/10 text-status-ok';
  if (status === 'failed') return 'bg-status-error/10 text-status-error';
  if (status === 'executing') return 'bg-blue-500/10 text-blue-400';
  if (status === 'outcome_unknown') return 'bg-status-warn/10 text-status-warn';
  return 'bg-surface-700/50 text-surface-400';
}

function roleLabel(role) {
  const labels = {
    planner: '规划者',
    executor: '执行者',
    validator: '验证者',
    incident_responder: '应急响应',
  };
  return labels[role] || role;
}

function phaseLabel(phase) {
  const labels = {
    understanding: '理解',
    planning: '规划',
    executing: '执行',
    validating: '验证',
    done: '完成',
  };
  return labels[phase] || phase;
}

function phaseColor(phase) {
  const colors = {
    understanding: 'text-blue-400',
    planning: 'text-purple-400',
    executing: 'text-status-warn',
    validating: 'text-status-ok',
    done: 'text-surface-400',
  };
  return colors[phase] || 'text-surface-400';
}

function resultIcon(status) {
  if (status === 'success') return CircleCheck;
  if (status === 'failed') return CircleX;
  if (status === 'precondition_failed' || status === 'postcondition_failed') return AlertCircle;
  return Clock;
}

function resultIconClass(status) {
  if (status === 'success') return 'text-status-ok';
  if (status === 'failed') return 'text-status-error';
  if (status === 'precondition_failed' || status === 'postcondition_failed') return 'text-status-warn';
  return 'text-surface-400';
}

function resultBorderClass(status) {
  if (status === 'success') return 'border-status-ok/20 bg-status-ok/5';
  if (status === 'failed') return 'border-status-error/20 bg-status-error/5';
  if (status === 'precondition_failed' || status === 'postcondition_failed') return 'border-status-warn/20 bg-status-warn/5';
  return 'border-surface-800 bg-surface-900/40';
}

usePullRefresh(load, { keepAlive: true });
function activate() { if (active) return; active = true; void load(); }
function deactivate() { active = false; invalidate(); }
function hostChanged() { invalidate(true); if (active) void load(); }
const stopAuth = onAuthEpochChange((_epoch, { identityChanged } = {}) => {
  invalidate(true);
  if (!identityChanged && active) void load();
});
window.addEventListener('composeops:host-changed', hostChanged);
onMounted(activate);
onActivated(activate);
onDeactivated(deactivate);
onBeforeUnmount(() => { deactivate(); stopAuth(); window.removeEventListener('composeops:host-changed', hostChanged); });

const { rows: pagedRows, page, pageSize, total, sortKey, descending } = usePagedRows(filteredExecutions, { createdAt: item => parseTimestamp(item.createdAt)?.getTime() || 0, status: item => item.status, message: item => item.message }, 'createdAt');
const sortOptions = [{ key: 'createdAt', label: '创建时间' }, { key: 'status', label: '状态' }, { key: 'message', label: '任务名称' }];
</script>

<style scoped>
@reference '../style.css';
.status-badge {
  @apply inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium;
}

</style>
