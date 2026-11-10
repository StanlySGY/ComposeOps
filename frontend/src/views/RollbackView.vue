<template>
  <div :class="embedded ? '' : 'page-shell'" :aria-busy="loading || busy">
    <div v-if="!embedded" class="page-header">
      <div>
        <h1 class="page-title">自动回滚中心</h1>
        <p class="page-subtitle">统一管理 Compose 配置、数据卷、镜像升级与 GitOps 的回滚恢复</p>
      </div>
      <div class="page-actions">
        <select v-model="selectedProjectId" class="input sm:w-56" aria-label="选择项目" :disabled="busy" @change="loadProject">
          <option value="">全部项目</option>
          <option v-for="p in store.projects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
        </select>
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>
    <!-- embedded 模式(变更与回滚页 tab)没有页头,单独保留选择项目的工具条 -->
    <div v-else class="mb-3 flex flex-wrap items-center justify-end gap-2">
      <select v-model="selectedProjectId" class="input sm:w-56" aria-label="选择项目" :disabled="busy" @change="loadProject">
        <option value="">全部项目</option>
        <option v-for="p in store.projects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
      </select>
      <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
    </div>

    <p v-if="loading" class="sr-only" role="status" aria-live="polite" aria-atomic="true">正在加载回滚中心数据</p>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>

    <div v-if="selectedProject" class="section-panel mb-4 space-y-2 text-sm">
      <p>目标节点：{{ selectedProject.hostName || selectedProject.hostId || 'local' }} · 项目：{{ selectedProject.projectName }}</p>
      <ol class="list-decimal pl-5 text-xs text-muted"><li v-for="file in selectedProject.composeFiles" :key="file" class="break-all">{{ file }}</li></ol>
    </div>
    <!-- 摘要统计 -->
    <div class="metric-grid">
      <MetricTile title="Compose 备份" :value="composeBackups.length" sub="配置版本" :icon="FileCode2" tone="text-blue-300" />
      <MetricTile title="数据卷备份" :value="volumeBackups.length" sub="持久化数据" :icon="HardDrive" tone="text-violet-300" />
      <MetricTile title="GitOps 仓库" :value="gitopsRepos.length" sub="代码版本" :icon="GitBranch" tone="text-status-ok" />
      <MetricTile title="可回滚项目" :value="rollbackableProjectCount" sub="有升级备份" :icon="RotateCcw" tone="text-status-warn" />
    </div>

    <!-- Compose 配置备份 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">Compose 配置备份</h2><p class="mt-1 text-muted">保存配置或升级时自动留存的版本,可一键恢复</p></div>
      <p v-if="loadErrors.compose" class="alert-error" role="alert">{{ loadErrors.compose }}</p>
      <EmptyState v-else-if="!loading && !composeBackups.length" compact title="暂无 Compose 配置备份" description="保存配置时会自动保留旧版本。"><router-link to="/compose?from=review" class="btn-secondary btn-sm">查看配置</router-link></EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead><tr><th>项目</th><th>原因</th><th>文件</th><th>时间</th><th class="text-right">操作</th></tr></thead>
          <tbody>
            <tr v-for="backup in composeBackups" :key="backup.id" class="hover:bg-surface-800/25">
              <td class="font-medium text-surface-100">{{ backup.projectName || backup.projectId }}</td>
              <td><span class="count-badge" :class="backup.reason === 'upgrade' || backup.reason?.startsWith('upgrade:') ? 'text-status-warn' : 'text-sky-300'">{{ reasonLabel(backup.reason) }}</span></td>
              <td class="max-w-56 truncate font-mono text-xs text-surface-400" :title="backup.filePath">{{ backup.filePath }}</td>
              <td class="whitespace-nowrap font-mono text-xs text-surface-400">{{ formatTime(backup.createdAt) }}</td>
              <td class="text-right">
                <button class="btn-secondary btn-sm" :disabled="busy" @click="restoreCompose(backup)"><RotateCcw class="h-3.5 w-3.5" />恢复</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 数据卷备份 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">数据卷备份</h2><p class="mt-1 text-muted">命名卷的 tar 备份,可恢复到指定时间点</p></div>
      <p v-if="loadErrors.volume" class="alert-error" role="alert">{{ loadErrors.volume }}</p>
      <EmptyState v-else-if="!loading && !volumeBackups.length" compact title="暂无数据卷备份" description="先为命名卷创建备份，再进行恢复或演练。"><router-link to="/resources?tab=backups&from=review" class="btn-secondary btn-sm">创建卷备份</router-link></EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead><tr><th>项目</th><th>卷</th><th>大小</th><th>时间</th><th class="text-right">操作</th></tr></thead>
          <tbody>
            <tr v-for="backup in volumeBackups" :key="backup.id" class="hover:bg-surface-800/25">
              <td class="font-medium text-surface-100">{{ backup.projectName }}</td>
              <td class="font-mono text-xs text-violet-300">{{ backup.volume }}</td>
              <td class="font-mono text-xs text-surface-400">{{ formatBytes(backup.bytes) }}</td>
              <td class="whitespace-nowrap font-mono text-xs text-surface-400">{{ formatTime(backup.createdAt) }}</td>
              <td class="text-right">
                <button class="btn-secondary btn-sm" :disabled="busy" @click="restoreVolume(backup)"><RotateCcw class="h-3.5 w-3.5" />恢复</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- GitOps 回滚 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">GitOps 回滚</h2><p class="mt-1 text-muted">将 GitOps 仓库工作区回滚到指定提交</p></div>
      <p v-if="loadErrors.gitops" class="alert-error" role="alert">{{ loadErrors.gitops }}</p>
      <EmptyState v-else-if="!loading && !gitopsRepos.length" compact title="暂无 GitOps 仓库" description="连接仓库后即可查看提交和恢复历史。"><router-link to="/gitops?from=review" class="btn-secondary btn-sm">添加仓库</router-link></EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead><tr><th>仓库</th><th>分支</th><th>最后同步</th><th class="text-right">操作</th></tr></thead>
          <tbody>
            <tr v-for="repo in gitopsRepos" :key="repo.id" class="hover:bg-surface-800/25">
              <td class="font-medium text-surface-100">{{ repo.name }}</td>
              <td class="font-mono text-xs text-surface-400">{{ repo.branch || 'main' }}</td>
              <td class="whitespace-nowrap font-mono text-xs text-surface-400">{{ repo.lastSync ? formatTime(repo.lastSync) : '—' }}</td>
              <td class="text-right">
                <button class="btn-secondary btn-sm" :disabled="busy" @click="openGitopsHistory(repo)"><History class="h-3.5 w-3.5" />历史</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 镜像升级回滚 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">升级配置恢复</h2><p class="mt-1 text-muted">仅展示有升级前 Compose 备份且当前非运行状态的项目；恢复配置并重建容器，不保证回退已拉取的镜像版本</p></div>
      <EmptyState v-if="!rollbackableProjectCount" compact title="当前没有可恢复的升级配置" description="完成升级并生成备份后，异常项目会出现在这里。"><router-link to="/services?from=review" class="btn-secondary btn-sm">查看服务</router-link></EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead><tr><th>项目</th><th>状态</th><th class="text-right">操作</th></tr></thead>
          <tbody>
            <tr v-for="project in rollbackableProjects" :key="project.id" class="hover:bg-surface-800/25">
              <td class="font-medium text-surface-100">{{ project.projectName }}</td>
              <td><span class="status-badge" :class="project.status === 'running' ? 'bg-status-ok/10 text-status-ok' : project.status === 'stopped' ? 'bg-surface-800/40 text-surface-400' : project.status === 'partial' ? 'bg-status-warn/10 text-status-warn' : 'bg-status-error/10 text-status-error'">{{ project.status === 'running' ? '运行中' : project.status === 'stopped' ? '已停止' : project.status === 'partial' ? '部分异常' : '异常' }}</span></td>
              <td class="text-right">
                <button class="btn-secondary btn-sm" :disabled="busy" @click="rollbackUpgrade(project)"><RotateCcw class="h-3.5 w-3.5" />恢复升级前配置</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- GitOps 历史弹窗 -->
    <BaseModal :show="showGitopsHistory" :title="`提交历史 · ${currentGitopsRepo?.name || ''}`" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[80vh] flex-col" body-class="flex-1 overflow-auto p-4 space-y-2" @close="showGitopsHistory = false">
      <EmptyState v-if="!gitopsCommits.length" compact title="暂无提交历史" description="关闭弹窗后检查仓库连接与同步状态。" action-label="关闭历史" @action="showGitopsHistory = false" />
      <div v-for="commit in gitopsCommits" :key="commit.hash" class="flex items-start gap-3 rounded-xl border border-surface-800 bg-surface-950/40 p-3">
        <code class="shrink-0 rounded-sm bg-surface-800 px-2 py-0.5 font-mono text-xs text-sky-300">{{ commit.hash.substring(0, 7) }}</code>
        <div class="min-w-0 flex-1">
          <p class="text-sm text-surface-200">{{ commit.message }}</p>
          <p class="mt-0.5 text-xs text-surface-400">{{ commit.author }} · {{ commit.date }}</p>
        </div>
        <button v-if="commit.hash !== currentGitopsRepo?.lastCommit" class="btn-secondary btn-sm" :disabled="busy" @click="rollbackGitops(commit.hash)"><RotateCcw class="h-3.5 w-3.5" />回滚</button>
        <span v-else class="count-badge text-status-ok">当前</span>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showGitopsHistory = false">关闭</button>
      </template>
    </BaseModal>

    <!-- 回滚输出抽屉 -->
    <BaseModal :show="output.open" :title="output.title" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[80vh] flex-col" body-class="flex min-h-0 flex-1 flex-col p-0" @close="output.open = false">
      <template #header-actions>
        <span v-if="output.open" role="status" aria-live="polite" aria-atomic="true" class="count-badge" :class="output.running ? 'text-sky-300' : output.status === 'failed' ? 'text-status-error' : output.status === 'cancelled' || output.status === 'unknown' ? 'text-status-warn' : 'text-status-ok'">{{ output.running ? '回滚执行中' : output.status === 'failed' ? '回滚失败' : output.status === 'cancelled' ? '回滚已中断' : output.status === 'unknown' ? '回滚结果未确认' : '回滚完成' }}</span>
      </template>
      <pre class="terminal-output max-h-[70vh] min-h-48 flex-1 overflow-auto p-4" role="region" aria-label="回滚执行输出" tabindex="0" aria-live="off" :aria-busy="output.running">{{ output.text || '等待输出...' }}</pre>
      <template #footer>
        <button class="btn-secondary" @click="output.open = false">关闭</button>
      </template>
    </BaseModal>

    <ConfirmDialog :show="!!confirmTarget" :title="confirmTarget?.title" :message="confirmTarget?.message" :tone="confirmTarget?.tone || 'warning'" :confirm-text="confirmTarget?.confirmText || '确认'" @confirm="confirmAction" @cancel="cancelConfirmation" />
  </div>
