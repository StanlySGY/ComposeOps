<template>
  <BaseModal
    :show="true"
    :close-on-route-change="false"
    :close-disabled="saving"
    :title="project.projectName"
    size-class="flex max-h-[86vh] max-w-[calc(100vw-1.5rem)] flex-col sm:max-w-4xl"
    body-class="flex min-h-0 flex-1 flex-col p-0"
    @close="close"
  >
    <template #header-actions>
      <KeyRound class="h-4 w-4 shrink-0 text-status-info" />
      <span class="hidden font-mono text-[11px] text-surface-400 sm:inline">{{ data.path || '.env' }}</span>
      <select v-if="envFiles.length > 1 || activeFile !== '.env'" aria-label="选择环境变量文件" class="input w-auto input-sm" :value="activeFile" :disabled="saving" @change="switchEnvFile($event.target.value)"><option v-for="item in envFiles" :key="item.name" :value="item.name">{{ item.name }}{{ item.exists ? '' : '（待创建）' }}</option></select>
      <button class="icon-btn" title="重置为磁盘当前内容" aria-label="重置" :disabled="saving" @click="reload"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" /></button>
    </template>

    <!-- 模式切换 Tab -->
    <div class="tabs shrink-0 px-4 pt-2">
        <button :class="{ active: mode === 'table' }" :disabled="editorDisabled" @click="switchMode('table')"><ListOrdered class="h-4 w-4" />键值表格</button>
        <button :class="{ active: mode === 'raw' }" :disabled="editorDisabled" @click="switchMode('raw')"><FileCode2 class="h-4 w-4" />原始文本</button>
      </div>

      <div v-if="loadError || saveError" class="mx-4 mt-3 rounded-lg border border-status-error/30 bg-status-error/5 p-3 text-sm" role="alert">
        <p>{{ loadError || saveError }}</p>
        <div class="mt-2 flex flex-wrap gap-2">
          <button v-if="loadError" class="btn-secondary btn-sm" :disabled="loading" @click="reload">重试读取</button>
          <template v-if="versionConflict">
            <button class="btn-secondary btn-sm" @click="copyDraft">复制当前草稿</button>
            <button class="btn-secondary btn-sm" @click="reload">重新读取磁盘内容</button>
          </template>
        </div>
      </div>
      <p v-if="filesError" class="mx-4 mt-2 text-xs text-status-warn" role="status">{{ filesError }} <button class="underline" @click="loadEnvFiles">重试文件列表</button></p>
      <p v-if="tableNotice" class="mx-4 mt-2 text-xs text-status-info" role="status">{{ tableNotice }}</p>
      <p v-if="loading" class="px-4 pt-3 text-xs text-surface-400" role="status">正在读取 {{ activeFile }}…</p>

      <section class="mx-4 mt-3 shrink-0 rounded-lg border border-surface-800 bg-surface-950/40">
        <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-surface-300 hover:text-surface-100" :disabled="backupLoading" @click="backupsExpanded = !backupsExpanded">
          <History class="h-4 w-4" />
          <span>历史备份</span>
          <span class="text-surface-400">({{ envBackups.length }})</span>
          <RefreshCw class="ml-auto h-3.5 w-3.5" :class="{ 'animate-spin': backupLoading }" @click.stop="loadEnvBackups" />
        </button>
        <div v-if="backupsExpanded" class="max-h-36 space-y-1 overflow-auto border-t border-surface-800 p-2">
          <p v-if="backupError" class="px-2 py-3 text-xs text-status-warn" role="status">{{ backupError }} <button class="underline" @click="loadEnvBackups">重试</button></p>
          <p v-else-if="!envBackups.length && !backupLoading" class="px-2 py-3 text-center text-xs text-surface-400">当前文件暂无历史备份</p>
          <div v-for="backup in envBackups" :key="backup.name" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-900">
            <div class="min-w-0 flex-1">
              <p class="truncate font-mono text-[11px] text-surface-300">{{ backup.name }}</p>
              <p class="text-[10px] text-surface-400">{{ formatBackupDate(backup.createdAt) }}<span v-if="backup.size != null"> · {{ formatBackupSize(backup.size) }}</span></p>
            </div>
            <button class="btn-secondary shrink-0 btn-sm" :disabled="editorDisabled || backupLoading" @click="requestRestore(backup)">恢复</button>
          </div>
        </div>
      </section>

      <p v-if="loaded && mode === 'table'" class="px-4 pt-2 text-[11px] text-surface-400">保留已有变量的引号及替换规则；新增含 $ 的值按字面值保存。需要变量替换时请编辑原始文本。</p>

      <!-- 搜索栏(仅表格模式) -->
      <div v-if="mode === 'table'" class="shrink-0 px-4 py-2">
        <label class="search-field max-w-xl">
          <Search class="h-4 w-4" />
          <input v-model="keyword" aria-label="按 Key 快速过滤变量" placeholder="按 Key 快速过滤变量" />
        </label>
      </div>

      <!-- 主体 -->
      <fieldset :disabled="editorDisabled" :aria-busy="loading || saving" class="min-h-0 min-w-0 flex-1 overflow-auto p-4">
        <!-- 表格模式 -->
        <div v-if="loaded && mode === 'table'" class="space-y-2">
          <div v-for="(entry, index) in filteredEntries" :key="entry._uid" class="flex flex-col gap-1 rounded-lg border border-surface-800 bg-surface-950/40 p-2 sm:flex-row sm:items-center">
            <div class="grid flex-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] sm:gap-2">
              <input v-model="entry.key" :aria-label="entry.key ? `${entry.key} 变量名` : `第 ${index + 1} 行变量名`" class="input font-mono text-xs" placeholder="KEY" spellcheck="false" @input="refreshSecret(entry)" />
              <div class="relative">
                <input
                  v-model="entry.value"
                  :aria-label="entry.key ? `${entry.key} 变量值` : `第 ${index + 1} 行变量值`"
                  class="input w-full font-mono text-xs pr-9"
                  :type="entry.isSecret && !revealed.has(entry._uid) ? 'password' : 'text'"
                  :placeholder="entry.isSecret ? '••••••••' : 'value'"
                  spellcheck="false"
                />
                <div v-if="entry.isSecret" class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                  <button class="icon-btn icon-btn-sm" :title="revealed.has(entry._uid) ? '隐藏' : '显示'" :aria-label="revealed.has(entry._uid) ? '隐藏' : '显示'" @click="toggleReveal(entry._uid)"><Eye v-if="!revealed.has(entry._uid)" class="h-3.5 w-3.5" /><EyeOff v-else class="h-3.5 w-3.5" /></button>
                  <button class="icon-btn icon-btn-sm" title="复制值" aria-label="复制值" @click="copyValue(entry)"><Copy class="h-3.5 w-3.5" /></button>
                </div>
              </div>
              <input v-model="entry.comment" :aria-label="entry.key ? `${entry.key} 说明注释` : `第 ${index + 1} 行说明注释`" class="input text-xs" placeholder="说明注释(可选)" />
            </div>
            <div class="flex shrink-0 items-center gap-1 self-end sm:self-center">
              <button class="icon-btn icon-btn-sm" title="上移" aria-label="上移" :disabled="!!keyword.trim() || index === 0" @click="move(entry._uid, -1)"><ChevronUp class="h-3.5 w-3.5" /></button>
              <button class="icon-btn icon-btn-sm" title="下移" aria-label="下移" :disabled="!!keyword.trim() || index === filteredEntries.length - 1" @click="move(entry._uid, 1)"><ChevronDown class="h-3.5 w-3.5" /></button>
              <button class="icon-btn hover:text-status-error icon-btn-sm" title="删除" aria-label="删除变量" @click="remove(entry._uid)"><Trash2 class="h-3.5 w-3.5" /></button>
            </div>
          </div>
          <div v-if="!filteredEntries.length" class="py-8 text-center text-sm text-surface-400">暂无变量{{ keyword ? '与过滤条件匹配' : ',点击下方添加' }}</div>
        </div>

        <!-- Raw 模式 -->
        <div v-else-if="loaded" class="flex min-h-[40vh] flex-col">
          <textarea
            v-model="rawText"
            aria-label="环境变量原始文本"
            class="flex-1 resize-none rounded-lg border border-surface-800 bg-surface-1000 p-3 font-mono text-xs leading-5 text-status-ok/90 outline-hidden focus:border-surface-600"
            spellcheck="false"
            placeholder="# KEY=value&#10;SECRET_TOKEN=••••••••"
          ></textarea>
          <p class="mt-2 text-[11px] text-surface-400">保留引号、注释与换行；保存前检查基本语法，最终变量替换由 Compose 处理。</p>
        </div>
      </fieldset>

    <!-- 底部操作 -->
    <div class="shrink-0 border-t border-surface-800 px-4 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <button class="btn-secondary" :disabled="editorDisabled" @click="addRow"><Plus class="h-4 w-4" />新增变量</button>
        <span class="text-xs text-surface-400" aria-live="polite">{{ saving ? '正在保存…' : dirty ? '有未保存修改' : loaded ? '已与读取版本同步' : '' }}</span>
        <span class="ml-auto flex flex-wrap gap-2">
          <button class="btn-ghost" :disabled="editorDisabled" @click="saveOnly"><Save class="h-4 w-4" />仅保存文件</button>
          <button class="btn-primary" :disabled="editorDisabled" @click="saveAndApply"><Play class="h-4 w-4" />保存并应用</button>
        </span>
      </div>
    </div>

    <BaseModal :show="confirm" title="保存文件并重建项目" size-class="max-w-[calc(100vw-1.5rem)] sm:max-w-md" body-class="space-y-3 p-4" @close="confirm = false">
      <p class="text-sm text-surface-300">将先保存 <strong class="font-mono">{{ activeFile }}</strong>，再按项目现有 Compose 配置重建服务。重建可能短暂中断服务。</p>
      <p class="text-sm text-status-warn" role="status">当前草稿尚未经过 Compose 生效预览。文件不会自动作为 --env-file 加入启动命令；只有被项目配置引用的变量才可能生效，具体取决于 Compose 的环境变量优先级。</p>
      <button class="btn-secondary w-full justify-start" @click="doSave(false)"><Save class="h-4 w-4" />仅保存文件(不重启容器)</button>
      <button class="btn-primary w-full justify-start" @click="doSave(true)"><Play class="h-4 w-4" />确认保存并重建</button>
    </BaseModal>
    <ConfirmDialog :show="!!restorePending" title="恢复历史环境变量" :message="restorePending ? '确定将 ' + activeFile + ' 恢复为 ' + restorePending.name + '？当前文件会先自动备份，选中的历史备份不会被删除。' : ''" tone="warning" confirm-text="确认恢复" @confirm="confirmRestore" @cancel="restorePending = null" />
    <ConfirmDialog :show="!!pendingConfirm" title="未保存的修改" :message="pendingConfirm?.message || ''" tone="warning" confirm-text="继续" @confirm="confirmPending" @cancel="pendingConfirm = null" />
  </BaseModal>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ChevronDown, ChevronUp, Copy, Eye, EyeOff, FileCode2, History, KeyRound, ListOrdered, Play, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import { parseDotenvDocument, editDotenvDocument, validateDotenv, isSecretKey } from '../../lib/dotenv.js';
