<template>
  <div class="page-shell cron-workspace">
    <div class="page-header">
      <div><h1 class="page-title">定时任务</h1><p class="page-subtitle">安排例行维护，确认执行时间，随时回看每次结果。</p></div>
      <div class="page-actions">
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
        <button class="btn-primary" @click="openCreate()"><Clock3 class="w-4 h-4" />新建定时任务</button>
      </div>
    </div>
    <p v-if="error" class="alert-error" role="alert">{{ error }}<span v-if="jobs.length">。任务清单保留了上次确认的数据。</span> <button class="underline" :disabled="jobsLoading" @click="loadJobs">重试加载</button></p>
    <p v-if="message" ref="feedbackEl" class="alert-success cron-feedback" role="status" tabindex="-1" aria-live="polite" aria-atomic="true"><CircleCheck class="h-4 w-4 shrink-0" /><span>{{ message }}</span><button class="icon-btn ml-auto" aria-label="关闭任务反馈" @click="message = ''"><X class="h-3.5 w-3.5" /></button></p>
    <p v-if="actionError" class="alert-error" role="alert">{{ actionError }}</p>

    <section v-if="jobs.length" class="cron-overview" aria-label="调度概览">
      <div class="min-w-0"><p class="cron-eyebrow"><Clock3 class="h-3.5 w-3.5" />下一个计划</p><h2>{{ nextJob?.name || (enabledCount ? '暂无后续执行时间' : '所有计划已停用') }}</h2><p class="text-muted">{{ nextJob ? formatTimestamp(nextJob.nextRunAt) : enabledCount ? '请检查已启用任务的周期设置。' : '启用任务后，会从新的计划时间开始执行。' }}</p></div>
      <SceneIllustration class="cron-scene" kind="schedule" :min-width="640" sizes="130px" eager />
      <dl class="cron-summary"><div><dt>已启用</dt><dd>{{ enabledCount }}<span> / {{ jobs.length }}</span></dd></div><div><dt>最近失败</dt><dd :class="{ 'text-status-error': failedCount }">{{ failedCount }}</dd></div></dl>
    </section>

    <div v-if="jobsLoading && !jobs.length" class="mt-2 space-y-2" aria-busy="true">
      <div v-for="i in 3" :key="i" class="card p-3 flex items-center gap-3">
        <div class="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-surface-800"></div>
        <div class="min-w-0 flex-1 space-y-2">
          <div class="h-3.5 w-1/3 animate-pulse rounded-sm bg-surface-800"></div>
          <div class="h-3 w-1/2 animate-pulse rounded-sm bg-surface-800/70"></div>
        </div>
        <div class="h-8 w-20 shrink-0 animate-pulse rounded-sm bg-surface-800"></div>
      </div>
    </div>

    <div v-if="!jobs.length && !jobsLoading && !error" class="cron-empty">
      <div class="cron-intro"><span class="cron-intro-icon"><Clock3 class="h-7 w-7" /></span><div class="space-y-1.5 min-w-0 flex-1">
        <h2 class="text-base font-semibold tracking-tight text-surface-100">还没有定时任务</h2>
        <p class="text-muted">从常用计划开始，确认执行范围与时间后再创建。</p></div>
        <SceneIllustration class="cron-scene" kind="schedule" :min-width="640" sizes="130px" eager />
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

    <div v-if="jobs.length" class="cron-jobs space-y-3">
      <article v-for="job in jobs" :key="job.id" class="cron-job" :class="{ 'is-paused': !job.enabled, 'is-running': runningId === job.id }" :data-job-id="job.id" :aria-labelledby="`cron-title-${job.id}`" :aria-busy="runningId === job.id || pendingJobs.has(job.id)">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 :id="`cron-title-${job.id}`" class="cron-job-title">{{ job.name }}</h3>
            <span class="count-badge">{{ job.typeLabel }}</span>
            <span class="count-badge font-mono text-xs">{{ job.cron }}</span>
            <span class="cron-enabled" :class="{ 'is-enabled': job.enabled }"><span></span>{{ job.enabled ? '启用' : '停用' }}</span>
          </div>
          <div class="cron-timing">
            <span><Clock3 class="h-3.5 w-3.5" />下次执行：{{ job.enabled ? formatTimestamp(job.nextRunAt) : '已停用' }}</span>
            <template v-if="job.lastRunAt">
              <span :class="job.lastStatus === 'success' ? 'text-status-ok' : 'text-status-error'">最近:{{ job.lastStatus === 'success' ? '成功' : '失败' }}</span>
              <span>{{ formatTimestamp(job.lastRunAt) }}</span>
            </template>
          </div>
          <details v-if="job.lastError" class="cron-last-error"><summary>查看最近失败原因<ChevronDown class="h-3 w-3" /></summary><p>{{ job.lastError }}</p></details>
          <p v-if="runningId === job.id" class="cron-running" role="status"><Loader2 class="h-3.5 w-3.5 animate-spin" />正在执行，结果将记录在下方历史中。</p>
        </div>
        <div class="cron-job-actions">
          <button class="btn-ghost" :disabled="pendingJobs.has(job.id) || runningId === job.id" :aria-label="`编辑定时任务 ${job.name}`" @click="openEdit(job)"><Pencil class="h-3.5 w-3.5" />编辑</button>
          <button class="btn-secondary" :disabled="!!runningId || pendingJobs.has(job.id)" @click="runNow(job)"><Loader2 v-if="runningId === job.id" class="w-4 h-4 animate-spin" /><Play v-else class="w-4 h-4" />{{ runningId === job.id ? '执行中' : '立即执行' }}</button>
          <label class="toggle-label" :title="job.enabled ? '点击停用' : '点击启用'"><input type="checkbox" :checked="job.enabled" :disabled="pendingJobs.has(job.id) || runningId === job.id" :aria-label="job.enabled ? `停用定时任务 ${job.name}` : `启用定时任务 ${job.name}`" @change="toggleEnabled(job, $event)" /></label>
          <button class="icon-btn" :disabled="pendingJobs.has(job.id) || runningId === job.id" title="删除任务" :aria-label="`删除定时任务 ${job.name}`" @click="removeJob(job)"><Trash2 class="w-4 h-4 text-status-error" /></button>
        </div>
      </article>

    </div>
      <section v-if="jobs.length || history.length || route.query.job || historyError || historyLoading" class="cron-history section-panel" aria-label="执行历史" :aria-busy="historyLoading">
        <p v-if="route.query.job" class="mb-3 flex flex-wrap items-center gap-3 text-sm text-surface-300">仅显示：{{ jobs.find(job => job.id === route.query.job)?.name || route.query.job }}<button class="btn-ghost" @click="clearHistoryFilter">查看全部历史</button></p>
        <div class="flex items-center justify-between"><h2 class="section-title">执行历史</h2><span class="text-muted text-xs">最多保留 200 条</span></div>
        <p v-if="historyError" class="alert-error mt-3" role="alert">{{ historyError }}<span v-if="history.length">。保留上次已读取的历史。</span> <button class="underline" :disabled="historyLoading" @click="loadHistory">重试历史</button></p>
        <p v-if="historyLoading" class="mt-3 text-muted" role="status">正在更新执行历史…</p>
        <HistoryControls v-model:page="page" v-model:sort-key="sortKey" v-model:descending="descending" :total="total" :page-size="pageSize" :options="sortOptions" label="定时执行历史" />
        <div v-if="filteredHistory.length" class="table-wrap"><table class="data-table"><thead><tr>
          <th v-for="option in sortOptions" :key="option.key" :aria-sort="ariaSort(option.key)"><button class="inline-flex items-center gap-1 py-1" @click="sortBy(option.key)">{{ option.label }}<span v-if="sortKey === option.key" aria-hidden="true">{{ descending ? '↓' : '↑' }}</span></button></th><th>说明</th>
        </tr></thead><tbody><tr v-for="item in pagedRows" :key="item.id">
          <td data-label="执行时间" class="whitespace-nowrap">{{ formatTimestamp(item.at) }}</td><td data-label="任务名称">{{ item.jobName }}</td><td data-label="状态"><StatusBadge :status="item.status" /></td><td data-label="耗时">{{ item.durationMs ?? '—' }} ms</td><td data-label="说明" class="cron-history-detail"><details v-if="item.error"><summary class="cursor-pointer text-status-error">查看错误</summary><p class="whitespace-pre-wrap text-xs">{{ item.error }}</p></details><span v-else class="text-muted">—</span></td>
        </tr></tbody></table></div>
        <EmptyState v-else-if="!historyLoading && !historyError" compact icon="History" title="暂无执行记录" description="任务按计划或手动执行后，结果会出现在这里。" action-label="刷新记录" @action="loadHistory" />
      </section>

    <BaseModal :show="!!editor" :close-disabled="saving" :title="editingId ? '编辑定时任务' : '新建定时任务'" size-class="max-w-[calc(100vw-2rem)] sm:max-w-lg flex max-h-[88vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-3" @close="closeEditor">
      <template #header-actions>
        <button v-if="!editingId" class="btn-secondary btn-sm" title="让 Agent 根据当前表单创建任务" @click="openCronAgent" :disabled="saving"><Bot class="h-3.5 w-3.5" />让 Agent 创建</button>
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
        <label class="flex items-center gap-2 text-sm"><input v-model="editor.enabled" type="checkbox" />{{ editingId ? '启用计划' : '创建后启用计划' }}</label>
        <p v-if="!editor.enabled" class="text-xs text-muted">先保存为停用状态，启用后才会按周期执行。</p>
      </fieldset>
      <template #footer>
        <button class="btn-secondary" :disabled="saving" @click="closeEditor()">取消</button>
        <button class="btn-primary" :disabled="saving || previewLoading || !schedulePreview || !types[editor?.type]" @click="saveEditor"><Loader2 v-if="saving" class="w-4 h-4 animate-spin" /><Save v-else class="w-4 h-4" />{{ editingId ? '保存修改' : '创建任务' }}</button>
      </template>
    </BaseModal>
    <ConfirmDialog
      :show="!!removeTarget"
      title="删除定时任务"
      :message="`确认删除定时任务「${removeTarget?.name || ''}」?删除后不会再按计划执行。`"
      tone="danger"
      confirm-text="删除任务"
      :busy="removing"
      @confirm="confirmRemove"
      @cancel="removeTarget = null"
    ><p v-if="removeError" class="alert-error" role="alert">{{ removeError }}</p></ConfirmDialog>
  </div>
