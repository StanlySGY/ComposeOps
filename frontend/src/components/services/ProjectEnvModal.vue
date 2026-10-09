<template>
  <BaseModal
    :show="true"
    :title="project.projectName"
    size-class="flex max-h-[86vh] max-w-[calc(100vw-1.5rem)] flex-col sm:max-w-4xl"
    body-class="flex min-h-0 flex-1 flex-col p-0"
    @close="close"
  >
    <template #header-actions>
      <KeyRound class="h-4 w-4 shrink-0 text-accent" />
      <span class="hidden font-mono text-[11px] text-surface-500 sm:inline">{{ data.path || '.env' }}</span>
      <select v-if="envFiles.length > 1 || activeFile !== '.env'" class="input min-h-8! w-auto! py-1! text-xs" :value="activeFile" @change="switchEnvFile($event.target.value)"><option v-for="item in envFiles" :key="item.name" :value="item.name">{{ item.name }}</option></select>
      <button class="icon-btn" title="重置为磁盘当前内容" aria-label="重置" @click="reload"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" /></button>
    </template>

    <!-- 模式切换 Tab -->
    <div class="tabs shrink-0 px-4 pt-2">
        <button :class="{ active: mode === 'table' }" @click="mode = 'table'"><ListOrdered class="h-4 w-4" />键值表格</button>
        <button :class="{ active: mode === 'raw' }" @click="mode = 'raw'"><FileCode2 class="h-4 w-4" />原始文本</button>
      </div>

      <section class="mx-4 mt-3 shrink-0 rounded-lg border border-surface-800 bg-surface-950/40">
        <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-surface-300 hover:text-surface-100" :disabled="backupLoading" @click="backupsExpanded = !backupsExpanded">
          <History class="h-4 w-4" />
          <span>历史备份</span>
          <span class="text-surface-500">({{ envBackups.length }})</span>
          <RefreshCw class="ml-auto h-3.5 w-3.5" :class="{ 'animate-spin': backupLoading }" @click.stop="loadEnvBackups" />
        </button>
        <div v-if="backupsExpanded" class="max-h-36 space-y-1 overflow-auto border-t border-surface-800 p-2">
          <p v-if="!envBackups.length && !backupLoading" class="px-2 py-3 text-center text-xs text-surface-500">当前文件暂无历史备份</p>
          <div v-for="backup in envBackups" :key="backup.name" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-900">
            <div class="min-w-0 flex-1">
              <p class="truncate font-mono text-[11px] text-surface-300">{{ backup.name }}</p>
              <p class="text-[10px] text-surface-500">{{ formatBackupDate(backup.createdAt) }}<span v-if="backup.size != null"> · {{ formatBackupSize(backup.size) }}</span></p>
            </div>
            <button class="btn-secondary shrink-0 px-2! py-1! text-[11px]" :disabled="saving || backupLoading" @click="requestRestore(backup)">恢复</button>
          </div>
        </div>
      </section>

      <!-- 搜索栏(仅表格模式) -->
      <div v-if="mode === 'table'" class="shrink-0 px-4 py-2">
        <label class="search-field max-w-xl">
          <Search class="h-4 w-4" />
          <input v-model="keyword" placeholder="按 Key 快速过滤变量" />
        </label>
      </div>

      <!-- 主体 -->
      <div class="min-h-0 flex-1 overflow-auto p-4">
        <!-- 表格模式 -->
        <div v-if="mode === 'table'" class="space-y-2">
          <div v-for="(entry, index) in filteredEntries" :key="entry._uid" class="flex flex-col gap-1 rounded-lg border border-surface-800 bg-surface-950/40 p-2 sm:flex-row sm:items-center">
            <div class="grid flex-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] sm:gap-2">
              <input v-model="entry.key" class="input font-mono text-xs" placeholder="KEY" spellcheck="false" @input="refreshSecret(entry)" />
              <div class="relative">
                <input
                  v-model="entry.value"
                  class="input w-full font-mono text-xs pr-9"
                  :type="entry.isSecret && !revealed.has(entry._uid) ? 'password' : 'text'"
                  :placeholder="entry.isSecret ? '••••••••' : 'value'"
                  spellcheck="false"
                />
                <div v-if="entry.isSecret" class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                  <button class="icon-btn h-7! w-7!" :title="revealed.has(entry._uid) ? '隐藏' : '显示'" @click="toggleReveal(entry._uid)"><Eye v-if="!revealed.has(entry._uid)" class="h-3.5 w-3.5" /><EyeOff v-else class="h-3.5 w-3.5" /></button>
                  <button class="icon-btn h-7! w-7!" title="复制值" @click="copyValue(entry)"><Copy class="h-3.5 w-3.5" /></button>
                </div>
              </div>
              <input v-model="entry.comment" class="input text-xs" placeholder="说明注释(可选)" />
            </div>
            <div class="flex shrink-0 items-center gap-1 self-end sm:self-center">
              <button class="icon-btn h-7! w-7!" title="上移" :disabled="index === 0" @click="move(entry._uid, -1)"><ChevronUp class="h-3.5 w-3.5" /></button>
              <button class="icon-btn h-7! w-7!" title="下移" :disabled="index === filteredEntries.length - 1" @click="move(entry._uid, 1)"><ChevronDown class="h-3.5 w-3.5" /></button>
              <button class="icon-btn h-7! w-7! hover:text-rose-400" title="删除" @click="remove(entry._uid)"><Trash2 class="h-3.5 w-3.5" /></button>
            </div>
          </div>
          <div v-if="!filteredEntries.length" class="py-8 text-center text-sm text-surface-500">暂无变量{{ keyword ? '与过滤条件匹配' : ',点击下方添加' }}</div>
        </div>

        <!-- Raw 模式 -->
        <div v-else class="flex min-h-[40vh] flex-col">
          <textarea
            v-model="rawText"
            class="flex-1 resize-none rounded-lg border border-surface-800 bg-surface-1000 p-3 font-mono text-xs leading-5 text-emerald-200/90 outline-hidden focus:border-surface-600"
            spellcheck="false"
            placeholder="# KEY=value&#10;SECRET_TOKEN=••••••••"
          ></textarea>
          <p class="mt-2 text-[11px] text-surface-500">支持 `.env` 与 `docker compose` 变量语法;保存时自动做合法性校验。</p>
        </div>
      </div>

    <!-- 底部操作 -->
    <div class="shrink-0 border-t border-surface-800 px-4 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <button class="btn-secondary" @click="addRow"><Plus class="h-4 w-4" />新增变量</button>
        <span class="ml-auto flex flex-wrap gap-2">
          <button class="btn-ghost" :disabled="saving" @click="saveOnly"><Save class="h-4 w-4" />仅保存文件</button>
          <button class="btn-primary" :disabled="saving" @click="saveAndApply"><Play class="h-4 w-4" />保存并应用</button>
        </span>
      </div>
    </div>

    <!-- 保存选项确认弹窗 -->
    <BaseModal :show="confirm" title="保存环境变量" size-class="max-w-[calc(100vw-1.5rem)] sm:max-w-md" body-class="space-y-2 p-4" @close="confirm = false">
      <p class="text-sm text-surface-300">请选择应用方式:</p>
      <button class="btn-secondary w-full justify-start" @click="doSave(false)"><Save class="h-4 w-4" />仅保存文件(不重启容器)</button>
      <button class="btn-primary w-full justify-start" :disabled="previewLoading" @click="applyWithPreview"><Play class="h-4 w-4" />保存并平滑重建容器(推荐)<span v-if="previewLoading" class="text-xs opacity-70">正在生成变更预览…</span></button>
    </BaseModal>
    <ChangePreviewModal :show="showPreview" :preview="changePreview" title="应用环境变量 · 变更预览" confirm-text="保存并重建" fallback-message="无法获取变更预览,继续将保存文件并平滑重建容器。" @confirm="doSave(true)" @cancel="showPreview = false" />
    <ConfirmDialog :show="!!restorePending" title="恢复历史环境变量" :message="restorePending ? '确定将 ' + activeFile + ' 恢复为 ' + restorePending.name + '？当前文件会先自动备份，选中的历史备份不会被删除。' : ''" tone="warning" confirm-text="确认恢复" @confirm="confirmRestore" @cancel="restorePending = null" />
    <ConfirmDialog :show="!!pendingConfirm" title="未保存的修改" :message="pendingConfirm?.message || ''" tone="warning" confirm-text="继续" @confirm="confirmPending" @cancel="pendingConfirm = null" />
  </BaseModal>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { ChevronDown, ChevronUp, Copy, Eye, EyeOff, FileCode2, History, KeyRound, ListOrdered, Play, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import { parseDotenv, serializeDotenv, isSecretKey } from '../../lib/dotenv.js';
import { useToastStore } from '../../stores/toast.js';
import BaseModal from '../common/BaseModal.vue';
import ChangePreviewModal from '../common/ChangePreviewModal.vue';
import ConfirmDialog from '../common/ConfirmDialog.vue';

const props = defineProps({
  project: { type: Object, required: true },
});
const emit = defineEmits(['close', 'refresh', 'apply']);

const toast = useToastStore();
const loading = ref(false);
const saving = ref(false);
const mode = ref('table');
const keyword = ref('');
const rawText = ref('');
const entries = ref([]);
const data = ref({ path: '.env', examplePath: '', exists: false, exampleRaw: '' });
const activeFile = ref('.env');
const envFiles = ref([]);
const envBackups = ref([]);
const backupLoading = ref(false);
const backupsExpanded = ref(false);
const restorePending = ref(null);
const revealed = ref(new Set());
const confirm = ref(false);
const pendingApply = ref(false);
const pendingConfirm = ref(null);
let uidSeq = 0;

const filteredEntries = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return entries.value;
  return entries.value.filter((entry) => entry.key.toLowerCase().includes(kw));
});
const dirty = computed(() => {
  if (mode.value === 'raw') return rawText.value !== data.value.raw;
  return JSON.stringify(entries.value.map(({ key, value, comment }) => ({ key, value, comment }))) !== JSON.stringify(parseEntries(data.value.raw));
});