import { useToastStore } from '../../stores/toast.js';
import BaseModal from '../common/BaseModal.vue';
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
const loaded = ref(false), loadError = ref(''), saveError = ref(''), versionConflict = ref(false), filesError = ref(''), backupError = ref('');
const tableSource = ref(''), tableBaseline = ref('');
const tableDocument = ref(parseDotenvDocument(''));
const tableNotice = computed(() => tableDocument.value.tableSafe ? '' : '此文件包含多行值、转义或复杂语法，请使用原始文本编辑以保留原意。');
const editorDisabled = computed(() => !loaded.value || loading.value || saving.value);
let alive = true, request = 0, fileRequest = 0, backupRequest = 0;
const current = version => alive && version === request;
const pendingConfirm = ref(null);
let uidSeq = 0;

const filteredEntries = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return entries.value;
  return entries.value.filter((entry) => entry.key.toLowerCase().includes(kw));
});
const tableValue = () => JSON.stringify(entries.value.map(({ key, value, comment }) => ({ key, value, comment })));
const tableChanged = computed(() => tableValue() !== tableBaseline.value);
const dirty = computed(() => loaded.value && buildRaw() !== data.value.raw);

function setEditor(raw) {
  rawText.value = raw;
  tableSource.value = raw;
  tableDocument.value = parseDotenvDocument(raw);
  entries.value = tableDocument.value.nodes.map(entry => ({ ...entry, _uid: ++uidSeq }));
  if (!tableDocument.value.tableSafe) mode.value = 'raw';
  tableBaseline.value = tableValue();
  revealed.value = new Set();
}
function switchMode(next) {
  if (editorDisabled.value || next === mode.value) return;
  if (next === 'raw') rawText.value = buildRaw();
  else {
    setEditor(rawText.value);
    if (!tableDocument.value.tableSafe) return;
  }
  mode.value = next;
}
async function load() {
  const version = ++request, projectId = props.project.id, file = activeFile.value;
  loading.value = true; loaded.value = false; loadError.value = ''; saveError.value = ''; versionConflict.value = false;
  envBackups.value = []; ++backupRequest; backupLoading.value = false; backupError.value = '';
  try {
    const result = await api.getProjectEnv(projectId, file);
    if (!current(version)) return;
    data.value = { ...result, raw: result.raw || '' };
    setEditor(data.value.raw);
    loaded.value = true;
    if (result.file) activeFile.value = result.file;
    void loadEnvBackups();
  } catch (error) {
    if (current(version)) loadError.value = `读取 ${file} 失败：${error.message}。成功读取前不能保存。`;
  } finally { if (current(version)) loading.value = false; }
}
async function loadEnvFiles() {
  const version = ++fileRequest, projectId = props.project.id;
  try {
    const result = await api.getProjectEnvFiles(projectId);
    if (!alive || version !== fileRequest || projectId !== props.project.id) return;
    envFiles.value = result.files || [];
    filesError.value = '';
    if (!envFiles.value.some(item => item.name === activeFile.value)) envFiles.value.unshift({ name: activeFile.value, exists: false });
  } catch (error) { if (alive && version === fileRequest) filesError.value = '文件列表读取失败：' + error.message; }
}
async function loadEnvBackups() {
  const version = ++backupRequest, projectId = props.project.id, file = activeFile.value;
  backupLoading.value = true;
  try {
    const result = await api.getProjectEnvBackups(projectId, file);
    if (alive && version === backupRequest) { envBackups.value = result.backups || []; backupError.value = ''; }
  } catch (error) {
    if (alive && version === backupRequest) { envBackups.value = []; backupError.value = '读取历史备份失败：' + error.message; }
  } finally { if (alive && version === backupRequest) backupLoading.value = false; }
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
  if (editorDisabled.value) return;
  if (dirty.value) {
    toast.error('请先保存或放弃当前修改，再恢复历史备份');
    return;
  }
  restorePending.value = backup;
}