</template>

<script setup>
import MetricTile from '../components/common/MetricTile.vue';
import EmptyState from '../components/common/EmptyState.vue';
// embedded 模式供 ReleaseView 的 tab 复用,隐藏独立页头
const props = defineProps({ embedded: { type: Boolean, default: false }, projectId: { type: String, default: '' } });
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { FileCode2, GitBranch, HardDrive, History, RefreshCw, RotateCcw } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { getRollbackableProjects } from '../lib/rollback-projects.js';
import { useServicesStore } from '../stores/services.js';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import BaseModal from '../components/common/BaseModal.vue';

const emit = defineEmits(['busy', 'project-change']);
const store = useServicesStore();
const selectedProjectId = ref(props.projectId);
const selectedProject = computed(() => store.projects.find(p => p.id === selectedProjectId.value));
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const composeBackups = ref([]);
const volumeBackups = ref([]);
const gitopsRepos = ref([]);
const showGitopsHistory = ref(false);
const currentGitopsRepo = ref(null);
const gitopsCommits = ref([]);
const output = ref({ open: false, text: '', title: '', running: false, status: 'completed' });
const loadErrors = ref({ compose: '', volume: '', gitops: '' });
let loadRequestId = 0;
const confirmTarget = ref(null);
let pendingAction = null;
let rollbackController = null;
let active = true;
let disposed = false;
let needsReload = false;
let mountedReady = false;
let historyVersion = 0;
watch(busy, value => emit('busy', value), { flush: 'sync' });
function cancelConfirmation() { pendingAction = null; confirmTarget.value = null; }


