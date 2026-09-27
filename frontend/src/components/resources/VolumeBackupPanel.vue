<template>
  <div class="space-y-4">
    <p class="text-xs leading-5 text-zinc-500">用一次性 helper 容器把项目的<b class="text-zinc-300">命名卷</b>打包为 tar.gz,存放于 Docker 宿主机的 <code class="rounded bg-surface-950 px-1 text-[11px] text-cyan-200">data/volume-backups</code>(可在设置中用 <code class="rounded bg-surface-950 px-1 text-[11px] text-cyan-200">backup.volume_dir</code> 覆盖;远程宿主则位于远端文件系统)。bind mount 与变量引用不纳入。每个卷保留最近 20 份。</p>
    <div class="flex flex-wrap items-end gap-2">
      <label class="form-grid-label"><span>项目</span>
        <select v-model="projectId" class="input !min-h-9 w-56 text-xs" @change="loadVolumes">
          <option value="">选择项目</option>
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option>
        </select>
      </label>
      <button class="btn-secondary !min-h-9 text-xs" :disabled="!projectId || loadingVolumes" @click="loadVolumes"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loadingVolumes }" />读取卷</button>
      <button class="btn-primary !min-h-9 text-xs" :disabled="!selected.length || backing" @click="backupSelected"><HardDriveDownload class="h-3.5 w-3.5" />备份选中 {{ selected.length }} 个卷</button>
    </div>

    <div v-if="projectId && volumes.length" class="grid gap-1.5 sm:grid-cols-2">
      <label v-for="volume in volumes" :key="volume.name" class="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-xs" :class="volume.skip ? 'border-surface-800/60 bg-surface-950/30 text-zinc-600' : selected.includes(volume.name) ? 'border-accent/50 bg-accent/10' : 'border-surface-800 bg-surface-950/40 hover:border-surface-700'">
        <input v-if="!volume.skip" v-model="selected" type="checkbox" :value="volume.name" class="accent-cyan-500" />
        <Ban v-else class="h-3.5 w-3.5 shrink-0 text-zinc-700" />
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">{{ volume.name }}</span>
        <span v-if="volume.skip" class="shrink-0 text-[10px]">{{ volume.skip }}</span>
        <span v-else-if="volume.exists === false" class="shrink-0 text-[10px] text-amber-400">宿主上不存在</span>
        <span v-else-if="volume.external" class="shrink-0 text-[10px] text-cyan-400">external</span>
      </label>
    </div>
    <p v-else-if="projectId && !loadingVolumes" class="text-xs text-zinc-600">该项目 compose 中没有声明卷。</p>

    <div class="rounded-xl border border-surface-800 bg-surface-950/40">
      <div class="flex items-center justify-between border-b border-surface-800/80 px-3 py-2 text-xs text-zinc-400">
        <span>备份记录<button class="ml-2 text-cyan-400 hover:text-cyan-300" @click="loadBackups">刷新</button></span>
        <label class="flex items-center gap-1.5">仅看项目
          <select v-model="filterProjectId" class="input !min-h-7 !py-0.5 text-[11px]" @change="loadBackups"><option value="">全部</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select>
        </label>
      </div>
      <div class="max-h-72 overflow-y-auto">
        <table v-if="backups.length" class="w-full text-left text-xs">
          <thead class="sticky top-0 bg-surface-950/95 text-[10px] uppercase tracking-wide text-zinc-600">
            <tr><th class="px-3 py-2 font-medium">项目 / 卷</th><th class="px-3 py-2 font-medium">文件</th><th class="px-3 py-2 font-medium">大小</th><th class="px-3 py-2 font-medium">时间</th><th class="px-3 py-2 font-medium">宿主</th><th class="px-3 py-2"></th></tr>
          </thead>
          <tbody>
            <tr v-for="backup in backups" :key="backup.id" class="border-t border-surface-800/60 hover:bg-surface-900/40">
              <td class="px-3 py-2"><b class="text-zinc-300">{{ backup.projectName }}</b><span class="block font-mono text-[10px] text-zinc-600">{{ backup.volume }}</span></td>
              <td class="max-w-52 truncate px-3 py-2 font-mono text-[11px] text-zinc-400">{{ backup.file }}</td>
              <td class="px-3 py-2 text-zinc-400">{{ formatBytes(backup.bytes) }}</td>
              <td class="px-3 py-2 text-zinc-500">{{ formatTime(backup.createdAt) }}</td>
              <td class="px-3 py-2"><span class="rounded bg-surface-800/80 px-1.5 py-0.5 text-[10px] text-zinc-400">{{ backup.host }}</span></td>
              <td class="whitespace-nowrap px-3 py-2 text-right">
                <a :href="api.volumeBackupDownloadUrl(backup.id)" class="mr-2 inline-flex text-cyan-400 hover:text-cyan-300" title="下载"><Download class="h-3.5 w-3.5" /></a>
                <button class="mr-2 text-amber-400 hover:text-amber-300" title="恢复到卷(覆盖现有内容)" @click="askRestore(backup)"><Undo2 class="h-3.5 w-3.5" /></button>
                <button class="text-zinc-500 hover:text-rose-300" title="删除备份" @click="askDelete(backup)"><Trash2 class="h-3.5 w-3.5" /></button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-3 py-6 text-center text-xs text-zinc-600">还没有备份记录。</p>
      </div>
    </div>

    <ConfirmDialog :show="restoreTarget !== null" title="恢复数据卷" :message="`将用 ${restoreTarget?.host || 'local'} 节点上的备份覆盖卷「${restoreTarget?.volume}」的现有内容,容器内服务正在写入时建议先停止。继续?`" tone="warning" confirm-text="覆盖恢复" @confirm="doRestore" @cancel="restoreTarget = null" />
    <ConfirmDialog :show="deleteTarget !== null" title="删除备份" :message="`删除备份文件 ${deleteTarget?.file}?该操作不可恢复。`" tone="danger" confirm-text="删除" @confirm="doDelete" @cancel="deleteTarget = null" />
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { Ban, Download, HardDriveDownload, RefreshCw, Trash2, Undo2 } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';
import ConfirmDialog from '../common/ConfirmDialog.vue';