async function confirmRestore() {
  const backup = restorePending.value;
  if (!backup || editorDisabled.value) return;
  const version = request;
  restorePending.value = null;
  saving.value = true;
  try {
    const result = await api.restoreProjectEnvBackup(props.project.id, activeFile.value, backup.name, data.value.version);
    if (!current(version)) return;
    toast.success('已恢复历史备份，并将恢复前内容另存为 ' + result.backup);
    saving.value = false;
    await load();
    if (alive) emit('refresh');
  } catch (error) {
    if (current(version)) { saveError.value = '恢复失败：' + error.message; versionConflict.value = error.code === 'ENV_VERSION_CONFLICT'; }
  } finally { if (current(version)) saving.value = false; }
}

function switchEnvFile(name) {
  if (saving.value || name === activeFile.value) return;
  if (dirty.value) { pendingConfirm.value = { type: 'switch', name, message: '当前有未保存修改,切换文件会丢失这些内容。继续?' }; return; }
  activeFile.value = name;
  load();
}
function reload() { if (saving.value) return; if (dirty.value) { pendingConfirm.value = { type: 'reload', message: '当前有未保存修改,重置会丢失这些内容。继续?' }; return; } load(); }
function addRow() {
  if (editorDisabled.value) return;
  if (mode.value === 'raw') switchMode('table');
  if (mode.value !== 'table') return;
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
  if (mode.value === 'raw') return rawText.value;
  return tableChanged.value ? editDotenvDocument(tableDocument.value, entries.value) : tableSource.value;
}