</template>

<script setup>
import EmptyState from '../components/common/EmptyState.vue';
import SceneIllustration from '../components/common/SceneIllustration.vue';
import StatusBadge from '../components/common/StatusBadge.vue';
import { formatTimestamp, parseTimestamp } from '../lib/date-time.js';
import { usePagedRows } from '../composables/usePagedRows.js';
import HistoryControls from '../components/common/HistoryControls.vue';
import { useRoute, useRouter } from 'vue-router';
const route = useRoute();
const router = useRouter();
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { ChevronDown, CircleCheck, Clock3, DatabaseBackup, Bot, Loader2, Pencil, Play, Plus, RefreshCw, Save, Sparkles, Trash2, X } from 'lucide-vue-next';
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
const jobsLoading = ref(false);
const historyLoading = ref(false);
const loading = computed(() => jobsLoading.value || historyLoading.value);
const runningId = ref('');
const pendingJobs = ref(new Set());
let loadId = 0;
let historyId = 0;
let disposed = false;
const error = ref('');
const historyError = ref('');
const actionError = ref('');
const message = ref('');
const feedbackEl = ref(null);
const editor = ref(null);
const editingId = ref('');
const editorError = ref('');
const saving = ref(false);
const manualCron = ref(false);
const removeTarget = ref(null);
const removing = ref(false);
const removeError = ref('');
const enabledCount = computed(() => jobs.value.filter(job => job.enabled).length);
const failedCount = computed(() => jobs.value.filter(job => job.lastStatus === 'failed').length);
const nextJob = computed(() => jobs.value.filter(job => job.enabled && parseTimestamp(job.nextRunAt))
  .sort((a, b) => parseTimestamp(a.nextRunAt) - parseTimestamp(b.nextRunAt))[0]);

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

