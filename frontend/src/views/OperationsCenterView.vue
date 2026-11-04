<template>
  <div class="page-shell" :aria-busy="loading">
    <div class="page-header">
      <div>
        <h1 class="page-title">定时运维计划</h1>
        <p class="page-subtitle">把备份、镜像更新与 AI 巡检组合成可复用的定时运维计划</p>
      </div>
      <div class="page-actions">
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <p v-if="loading" class="sr-only" role="status" aria-live="polite" aria-atomic="true">正在加载运维任务中心</p>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>

    <!-- 任务流生成器 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">生成运维计划</h2><p class="mt-1 text-muted">选择目标项目和执行时间，生成当前系统实际支持的定时任务</p></div>
      <div class="grid gap-4 lg:grid-cols-3">
        <div class="lg:col-span-1 space-y-3">
          <div>
            <label class="block text-sm font-medium text-surface-300">目标项目</label>
            <select v-model="targetProjectId" class="input mt-1.5 w-full" aria-label="目标项目">
              <option value="">选择项目</option>
              <option v-for="p in store.projects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-surface-300">执行时间</label>
            <select v-model="scheduleCron" class="input mt-1.5 w-full" aria-label="执行时间">
              <option value="0 3 * * *">每天 03:00</option>
              <option value="0 4 * * 0">每周日 04:00</option>
              <option value="0 2 1 * *">每月 1 日 02:00</option>
            </select>
          </div>
          <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-3">
            <div class="flex items-center justify-between">
              <span class="text-sm text-surface-300">自动巡检</span>
              <label class="toggle-label"><input v-model="enableInspection" type="checkbox" aria-label="自动巡检" /></label>
            </div>
            <p class="mt-1 text-xs text-surface-500">按同一周期执行只读 AI 巡检并留存报告</p>
          </div>
          <button class="btn-primary w-full" :disabled="!targetProjectId || generating" @click="generateFlow">
            <Sparkles class="w-4 h-4" :class="{ 'animate-pulse': generating }" />{{ generating ? '生成中...' : '生成任务流' }}
          </button>
        </div>

        <!-- 任务流预览 -->
        <div class="lg:col-span-2">
          <div v-if="!flowSteps.length" class="flex h-full min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-surface-700 p-6 text-center">
            <Bot class="mb-3 h-8 w-8 text-surface-600" />
            <p class="text-sm text-surface-400">选择项目后生成计划，系统会列出实际会创建的定时任务</p>
          </div>
          <div v-else class="space-y-2">
            <div v-for="(step, idx) in flowSteps" :key="idx" class="flex items-start gap-3 rounded-xl border border-surface-800 bg-surface-950/40 p-3">
              <span class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border font-mono text-xs" :class="step.tone === 'danger' ? 'border-rose-500/40 text-rose-300' : step.tone === 'warning' ? 'border-amber-500/40 text-amber-300' : 'border-emerald-500/40 text-emerald-300'">{{ idx + 1 }}</span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-surface-100">{{ step.title }}</p>
                <p class="mt-0.5 text-xs text-surface-400">{{ step.description }}</p>
              </div>
              <span class="shrink-0 rounded-sm px-2 py-0.5 text-[10px] font-semibold" :class="step.tone === 'danger' ? 'bg-rose-500/20 text-rose-300' : step.tone === 'warning' ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'">{{ step.tag }}</span>
            </div>
            <div class="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/80">
              当前计划会创建“数据卷备份”“拉取镜像”和可选的“AI 巡检”定时任务；部署、健康检查和回滚仍需在服务/运维操作中执行，不会被假装成已自动化。
            </div>
            <div class="flex gap-2 pt-1">
              <button class="btn-primary flex-1" :disabled="creating || loading" @click="createFlowJobs"><Rocket class="w-4 h-4" :class="{ 'animate-pulse': creating }" />{{ creating ? '创建中...' : '创建定时任务' }}</button>
              <button class="btn-secondary" @click="flowSteps = []">清空</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 持久化 Agent 后台任务 -->
    <section class="section-panel">
      <div class="mb-4 flex items-center justify-between gap-3">
        <div><h2 class="section-title">Agent 后台任务</h2><p class="mt-1 text-muted">任务独立于聊天连接运行；中断后结果不确定的任务需要先核对 Docker 实际状态</p></div>
        <button class="btn-secondary px-2.5! py-1.5! text-xs" :disabled="taskLoading" @click="loadAgentTasks()"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': taskLoading }" />刷新任务</button>
      </div>
      <p v-if="agentTaskError" class="alert-error" role="alert">{{ agentTaskError }}</p>
      <div v-if="!agentTasks.length && !agentTaskError" class="rounded-xl border border-dashed border-surface-700 p-6 text-center text-sm text-surface-500">暂无 Agent 后台任务。通过 AI 助手将长时间的 Compose 操作转入后台后，任务会出现在这里。</div>
      <div v-else-if="agentTasks.length" class="table-wrap">
        <table class="data-table">
          <thead><tr><th>任务</th><th>项目</th><th>状态</th><th>开始时间</th><th>操作</th></tr></thead>
          <tbody>
            <template v-for="task in agentTasks" :key="task.id">
              <tr class="hover:bg-surface-800/25">
                <td><div class="font-medium text-surface-100">{{ task.label }}</div><div class="mt-0.5 font-mono text-[10px] text-surface-500">{{ task.id }}</div></td>
                <td class="max-w-48 truncate text-xs text-surface-400" :title="task.projectId || ''">{{ task.projectId || '全局任务' }}</td>
                <td><span class="status-badge" :class="agentTaskTone(task.status)">{{ agentTaskStatusLabel(task.status) }}</span><p v-if="task.error" class="mt-1 max-w-64 text-xs text-amber-300">{{ task.error }}</p></td>
                <td class="whitespace-nowrap font-mono text-xs text-surface-400">{{ formatTime(task.startedAt || task.createdAt) }}</td>
                <td><div class="flex gap-1">
                  <button class="btn-secondary px-2! py-1! text-xs" @click="toggleTaskOutput(task)"><FileText class="h-3.5 w-3.5" />{{ expandedTaskId === task.id ? '收起' : '输出' }}</button>
                  <button v-if="['queued', 'running'].includes(task.status)" class="btn-secondary px-2! py-1! text-xs" @click="stopTarget = task"><Square class="h-3.5 w-3.5" />停止</button>
                </div></td>
              </tr>
              <tr v-if="expandedTaskId === task.id" :key="task.id + '-output'">
                <td colspan="5" class="bg-surface-950/40">
                  <p v-if="taskDetails[task.id]?.error" class="mb-2 text-xs text-amber-300">{{ taskDetails[task.id].error }}</p>
                  <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-surface-800 bg-black/20 p-3 font-mono text-xs text-surface-300">{{ taskDetails[task.id]?.output || '暂无任务输出' }}</pre>
                  <p v-if="taskDetails[task.id]?.status === 'outcome_unknown'" class="mt-2 text-xs text-amber-300">该任务没有可证明的最终结果。请先检查目标容器/项目状态，不要直接重放原操作。</p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 现有定时任务 -->
    <section class="section-panel">
      <div class="mb-4 flex items-center justify-between">
        <div><h2 class="section-title">现有定时任务</h2><p class="mt-1 text-muted">当前已配置的自动运维任务</p></div>
        <router-link to="/cron" class="text-xs text-emerald-400 hover:text-emerald-300">管理全部 →</router-link>
      </div>
      <p v-if="loading && !loadErrors.jobs" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4 text-sm text-surface-400">正在加载定时任务…</p>
      <p v-else-if="loadErrors.jobs" class="alert-error" role="alert">{{ loadErrors.jobs }}</p>
      <div v-else-if="!jobs.length" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4 text-sm text-surface-400">暂无定时任务。可通过上方任务流生成,或到定时任务页手动创建。</div>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead><tr><th>任务</th><th>类型</th><th>Cron</th><th>状态</th><th>最近执行</th></tr></thead>
          <tbody>
            <tr v-for="job in jobs" :key="job.id" class="hover:bg-surface-800/25">
              <td class="font-medium text-surface-100">{{ job.name }}</td>
              <td><span class="count-badge text-sky-300">{{ jobTypeLabel(job.type) }}</span></td>
              <td class="font-mono text-xs text-surface-400">{{ job.cron }}</td>
              <td><span class="status-badge" :class="job.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-surface-800 text-surface-400'">{{ job.enabled ? '启用' : '停用' }}</span></td>
              <td class="whitespace-nowrap font-mono text-xs text-surface-400">{{ job.lastRunAt ? formatTime(job.lastRunAt) : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- AI 主动巡检 -->
    <section class="section-panel">
      <div class="mb-4 flex items-center justify-between">
        <div class="flex items-center gap-2"><h2 class="section-title">AI 主动巡检</h2><Bot class="h-4 w-4 text-emerald-400" /></div>
        <!-- 巡检开关/间隔的唯一入口在 AI 巡检页,这里只展示当前状态,避免两处控件互相打架 -->
        <div class="text-xs text-surface-400">
          自动巡检{{ inspectionEnabled ? `已开启 · ${inspectionScheduleLabel}` : '已关闭' }},在
          <router-link to="/inspection" class="text-accent hover:underline">AI 巡检页</router-link>调整
        </div>
      </div>
      <p v-if="loading && !loadErrors.inspection" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4 text-sm text-surface-400">正在加载巡检状态…</p>
      <p v-else-if="loadErrors.inspection" class="alert-error" role="alert">{{ loadErrors.inspection }}</p>
      <div v-else-if="latestInspection" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
        <div class="flex flex-wrap items-center gap-3">
          <span class="grid h-12 w-12 shrink-0 place-items-center rounded-xl border font-mono text-lg font-semibold" :class="inspectionTileClass">{{ latestInspection.score }}</span>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-surface-100">最近巡检:{{ inspectionGradeLabel }}</p>
            <p class="mt-0.5 text-sm text-surface-300">{{ latestInspection.summary }}</p>
            <p class="mt-0.5 text-xs text-surface-500">{{ formatTime(latestInspection.createdAt) }}</p>
          </div>
          <router-link to="/inspection" class="btn-secondary px-2.5! py-1.5! text-xs">查看报告</router-link>
        </div>
      </div>
      <div v-else-if="!loading" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4 text-sm text-surface-400">暂无巡检报告。前往 <router-link to="/inspection" class="text-accent hover:underline">AI 巡检页</router-link> 生成第一份报告。</div>
    </section>
    <ConfirmDialog :show="!!stopTarget" title="停止后台任务" :message="'确认向任务「' + (stopTarget?.label || '') + '」发送停止请求？若执行方式无法确认进程已终止，任务会标记为结果待核对。'" tone="warning" confirm-text="发送停止请求" @confirm="confirmStopTask" @cancel="stopTarget = null" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { Bot, FileText, RefreshCw, Rocket, Sparkles, Square } from 'lucide-vue-next';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import { api } from '../api/client.js';
import { useServicesStore } from '../stores/services.js';

const store = useServicesStore();
const loading = ref(false);
const generating = ref(false);
const creating = ref(false);
const error = ref('');
const loadErrors = ref({ jobs: '', inspection: '' });
const targetProjectId = ref('');
const scheduleCron = ref('0 3 * * *');
const enableInspection = ref(true);
const flowSteps = ref([]);
const jobs = ref([]);
const inspectionEnabled = ref(false);
const inspectionInterval = ref(24);
const latestInspection = ref(null);
const agentTasks = ref([]);
const taskDetails = ref({});
const expandedTaskId = ref('');
const taskLoading = ref(false);
const agentTaskError = ref('');
const stopTarget = ref(null);
let taskPollTimer = null;

const targetProject = computed(() => store.projects.find((p) => p.id === targetProjectId.value));

function jobTypeLabel(type) {
  return { 'db-backup': '数据库备份', 'prune-safe': '安全清理', 'prune-all': '深度清理', 'images-check': '镜像检查', 'pull-images': '拉取镜像', 'volume-backup': '数据卷备份', inspection: 'AI 巡检' }[type] || type;
}
function agentTaskStatusLabel(status) {
  return { queued: '等待执行', running: '执行中', stopping: '正在停止', completed: '已完成', failed: '失败', stopped: '已取消', outcome_unknown: '结果待核对' }[status] || status;
}
function agentTaskTone(status) {
  if (status === 'completed') return 'bg-emerald-500/10 text-emerald-400';
  if (status === 'failed' || status === 'outcome_unknown') return 'bg-amber-500/10 text-amber-300';
  if (status === 'running' || status === 'stopping') return 'bg-sky-500/10 text-sky-300';
  return 'bg-surface-800 text-surface-400';
}
async function loadAgentTasks() {
  taskLoading.value = true;
  try {
    const data = await api.getAgentTasks(50);
    agentTasks.value = data.tasks || [];
    agentTaskError.value = '';
  } catch (e) {
    agentTaskError.value = '后台任务加载失败：' + (e.message || '未知错误');
  } finally {
    taskLoading.value = false;
  }
}
async function toggleTaskOutput(task) {
  if (expandedTaskId.value === task.id) { expandedTaskId.value = ''; return; }
  expandedTaskId.value = task.id;
  try {
    const data = await api.getAgentTask(task.id, 0);
    taskDetails.value = { ...taskDetails.value, [task.id]: data.task || {} };
  } catch (e) {
    taskDetails.value = { ...taskDetails.value, [task.id]: { error: e.message || '读取任务失败' } };
  }
}
async function confirmStopTask() {
  const task = stopTarget.value;
  stopTarget.value = null;
  if (!task) return;
  try {
    await api.stopAgentTask(task.id);
    await loadAgentTasks();
  } catch (e) {
    agentTaskError.value = '停止请求失败：' + (e.message || '未知错误');
  }
}
function formatTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

const inspectionGradeLabel = computed(() => {
  const grade = latestInspection.value?.grade;
  return { healthy: '健康', attention: '需关注', degraded: '需处理', critical: '严重' }[grade] || '健康';
});
const inspectionTileClass = computed(() => {
  const score = latestInspection.value?.score;
  if (score == null) return 'border-surface-700 bg-surface-900 text-surface-300';
  if (score >= 90) return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
  if (score >= 70) return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  return 'border-rose-500/40 bg-rose-500/10 text-rose-300';
});

const inspectionScheduleLabel = computed(() => (
  { 6: '每 6 小时', 12: '每 12 小时', 24: '每天', 168: '每周' }[inspectionInterval.value] || `每 ${inspectionInterval.value} 小时`
));

function generateFlow() {
  if (!targetProject.value) return;
  generating.value = true;
  const name = targetProject.value.projectName;
  const steps = [
    { title: '备份数据卷', description: `对「${name}」的命名卷执行 tar 备份,保留最近 20 份`, tag: '备份', tone: 'success' },
    { title: '拉取最新镜像', description: `执行 docker compose pull,获取「${name}」的最新镜像`, tag: '拉取', tone: 'success' },
  ];
  if (enableInspection.value) {
    steps.push({ title: 'AI 巡检', description: '部署完成后执行一次只读巡检,留存报告', tag: '巡检', tone: 'success' });
  }
  flowSteps.value = steps;
  generating.value = false;
}

async function createFlowJobs() {
  if (!targetProject.value || !flowSteps.value.length) return;
  creating.value = true;
  error.value = '';
  const name = targetProject.value.projectName;
  const expectedCount = enableInspection.value ? 3 : 2;
  const created = [];
  try {
    // 顺序创建不是原子操作；若中途失败，必须提醒已成功创建的部分，防止用户直接重试造成重复任务。
    created.push(await api.createCronJob({ name: `${name} 数据卷备份`, cron: scheduleCron.value, type: 'volume-backup', enabled: true }));
    created.push(await api.createCronJob({ name: `${name} 拉取镜像`, cron: scheduleCron.value, type: 'pull-images', enabled: true }));
    if (enableInspection.value) {
      created.push(await api.createCronJob({ name: `${name} AI 巡检`, cron: scheduleCron.value, type: 'inspection', enabled: true }));
    }
    await load();
    flowSteps.value = [];
  } catch (e) {
    if (created.length) {
      flowSteps.value = [];
      await load();
      error.value = `任务仅部分创建：已创建 ${created.length}/${expectedCount} 项，后续创建失败（${e.message}）。请先核对现有定时任务，再手动补齐未创建项；不要直接重试整组计划，以免重复创建。`;
    } else {
      error.value = `创建任务失败：${e.message}`;
    }
  } finally {
    creating.value = false;
  }
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  loadErrors.value = { jobs: '', inspection: '' };
  try {
    const [jobData, inspectionData, taskData] = await Promise.allSettled([
      api.listCronJobs(),
      api.getInspectionOverview(1),
      api.getAgentTasks(50),
    ]);
    if (jobData.status === 'fulfilled') jobs.value = jobData.value.jobs || [];
    else loadErrors.value.jobs = `定时任务加载失败：${jobData.reason?.message || '未知错误'}`;
    if (taskData.status === 'fulfilled') { agentTasks.value = taskData.value.tasks || []; agentTaskError.value = ''; }
    else agentTaskError.value = '后台任务加载失败：' + (taskData.reason?.message || '未知错误');

    if (inspectionData.status === 'fulfilled') {
      latestInspection.value = inspectionData.value.latest || null;
      const schedule = inspectionData.value.schedule;
      if (schedule) {
        inspectionEnabled.value = !!schedule.enabled;
        inspectionInterval.value = schedule.intervalHours || 24;
      }
    } else {
      loadErrors.value.inspection = `AI 巡检状态加载失败：${inspectionData.reason?.message || '未知错误'}`;
    }
  } catch (e) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

usePullRefresh(load);
onMounted(async () => {
  await store.refresh(false);
  await load();
  taskPollTimer = setInterval(() => { void loadAgentTasks(); }, 10000);
});
onBeforeUnmount(() => { if (taskPollTimer) clearInterval(taskPollTimer); });
</script>