function parseEntries(raw) {
  return parseDotenv(raw).map(({ key, value, comment }) => ({ key, value, comment }));
}

async function load() {
  loading.value = true;
  try {
    const result = await api.getProjectEnv(props.project.id, activeFile.value);
    data.value = result;
    rawText.value = result.raw || '';
    entries.value = (result.entries || []).map((entry) => ({ ...entry, _uid: ++uidSeq }));
    if (result.file) activeFile.value = result.file;
    await loadEnvBackups();
  } catch (error) {
    toast.error(`读取环境变量失败:${error.message}`);
  } finally { loading.value = false; }
}

async function loadEnvFiles() {
  try {
    envFiles.value = (await api.getProjectEnvFiles(props.project.id)).files || [];
    if (!envFiles.value.some((item) => item.name === activeFile.value)) {
      envFiles.value.unshift({ name: activeFile.value, exists: false });
    }
  } catch { envFiles.value = [{ name: '.env', exists: true }]; }
}

async function loadEnvBackups() {
  backupLoading.value = true;
  try {
    const result = await api.getProjectEnvBackups(props.project.id, activeFile.value);
    envBackups.value = result.backups || [];
  } catch (error) {
    envBackups.value = [];
    toast.error('读取历史备份失败:' + error.message);
  } finally { backupLoading.value = false; }
}

