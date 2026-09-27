<template>
  <div class="page-shell">
    <div class="page-header">
      <div><h1 class="page-title">定时任务</h1><p class="page-subtitle">可视化 Cron 调度:自动备份、Docker 清理与镜像检查</p></div>
      <div class="page-actions">
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
        <button class="btn-primary" @click="openCreate()"><Clock3 class="w-4 h-4" />新建定时任务</button>
      </div>
    </div>
    <p v-if="error" class="alert-error">{{ error }}</p>
    <p v-if="message" class="alert-success">{{ message }}</p>

    <div v-if="loading && !jobs.length" class="mt-2 space-y-2" aria-busy="true">
      <div v-for="i in 3" :key="i" class="card p-3 flex items-center gap-3">
        <div class="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-surface-800"></div>
        <div class="min-w-0 flex-1 space-y-2">
          <div class="h-3.5 w-1/3 animate-pulse rounded bg-surface-800"></div>
          <div class="h-3 w-1/2 animate-pulse rounded bg-surface-800/70"></div>
        </div>
        <div class="h-8 w-20 shrink-0 animate-pulse rounded bg-surface-800"></div>
      </div>
    </div>

    <div v-if="!jobs.length && !loading" class="flex flex-1 flex-col items-center justify-center gap-6 py-12">
      <div class="space-y-1.5 text-center">
        <h2 class="text-base font-semibold tracking-tight text-surface-100">还没有定时任务</h2>
        <p class="text-muted">按 Cron 周期自动执行备份、清理与镜像检查,失败时通过现有通知渠道告警</p>
      </div>
      <div class="grid w-full max-w-2xl gap-3 sm:grid-cols-2">
        <button v-for="preset in presets" :key="preset.name" class="cron-preset-card" @click="openCreate(preset)">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-surface-700 bg-surface-950/60"><component :is="preset.icon" class="h-4 w-4 text-accent" /></span>
          <span class="min-w-0 flex-1 text-left">
            <strong class="block truncate text-sm font-medium text-surface-200">{{ preset.name }}</strong>
            <small class="block truncate text-muted">{{ preset.description }}</small>
          </span>
          <Plus class="h-4 w-4 shrink-0 text-surface-500" />
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
            <span v-if="job.enabled" class="count-badge text-emerald-300">启用</span>
            <span v-else class="count-badge text-surface-500">停用</span>
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted">
            <span>下次执行:{{ job.nextRunAt ? new Date(job.nextRunAt).toLocaleString('zh-CN') : '—' }}</span>
            <template v-if="job.lastRunAt">
              <span :class="job.lastStatus === 'success' ? 'text-emerald-400' : 'text-rose-400'">最近:{{ job.lastStatus === 'success' ? '成功' : '失败' }}</span>
              <span>于 {{ new Date(job.lastRunAt).toLocaleString('zh-CN') }}</span>
              <span v-if="job.lastError" class="text-rose-400 truncate max-w-[320px]" :title="job.lastError">{{ job.lastError }}</span>
            </template>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <button class="btn-secondary" :disabled="runningId === job.id" @click="runNow(job)"><Play class="w-4 h-4" :class="{ 'animate-pulse': runningId === job.id }" />立即执行</button>
          <label class="toggle-label" :title="job.enabled ? '点击停用' : '点击启用'"><input type="checkbox" :checked="job.enabled" @change="toggleEnabled(job)" /></label>
          <button class="icon-btn" title="删除任务" @click="removeJob(job)"><Trash2 class="w-4 h-4 text-rose-300" /></button>
        </div>
      </article>

      <div class="border-t border-surface-800 pt-3">
        <div class="flex items-center justify-between"><h2 class="section-title">执行历史</h2><span class="text-muted text-xs">最多保留 200 条</span></div>
        <div v-if="history.length" class="space-y-1">
          <div v-for="item in history" :key="item.id" class="flex flex-wrap items-center gap-2 text-xs py-1 border-b border-surface-800/60">
            <span class="count-badge shrink-0" :class="item.status === 'success' ? 'text-emerald-300' : 'text-rose-300'">{{ item.status === 'success' ? '成功' : '失败' }}</span>
            <span class="shrink-0 text-surface-400">{{ new Date(item.at).toLocaleString('zh-CN') }}</span>
            <span class="text-surface-300">{{ item.jobName }}</span>
            <span class="text-muted">{{ item.durationMs }}ms</span>
            <span v-if="item.error" class="text-rose-400 truncate flex-1 max-w-[360px]" :title="item.error">{{ item.error }}</span>
          </div>
        </div>
        <p v-else class="text-muted text-sm py-3">暂无执行记录,点击「立即执行」触发一次。</p>
      </div>
    </div>

    <BaseModal :show="!!editor" title="新建定时任务" size-class="max-w-[calc(100vw-2rem)] sm:max-w-lg flex max-h-[88vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-3" @close="closeEditor">
      <template #header-actions>
        <button class="btn-secondary !px-2.5 !py-1.5 text-xs" title="让 Agent 根据当前表单创建任务" @click="openCronAgent"><Bot class="h-3.5 w-3.5" />让 Agent 创建</button>
      </template>
      <template v-if="editor">
        <p v-if="editorError" class="alert-error">{{ editorError }}</p>
        <label>任务名称<input v-model="editor.name" class="input" placeholder="例如:每天凌晨自动备份数据库" /></label>
        <label>任务类型<select v-model="editor.type" class="input"><option v-for="(info, key) in types" :key="key" :value="key">{{ info.label }} — {{ info.description }}</option></select></label>
        <label>周期模板<select v-model="editor.cron" class="input" @change="onCronTemplateChange"><option value="0 3 * * *">每天凌晨 3:00</option><option value="0 0 * * 0">每周日 0:00</option><option value="0 * * * *">每小时整点</option><option value="*/5 * * * *">每 5 分钟(测试用)</option><option value="custom">自定义表达式…</option></select></label>
        <label v-if="manualCron">Cron 表达式<input v-model="editor.cron" class="input font-mono" placeholder="分 时 日 月 周,如 0 3 * * *" /><span class="text-xs text-muted">下一次执行:{{ nextPreview }}</span></label>
        <details class="text-sm"><summary class="cursor-pointer text-surface-300">支持的预设表达式</summary><div class="mt-2 space-y-1 text-xs text-muted font-mono"><p>0 3 * * *- 每天 03:00</p><p>0 0 * * 0 - 每周日 00:00</p><p>0 * * * * - 每小时整点</p><p>*/30 * * * * - 每 30 分钟</p></div></details>
      </template>
      <template #footer>
        <button class="btn-secondary" @click="closeEditor">取消</button>
        <button class="btn-primary" :disabled="saving" @click="saveEditor"><Save class="w-4 h-4" />创建任务</button>
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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

