<template>
  <div class="page-shell page-shell-workspace">
    <div class="page-header">
      <div>
        <h1 class="page-title">Agent 执行历史</h1>
        <p class="page-subtitle">查看 Agent 的计划、工具调用与执行结果</p>
      </div>
      <div class="flex items-center gap-3">
        <button class="btn-secondary" :disabled="loading" @click="load">
          <RefreshCw :class="{ 'animate-spin': loading }" class="h-4 w-4" />刷新
        </button>
      </div>
    </div>

    <div v-if="error" class="card border-rose-500/20 bg-rose-500/5 p-4 text-rose-300">{{ error }}</div>

    <section v-if="usage" class="space-y-3">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="card p-4">
          <p class="text-xs text-zinc-500">总 token</p>
          <p class="mt-1 text-xl font-semibold text-zinc-100">{{ formatNumber(usage.totals?.total_tokens) }}</p>
          <p class="mt-1 text-xs text-zinc-500">最近 {{ usage.days }} 天</p>
        </div>
        <div class="card p-4">
          <p class="text-xs text-zinc-500">LLM 调用</p>
          <p class="mt-1 text-xl font-semibold text-zinc-100">{{ formatNumber(usage.totals?.calls) }}</p>
          <p class="mt-1 text-xs text-zinc-500">Tool Loop 轮次</p>
        </div>
        <div class="card p-4">
          <p class="text-xs text-zinc-500">输入 token</p>
          <p class="mt-1 text-xl font-semibold text-zinc-100">{{ formatNumber(usage.totals?.prompt_tokens) }}</p>
          <p class="mt-1 text-xs text-zinc-500">上下文与工具结果</p>
        </div>
        <div class="card p-4">
          <p class="text-xs text-zinc-500">输出 token</p>
          <p class="mt-1 text-xl font-semibold text-zinc-100">{{ formatNumber(usage.totals?.completion_tokens) }}</p>
          <p class="mt-1 text-xs text-zinc-500">模型生成内容</p>
        </div>
      </div>

      <div v-if="usage.byModel?.length" class="card p-4">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-sm font-medium text-zinc-200">模型用量</h2>
          <span class="text-xs text-zinc-500">按总 token 排序</span>
        </div>
        <div class="mt-3 grid gap-2 md:grid-cols-2">
          <div v-for="model in usage.byModel" :key="model.model" class="flex items-center justify-between gap-3 rounded-sm border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
            <span class="min-w-0 truncate font-mono text-zinc-300">{{ model.model }}</span>
            <span class="shrink-0 text-zinc-500">{{ formatNumber(model.total_tokens) }} · {{ formatNumber(model.calls) }} 次</span>
          </div>
        </div>
      </div>
    </section>

    <div v-if="!loading && !executions.length" class="card p-8">
      <EmptyState icon="history" title="暂无执行记录" message="Agent 工作流执行后会在此显示" />
    </div>

    <div v-else class="space-y-3">
      <div v-for="exec in executions" :key="exec.planId" class="card p-4">
        <div class="mb-3 flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="mb-1 flex items-center gap-2">
              <h3 class="truncate text-base font-semibold text-zinc-200">{{ exec.message || '工作流执行' }}</h3>
              <span :class="statusClass(exec.status)" class="status-badge">{{ statusLabel(exec.status) }}</span>
            </div>
            <p class="text-sm text-zinc-400">计划 ID: {{ exec.planId }}</p>
            <div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
              <span>角色: {{ roleLabel(exec.role) }}</span>
              <span>步骤: {{ exec.stepCount }}</span>
              <span v-if="exec.createdAt">创建: {{ formatTime(exec.createdAt) }}</span>
              <span v-if="exec.executedAt">执行: {{ formatTime(exec.executedAt) }}</span>
            </div>
          </div>
          <button class="btn-secondary px-3! py-1.5! text-xs!" @click="toggleDetail(exec.planId)">
            <ChevronDown :class="{ 'rotate-180': expandedPlan === exec.planId }" class="h-3.5 w-3.5 transition-transform" />
            {{ expandedPlan === exec.planId ? '收起' : '详情' }}
          </button>
        </div>

        <div v-if="expandedPlan === exec.planId" class="space-y-4 border-t border-zinc-800 pt-4">
          <!-- 工作流步骤 -->
          <div v-if="exec.steps && exec.steps.length">
            <h4 class="mb-2 text-sm font-medium text-zinc-300">工作流步骤</h4>
            <div class="space-y-2">
              <div v-for="(step, idx) in exec.steps" :key="idx" class="rounded-sm border border-zinc-800 bg-zinc-900/40 p-3">
                <div class="mb-2 flex items-start justify-between">
                  <div class="flex items-center gap-2">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-medium text-zinc-400">{{ idx + 1 }}</span>
                    <span class="font-mono text-sm text-zinc-300">{{ step.tool }}</span>
                    <span v-if="step.risk" :class="riskClass(step.risk)" class="risk-badge">{{ riskLabel(step.risk) }}</span>
                  </div>
                  <span v-if="step.confirmationRequired" class="text-xs text-amber-400">需确认</span>
                </div>
                <div v-if="step.reason" class="mb-2 text-xs text-zinc-400">{{ step.reason }}</div>
                <div v-if="step.params && Object.keys(step.params).length" class="text-xs">
                  <span class="text-zinc-500">参数:</span>
                  <code class="ml-2 rounded-sm bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-300">{{ formatParams(step.params) }}</code>
                </div>
              </div>
            </div>
          </div>

          <!-- 执行结果 -->
          <div v-if="exec.results && exec.results.length">
            <h4 class="mb-2 text-sm font-medium text-zinc-300">执行结果</h4>
            <div class="space-y-2">
              <div v-for="(result, idx) in exec.results" :key="idx" class="rounded-sm border p-3" :class="resultBorderClass(result.status)">
                <div class="mb-2 flex items-start justify-between">
                  <div class="flex items-center gap-2">
                    <component :is="resultIcon(result.status)" :class="resultIconClass(result.status)" class="h-4 w-4 shrink-0" />
                    <span class="font-mono text-sm text-zinc-300">{{ result.tool }}</span>
                  </div>
                  <span v-if="result.durationMs" class="text-xs text-zinc-500">{{ result.durationMs }}ms</span>
                </div>
                <div v-if="result.error" class="mb-2 text-sm text-rose-300">{{ result.error }}</div>
                <div v-if="result.result" class="max-h-32 overflow-auto rounded-sm bg-zinc-900 p-2 text-xs">
                  <pre class="whitespace-pre-wrap text-zinc-400">{{ stringifyResult(result.result) }}</pre>
                </div>
              </div>
            </div>
          </div>

          <!-- 执行轨迹 -->
          <div v-if="exec.thoughts && exec.thoughts.length">
            <h4 class="mb-2 text-sm font-medium text-zinc-300">执行轨迹</h4>
            <div class="space-y-1.5">
              <div v-for="(thought, idx) in exec.thoughts" :key="idx" class="flex gap-3 text-xs">
                <span :class="phaseColor(thought.phase)" class="w-16 shrink-0 font-medium">{{ phaseLabel(thought.phase) }}</span>
                <span class="flex-1 text-zinc-400">{{ thought.content }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onActivated, onMounted, ref } from 'vue';