async function copyDraft() {
  try { await navigator.clipboard.writeText(buildRaw()); toast.success('已复制当前草稿，请妥善保管其中的敏感值'); }
  catch { toast.error('复制失败，可切换原始文本手动复制'); }
}
function close() {
  if (saving.value) return;
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
async function saveAndApply() { if (!editorDisabled.value) confirm.value = true; }
async function doSave(apply) {
  if (editorDisabled.value) return;
  const version = request, project = props.project, file = activeFile.value, raw = buildRaw();
  const validation = validateDotenv(raw);
  if (!validation.ok) { confirm.value = false; saveError.value = validation.errors.join('；'); return; }
  confirm.value = false; saving.value = true; saveError.value = ''; versionConflict.value = false;
  try {
    const saved = await api.saveProjectEnv(project.id, { file, raw, expectedVersion: data.value.version });
    if (!current(version)) return;
    data.value = { ...data.value, raw, exists: true, version: saved.version };
    setEditor(raw);
    toast.success('环境变量更新成功');
    void loadEnvBackups(); void loadEnvFiles();
    emit('refresh');
    if (apply) emit('apply', { project });
  } catch (error) {
    if (current(version)) { saveError.value = `保存失败：${error.message}`; versionConflict.value = error.code === 'ENV_VERSION_CONFLICT'; }
  } finally { if (current(version)) saving.value = false; }
}
function beforeUnload(event) { if (dirty.value || saving.value) { event.preventDefault(); event.returnValue = ''; } }
window.addEventListener('beforeunload', beforeUnload);
onBeforeUnmount(() => { alive = false; request++; fileRequest++; backupRequest++; window.removeEventListener('beforeunload', beforeUnload); });
watch(() => props.project.id, () => {
  if (!props.project.id) return;
  saving.value = false; confirm.value = false;
  restorePending.value = null; pendingConfirm.value = null; activeFile.value = '.env'; envFiles.value = []; filesError.value = '';
  void load(); void loadEnvFiles();
});
void load();
void loadEnvFiles();
</script>