function onCronTemplateChange() {
  if (!editor.value) return;
  manualCron.value = editor.value.cron === 'custom';
  if (manualCron.value) editor.value.cron = '';
}
const nextPreview = computed(() => {
  if (!editor.value?.cron || editor.value.cron === 'custom') return '';
  // 本地粗算:借用后端下次执行语义,简单提示 cron 格式合法即可
  return /^(\S+\s+){4}\S+$/.test(editor.value.cron) ? '格式正确' : '请填写 5 段表达式';
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.listCronJobs();
    jobs.value = data.jobs || [];
    types.value = data.types || {};
    history.value = (await api.getCronHistory()).history || [];
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
function openCreate(preset) {
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
  if (!editor.value) return;
  saving.value = true;
  editorError.value = '';
  try {
    if (editor.value.cron === 'custom') editor.value.cron = '';
    if (!editor.value.name.trim()) throw new Error('请填写任务名称');
    if (!editor.value.cron.trim()) throw new Error('请填写 Cron 表达式(5 段)');
    await api.createCronJob(editor.value);
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
  runningId.value = job.id;
  try {
    const result = await api.runCronJob(job.id);
    toast.success(result.summary || '执行成功');
    await load();
  } catch (e) {
    toast.error(e.message);
  } finally {
    runningId.value = '';
  }
}
async function toggleEnabled(job) {
  try {
    await api.updateCronJob(job.id, { enabled: !job.enabled });
    job.enabled = !job.enabled;
    await load();
  } catch (e) {
    toast.error(e.message);
  }
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
    toast.error(e.message);
  }
}
watch(editor, (value) => {
  if (value) updateAgentContext({ state: JSON.stringify(value) });
}, { deep: true });
onMounted(() => {
  load();
  window.addEventListener('composeops:cron-agent-created', handleAgentCreated);
  window.addEventListener('composeops:host-changed', handleHostChanged);
});
function handleHostChanged() { void load(); }
onBeforeUnmount(() => { window.removeEventListener('composeops:cron-agent-created', handleAgentCreated); window.removeEventListener('composeops:host-changed', handleHostChanged); });
</script>
