<template>
  <div class="volume-backups space-y-4">
    <header class="backup-intro">
      <div class="min-w-0">
        <p class="backup-eyebrow"><Archive class="h-3.5 w-3.5" aria-hidden="true" />数据保护</p>
        <h3>留存快照，验证恢复</h3>
        <p class="backup-intro-copy">选择项目的命名卷创建备份，再用临时卷验证它是否可以还原。</p>
        <ol class="backup-steps" aria-label="备份流程"><li><span>1</span>选择数据卷</li><li><span>2</span>创建备份</li><li><span>3</span>验证与留存</li></ol>
      </div>
      <SceneIllustration kind="recovery" class="backup-scene" sizes="(max-width: 639px) 104px, 180px" />
    </header>
    <p class="backup-caution"><CircleAlert class="h-4 w-4 shrink-0" aria-hidden="true" /><span>数据库卷请先停写，或使用数据库原生备份。持续写入时，卷快照不保证事务一致。</span></p>
    <details class="backup-notes">
      <summary>备份范围与保存规则<ChevronDown class="h-3.5 w-3.5" aria-hidden="true" /></summary>
      <div><p>仅备份命名卷；bind mount 与变量引用不纳入。每卷保留最近 20 份，新备份成功后才清理超额旧包。磁盘不足时保留已有恢复点。</p><p>备份存于对应 Docker 宿主机的 <code>data/volume-backups</code>，可通过 <code>backup.volume_dir</code> 配置。下载后可在其他位置留存一份。</p></div>
    </details>
    <div v-if="projectsError" class="backup-load-error" role="alert"><span>项目列表读取失败：{{ projectsError }}</span><button class="btn-secondary btn-sm" aria-label="重新读取备份项目" @click="loadProjects()">重试</button></div>
    <div class="backup-create-row">
      <label class="form-grid-label"><span>项目</span>
        <select v-model="projectId" class="input input-sm" :disabled="operationBusy || projectsLoading || !!projectsError" aria-label="选择要备份卷的项目" @change="loadVolumes">
          <option value="">{{ projectsLoading ? '正在读取项目…' : '选择项目' }}</option>
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option>
        </select>
      </label>
      <button class="btn-secondary btn-sm" :disabled="!projectId || loadingVolumes || operationBusy" @click="loadVolumes"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loadingVolumes }" />读取卷</button>
      <button class="btn-primary btn-sm" :disabled="!selected.length || operationBusy || projectsLoading || !!projectsError" @click="backupSelected"><LoaderCircle v-if="backing" class="h-3.5 w-3.5 animate-spin" /><HardDriveDownload v-else class="h-3.5 w-3.5" />{{ backing ? `正在备份 ${batchProgress.done} / ${batchProgress.total}` : `备份选中 ${selected.length} 个卷` }}</button>
    </div>

    <div v-if="projectId && volumes.length" class="grid gap-1.5 sm:grid-cols-2">
      <label v-for="volume in volumes" :key="volume.name" class="backup-volume-choice" :class="{ 'is-selected': selected.includes(volume.name), 'is-unavailable': volume.skip || volume.exists === false }">
        <input v-if="!volume.skip" v-model="selected" type="checkbox" :disabled="operationBusy || volume.exists === false" :value="volume.name" :aria-label="`选择数据卷 ${volume.name}`" class="checkbox" />
        <Ban v-else class="h-3.5 w-3.5 shrink-0 text-surface-400" />
        <span class="min-w-0 flex-1 break-all font-mono text-xs text-surface-300">{{ volume.name }}</span>
        <span v-if="volume.skip" class="shrink-0 text-[10px]">{{ volume.skip }}</span>
        <span v-else-if="volume.exists === false" class="shrink-0 text-[10px] text-status-warn">宿主上不存在</span>
        <span v-else-if="volume.external" class="shrink-0 text-[10px] text-cyan-400">external</span>
      </label>
    </div>
    <p v-if="volumeError" class="text-xs text-status-error" role="alert">卷列表加载失败：{{ volumeError }}</p>
    <p v-else-if="loadingVolumes" class="text-xs text-surface-400" role="status" aria-live="polite">正在读取卷列表…</p>
    <p v-else-if="projectId && !volumes.length" class="text-xs text-surface-400">该项目 compose 中没有声明卷。</p>

    <div v-if="backupStatus" class="backup-feedback" :class="{ 'has-error': backupStatusError }" :role="backupStatusError ? 'alert' : 'status'" aria-live="polite" aria-atomic="true">
      <Info v-if="backupInterrupted" class="h-4 w-4 shrink-0" aria-hidden="true" /><LoaderCircle v-else-if="operationBusy" class="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" /><CircleAlert v-else-if="backupStatusError" class="h-4 w-4 shrink-0" aria-hidden="true" /><Check v-else class="h-4 w-4 shrink-0" aria-hidden="true" />
      <div class="min-w-0 flex-1"><p>{{ backupStatus }}</p><p v-if="backing && batchProgress.current" class="mt-1 break-all font-mono text-xs text-surface-400">{{ batchProgress.current }}</p><div v-if="backing" class="backup-progress" role="progressbar" aria-label="批量卷备份进度" :aria-valuenow="batchProgress.done" :aria-valuemin="0" :aria-valuemax="batchProgress.total"><span :style="{ width: `${batchProgress.done / batchProgress.total * 100}%` }" /></div></div>
    </div>

    <div class="backup-records rounded-xl border border-surface-800 bg-surface-950/40">
      <div class="backup-records-toolbar">
        <span class="flex items-center gap-2"><b class="text-surface-200">备份记录</b><span class="count-badge">{{ backups.length }}</span><button class="icon-btn" aria-label="刷新备份记录" :disabled="loadingBackups" @click="loadBackups"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loadingBackups }" /></button></span>
        <label class="flex items-center gap-1.5">仅看项目
          <select v-model="filterProjectId" class="input input-sm" aria-label="筛选备份记录的项目" @change="loadBackups"><option value="">全部</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select>
        </label>
      </div>
      <p v-if="backupsError" class="px-3 py-2 text-xs text-status-error" role="alert">备份记录加载失败：{{ backupsError }}</p>
      <p v-else-if="loadingBackups" class="px-3 py-2 text-xs text-surface-400" role="status" aria-live="polite">正在读取备份记录…</p>
      <div v-else class="backup-records-scroll">
        <table v-if="backups.length" class="backup-table w-full text-left text-xs">
          <caption class="sr-only">数据卷备份记录</caption>
          <thead class="sticky top-0 bg-surface-950/95 text-[10px] uppercase tracking-wide text-surface-400">
            <tr><th class="px-3 py-2 font-medium">项目 / 卷</th><th class="px-3 py-2 font-medium">文件</th><th class="px-3 py-2 font-medium">大小</th><th class="px-3 py-2 font-medium">时间</th><th class="px-3 py-2 font-medium">宿主</th><th class="px-3 py-2 font-medium">演练</th><th class="px-3 py-2"><span class="sr-only">操作</span></th></tr>
          </thead>
          <tbody>
            <tr v-for="backup in backups" :key="backup.id" class="border-t border-surface-800/60 hover:bg-surface-900/40">
              <td class="backup-name px-3 py-2"><b class="text-surface-200">{{ backup.projectName }}</b><span class="mt-1 block break-all font-mono text-xs text-surface-400">{{ backup.volume }}</span></td>
              <td class="backup-file max-w-52 truncate px-3 py-2 font-mono text-[11px] text-surface-400" :title="backup.file">{{ backup.file }}</td>
              <td class="backup-meta px-3 py-2 text-surface-400" data-label="大小">{{ formatBytes(backup.bytes) }}</td>
              <td class="backup-meta px-3 py-2 text-surface-400" data-label="时间">{{ formatTime(backup.createdAt) }}</td>
              <td class="backup-meta px-3 py-2" data-label="宿主"><span class="rounded-sm bg-surface-800/80 px-1.5 py-0.5 text-[10px] text-surface-400">{{ backup.host }}</span></td>
              <td class="backup-meta px-3 py-2" data-label="演练">
                <span v-if="backup.verifyStatus === 'verified'" class="status-badge bg-status-ok/10 text-status-ok" :title="`演练通过 · ${backup.verifyFiles ?? '—'} 个文件 · ${formatTime(backup.verifyAt)}`">✓ {{ backup.verifyFiles ?? '?' }} 文件</span>
                <span v-else-if="backup.verifyStatus === 'empty'" class="status-badge bg-surface-800 text-surface-400" title="备份可解压,但内容为空">空备份</span>
                <span v-else-if="backup.verifyStatus === 'failed'" class="status-badge bg-status-error/10 text-status-error" title="还原演练失败,备份不可用">损坏</span>
                <span v-else class="text-[10px] text-surface-400">未演练</span>
              </td>
              <td class="backup-actions px-3 py-2 text-right">
                <a :href="api.volumeBackupDownloadUrl(backup.id)" class="backup-action text-cyan-300" title="下载备份" :aria-label="`下载备份 ${backup.file}`"><Download class="h-3.5 w-3.5" /><span>下载</span></a>
                <button class="backup-action text-status-ok" title="验证备份：在一次性临时卷中解包并统计文件数，不会修改原卷" :aria-label="`验证备份 ${backup.file}`" :disabled="operationBusy" @click="doVerify(backup)"><LoaderCircle v-if="verifyingId === backup.id" class="h-3.5 w-3.5 animate-spin" /><ShieldCheck v-else class="h-3.5 w-3.5" /><span>验证</span></button>
                <button class="backup-action text-status-warn" :title="restoringId === backup.id ? '正在验证备份并恢复' : '完整替换卷内容（备份中不存在的文件也会删除）'" :aria-label="restoringId === backup.id ? `正在恢复 ${backup.volume}` : `恢复卷 ${backup.volume} 的备份`" :disabled="operationBusy" @click="askRestore(backup)"><Undo2 class="h-3.5 w-3.5" /><span>恢复</span></button>
                <button class="backup-action text-surface-400 hover:text-status-error" title="删除备份" :aria-label="`删除备份 ${backup.file}`" :disabled="operationBusy" @click="askDelete(backup)"><Trash2 class="h-3.5 w-3.5" /><span>删除</span></button>
              </td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else compact icon="History" title="还没有备份记录" description="在上方选择项目和命名卷，即可创建第一份备份。" action-label="刷新记录" @action="loadBackups" />
      </div>
    </div>

    <ConfirmDialog :show="restoreTarget !== null" :busy="restoringId === restoreTarget?.id" title="完整恢复数据卷" :message="`将先验证 ${restoreTarget?.file} 并在临时卷演练；仅演练通过后才会用 ${restoreTarget?.host || 'local'} 节点上的快照完整替换卷「${restoreTarget?.volume}」的内容。备份中不存在的文件（包括备份后新增的文件）也会被删除。若恢复中途失败，系统会尝试补偿原卷；若补偿也失败，会保留可再次恢复的应急备份记录。建议先停止正在写入的容器。继续?`" tone="warning" confirm-text="验证并完整恢复" @confirm="doRestore" @cancel="restoreTarget = null" />
    <ConfirmDialog :show="deleteTarget !== null" :busy="deletingId === deleteTarget?.id" title="删除备份" :message="`删除备份文件 ${deleteTarget?.file}?该操作不可恢复。`" tone="danger" confirm-text="删除" @confirm="doDelete" @cancel="deleteTarget = null" />
  </div>