function formatBackupDate(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : '未知时间';
}
function formatBackupSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function requestRestore(backup) {
  if (dirty.value) {
    toast.error('请先保存或放弃当前修改，再恢复历史备份');
    return;
  }
  restorePending.value = backup;
}

async function confirmRestore() {
  const backup = restorePending.value;
  if (!backup) return;
  restorePending.value = null;
  saving.value = true;
  try {
    const result = await api.restoreProjectEnvBackup(props.project.id, activeFile.value, backup.name);
    toast.success('已恢复历史备份，并将恢复前内容另存为 ' + result.backup);
    await load();
    emit('refresh');
  } catch (error) {
    toast.error('恢复失败:' + error.message);
  } finally { saving.value = false; }
}

function switchEnvFile(name) {
  if (dirty.value) { pendingConfirm.value = { type: 'switch', name, message: '当前有未保存修改,切换文件会丢失这些内容。继续?' }; return; }
  activeFile.value = name;
  load();
}
function reload() { if (dirty.value) { pendingConfirm.value = { type: 'reload', message: '当前有未保存修改,重置会丢失这些内容。继续?' }; return; } load(); }
function addRow() {
  entries.value.push({ key: '', value: '', comment: '', isSecret: false, _uid: ++uidSeq });
  nextTick(() => { keyword.value = ''; });
}
function remove(uid) { entries.value = entries.value.filter((entry) => entry._uid !== uid); }
function move(uid, delta) {
  const index = entries.value.findIndex((entry) => entry._uid === uid);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= entries.value.length) return;
  const list = entries.value;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
}
function refreshSecret(entry) {
  if (entry.key && !entry.isSecret && isSecretKey(entry.key)) entry.isSecret = true;
  else if (entry.key && !isSecretKey(entry.key)) entry.isSecret = false;
}
function toggleReveal(uid) {
  const next = new Set(revealed.value);
  if (next.has(uid)) next.delete(uid); else next.add(uid);
  revealed.value = next;
}
async function copyValue(entry) {
  try { await navigator.clipboard.writeText(entry.value || ''); toast.success(`已复制 ${entry.key}`); }
  catch { toast.error('复制失败'); }
}
function buildRaw() {
  if (mode.value === 'raw') return rawText.value.trim();
  return serializeDotenv(entries.value);
}