async function loadJobs() {
  if (disposed) return;
  const id = ++loadId;
  jobsLoading.value = true;
  error.value = '';
  try {
    const data = await api.listCronJobs(true);
    if (id !== loadId || disposed) return;
    jobs.value = data.jobs || [];
    types.value = data.types || {};
  } catch (e) {
    if (id === loadId && !disposed) error.value = e.message;
  } finally {
    if (id === loadId) jobsLoading.value = false;
  }
}
async function loadHistory() {
  if (disposed) return;
  const id = ++historyId;
  historyLoading.value = true;
  historyError.value = '';
  try {
    const data = await api.getCronHistory(200);
    if (id === historyId && !disposed) history.value = data.history || [];
  } catch (e) {
    if (id === historyId && !disposed) historyError.value = e.message;
  } finally { if (id === historyId) historyLoading.value = false; }
}
async function load() { await Promise.all([loadJobs(), loadHistory()]); }
function applyConfirmedJob(job) {
  if (disposed || !job?.id) return;
  const index = jobs.value.findIndex(item => item.id === job.id);
  if (index < 0) jobs.value.push(job);
  else jobs.value[index] = { ...jobs.value[index], ...job };
}
function openCreate(preset) {
  editingId.value = '';
  manualCron.value = false;
  editor.value = preset
    ? { name: preset.name, type: preset.type, cron: preset.cron, enabled: true }
    : { name: '', type: 'db-backup', cron: '0 3 * * *', enabled: true };
  editorError.value = '';
}
function openEdit(job) {
  if (pendingJobs.value.has(job.id) || runningId.value === job.id) return;
  resetAgentContext();
  editingId.value = job.id;
  editor.value = { name: job.name, type: job.type, cron: job.cron, enabled: job.enabled };
  manualCron.value = !scheduleOptions.some(option => option.value === job.cron);
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
  if (!editingId.value) closeEditor(true);
  void load();
}
function closeEditor(force = false) { if (!saving.value || force) { resetAgentContext(); editor.value = null; editingId.value = ''; editorError.value = ''; stopPreview(); } }
async function saveEditor() {
  if (!editor.value || saving.value || !schedulePreview.value || previewLoading.value) return;
  saving.value = true;
  editorError.value = '';
  try {
    if (editor.value.cron === 'custom') editor.value.cron = '';
    if (!editor.value.name.trim()) throw new Error('请填写任务名称');
    if (!editor.value.cron.trim()) throw new Error('请填写 Cron 表达式(5 段)');
    const id = editingId.value;
    const job = id ? await api.updateCronJob(id, { ...editor.value }) : await api.createCronJob({ ...editor.value });
    if (disposed) return;
    applyConfirmedJob(job);
    message.value = `「${job?.name || editor.value.name}」${id ? '已保存修改' : '已创建'}。`;
    actionError.value = '';
    toast.success(id ? '定时任务已更新' : '定时任务已创建');
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
  actionError.value = '';
  message.value = '';
  try {
    const result = await api.runCronJob(job.id);
    if (disposed) return;
    message.value = `「${job.name}」${result.summary || '执行成功'}。`;
    toast.success(result.summary || '执行成功');
  } catch (e) {
    if (!disposed) { actionError.value = `「${job.name}」执行失败：${e.message}`; toast.error(e); }
  } finally {
    if (!disposed) await load();
    runningId.value = '';
  }
}
async function toggleEnabled(job, event) {
  // Native checkboxes toggle before change fires; keep the confirmed value until the write succeeds.
  if (event?.target) event.target.checked = job.enabled;
  if (pendingJobs.value.has(job.id) || runningId.value === job.id) return;
  pendingJobs.value.add(job.id);
  try {
    const updated = await api.updateCronJob(job.id, { enabled: !job.enabled });
    if (disposed) return;
    applyConfirmedJob(updated);
    message.value = `「${job.name}」${updated?.enabled ? '已启用' : '已停用'}。`;
    actionError.value = '';
    await load();
  } catch (e) {
    toast.error(e);
  } finally { pendingJobs.value.delete(job.id); }
}
async function removeJob(job) {
  if (removing.value || pendingJobs.value.has(job.id) || runningId.value === job.id) return;
  removeError.value = '';
  removeTarget.value = job;
}
async function confirmRemove() {
  const job = removeTarget.value;
  if (!job || removing.value || pendingJobs.value.has(job.id) || runningId.value === job.id) return;
  removing.value = true;
  pendingJobs.value.add(job.id);
  removeError.value = '';
  try {
    await api.deleteCronJob(job.id);
    if (disposed) return;
    jobs.value = jobs.value.filter(item => item.id !== job.id);
    removeTarget.value = null;
    message.value = `「${job.name}」已删除，执行历史仍可回看。`;
    actionError.value = '';
    toast.success('任务已删除');
    await nextTick();
    feedbackEl.value?.focus({ preventScroll: true });
    feedbackEl.value?.scrollIntoView?.({ block: 'nearest' });
    await load();
    // A refresh error inserts content above the feedback; reveal it again after that layout settles.
    // Only follow the feedback while it still owns focus, so a user who moved on is not pulled back.
    await nextTick();
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (!disposed && document.activeElement === feedbackEl.value) feedbackEl.value?.scrollIntoView?.({ block: 'center', behavior: 'instant' });
  } catch (e) {
    removeError.value = e.message || '删除失败，请重试';
    toast.error(e);
  } finally { removing.value = false; pendingJobs.value.delete(job.id); }
}
watch(editor, (value) => {
  if (value && !editingId.value) updateAgentContext({ state: JSON.stringify(value) });
}, { deep: true });
usePullRefresh(load);
onMounted(() => {
  load();
  window.addEventListener('composeops:cron-agent-created', handleAgentCreated);
  window.addEventListener('composeops:host-changed', handleHostChanged);
});
function handleHostChanged() { void load(); }
onBeforeUnmount(() => { disposed = true; loadId++; historyId++; stopPreview(); window.removeEventListener('composeops:cron-agent-created', handleAgentCreated); window.removeEventListener('composeops:host-changed', handleHostChanged); });

const { rows: pagedRows, page, pageSize, total, sortKey, descending, sortBy, ariaSort } = usePagedRows(filteredHistory, { at: item => parseTimestamp(item.at)?.getTime() || 0, jobName: item => item.jobName, status: item => item.status, durationMs: item => Number(item.durationMs) || 0 }, 'at');
const sortOptions = [{ key: 'at', label: '执行时间' }, { key: 'jobName', label: '任务名称' }, { key: 'status', label: '状态' }, { key: 'durationMs', label: '耗时' }];
</script>

<style scoped>
@reference '../style.css';
.cron-overview { @apply grid items-center gap-5 rounded-2xl border border-surface-800 bg-surface-900 px-5 py-3; grid-template-columns: minmax(0,1fr) 130px auto; }
.cron-eyebrow { @apply mb-2 flex items-center gap-2 text-xs text-surface-400; }
.cron-overview h2 { @apply mb-2 text-lg font-semibold tracking-tight text-surface-100; overflow-wrap: anywhere; }
.cron-scene { width: 130px; }
.cron-summary { @apply grid grid-cols-2 gap-7 border-l border-surface-800 pl-6; }
.cron-summary dt { @apply text-xs text-surface-400; }
.cron-summary dd { @apply mt-2 text-2xl font-semibold tabular-nums; }
.cron-summary dd span { @apply text-sm font-normal text-surface-400; }
.cron-job { @apply flex flex-col gap-4 rounded-xl border border-surface-800 bg-surface-900/60 p-4 transition-colors; }
.cron-job:hover, .cron-job:focus-within { border-color: var(--color-surface-700); }
.cron-job.is-running { @apply border-emerald-400/30; }
.cron-job.is-paused { @apply bg-surface-950/30; }
.cron-job-title { @apply text-sm font-semibold text-surface-100; overflow-wrap: anywhere; }
.cron-enabled { @apply inline-flex items-center gap-1.5 text-xs text-surface-400; }
.cron-enabled > span { @apply h-1.5 w-1.5 rounded-full bg-surface-500; }
.cron-enabled.is-enabled { @apply text-emerald-300; }
.cron-enabled.is-enabled > span { @apply bg-emerald-300; }
.cron-timing { @apply mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-surface-400; }
.cron-timing > span { @apply inline-flex items-center gap-1.5; }
.cron-job-actions { @apply flex flex-wrap items-center justify-end gap-2; }
.cron-last-error { @apply mt-3 rounded-lg border border-rose-400/15 bg-rose-400/5 text-xs text-rose-300; }
.cron-last-error summary { @apply flex min-h-9 cursor-pointer items-center justify-between gap-2 px-3; list-style: none; }
.cron-last-error summary::-webkit-details-marker { display: none; }
.cron-last-error summary svg { transition: transform 160ms ease; }
.cron-last-error[open] summary svg { transform: rotate(180deg); }
.cron-last-error p { @apply border-t border-rose-400/10 px-3 py-2 leading-6; white-space: pre-wrap; overflow-wrap: anywhere; }
.cron-running { @apply mt-3 flex items-center gap-2 text-xs text-emerald-300; }
.cron-feedback { @apply flex items-center gap-2; }
.cron-feedback span { min-width: 0; overflow-wrap: anywhere; }
.cron-history-detail { max-width: 26rem; overflow-wrap: anywhere; }
.cron-history td { overflow-wrap: anywhere; }
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
@media (min-width: 1100px) {
 .cron-job { flex-direction: row; align-items: center; }
 .cron-job-actions { flex-shrink: 0; }
}
@media (max-width: 639px) {
 .cron-overview { grid-template-columns: minmax(0,1fr); gap: 14px; padding: 16px; }
 .cron-overview h2 { font-size: 16px; }
 .cron-scene { display: none; }
 .cron-summary { border-left: 0; border-top: 1px solid var(--color-surface-800); padding: 12px 0 0; gap: 16px; }
 .cron-summary > div { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
 .cron-summary dd { margin: 0; font-size: 20px; }
 .cron-job { padding: 14px; }
 .cron-job-actions { border-top: 1px solid var(--color-surface-800); padding-top: 12px; }
 .cron-job-actions button, .cron-job-actions .toggle-label, .cron-last-error summary { min-height: 44px; }
 .cron-job-actions .toggle-label { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; }
 .cron-job-actions > button:first-child { margin-right: auto; }
 .cron-history { padding: 14px; }
 .cron-history .table-wrap { overflow: visible; border: 0; }
 .cron-history table, .cron-history tbody { display: block; width: 100%; }
 .cron-history thead { @apply sr-only; }
 .cron-history tbody { @apply space-y-3; }
 .cron-history tbody tr { @apply block rounded-xl border border-surface-800 bg-surface-950/30 p-3; }
 .cron-history td { display: grid; grid-template-columns: 64px minmax(0,1fr); align-items: start; gap: 12px; max-width: none; padding: 6px 0; border: 0; white-space: normal; }
 .cron-history td::before { content: attr(data-label); color: var(--color-surface-400); font-size: 12px; }
 .cron-history td > .status-badge { justify-self: start; }
 .cron-history-detail summary { min-height: 32px; }
}
@media (prefers-reduced-motion: reduce) { .cron-last-error summary svg, .cron-job { transition: none; } }
</style>
