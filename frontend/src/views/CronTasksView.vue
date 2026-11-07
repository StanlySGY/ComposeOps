<template>
  <div class="page-shell cron-workspace">
    <div class="page-header">
      <div><h1 class="page-title">定时任务</h1><p class="page-subtitle">可视化 Cron 调度:自动备份、Docker 清理与镜像检查</p></div>
      <div class="page-actions">
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
        <button class="btn-primary" @click="openCreate()"><Clock3 class="w-4 h-4" />新建定时任务</button>
      </div>
    </div>
    <p v-if="error" class="alert-error" role="alert">{{ error }} <button class="underline" @click="load">重试加载</button></p>
    <p v-if="message" class="alert-success" role="status" aria-live="polite" aria-atomic="true">{{ message }}</p>

    <div v-if="loading && !jobs.length" class="mt-2 space-y-2" aria-busy="true">
      <div v-for="i in 3" :key="i" class="card p-3 flex items-center gap-3">
        <div class="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-surface-800"></div>
        <div class="min-w-0 flex-1 space-y-2">
          <div class="h-3.5 w-1/3 animate-pulse rounded-sm bg-surface-800"></div>
          <div class="h-3 w-1/2 animate-pulse rounded-sm bg-surface-800/70"></div>
        </div>
        <div class="h-8 w-20 shrink-0 animate-pulse rounded-sm bg-surface-800"></div>
      </div>
    </div>

    <div v-if="!jobs.length && !loading && !error" class="cron-empty">
      <div class="cron-intro"><span class="cron-intro-icon"><Clock3 class="h-7 w-7" /></span><div class="space-y-1.5">
        <h2 class="text-base font-semibold tracking-tight text-surface-100">还没有定时任务</h2>
        <p class="text-muted">从常用计划开始，确认执行范围与时间后再创建。</p></div>
      </div>
      <div class="grid w-full gap-3 lg:grid-cols-3">
        <button v-for="preset in presets" :key="preset.name" class="cron-preset-card" @click="openCreate(preset)">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-surface-700 bg-surface-950/60"><component :is="preset.icon" class="h-4 w-4 text-status-info" /></span>
          <span class="min-w-0 flex-1 text-left">
            <strong class="block text-sm font-medium text-surface-200">{{ preset.name }}</strong>
            <small class="mt-1 block text-muted">{{ preset.description }}</small>
          </span>
          <Plus class="h-4 w-4 shrink-0 text-surface-400" />
        </button>
      </div>
    </div>

    <div v-if="jobs.length" class="flex-1 space-y-2">
      <article v-for="job in jobs" :key="job.id" class="card p-3 flex flex-col sm:flex-row sm:items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <strong class="text-sm text-surface-100">{{ job.name }}</strong>
            <span class="count-badge">{{ job.typeLabel }}</span>
            <span class="count-badge font-mono text-xs">{{ job.cron }}</span>
            <span v-if="job.enabled" class="count-badge text-status-ok">启用</span>
            <span v-else class="count-badge text-surface-400">停用</span>
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted">
            <span>下次执行:{{ job.nextRunAt ? new Date(job.nextRunAt).toLocaleString('zh-CN') : '—' }}</span>
            <template v-if="job.lastRunAt">
              <span :class="job.lastStatus === 'success' ? 'text-status-ok' : 'text-status-error'">最近:{{ job.lastStatus === 'success' ? '成功' : '失败' }}</span>
              <span>于 {{ new Date(job.lastRunAt).toLocaleString('zh-CN') }}</span>
              <span v-if="job.lastError" class="text-status-error truncate max-w-[320px]" :title="job.lastError">{{ job.lastError }}</span>
            </template>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <button class="btn-secondary" :disabled="!!runningId || pendingJobs.has(job.id)" @click="runNow(job)"><Play class="w-4 h-4" :class="{ 'animate-pulse': runningId === job.id }" />立即执行</button>
          <label class="toggle-label" :title="job.enabled ? '点击停用' : '点击启用'"><input type="checkbox" :checked="job.enabled" :disabled="pendingJobs.has(job.id) || runningId === job.id" :aria-label="job.enabled ? `停用定时任务 ${job.name}` : `启用定时任务 ${job.name}`" @change="toggleEnabled(job)" /></label>
          <button class="icon-btn" :disabled="pendingJobs.has(job.id) || runningId === job.id" title="删除任务" :aria-label="`删除定时任务 ${job.name}`" @click="removeJob(job)"><Trash2 class="w-4 h-4 text-status-error" /></button>
        </div>
      </article>

    </div>
      <div v-if="jobs.length || history.length || route.query.job" class="cron-history border-t border-surface-800 pt-5 mt-5">
        <p v-if="route.query.job" class="mb-3 flex flex-wrap items-center gap-3 text-sm text-surface-300">仅显示：{{ jobs.find(job => job.id === route.query.job)?.name || route.query.job }}<button class="btn-ghost" @click="clearHistoryFilter">查看全部历史</button></p>
        <div class="flex items-center justify-between"><h2 class="section-title">执行历史</h2><span class="text-muted text-xs">最多保留 200 条</span></div>
        <HistoryControls v-model:page="page" v-model:sort-key="sortKey" v-model:descending="descending" :total="total" :page-size="pageSize" :options="sortOptions" label="定时执行历史" />
        <div v-if="filteredHistory.length" class="table-wrap"><table class="data-table"><thead><tr>
          <th v-for="option in sortOptions" :key="option.key" :aria-sort="ariaSort(option.key)"><button class="inline-flex items-center gap-1 py-1" @click="sortBy(option.key)">{{ option.label }}<span v-if="sortKey === option.key" aria-hidden="true">{{ descending ? '↓' : '↑' }}</span></button></th><th>说明</th>
        </tr></thead><tbody><tr v-for="item in pagedRows" :key="item.id">
          <td class="whitespace-nowrap">{{ new Date(item.at).toLocaleString('zh-CN') }}</td><td>{{ item.jobName }}</td><td><StatusBadge :status="item.status" /></td><td>{{ item.durationMs }} ms</td><td class="max-w-72"><details v-if="item.error"><summary class="cursor-pointer text-status-error">查看错误</summary><p class="whitespace-pre-wrap text-xs">{{ item.error }}</p></details><span v-else class="text-muted">—</span></td>
        </tr></tbody></table></div>
        <EmptyState v-else compact icon="History" title="暂无执行记录" description="选择上方任务并点击「立即执行」，即可查看执行结果。" action-label="刷新记录" @action="load" />
      </div>

    <BaseModal :show="!!editor" :close-disabled="saving" title="新建定时任务" size-class="max-w-[calc(100vw-2rem)] sm:max-w-lg flex max-h-[88vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-3" @close="closeEditor">
      <template #header-actions>
        <button class="btn-secondary btn-sm" title="让 Agent 根据当前表单创建任务" @click="openCronAgent" :disabled="saving"><Bot class="h-3.5 w-3.5" />让 Agent 创建</button>
      </template>
      <fieldset v-if="editor" :disabled="saving" class="cron-editor">
        <p v-if="editorError" class="alert-error" role="alert">{{ editorError }}</p>
        <div class="cron-field"><label for="cron-name">任务名称</label><input id="cron-name" v-model="editor.name" class="input" placeholder="例如：每日数据库备份" maxlength="60" /></div>
        <div class="cron-field"><label for="cron-type">任务类型</label><select id="cron-type" v-model="editor.type" class="input"><option v-for="(info, key) in types" :key="key" :value="key">{{ info.label }}</option></select></div>
        <p class="cron-type-note">{{ types[editor.type]?.description || '任务类型尚未加载，请返回后刷新重试。' }}</p>
        <div class="cron-field"><label for="cron-schedule">执行周期</label><select id="cron-schedule" :value="manualCron ? 'custom' : editor.cron" class="input" @change="onCronTemplateChange"><option v-for="preset in scheduleOptions" :key="preset.value" :value="preset.value">{{ preset.label }}</option><option value="custom">自定义表达式…</option></select></div>
        <div v-if="manualCron" class="cron-field"><label for="cron-expression">Cron 表达式</label><input id="cron-expression" v-model="editor.cron" class="input font-mono" placeholder="分 时 日 月 周，如 0 3 * * *" aria-describedby="cron-expression-help" /><span id="cron-expression-help" class="text-xs text-muted">支持 *、范围、列表和步长；日期与星期条件需同时满足。</span></div>
        <section class="cron-preview" aria-label="执行时间预览" :aria-busy="previewLoading">
          <div class="flex items-center gap-2 text-sm font-medium"><Clock3 class="h-4 w-4 text-emerald-300" />接下来三次执行</div>
          <p v-if="previewLoading" class="text-xs text-muted" role="status">正在计算执行时间…</p>
          <p v-else-if="previewError" class="text-xs text-status-error" role="status">{{ previewError }}<button v-if="editor.cron" class="ml-2 underline" @click="refreshPreview">重试</button></p>
          <template v-else-if="schedulePreview">
            <p class="text-xs text-muted">按服务器时区 {{ schedulePreview.timezone }} 执行，以下也按该时区显示。</p>
            <ol><li v-for="(time, index) in schedulePreview.nextRuns" :key="time"><span>{{ index + 1 }}</span><time :datetime="time">{{ formatScheduleTime(time) }}</time></li></ol>
          </template>
        </section>
        <label class="flex items-center gap-2 text-sm"><input v-model="editor.enabled" type="checkbox" />创建后启用计划</label>
        <p v-if="!editor.enabled" class="text-xs text-muted">先保存为停用状态，启用后才会按周期执行。</p>
      </fieldset>
      <template #footer>
        <button class="btn-secondary" :disabled="saving" @click="closeEditor()">取消</button>
        <button class="btn-primary" :disabled="saving || previewLoading || !schedulePreview || !types[editor?.type]" @click="saveEditor"><Save class="w-4 h-4" />创建任务</button>
      </template>
    </BaseModal>
    <ConfirmDialog
      :show="!!removeTarget"
      title="删除定时任务"
      :message="`确认删除定时任务「${removeTarget?.name || ''}」?删除后不会再按计划执行。`"
      tone="danger"
      confirm-text="删除任务"
      @confirm="confirmRemove"
      @cancel="removeTarget = null"
    />
  </div>
