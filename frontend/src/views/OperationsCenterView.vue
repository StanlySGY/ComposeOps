<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">运维任务中心</h1>
        <p class="page-subtitle">把备份、镜像更新与 AI 巡检组合成可复用的定时运维计划</p>
      </div>
      <div class="page-actions">
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>

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
              <label class="toggle-label"><input v-model="enableInspection" type="checkbox" /></label>
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
              <button class="btn-primary flex-1" :disabled="creating" @click="createFlowJobs"><Rocket class="w-4 h-4" :class="{ 'animate-pulse': creating }" />{{ creating ? '创建中...' : '创建定时任务' }}</button>
              <button class="btn-secondary" @click="flowSteps = []">清空</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 现有定时任务 -->
    <section class="section-panel">
      <div class="mb-4 flex items-center justify-between">
        <div><h2 class="section-title">现有定时任务</h2><p class="mt-1 text-muted">当前已配置的自动运维任务</p></div>
        <router-link to="/cron" class="text-xs text-emerald-400 hover:text-emerald-300">管理全部 →</router-link>
      </div>
      <div v-if="!jobs.length" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4 text-sm text-surface-400">暂无定时任务。可通过上方任务流生成,或到定时任务页手动创建。</div>
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
      <div v-if="latestInspection" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
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
      <div v-else class="rounded-xl border border-surface-800 bg-surface-950/40 p-4 text-sm text-surface-400">暂无巡检报告。前往 <router-link to="/inspection" class="text-accent hover:underline">AI 巡检页</router-link> 生成第一份报告。</div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Bot, RefreshCw, Rocket, Sparkles } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { useServicesStore } from '../stores/services.js';

const store = useServicesStore();
const loading = ref(false);
const generating = ref(false);
const creating = ref(false);
const error = ref('');
const targetProjectId = ref('');
const scheduleCron = ref('0 3 * * *');
const enableInspection = ref(true);
const flowSteps = ref([]);
const jobs = ref([]);
const inspectionEnabled = ref(false);
const inspectionInterval = ref(24);
const latestInspection = ref(null);

const targetProject = computed(() => store.projects.find((p) => p.id === targetProjectId.value));

function jobTypeLabel(type) {
  return { 'db-backup': '数据库备份', 'prune-safe': '安全清理', 'prune-all': '深度清理', 'images-check': '镜像检查', 'pull-images': '拉取镜像', 'volume-backup': '数据卷备份', inspection: 'AI 巡检' }[type] || type;
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
  const created = [];
  try {
    // 数据卷备份
    created.push(await api.createCronJob({ name: `${name} 数据卷备份`, cron: scheduleCron.value, type: 'volume-backup', enabled: true }));
    // 拉取镜像
    created.push(await api.createCronJob({ name: `${name} 拉取镜像`, cron: scheduleCron.value, type: 'pull-images', enabled: true }));
    // AI 巡检
    if (enableInspection.value) {
      created.push(await api.createCronJob({ name: `${name} AI 巡检`, cron: scheduleCron.value, type: 'inspection', enabled: true }));
    }
    await load();
    flowSteps.value = [];
  } catch (e) {
    error.value = `创建任务失败: ${e.message}`;
  } finally {
    creating.value = false;
  }
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const [jobData, inspectionData] = await Promise.allSettled([
      api.listCronJobs(),
      api.getInspectionOverview(1),
    ]);
    jobs.value = jobData.status === 'fulfilled' ? (jobData.value.jobs || []) : [];
    latestInspection.value = inspectionData.status === 'fulfilled' ? (inspectionData.value.latest || null) : null;
    const schedule = inspectionData.status === 'fulfilled' ? inspectionData.value.schedule : null;
    if (schedule) {
      inspectionEnabled.value = !!schedule.enabled;
      inspectionInterval.value = schedule.intervalHours || 24;
    }
  } catch (e) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await store.refresh(false);
  await load();
});
</script>