const toast = useToastStore();
const projects = ref([]);
const projectId = ref('');
const filterProjectId = ref('');
const volumes = ref([]);
const selected = ref([]);
const backups = ref([]);
const loadingVolumes = ref(false);
const backing = ref(false);
const restoreTarget = ref(null);
const deleteTarget = ref(null);

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatTime(value) {
  return value ? new Date(`${String(value).replace(' ', 'T')}Z`).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}
async function loadVolumes() {
  selected.value = [];
  volumes.value = [];
  if (!projectId.value) return;
  loadingVolumes.value = true;
  try {
    volumes.value = (await api.getProjectVolumes(projectId.value)).volumes || [];
  } catch (error) {
    toast.error(error.message);
  }
  loadingVolumes.value = false;
}
async function loadBackups() {
  try {
    backups.value = (await api.getVolumeBackups(filterProjectId.value)).backups || [];
  } catch (error) {
    toast.error(error.message);
  }
}
async function backupSelected() {
  backing.value = true;
  let ok = 0;
  const errors = [];
  for (const volume of selected.value) {
    try {
      await api.createVolumeBackup(projectId.value, volume);
      ok += 1;
    } catch (error) {
      errors.push(`${volume}:${error.message}`);
    }
  }
  backing.value = false;
  if (ok) toast.success(`已备份 ${ok} 个卷`);
  if (errors.length) toast.error(errors[0]);
  await loadBackups();
}
function askRestore(backup) { restoreTarget.value = backup; }
async function doRestore() {
  const backup = restoreTarget.value;
  restoreTarget.value = null;
  if (!backup) return;
  try {
    await api.restoreVolumeBackup(backup.id);
    toast.success(`卷 ${backup.volume} 已从备份恢复`);
  } catch (error) {
    toast.error(error.message);
  }
}
function askDelete(backup) { deleteTarget.value = backup; }
async function doDelete() {
  const backup = deleteTarget.value;
  deleteTarget.value = null;
  if (!backup) return;
  try {
    await api.deleteVolumeBackup(backup.id);
    toast.success('备份已删除');
    await loadBackups();
  } catch (error) {
    toast.error(error.message);
  }
}
onMounted(async () => {
  try {
    projects.value = ((await api.getProjects(true)).projects || []).filter((project) => project.managed);
  } catch { projects.value = []; }
  await loadBackups();
});
</script>

<style scoped>
.form-grid-label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: #71717a; }
</style>