const rollbackableProjects = computed(() => getRollbackableProjects(store.projects, composeBackups.value));
const rollbackableProjectCount = computed(() => rollbackableProjects.value.length);

function reasonLabel(reason) {
  if (reason === 'upgrade' || reason?.startsWith('upgrade:')) return '升级';
  return { save: '保存', restore: '恢复', 'env.apply': '环境变量' }[reason] || reason;
}
function formatTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatBytes(value = 0) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(value) || 0, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function load() {
  if (!active || disposed || busy.value) return;
  needsReload = false;
  cancelConfirmation();
  const requestId = ++loadRequestId;
  const requestedProjectId = selectedProjectId.value;
  loading.value = true;
  error.value = '';
  loadErrors.value = { compose: '', volume: '', gitops: '' };
  composeBackups.value = [];
  volumeBackups.value = [];
  gitopsRepos.value = [];
  if (requestedProjectId && !store.projects.some(project => project.id === requestedProjectId)) {
    error.value = '当前节点找不到此项目，请重新选择。'; loading.value = false; return;
  }
  try {
    const [volumeData, gitopsData] = await Promise.allSettled([
      api.getVolumeBackups(requestedProjectId),
      fetch('/api/v1/gitops').then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || `HTTP ${res.status}`);
        }
        return res.json();
      }),
    ]);
    if (requestId !== loadRequestId) return;
    if (volumeData.status === 'fulfilled') volumeBackups.value = volumeData.value.backups || [];
    else loadErrors.value.volume = `数据卷备份加载失败：${volumeData.reason?.message || '未知错误'}`;
    if (gitopsData.status === 'fulfilled') gitopsRepos.value = gitopsData.value?.repositories || [];
    else loadErrors.value.gitops = `GitOps 仓库加载失败：${gitopsData.reason?.message || '未知错误'}`;
    await loadComposeBackups(requestId, requestedProjectId);
  } catch (e) {
    if (requestId === loadRequestId) error.value = e.message || '加载失败';
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}
async function loadComposeBackups(requestId = loadRequestId, requestedProjectId = selectedProjectId.value) {
  const projects = (requestedProjectId
    ? store.projects.filter((p) => p.id === requestedProjectId)
    : store.projects
  ).filter((project) => project.managed);
  const results = await Promise.allSettled(projects.map((p) => api.getBackups(p.id)));
  if (requestId !== loadRequestId) return;
  const backups = [];
  const failures = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      for (const backup of result.value.backups || []) {
        const project = store.projects.find((p) => p.id === backup.projectId);
        backups.push({ ...backup, projectName: project?.projectName || backup.projectId });
      }
    } else {
      failures.push(projects[index]?.projectName || projects[index]?.id || '未知项目');
    }
  }
  composeBackups.value = backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  loadErrors.value = {
    ...loadErrors.value,
    compose: failures.length ? `部分 Compose 配置备份加载失败：${failures.join('、')}` : '',
  };
}
async function loadProject() {
  emit('project-change', selectedProjectId.value, selectedProject.value?.hostId);
  await load();
}