</template>

<script setup>
import EmptyState from '../components/common/EmptyState.vue';
import StatusBadge from '../components/common/StatusBadge.vue';
import { usePagedRows } from '../composables/usePagedRows.js';
import HistoryControls from '../components/common/HistoryControls.vue';
import { useRoute, useRouter } from 'vue-router';
const route = useRoute();
const router = useRouter();
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { Clock3, DatabaseBackup, Bot, Play, Plus, RefreshCw, Save, Sparkles, Trash2 } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { useToastStore } from '../stores/toast.js';
import { useAgentConsole } from '../composables/useAgentConsole.js';
import BaseModal from '../components/common/BaseModal.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';

const toast = useToastStore();
const { openAgent, updateAgentContext, resetAgentContext } = useAgentConsole();
const jobs = ref([]);
const types = ref({});
const history = ref([]);
const loading = ref(false);
const runningId = ref('');
const pendingJobs = ref(new Set());
let loadId = 0;
let disposed = false;
const error = ref('');
const message = ref('');
const editor = ref(null);
const editorError = ref('');
const saving = ref(false);
const manualCron = ref(false);
const removeTarget = ref(null);

const presets = [
  { name: '每天 03:00 自动备份数据库', description: '对所有数据库容器执行 Dump 并留存本地', icon: DatabaseBackup, type: 'db-backup', cron: '0 3 * * *' },
  { name: '每周日 04:00 清理 Docker 悬空镜像', description: '安全清理悬空镜像、退出容器与未使用缓存', icon: Sparkles, type: 'prune-safe', cron: '0 4 * * 0' },
  { name: '每天 02:00 检查镜像更新', description: '全局检测纳管项目镜像是否有远程更新', icon: RefreshCw, type: 'images-check', cron: '0 2 * * *' },
];