import { api } from '../api/client.js';
import { RefreshCw, ChevronDown, CircleCheck, CircleX, Clock, AlertCircle } from 'lucide-vue-next';
import EmptyState from '../components/common/EmptyState.vue';

const loading = ref(false);
const error = ref('');
const executions = ref([]);
const usage = ref(null);
const expandedPlan = ref(null);

async function load() {
  loading.value = true;
  error.value = '';
  usage.value = null;
  try {
    const [executionResult, usageResult] = await Promise.allSettled([
      api.getAgentExecutions(),
      api.getAgentUsage(30),
    ]);
    if (executionResult.status === 'rejected') throw executionResult.reason;
    if (usageResult.status === 'fulfilled') usage.value = usageResult.value;
    const response = executionResult.value;
    const rowsByPlan = new Map();
    for (const row of response.executions || []) {
      const rows = rowsByPlan.get(row.plan_id) || [];
      rows.push(row);
      rowsByPlan.set(row.plan_id, rows);
    }
    executions.value = (response.plans || []).map((plan) => mapPlan(plan, rowsByPlan.get(plan.id) || []));
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function formatNumber(value) {
  return (Number(value) || 0).toLocaleString('zh-CN');
}

function toggleDetail(planId) {
  expandedPlan.value = expandedPlan.value === planId ? null : planId;
}

function formatTime(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
    completed: '已完成',
    failed: '失败',
  };
  return labels[status] || status;
}

function statusClass(status) {
  if (status === 'completed') return 'bg-emerald-500/10 text-emerald-400';
  if (status === 'failed') return 'bg-rose-500/10 text-rose-400';
  if (status === 'executing') return 'bg-blue-500/10 text-blue-400';
  return 'bg-zinc-700/50 text-zinc-400';
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
    executing: 'text-amber-400',
    validating: 'text-emerald-400',
    done: 'text-zinc-400',
  };
  return colors[phase] || 'text-zinc-500';
}

function riskLabel(risk) {
  const labels = {
    low: '低风险',
    medium: '中风险',
    high: '高风险',
    critical: '极高',
  };
  return labels[risk] || risk;
}

function riskClass(risk) {
  if (risk === 'critical') return 'bg-rose-500/20 text-rose-300';
  if (risk === 'high') return 'bg-orange-500/20 text-orange-300';
  if (risk === 'medium') return 'bg-amber-500/20 text-amber-300';
  return 'bg-blue-500/20 text-blue-300';
}

function resultIcon(status) {
  if (status === 'success') return CircleCheck;
  if (status === 'failed') return CircleX;
  if (status === 'precondition_failed' || status === 'postcondition_failed') return AlertCircle;
  return Clock;
}

function resultIconClass(status) {
  if (status === 'success') return 'text-emerald-400';
  if (status === 'failed') return 'text-rose-400';
  if (status === 'precondition_failed' || status === 'postcondition_failed') return 'text-amber-400';
  return 'text-zinc-500';
}

function resultBorderClass(status) {
  if (status === 'success') return 'border-emerald-500/20 bg-emerald-500/5';
  if (status === 'failed') return 'border-rose-500/20 bg-rose-500/5';
  if (status === 'precondition_failed' || status === 'postcondition_failed') return 'border-amber-500/20 bg-amber-500/5';
  return 'border-zinc-800 bg-zinc-900/40';
}

onMounted(() => load());
let historyActivatedOnce = false;
onActivated(() => { if (historyActivatedOnce) void load(); historyActivatedOnce = true; });
</script>

<style scoped>
@reference '../style.css';
.status-badge {
  @apply inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium;
}

.risk-badge {
  @apply inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium;
}
</style>