watch(() => props.projectId, id => {
  if (id === selectedProjectId.value) return;
  if (busy.value) { emit('project-change', selectedProjectId.value, selectedProject.value?.hostId); return; }
  cancelConfirmation(); loadRequestId++; historyVersion++; showGitopsHistory.value = false;
  selectedProjectId.value = id; needsReload = true;
  if (mountedReady && active) void load();
});

function restoreCompose(backup) {
  confirmTarget.value = {
    title: '恢复 Compose 配置',
    message: `节点「${selectedProject.value?.hostName || selectedProject.value?.hostId || '当前节点'}」，文件「${backup.filePath}」：确认将项目「${backup.projectName}」的配置恢复到 ${formatTime(backup.createdAt)} 的版本?`,
    tone: 'warning',
    confirmText: '恢复配置',
  };
  pendingAction = () => doRestoreCompose(backup);
}
async function doRestoreCompose(backup) {
  busy.value = true;
  output.value = { open: true, text: '', title: `恢复配置 · ${backup.projectName}`, running: true, status: 'running' };
  try {
    await api.restoreBackup(backup.projectId, backup.id);
    output.value.text += '配置已恢复,正在重建容器...\n';
    let exitCode = null;
    let streamReportedError = false;
    await api.streamRollback(backup.projectId, (frame) => {
      if (frame.type === 'stdout' || frame.type === 'stderr') output.value.text += frame.data;
      else if (frame.type === 'error') { streamReportedError = true; output.value.text += `\n[错误] ${frame.data}`; }
      else if (frame.type === 'exit') { exitCode = Number(frame.data?.code); output.value.text += `\n[退出码 ${frame.data.code}]`; }
    }, rollbackController?.signal);
    if (streamReportedError || exitCode !== 0) {
      output.value.status = exitCode === null && !streamReportedError ? 'unknown' : 'failed';
      if (exitCode === null && !streamReportedError) output.value.text += '\n[未收到 Compose 退出码，恢复结果未确认]';
      return;
    }
    output.value.status = 'completed';
    try { await store.refresh(true); } catch (refreshError) { output.value.text += `\n[恢复已完成，但刷新项目状态失败] ${refreshError.message}`; }
  } catch (e) {
    output.value.status = e.name === 'AbortError' ? 'cancelled' : 'failed';
    output.value.text += `\n[失败] ${e.message}`;
  } finally {
    busy.value = false;
    output.value.running = false;
  }
}