function close() {
  if (dirty.value) { pendingConfirm.value = { type: 'close', message: '有未保存的修改,关闭会丢失这些内容。继续?' }; return; }
  emit('close');
}
function confirmPending() {
  const action = pendingConfirm.value;
  pendingConfirm.value = null;
  if (!action) return;
  if (action.type === 'switch') { activeFile.value = action.name; load(); }
  else if (action.type === 'reload') load();
  else if (action.type === 'close') emit('close');
}
async function saveOnly() { await doSave(false); }
async function saveAndApply() { pendingApply.value = true; confirm.value = true; }
const showPreview = ref(false);
const changePreview = ref(null);
const previewLoading = ref(false);
async function applyWithPreview() {
  confirm.value = false;
  previewLoading.value = true;
  try {
    const compose = await api.getComposeFile(props.project.id);
    changePreview.value = await api.previewCompose(props.project.id, compose?.content ?? '');
  } catch {
    changePreview.value = null;
  } finally {
    previewLoading.value = false;
    showPreview.value = true;
  }
}
async function doSave(apply) {
  confirm.value = false;
  showPreview.value = false;
  saving.value = true;
  try {
    await api.saveProjectEnv(props.project.id, { file: activeFile.value, raw: buildRaw() });
    toast.success('环境变量更新成功');
    await load();
    emit('refresh');
    if (apply) {
      // 触发应用:SSE 流式;由父级打开 OperationOutputDrawer
      emit('apply', { project: props.project });
    }
  } catch (error) {
    toast.error(`保存失败:${error.message}`);
  } finally { saving.value = false; pendingApply.value = false; }
}

watch(() => props.project.id, () => { if (props.project.id) { load(); loadEnvFiles(); } });
load();
loadEnvFiles();
</script>