const scheduleOptions = [
  { value: '0 3 * * *', label: '每天 03:00' },
  { value: '0 2 * * *', label: '每天 02:00' },
  { value: '0 4 * * 0', label: '每周日 04:00' },
  { value: '0 0 * * 0', label: '每周日 00:00' },
  { value: '0 * * * *', label: '每小时整点' },
  { value: '*/5 * * * *', label: '每 5 分钟' },
];
function onCronTemplateChange(event) {
  if (!editor.value) return;
  manualCron.value = event.target.value === 'custom';
  if (!manualCron.value) editor.value.cron = event.target.value;
}
const schedulePreview = ref(null);
const previewLoading = ref(false);
const previewError = ref('');
let previewTimer;
let previewId = 0;
function stopPreview() { clearTimeout(previewTimer); previewId++; previewLoading.value = false; }
async function refreshPreview() {
  clearTimeout(previewTimer);
  const cron = editor.value?.cron?.trim();
  if (!cron) return;
  const id = ++previewId;
  previewLoading.value = true;
  schedulePreview.value = null;
  previewError.value = '';
  try {
    const result = await api.previewCronSchedule(cron);
    if (id === previewId && !disposed) schedulePreview.value = result;
  } catch (error) {
    if (id === previewId && !disposed) previewError.value = error.message;
  } finally { if (id === previewId) previewLoading.value = false; }
}
watch(() => editor.value?.cron, (cron) => {
  stopPreview();
  schedulePreview.value = null;
  previewError.value = '';
  if (!editor.value) return;
  if (!cron?.trim()) { previewError.value = '请填写五段 Cron 表达式'; return; }
  previewLoading.value = true;
  previewTimer = setTimeout(refreshPreview, 250);
});
function formatScheduleTime(time) {
  return new Date(time).toLocaleString('zh-CN', { timeZone: schedulePreview.value.timezone, month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
const filteredHistory = computed(() => history.value.filter(item => !route.query.job || item.jobId === route.query.job));
function clearHistoryFilter() { const query = { ...route.query }; delete query.job; void router.replace({ query }); }

async function load() {
  if (disposed) return;
  const id = ++loadId;
  loading.value = true;
  error.value = '';
  try {
    const [data, historyData] = await Promise.all([api.listCronJobs(), api.getCronHistory(200)]);
    if (id !== loadId || disposed) return;
    jobs.value = data.jobs || [];
    types.value = data.types || {};
    history.value = historyData.history || [];
  } catch (e) {
    if (id === loadId && !disposed) error.value = e.message;
  } finally {
    if (id === loadId) loading.value = false;
  }
}
function openCreate(preset) {
  manualCron.value = false;
  editor.value = preset
    ? { name: preset.name, type: preset.type, cron: preset.cron, enabled: true }
    : { name: '', type: 'db-backup', cron: '0 3 * * *', enabled: true };
  editorError.value = '';
}
function openCronAgent() {
  updateAgentContext({ page: '定时任务', mode: 'cron-editor', summary: '正在新建定时任务，Agent 可读取当前表单并调用 cron.create 创建任务', state: JSON.stringify(editor.value || {}) });
  openAgent();
}
function handleAgentCreated(event) {
  const created = event.detail || {};
  toast.success(`Agent 已创建定时任务${created.name ? `「${created.name}」` : ''}`);
  resetAgentContext();
  editor.value = null;
  void load();
}
function closeEditor(force = false) { if (!saving.value || force) { resetAgentContext(); editor.value = null; editorError.value = ''; } }
async function saveEditor() {
  if (!editor.value || saving.value || !schedulePreview.value || previewLoading.value) return;
  saving.value = true;
  editorError.value = '';
  try {
    if (editor.value.cron === 'custom') editor.value.cron = '';
    if (!editor.value.name.trim()) throw new Error('请填写任务名称');
    if (!editor.value.cron.trim()) throw new Error('请填写 Cron 表达式(5 段)');
    await api.createCronJob({ ...editor.value });
    toast.success('定时任务已创建');
    closeEditor(true);
    await load();
  } catch (e) {
    editorError.value = e.message;
  } finally {
    saving.value = false;
  }
}
async function runNow(job) {
  if (runningId.value || pendingJobs.value.has(job.id)) return;
  runningId.value = job.id;
  try {
    const result = await api.runCronJob(job.id);
    toast.success(result.summary || '执行成功');
    await load();
  } catch (e) {
    toast.error(e);
  } finally {
    runningId.value = '';
  }
}
async function toggleEnabled(job) {
  if (pendingJobs.value.has(job.id) || runningId.value === job.id) return;
  pendingJobs.value.add(job.id);
  try {
    await api.updateCronJob(job.id, { enabled: !job.enabled });
    await load();
  } catch (e) {
    toast.error(e);
  } finally { pendingJobs.value.delete(job.id); }
}
async function removeJob(job) {
  removeTarget.value = job;
}
async function confirmRemove() {
  const job = removeTarget.value;
  removeTarget.value = null;
  if (!job) return;
  try {
    await api.deleteCronJob(job.id);
    toast.success('任务已删除');
    await load();
  } catch (e) {
    toast.error(e);
  }
}
watch(editor, (value) => {
  if (value) updateAgentContext({ state: JSON.stringify(value) });
}, { deep: true });
usePullRefresh(load);
onMounted(() => {
  load();
  window.addEventListener('composeops:cron-agent-created', handleAgentCreated);
  window.addEventListener('composeops:host-changed', handleHostChanged);
});
function handleHostChanged() { void load(); }
onBeforeUnmount(() => { disposed = true; loadId++; stopPreview(); window.removeEventListener('composeops:cron-agent-created', handleAgentCreated); window.removeEventListener('composeops:host-changed', handleHostChanged); });

const { rows: pagedRows, page, pageSize, total, sortKey, descending, sortBy, ariaSort } = usePagedRows(filteredHistory, { at: item => Date.parse(item.at) || 0, jobName: item => item.jobName, status: item => item.status, durationMs: item => Number(item.durationMs) || 0 }, 'at');
const sortOptions = [{ key: 'at', label: '执行时间' }, { key: 'jobName', label: '任务名称' }, { key: 'status', label: '状态' }, { key: 'durationMs', label: '耗时' }];
</script>

<style scoped>
@reference '../style.css';
.cron-empty { @apply mt-5 space-y-6 rounded-xl border border-surface-800 bg-surface-900/40 p-5 sm:p-6; }
.cron-intro { @apply flex items-center gap-4; }
.cron-intro-icon { @apply grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300; }
.cron-editor { @apply min-w-0 space-y-4 border-0 p-0; }
.cron-field { @apply grid gap-2 text-sm text-surface-300; }
.cron-editor .input { @apply w-full; min-height: 44px; }
.cron-type-note { @apply rounded-lg bg-surface-950/50 px-3 py-2 text-xs leading-6 text-surface-400; }
.cron-preview { @apply space-y-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4; }
.cron-preview ol { @apply space-y-2; }
.cron-preview li { @apply flex items-center gap-3 text-sm text-surface-200; }
.cron-preview li > span { @apply grid h-5 w-5 place-items-center rounded-full bg-emerald-400/10 text-xs text-emerald-300; }
.cron-preview time { @apply tabular-nums; }
</style>