</template>

<script setup>
import EmptyState from '../common/EmptyState.vue';
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { Archive, Ban, Check, ChevronDown, CircleAlert, Download, HardDriveDownload, Info, LoaderCircle, RefreshCw, ShieldCheck, Trash2, Undo2 } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';
import ConfirmDialog from '../common/ConfirmDialog.vue';
import SceneIllustration from '../common/SceneIllustration.vue';
import { usePullRefresh } from '../../composables/usePullRefresh.js';

const toast = useToastStore();
const projects = ref([]);
const projectsLoading = ref(false);
const projectsError = ref('');
const props = defineProps({ initialProjectId: { type: String, default: '' } });
const projectId = ref('');
watch(() => props.initialProjectId, value => {
  if (!active || value === projectId.value || !projects.value.some(project => project.id === value)) return;
  invalidateContext('项目已变化，后续备份已停止；已发出的请求会继续完成。');
  projectId.value = value;
  void loadVolumes();
});
const filterProjectId = ref('');
const volumes = ref([]);
const selected = ref([]);
const backups = ref([]);
const loadingVolumes = ref(false);
const volumeError = ref('');
const loadingBackups = ref(false);
const backupsError = ref('');
const backupStatus = ref('');
const backupStatusError = ref(false);
const backupInterrupted = ref(false);
let volumeRequest = 0;
let backupRequest = 0;
let projectRequest = 0;
let contextVersion = 0;
let active = true;
const backing = ref(false);
const batchProgress = ref({ done: 0, total: 0, current: '' });
const restoreTarget = ref(null);
const deleteTarget = ref(null);
const verifyingId = ref('');
const restoringId = ref('');
const deletingId = ref('');
const operationBusy = computed(() => backing.value || !!verifyingId.value || !!restoringId.value || !!deletingId.value);
const current = version => active && version === contextVersion;

