<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">AI 巡检中心</h1>
        <p class="page-subtitle">只读巡检容器状态、磁盘、内存、备份时效与项目纳管,输出结论与建议,不执行任何变更</p>
      </div>
      <div class="page-actions">
        <button class="btn-secondary" :disabled="loading" @click="load">
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading || running }" />刷新
        </button>
        <button v-if="latest" class="btn-secondary" title="让 Agent 根据本次巡检结论给出处置建议" @click="askAgent">
          <Bot class="w-4 h-4" />交给 Agent
        </button>
        <button class="btn-primary" :disabled="running" @click="runNow">
          <Play class="w-4 h-4" :class="{ 'animate-pulse': running }" />立即巡检
        </button>
      </div>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>

    <!-- 概览卡片 -->
    <div v-if="latest" class="card p-4 sm:p-5">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-4">
          <span class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border font-mono text-xl font-semibold" :class="tileClass(latest.score)">
            {{ latest.score }}
          </span>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-base font-semibold text-surface-100">最近巡检:{{ gradeLabel(latest.grade) }}</h2>
              <span class="count-badge" :class="gradeBadgeClass(latest.grade)">{{ latest.grade === 'healthy' ? '无需处理' : GRADE_LABELS[latest.grade] }}</span>
            </div>
            <p class="mt-1 text-sm text-surface-300">{{ latest.summary }}</p>
            <p class="mt-1 text-xs text-muted">
              {{ formatTime(latest.createdAt) }} · {{ sourceLabel(latest.source) }} · 耗时 {{ latest.durationMs != null ? `${latest.durationMs}ms` : '—' }}
            </p>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-4 text-xs text-muted">
          <span class="flex items-center gap-1.5"><i class="status-dot bg-rose-400"></i>{{ latest.counts?.critical || 0 }} 严重</span>
          <span class="flex items-center gap-1.5"><i class="status-dot bg-amber-400"></i>{{ latest.counts?.warning || 0 }} 关注</span>
          <span class="flex items-center gap-1.5"><i class="status-dot bg-surface-500"></i>{{ latest.counts?.info || 0 }} 提示</span>
          <button class="icon-btn" title="查看完整报告" @click="openDetail(latest.id)"><FileText class="h-4 w-4" /></button>
        </div>
      </div>

      <!-- 容量预测 -->
      <div v-if="latest.predictions?.length" class="mt-4 border-t border-surface-800 pt-4">
        <div class="mb-2 flex items-center gap-2"><span class="section-eyebrow">容量预测</span></div>
        <div class="grid gap-2 sm:grid-cols-2">
          <div v-for="prediction in latest.predictions" :key="prediction.metric" class="panel-card flex items-start gap-3">
            <component :is="prediction.status === 'unknown' ? Hourglass : prediction.status === 'warning' ? TriangleAlert : CheckCircle2" class="mt-0.5 h-4 w-4 shrink-0" :class="prediction.status === 'warning' ? 'text-amber-300' : prediction.status === 'unknown' ? 'text-surface-500' : 'text-emerald-300'" />
            <div class="min-w-0">
              <p class="text-sm text-surface-200">{{ predictionTitle(prediction) }}</p>
              <p class="mt-0.5 text-xs leading-5 text-muted">{{ prediction.detail }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 自动巡检配置 -->
    <div class="panel-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="section-eyebrow">自动巡检</span>
          <span class="count-badge" :class="schedule.enabled ? 'text-emerald-300' : 'text-surface-500'">{{ schedule.enabled ? '已启用' : '已停用' }}</span>
        </div>
        <p class="mt-1 text-xs text-muted">
          按间隔自动执行只读巡检并留存报告;默认关闭,开启后每天最多执行一次。
          <template v-if="schedule.lastRunAt">上次执行:{{ formatTime(schedule.lastRunAt) }}</template>
        </p>
      </div>
      <div class="flex shrink-0 flex-wrap items-center gap-3">
        <select v-model="intervalHours" class="input w-40! min-h-8! py-1.5! text-xs" :disabled="!schedule.enabled" title="自动巡检间隔">
          <option v-for="option in intervalOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <label class="toggle-label"><input type="checkbox" :checked="schedule.enabled" @change="toggleSchedule" /><span>{{ schedule.enabled ? '关闭自动巡检' : '开启自动巡检' }}</span></label>
      </div>
    </div>

    <!-- 报告列表 -->
    <div>
      <div class="mb-2 flex items-center justify-between">
        <h2 class="section-title">报告历史</h2>
        <button v-if="reports.length" class="btn-ghost px-2! py-1! text-xs" @click="pruneReports"><Trash2 class="h-3.5 w-3.5" />清理 180 天前</button>
      </div>
      <div v-if="reports.length" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>来源</th>
              <th>评分</th>
              <th>结论</th>
              <th>明细</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="report in reports" :key="report.id" class="cursor-pointer" @click="openDetail(report.id)">
              <td class="whitespace-nowrap">{{ formatTime(report.createdAt) }}</td>
              <td><span class="count-badge">{{ sourceLabel(report.source) }}</span></td>
              <td>
                <span class="inline-flex items-center gap-1.5">
                  <span class="font-mono font-semibold" :class="scoreTextClass(report.score)">{{ report.score }}</span>
                  <span class="text-xs" :class="gradeBadgeClass(report.grade)">{{ GRADE_LABELS[report.grade] }}</span>
                </span>
              </td>
              <td class="max-w-[380px] truncate text-surface-400">{{ report.summary }}</td>
              <td class="whitespace-nowrap">
                <span class="text-rose-300">{{ report.counts?.critical || 0 }}</span>
                <span class="mx-0.5 text-surface-600">/</span>
                <span class="text-amber-300">{{ report.counts?.warning || 0 }}</span>
                <span class="mx-0.5 text-surface-600">/</span>
                <span class="text-surface-500">{{ report.counts?.info || 0 }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="!loading" class="empty-state">
        <ShieldCheck class="h-10 w-10 text-surface-600" />
        <p>还没有巡检报告</p>
        <button class="btn-primary" @click="runNow"><Play class="h-4 w-4" />现在巡检一次</button>
      </div>
    </div>

    <!-- 报告明细抽屉 -->
    <BaseModal :show="!!detail" :title="detail ? `${formatTime(detail.createdAt)} · ${sourceLabel(detail.source)} · 评分 ${detail.score} / ${GRADE_LABELS[detail.grade]}` : ''" size-class="max-h-[88vh] max-w-3xl flex flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4" @close="closeDetail">
      <template #header-actions>
        <button class="btn-secondary px-2.5! py-1.5! text-xs" :disabled="detailLoading" @click="askAgentForReport">交给 Agent</button>
      </template>
      <p v-if="detailLoading" class="text-sm text-muted">加载中...</p>
      <template v-else-if="detail?.report">
        <p class="mb-4 rounded-lg border border-surface-800 bg-surface-950/50 px-3 py-2 text-sm text-surface-300">{{ detail.report.summary }}</p>

        <div v-if="detail.report.predictions?.length" class="mb-5">
          <h3 class="section-title mb-2">容量预测</h3>
          <div class="space-y-1.5">
            <p v-for="prediction in detail.report.predictions" :key="prediction.metric" class="flex items-start gap-2 text-sm text-surface-300">
              <component :is="prediction.status === 'unknown' ? Hourglass : prediction.status === 'warning' ? TriangleAlert : CheckCircle2" class="mt-0.5 h-4 w-4 shrink-0" :class="prediction.status === 'warning' ? 'text-amber-300' : 'text-emerald-300'" />
              <span class="min-w-0">{{ prediction.detail }}</span>
            </p>
          </div>
        </div>

        <h3 class="section-title mb-2">巡检项({{ (detail.report.findings || []).length }})</h3>
        <div v-if="detail.report.findings?.length" class="space-y-2">
          <article v-for="item in detail.report.findings" :key="item.id" class="rounded-xl border p-3" :class="levelBorderClass(item.level)">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-surface-100" :class="levelTextClass(item.level)">
                  <component :is="levelIcon(item.level)" class="mr-1.5 inline h-4 w-4 -mt-0.5" />{{ item.title }}
                </p>
                <p class="mt-1 text-sm leading-relaxed text-surface-300">{{ item.detail }}</p>
                <p v-if="item.advice" class="mt-1.5 text-xs leading-5 text-muted">建议:{{ item.advice }}</p>
              </div>
              <div v-if="item.tool" class="flex shrink-0 flex-col items-end gap-1.5">
                <span class="count-badge text-accent">{{ item.tool }}</span>
                <button class="btn-secondary px-2! py-1! text-xs" @click="handoffToAgent(item)"><Bot class="h-3.5 w-3.5" />让 Agent 处理</button>
              </div>
            </div>
          </article>
        </div>
        <p v-else class="text-sm text-muted">本次巡检未发现需要提示的事项。</p>
        <p v-if="detail.report.durationMs != null" class="mt-4 text-xs text-muted">耗时 {{ detail.report.durationMs }}ms</p>
      </template>
    </BaseModal>
  </div>
</template>

<script setup>
import { onActivated, onBeforeUnmount, onMounted, ref } from 'vue';
import { Bot, CheckCircle2, CircleAlert, CircleX, FileText, Hourglass, Info, Play, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { useAgentConsole } from '../composables/useAgentConsole.js';
import { useToastStore } from '../stores/toast.js';
import BaseModal from '../components/common/BaseModal.vue';

const GRADE_LABELS = { healthy: '健康', attention: '需关注', degraded: '需处理', critical: '严重' };
// 与后端 inspection.js 的阈值一致:90 / 75 / 55
const GRADE_SCORE = { healthy: 90, attention: 75, degraded: 55, critical: 0 };

const toast = useToastStore();
const { openAgent, updateAgentContext, resetAgentContext } = useAgentConsole();

const loading = ref(false);
const running = ref(false);
const error = ref('');
const overview = ref(null);
const reports = ref([]);
const latest = ref(null);
const schedule = ref({ enabled: false, intervalHours: 24, lastRunAt: 0 });
const intervalHours = ref(24);
const detail = ref(null);
const detailLoading = ref(false);

const intervalOptions = [
  { value: 6, label: '每 6 小时' },
  { value: 12, label: '每 12 小时' },
  { value: 24, label: '每天' },
  { value: 48, label: '每 2 天' },
  { value: 168, label: '每周' },
];

function gradeBadgeClass(grade) {
  return {
    healthy: 'text-emerald-300',
    attention: 'text-amber-300',
    degraded: 'text-amber-300',
    critical: 'text-rose-300',
  }[grade] || 'text-surface-400';
}
function scoreTextClass(score) {
  return score >= GRADE_SCORE.healthy ? 'text-emerald-300' : score >= GRADE_SCORE.attention ? 'text-amber-300' : 'text-rose-300';
}
function tileClass(score) {
  const base = 'border';
  if (score == null) return `${base} border-surface-700 bg-surface-900 text-surface-300`;
  if (score >= GRADE_SCORE.healthy) return `${base} border-emerald-500/40 bg-emerald-500/10 text-emerald-300`;
  if (score >= GRADE_SCORE.attention) return `${base} border-amber-500/40 bg-amber-500/10 text-amber-300`;
  return `${base} border-rose-500/40 bg-rose-500/10 text-rose-300`;
}
function levelIcon(level) {
  return { critical: CircleX, warning: TriangleAlert, info: Info }[level] || CircleAlert;
}
function levelTextClass(level) {
  return { critical: 'text-rose-300', warning: 'text-amber-300', info: 'text-surface-300' }[level] || '';
}
function levelBorderClass(level) {
  return {
    critical: 'border-rose-900/50 bg-rose-950/20',
    warning: 'border-amber-900/50 bg-amber-950/10',
    info: 'border-surface-800 bg-surface-950/40',
  }[level] || 'border-surface-800';
}
function sourceLabel(source) {
  return { manual: '手动', schedule: '自动', agent: 'Agent', cron: '定时' }[source] || source || '手动';
}
function predictionTitle(prediction) {
  if (prediction.metric === 'disk') {
    if (prediction.usedPercent != null) return `磁盘水位 ${prediction.usedPercent}%`;
    return '磁盘容量';
  }
  return prediction.metric;
}
function gradeLabel(grade) {
  return GRADE_LABELS[grade] || grade || '健康';
}

function formatTime(value) {
  if (!value) return '—';
  const time = typeof value === 'string' ? (value.includes('T') ? new Date(value) : new Date(`${value.replace(' ', 'T')}Z`)) : new Date(Number(value));
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleString('zh-CN', { hour12: false });
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.getInspectionOverview(20);
    overview.value = data;
    latest.value = data.latest;
    reports.value = data.reports || [];
    schedule.value = { ...(data.schedule || { enabled: false, intervalHours: 24, lastRunAt: 0 }) };
    intervalHours.value = schedule.value.intervalHours || 24;
  } catch (loadError) {
    error.value = `加载巡检数据失败:${loadError.message}`;
  } finally {
    loading.value = false;
  }
}

async function runNow() {
  if (running.value) return;
  running.value = true;
  error.value = '';
  try {
    const data = await api.runInspection();
    toast.success(`巡检完成:${data.report?.summary || '请查看报告'}`);
    await load();
  } catch (runError) {
    error.value = `巡检失败:${runError.message}`;
    toast.error('巡检执行失败');
  } finally {
    running.value = false;
  }
}

async function toggleSchedule(event) {
  const next = event.target.checked;
  try {
    const data = await api.saveInspectionSchedule({ enabled: next, intervalHours: Number(intervalHours.value) || 24 });
    schedule.value = { ...(data.schedule || {}) };
    toast.success(next ? `已开启自动巡检(每 ${schedule.value.intervalHours} 小时一次)` : '已关闭自动巡检');
  } catch (scheduleError) {
    event.target.checked = !next;
    error.value = `保存失败:${scheduleError.message}`;
  }
}

async function pruneReports() {
  try {
    const result = await api.pruneInspections(180);
    toast.success(`已清理 ${result.removed || 0} 条历史报告`);
    await load();
  } catch (pruneError) {
    toast.error(`清理失败:${pruneError.message}`);
  }
}

async function openDetail(id) {
  detailLoading.value = true;
  detail.value = { id, report: null };
  try {
    const data = await api.getInspectionReport(id);
    detail.value = data.report ? { id, report: data.report } : detail.value;
  } catch (detailError) {
    toast.error(`读取报告失败:${detailError.message}`);
    detail.value = null;
  } finally {
    detailLoading.value = false;
  }
}
function closeDetail() { detail.value = null; }

function buildAgentPrompt(item) {
  const summaryText = item?.detail ? `${item.title}\n${item.detail}` : (latest.value?.summary || '最近一次巡检');
  return `请基于最新一次 AI 巡检的结论进行分析并给出处置建议:\n\n${summaryText}\n\n${item?.advice ? `系统建议:${item.advice}\n\n` : ''}请先做必要的只读诊断(如检查容器状态、日志、磁盘)确认后,再给出明确建议;需要执行变更时先列出计划并等我确认。`;
}
function handoffToAgent(item) {
  updateAgentContext({ page: 'AI 巡检中心', mode: 'inspection-fix', summary: '来自巡检报告的一条建议,请分析并给出处置', state: JSON.stringify({ title: item.title, detail: item.detail, advice: item.advice, tool: item.tool }) });
  openAgent();
  window.dispatchEvent(new CustomEvent('composeops:agent-prompt', { detail: { prompt: buildAgentPrompt(item) } }));
}
function askAgent() {
  updateAgentContext({ page: 'AI 巡检中心', mode: 'inspection-review', summary: '请分析最新一次巡检结论' });
  openAgent();
  window.dispatchEvent(new CustomEvent('composeops:agent-prompt', { detail: { prompt: buildAgentPrompt() } }));
}
function askAgentForReport() {
  const report = detail.value?.report;
  const summaryText = report ? `#${detail.value.id} ${report.summary}${report.findings?.length ? `\n\n发现 ${report.findings.filter((item) => item.level === 'critical').length} 项严重、${report.findings.filter((item) => item.level === 'warning').length} 项需关注。` : ''}` : (latest.value?.summary || '最近一次巡检');
  updateAgentContext({ page: 'AI 巡检中心', mode: 'inspection-review', summary: '请分析这份巡检报告' });
  openAgent();
  window.dispatchEvent(new CustomEvent('composeops:agent-prompt', { detail: { prompt: `请分析这份巡检报告并给出处置建议:\n\n${summaryText}` } }));
}

let activatedOnce = false;
function onActivatedLoad() { if (activatedOnce) void load(); activatedOnce = true; }
function handleHostChanged() { void load(); }

onMounted(() => {
  void load();
  window.addEventListener('composeops:host-changed', handleHostChanged);
});
onActivated(onActivatedLoad);
onBeforeUnmount(() => {
  window.removeEventListener('composeops:host-changed', handleHostChanged);
  resetAgentContext();
});
</script>