function restoreVolume(backup) {
  confirmTarget.value = {
    title: '恢复数据卷',
    message: `确认将卷「${backup.volume}」完整恢复到 ${formatTime(backup.createdAt)} 的快照?此操作会替换卷内全部内容，备份中不存在的文件也会被删除。恢复中途失败时系统会尝试补偿原数据；若补偿也失败，会保留应急备份记录供再次恢复。建议先停止正在写入的容器。`,
    tone: 'danger',
    confirmText: '恢复卷',
  };
  pendingAction = () => doRestoreVolume(backup);
}
async function doRestoreVolume(backup) {
  busy.value = true;
  output.value = { open: true, text: '', title: `恢复卷 · ${backup.volume}`, running: true, status: 'running' };
  try {
    const result = await api.restoreVolumeBackup(backup.id);
    output.value.status = 'completed';
    output.value.text += result?.message || '数据卷恢复完成\n';
  } catch (e) {
    output.value.status = 'failed';
    output.value.text += `\n[失败] ${e.message}`;
  } finally {
    busy.value = false;
    output.value.running = false;
  }
}

async function openGitopsHistory(repo) {
  const version = ++historyVersion;
  currentGitopsRepo.value = repo;
  try {
    const res = await fetch(`/api/v1/gitops/${repo.id}/history?limit=50`);
    if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
    const data = await res.json();
    if (!active || disposed || version !== historyVersion) return;
    gitopsCommits.value = data.commits || [];
    showGitopsHistory.value = true;
  } catch (e) {
    if (active && !disposed && version === historyVersion) error.value = e.message;
  }
}
function rollbackGitops(commitHash) {
  confirmTarget.value = {
    title: '回滚 GitOps 仓库',
    message: `确认将仓库「${currentGitopsRepo.value.name}」回滚到提交 ${commitHash.substring(0, 7)}?工作区会重置到该版本。`,
    tone: 'warning',
    confirmText: '确认回滚',
  };
  pendingAction = () => doRollbackGitops(commitHash);
}
async function doRollbackGitops(commitHash) {
  busy.value = true;
  try {
    const res = await fetch(`/api/v1/gitops/${currentGitopsRepo.value.id}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitHash }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || '回滚失败');
    }
    showGitopsHistory.value = false;
    needsReload = true;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
    if (needsReload && active) void load();
  }
}

function rollbackUpgrade(project) {
  confirmTarget.value = {
    title: '恢复升级前配置',
    message: '确认将项目「' + project.projectName + '」恢复到最近一次升级前的 Compose 配置并重建容器？注意：这不会保证回退已经拉取的镜像版本。',
    tone: 'warning',
    confirmText: '恢复配置',
  };
  pendingAction = () => doRollbackUpgrade(project);
}
async function doRollbackUpgrade(project) {
  busy.value = true;
  output.value = { open: true, text: '', title: '恢复升级前配置 · ' + project.projectName, running: true, status: 'running' };
  rollbackController?.abort();
  rollbackController = new AbortController();
  try {
    let exitCode = null;
    let streamReportedError = false;
    await api.streamRollback(project.id, (frame) => {
      if (frame.type === 'stdout' || frame.type === 'stderr') output.value.text += frame.data;
      else if (frame.type === 'error') { streamReportedError = true; output.value.text += `\n[错误] ${frame.data}`; }
      else if (frame.type === 'exit') { exitCode = Number(frame.data?.code); output.value.text += `\n[退出码 ${frame.data.code}]`; }
    }, rollbackController.signal);
    if (streamReportedError || exitCode !== 0) {
      output.value.status = exitCode === null && !streamReportedError ? 'unknown' : 'failed';
      if (exitCode === null && !streamReportedError) output.value.text += '\n[未收到 Compose 退出码，回滚结果未确认]';
      return;
    }
    output.value.status = 'completed';
    try { await store.refresh(true); } catch (refreshError) { output.value.text += `\n[恢复已完成，但刷新项目状态失败] ${refreshError.message}`; }
  } catch (e) {
    output.value.status = e.name === 'AbortError' ? 'cancelled' : 'failed';
    if (e.name !== 'AbortError') output.value.text += `\n[失败] ${e.message}`;
  } finally {
    rollbackController = null;
    busy.value = false;
    output.value.running = false;
  }
}

function confirmAction() {
  if (!active || disposed || busy.value) return;
  const action = pendingAction;
  pendingAction = null;
  confirmTarget.value = null;
  if (action) void action();
}

function deactivate() {
  active = false;
  loadRequestId += 1;
  historyVersion += 1;
  if (loading.value || !mountedReady) needsReload = true;
  loading.value = false;
  cancelConfirmation();
  showGitopsHistory.value = false;
  output.value.open = false;
}
function onHostChanged() {
  loadRequestId += 1;
  historyVersion += 1;
  cancelConfirmation();
  selectedProjectId.value = '';
  emit('project-change', '');
  composeBackups.value = [];
  volumeBackups.value = [];
  gitopsRepos.value = [];
  showGitopsHistory.value = false;
  needsReload = true;
  if (active && !busy.value) void load();
}
onActivated(() => { active = true; if (mountedReady && needsReload && !loading.value) void load(); });
onDeactivated(deactivate);
onBeforeUnmount(() => {
  disposed = true;
  deactivate();
  rollbackController?.abort();
  window.removeEventListener('composeops:host-changed', onHostChanged);
  emit('busy', false);
});
usePullRefresh(load, { keepAlive: true, enabled: () => !busy.value });
onMounted(async () => {
  window.addEventListener('composeops:host-changed', onHostChanged);
  await store.refresh(false);
  mountedReady = true;
  needsReload = true;
  if (!disposed && active) await load();
});
</script>