async function loadProjects(selectInitial = false) {
  if (!active) return;
  const request = ++projectRequest;
  projectsLoading.value = true;
  projectsError.value = '';
  try {
    const result = await api.getProjects(true);
    if (!active || request !== projectRequest) return;
    projects.value = (result.projects || []).filter(project => project.managed);
    if (selectInitial && projects.value.some(project => project.id === props.initialProjectId)) {
      projectId.value = props.initialProjectId;
      void loadVolumes();
    } else if (projectId.value && !projects.value.some(project => project.id === projectId.value)) {
      projectId.value = '';
      void loadVolumes();
    }
  } catch (error) {
    if (active && request === projectRequest) projectsError.value = error.message || '请检查节点连接后重试';
  } finally { if (request === projectRequest) projectsLoading.value = false; }
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatTime(value) {
  if (!value) return '—';
  const text = String(value).trim().replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
async function loadVolumes() {
  if (!active) return;
  const request = ++volumeRequest;
  const requestedProject = projectId.value;
  selected.value = [];
  volumes.value = [];
  volumeError.value = '';
  if (!requestedProject) { loadingVolumes.value = false; return; }
  loadingVolumes.value = true;
  try {
    const result = await api.getProjectVolumes(requestedProject);
    // 切换项目后,旧请求的迟到结果不可再写入当前卷列表。
    if (request === volumeRequest && requestedProject === projectId.value) volumes.value = result.volumes || [];
  } catch (error) {
    if (request === volumeRequest && requestedProject === projectId.value) {
      volumeError.value = error.message || '未知错误';
      toast.error(`卷列表加载失败：${volumeError.value}`);
    }
  } finally {
    if (request === volumeRequest) loadingVolumes.value = false;
  }
}
async function loadBackups() {
  if (!active) return;
  const request = ++backupRequest;
  const requestedProject = filterProjectId.value;
  loadingBackups.value = true;
  backupsError.value = '';
  try {
    const result = await api.getVolumeBackups(requestedProject);
    if (request === backupRequest && requestedProject === filterProjectId.value) backups.value = result.backups || [];
  } catch (error) {
    if (request === backupRequest && requestedProject === filterProjectId.value) {
      backups.value = [];
      backupsError.value = error.message || '未知错误';
      toast.error(`备份记录加载失败：${backupsError.value}`);
    }
  } finally {
    if (request === backupRequest) loadingBackups.value = false;
  }
}
async function backupSelected() {
  if (!active || operationBusy.value || loadingVolumes.value || projectsLoading.value || projectsError.value || !projectId.value || !selected.value.length) return;
  const requestedProject = projectId.value;
  const requestedVolumes = [...selected.value];
  const version = contextVersion;
  backing.value = true;
  backupInterrupted.value = false;
  batchProgress.value = { done: 0, total: requestedVolumes.length, current: '' };
  backupStatus.value = `正在备份 ${requestedVolumes.length} 个卷…`;
  backupStatusError.value = false;
  let ok = 0;
  const errors = [];
  for (const volume of requestedVolumes) {
    if (!current(version)) break;
    batchProgress.value.current = volume;
    try {
      await api.createVolumeBackup(requestedProject, volume);
      ok += 1;
    } catch (error) {
      errors.push({ volume, message: error.message });
    }
    if (current(version)) batchProgress.value.done++;
  }
  backing.value = false;
  if (!current(version)) return;
  selected.value = errors.map(error => error.volume);
  if (errors.length) {
    backupStatus.value = `备份部分失败：成功 ${ok} 个，失败 ${errors.length} 个。${errors[0].volume}：${errors[0].message}。已保留失败项，可重新备份。`;
    backupStatusError.value = true;
    toast.error(backupStatus.value);
  } else {
    backupStatus.value = `备份完成：已备份 ${ok} 个卷`;
    backupStatusError.value = false;
    toast.success(backupStatus.value);
  }
  await loadBackups();
}
function askRestore(backup) { if (!operationBusy.value && active) restoreTarget.value = backup; }
async function doVerify(backup) {
  if (operationBusy.value || !active) return;
  const version = contextVersion;
  verifyingId.value = backup.id;
  backupInterrupted.value = false;
  backupStatus.value = `正在临时卷中验证 ${backup.volume} 的备份…`;
  backupStatusError.value = false;
  try {
    const result = await api.verifyVolumeBackup(backup.id);
    if (!current(version)) return;
    if (result.status === 'verified') { backupStatus.value = `备份演练通过：还原出 ${result.files} 个文件`; backupStatusError.value = false; toast.success(`演练通过：还原出 ${result.files} 个文件(${(result.durationMs / 1000).toFixed(1)}s)`); }
    else if (result.status === 'empty') { backupStatus.value = '备份可正常解压，但内容为空'; backupStatusError.value = false; toast.info(backupStatus.value); }
    else { backupStatus.value = '演练失败：备份疑似损坏'; backupStatusError.value = true; toast.error(backupStatus.value); }
  } catch (error) {
    if (!current(version)) return;
    backupStatus.value = `演练失败：${error.message}`; backupStatusError.value = true;
    toast.error(`演练失败：${error.message}`);
  } finally {
    verifyingId.value = '';
    if (current(version)) await loadBackups();
  }
}
async function doRestore() {
  const backup = restoreTarget.value;
  if (!backup || operationBusy.value || !active) return;
  const version = contextVersion;
  restoringId.value = backup.id;
  backupInterrupted.value = false;
  try {
    await api.restoreVolumeBackup(backup.id);
    if (!current(version)) return;
    backupStatus.value = `卷 ${backup.volume} 已通过还原演练并完成恢复`; backupStatusError.value = false;
    toast.success(`卷 ${backup.volume} 已通过还原演练并完成恢复`);
    restoreTarget.value = null;
  } catch (error) {
    if (!current(version)) return;
    backupStatus.value = `恢复失败：${error.message}。请检查目标卷状态并确认服务健康。`; backupStatusError.value = true;
    toast.error(backupStatus.value);
  } finally {
    restoringId.value = '';
    if (current(version)) await loadBackups();
  }
}
function askDelete(backup) { if (!operationBusy.value && active) deleteTarget.value = backup; }
async function doDelete() {
  const backup = deleteTarget.value;
  if (!backup || operationBusy.value || !active) return;
  const version = contextVersion;
  deletingId.value = backup.id;
  backupInterrupted.value = false;
  try {
    await api.deleteVolumeBackup(backup.id);
    if (!current(version)) return;
    deleteTarget.value = null;
    backupStatus.value = `备份 ${backup.file} 已删除`; backupStatusError.value = false;
    toast.success('备份已删除');
    await loadBackups();
  } catch (error) {
    if (!current(version)) return;
    backupStatus.value = `删除备份失败：${error.message}`; backupStatusError.value = true;
    toast.error(error);
  } finally { deletingId.value = ''; }
}
function invalidateContext(message = '已离开备份页面，后续备份已停止；已发出的请求会继续完成。') {
  contextVersion++;
  volumeRequest++;
  backupRequest++;
  projectRequest++;
  loadingVolumes.value = false;
  loadingBackups.value = false;
  projectsLoading.value = false;
  restoreTarget.value = null;
  deleteTarget.value = null;
  if (operationBusy.value) {
    backupInterrupted.value = true;
    backupStatus.value = message;
    backupStatusError.value = false;
    toast.info(message);
  }
}
function onHostChanged() {
  invalidateContext('节点已变化，后续备份已停止；已发出的请求会在原节点继续完成。');
  projectId.value = ''; filterProjectId.value = '';
  projects.value = []; volumes.value = []; selected.value = []; backups.value = [];
  volumeError.value = ''; backupsError.value = ''; projectsError.value = '';
  if (active) void Promise.all([loadProjects(), loadBackups()]);
}
onMounted(() => {
  window.addEventListener('composeops:host-changed', onHostChanged);
  void Promise.all([loadProjects(true), loadBackups()]);
});
let activatedOnce = false;
onActivated(() => {
  active = true;
  if (activatedOnce) void Promise.all([loadProjects(), loadBackups(), loadVolumes()]);
  activatedOnce = true;
});
function deactivate() { if (active) { active = false; invalidateContext(); } }
onDeactivated(deactivate);
onBeforeUnmount(() => {
  deactivate();
  window.removeEventListener('composeops:host-changed', onHostChanged);
});
usePullRefresh(() => Promise.all([loadProjects(), loadBackups()]), { keepAlive: true, enabled: () => !operationBusy.value });
</script>

<style scoped>
.volume-backups { padding: 20px; }
.backup-intro { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.backup-eyebrow { display: flex; align-items: center; gap: 7px; color: var(--color-status-ok); font-size: 11px; letter-spacing: .08em; }
.backup-intro h3 { margin-top: 9px; color: var(--color-surface-100); font-size: 20px; font-weight: 650; letter-spacing: -.03em; }
.backup-intro-copy { max-width: 40rem; margin-top: 8px; color: var(--color-surface-400); font-size: 12px; line-height: 1.7; }
.backup-scene { width: 180px; margin: -12px -8px; }
.backup-steps { display: flex; flex-wrap: wrap; gap: 10px 20px; margin-top: 15px; color: var(--color-surface-300); font-size: 11px; }
.backup-steps li { display: inline-flex; align-items: center; gap: 7px; }
.backup-steps span { display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--color-surface-700); border-radius: 6px; color: var(--color-surface-400); font-variant-numeric: tabular-nums; }
.backup-caution { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid rgba(251,191,36,.13); border-radius: 9px; background: rgba(251,191,36,.035); color: var(--color-surface-300); font-size: 12px; line-height: 1.6; }
.backup-caution svg { margin-top: 2px; color: var(--color-status-warn); }
.backup-notes { color: var(--color-surface-400); font-size: 12px; line-height: 1.7; }
.backup-notes summary { display: flex; align-items: center; gap: 8px; width: fit-content; min-height: 32px; cursor: pointer; list-style: none; border-radius: 4px; }
.backup-notes summary::-webkit-details-marker { display: none; }
.backup-notes summary svg { transition: transform 160ms ease; }
.backup-notes[open] summary svg { transform: rotate(180deg); }
.backup-notes > div { max-width: 64rem; padding: 8px 0 2px; }
.backup-notes p + p { margin-top: 6px; }
.backup-notes code { color: var(--color-surface-300); overflow-wrap: anywhere; }
.backup-create-row { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
.form-grid-label { display: flex; flex-direction: column; gap: 7px; min-width: 0; width: 240px; font-size: 12px; color: var(--color-surface-400); }
.backup-load-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--color-status-error); font-size: 12px; }
.backup-volume-choice { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 10px 12px; border: 1px solid var(--color-surface-800); border-radius: 9px; background: rgba(0,0,0,.12); cursor: pointer; transition: background-color 140ms ease, border-color 140ms ease; }
.backup-volume-choice:hover { border-color: var(--color-surface-600); }
.backup-volume-choice.is-selected { border-color: rgba(52,211,153,.45); background: rgba(52,211,153,.05); }
.backup-volume-choice.is-unavailable { opacity: .65; cursor: default; }
.backup-feedback { display: flex; align-items: flex-start; gap: 9px; padding: 12px; border: 1px solid var(--color-surface-700); border-radius: 9px; color: var(--color-surface-200); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.backup-feedback > svg { margin-top: 3px; color: var(--color-status-ok); }
.backup-feedback.has-error > svg { color: var(--color-status-error); }
.backup-progress { height: 4px; overflow: hidden; margin-top: 10px; border-radius: 3px; background: var(--color-surface-800); }
.backup-progress span { display: block; height: 100%; background: var(--color-status-ok); transition: width 180ms ease; }
.backup-records-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--color-surface-800); font-size: 12px; color: var(--color-surface-400); }
.backup-records-scroll { max-height: 440px; overflow: auto; }
.backup-table { min-width: 720px; }
.backup-actions { white-space: nowrap; }
.backup-action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 36px; min-height: 36px; padding: 6px; border-radius: 7px; transition: background-color 140ms ease; }
.backup-action:hover { background: rgba(148,163,184,.09); }
.backup-action:disabled { cursor: not-allowed; opacity: .4; }
.backup-action span { display: none; }
@media (max-width: 760px) {
  .volume-backups { padding: 14px; }
  .backup-intro { position: relative; gap: 0; }
  .backup-intro > div:first-child { position: relative; z-index: 1; }
  .backup-intro h3 { padding-right: 72px; font-size: 18px; }
  .backup-intro-copy { padding-right: 64px; }
  .backup-scene { position: absolute; width: 104px; right: -14px; top: -6px; opacity: .75; }
  .backup-steps { gap: 8px 12px; font-size: 10px; }
  .backup-steps li { gap: 5px; }
  .backup-steps span { width: 18px; height: 18px; }
  .backup-create-row .form-grid-label { width: 100%; }
  .backup-create-row > button { flex: 1; min-height: 40px; }
  .backup-records-toolbar { align-items: flex-start; }
  .backup-records-toolbar > label { width: 100%; }
  .backup-records-toolbar select { flex: 1; min-width: 0; }
  .backup-records-scroll { max-height: none; }
  .backup-table, .backup-table tbody { display: block; min-width: 0; }
  .backup-table thead { display: none; }
  .backup-table tr { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); padding: 12px; gap: 10px; }
  .backup-table td { display: block; padding: 0; }
  .backup-name, .backup-file, .backup-actions { grid-column: 1 / -1; }
  .backup-table .backup-file { max-width: none; white-space: normal; overflow-wrap: anywhere; }
  .backup-meta::before { display: block; margin-bottom: 4px; font-size: 10px; color: var(--color-surface-400); content: attr(data-label); }
  .backup-table .backup-actions { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 4px; margin-top: 2px; padding-top: 10px; border-top: 1px solid var(--color-surface-800); }
  .backup-action { min-width: 0; min-height: 40px; padding: 4px 2px; font-size: 11px; }
  .backup-action span { display: inline; }
}
@media (prefers-reduced-motion: reduce) {
  .volume-backups .animate-spin { animation: none; }
  .backup-notes summary svg, .backup-volume-choice, .backup-action, .backup-progress span { transition: none; }
}
</style>
