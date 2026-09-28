<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">GitOps 集成</h1>
        <p class="page-subtitle">同步 Git 仓库,按提交查看与回滚代码版本</p>
      </div>
      <div class="page-actions">
        <button class="btn-primary" @click="openAddModal"><Plus class="h-4 w-4" />添加仓库</button>
      </div>
    </div>

    <!-- 漂移状态条 -->
    <div v-if="drift && drift.repos?.length" class="section-panel py-3! flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="font-medium text-surface-300">漂移检测</span>
        <span class="count-badge text-emerald-300">一致 {{ drift.counts?.clean || 0 }}</span>
        <span class="count-badge text-amber-300">有差异 {{ drift.counts?.diverged || 0 }}</span>
        <span class="count-badge text-sky-300">落后远端 {{ drift.counts?.behind || 0 }}</span>
        <span v-if="drift.counts?.detached" class="count-badge text-rose-300">游离提交 {{ drift.counts.detached }}</span>
        <span v-if="drift.scannedAt" class="text-surface-500">扫描于 {{ new Date(drift.scannedAt).toLocaleString('zh-CN') }}</span>
      </div>
      <button class="btn-secondary py-1.5! text-xs" @click="loadDrift">
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': driftLoading }" />重新检测
      </button>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>加载仓库...</p>
    </div>

    <EmptyState
      v-else-if="repos.length === 0"
      icon="Inbox"
      title="暂无 GitOps 仓库"
      description="添加第一个仓库开始同步代码:配置仓库地址、分支与本地路径,可开启自动同步与漂移检测。"
      action-label="添加仓库"
      @action="openAddModal"
    />

    <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <article v-for="repo in repos" :key="repo.id" class="card p-4 flex flex-col gap-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <h3 class="truncate text-base font-medium text-surface-100">{{ repo.name }}</h3>
            <p class="mt-1 truncate text-sm text-surface-400">{{ repo.url }}</p>
          </div>
          <span class="status-badge flex-none" :class="getStatusColor(repo.status)">{{ getStatusLabel(repo.status) }}</span>
        </div>

        <div v-if="driftMap[repo.id]" class="flex flex-col gap-2 rounded-lg border border-surface-800 bg-surface-950/40 p-3">
          <p class="flex items-start gap-2 text-xs leading-5 text-surface-300">
            <span :class="driftDotClass(driftMap[repo.id].status)"></span>
            <span class="min-w-0">{{ driftMap[repo.id].summary || '无漂移' }}</span>
          </p>
          <div v-if="driftMap[repo.id].drifts?.length" class="space-y-1">
            <p v-for="item in driftMap[repo.id].drifts.slice(0, 5)" :key="item.file"
              class="flex items-center gap-2 truncate font-mono text-[11px]" :class="item.type === 'deleted' ? 'text-rose-400' : 'text-amber-300'">
              <span class="shrink-0 rounded-sm border border-current/20 px-1">{{ item.type === 'deleted' ? '删除' : '修改' }}</span>
              <span class="truncate">{{ item.file }}</span>
            </p>
            <p v-if="driftMap[repo.id].drifts.length > 5" class="text-[11px] text-surface-500">等共 {{ driftMap[repo.id].drifts.length }} 处</p>
          </div>
          <div v-if="driftMap[repo.id].behind > 0" class="text-[11px] text-sky-300">
            落后远端 {{ driftMap[repo.id].behind }} 个提交,执行同步可拉齐
          </div>
          <div v-if="driftMap[repo.id].repairs?.length" class="flex flex-wrap gap-1.5">
            <span v-for="(repair, index) in driftMap[repo.id].repairs" :key="index"
              class="count-badge text-[11px]!">{{ repair.action === 'none' ? '无需处理' : repair.action }}</span>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p class="text-surface-500">分支</p>
            <p class="mt-1 font-medium text-surface-300">{{ repo.branch || 'main' }}</p>
          </div>
          <div>
            <p class="text-surface-500">自动同步</p>
            <p class="mt-1 font-medium text-surface-300">{{ repo.autoSync ? '开启' : '关闭' }}</p>
          </div>
        </div>

        <div v-if="repo.lastSync" class="text-xs text-surface-500">
          最后同步:{{ new Date(repo.lastSync).toLocaleString('zh-CN') }}
        </div>

        <div class="mt-auto flex flex-wrap gap-2 border-t border-surface-800 pt-3">
          <button class="btn-secondary px-2.5! py-1.5! text-xs flex-1" :disabled="syncingId === repo.id" @click="syncRepo(repo.id)">
            <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': syncingId === repo.id }" />同步
          </button>
          <button class="btn-secondary px-2.5! py-1.5! text-xs flex-1" @click="loadHistory(repo.id)">
            <History class="h-3.5 w-3.5" />历史
          </button>
          <button class="btn-secondary px-2.5! py-1.5! text-xs" @click="openEditModal(repo)">编辑</button>
          <button class="btn-danger px-2.5! py-1.5! text-xs" @click="deleteRepo(repo.id)">删除</button>
        </div>
      </article>
    </div>

    <!-- 添加/编辑仓库 -->
    <BaseModal
      :show="showAddModal || showEditModal"
      :title="showAddModal ? '添加仓库' : '编辑仓库'"
      size-class="max-w-lg!"
      body-class="p-6"
      @close="showAddModal = showEditModal = false"
    >
      <form @submit.prevent="showAddModal ? addRepo() : updateRepo()" class="space-y-4">
        <label class="block">
          <span class="text-xs font-medium text-surface-400">仓库名称</span>
          <input v-model="formData.name" required maxlength="200" class="input mt-1.5 w-full" placeholder="例:my-app" />
        </label>

        <label class="block">
          <span class="text-xs font-medium text-surface-400">Git URL(http(s)://、ssh:// 或 git@ 形式)</span>
          <input v-model="formData.url" required maxlength="500" class="input mt-1.5 w-full" placeholder="git@github.com:user/repo.git" />
        </label>

        <div class="grid grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-medium text-surface-400">分支</span>
            <input v-model="formData.branch" maxlength="100" class="input mt-1.5 w-full" placeholder="main" />
          </label>
          <label class="block">
            <span class="text-xs font-medium text-surface-400">关联项目</span>
            <select v-model="formData.projectId" required class="input mt-1.5 w-full">
              <option value="">选择项目</option>
              <option v-for="proj in projects" :key="proj.id" :value="proj.id">{{ proj.name }}</option>
            </select>
          </label>
        </div>

        <label class="block">
          <span class="text-xs font-medium text-surface-400">本地路径(绝对路径)</span>
          <input v-model="formData.localPath" required maxlength="500" class="input mt-1.5 w-full" placeholder="/path/to/local/repo" />
        </label>

        <label class="block">
          <span class="text-xs font-medium text-surface-400">SSH 私钥路径(可选)</span>
          <textarea v-model="formData.sshKey" rows="3" maxlength="10000" class="input mt-1.5 w-full font-mono text-xs" placeholder="/root/.ssh/id_ed25519"></textarea>
        </label>

        <label class="flex items-center gap-2 text-sm text-surface-300">
          <input v-model="formData.autoSync" type="checkbox" class="h-4 w-4 rounded-sm border-surface-700 bg-surface-900 accent-accent" />
          启用自动同步
        </label>

        <div class="flex gap-3 pt-2">
          <button type="button" class="btn-secondary flex-1 justify-center" @click="showAddModal = showEditModal = false">取消</button>
          <button type="submit" class="btn-primary flex-1 justify-center">{{ showAddModal ? '添加' : '保存' }}</button>
        </div>
      </form>
    </BaseModal>

    <!-- 提交历史 -->
    <BaseModal
      :show="showHistoryModal"
      :title="`提交历史 · ${currentRepo?.name || ''}`"
      size-class="max-w-2xl!"
      body-class="flex h-[65vh] flex-col overflow-hidden p-0"
      @close="showHistoryModal = false"
    >
      <div class="flex-1 overflow-auto p-6">
        <EmptyState v-if="commitHistory.length === 0" compact icon="History" title="暂无提交历史" description="仓库尚未克隆或没有任何提交记录。" />

        <div v-else class="space-y-3">
          <article v-for="commit in commitHistory" :key="commit.hash" class="flex items-start gap-4 rounded-lg border border-surface-800 bg-surface-950/40 p-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <code class="rounded-sm bg-surface-800 px-2 py-0.5 text-xs font-mono text-accent">{{ commit.hash.substring(0, 7) }}</code>
                <span class="text-xs text-surface-500">{{ commit.date }}</span>
              </div>
              <p class="mt-2 text-sm text-surface-300">{{ commit.message }}</p>
              <p class="mt-1 text-xs text-surface-500">{{ commit.author }}</p>
            </div>
            <button
              v-if="commit.hash !== currentRepo?.lastCommit"
              class="btn-secondary flex-none px-2.5! py-1.5! text-xs text-amber-300"
              @click="rollback(commit.hash)"
            >
              回滚
            </button>
            <span v-else class="status-badge flex-none bg-emerald-500/10 text-emerald-400">当前</span>
          </article>
        </div>
      </div>

      <template #footer>
        <button class="btn-secondary w-full justify-center" @click="showHistoryModal = false">关闭</button>
      </template>
    </BaseModal>
    <ConfirmDialog :show="!!deleteTarget" title="删除 GitOps 仓库" message="确认移除此 GitOps 配置?不会删除本地仓库文件。" tone="danger" confirm-text="删除仓库" @confirm="confirmDelete" @cancel="deleteTarget = null" />
    <ConfirmDialog :show="!!rollbackTarget" title="回滚 GitOps 仓库" :message="`确认回滚到提交 ${rollbackTarget?.slice(0, 7) || ''}?仓库工作区会重置到该版本。`" tone="warning" confirm-text="确认回滚" @confirm="confirmRollback" @cancel="rollbackTarget = null" />
  </div>
</template>

<script setup>
import { computed, ref, onActivated, onMounted } from 'vue';
import { History, Plus, RefreshCw } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { useToastStore } from '../stores/toast.js';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import BaseModal from '../components/common/BaseModal.vue';
import EmptyState from '../components/common/EmptyState.vue';

const toast = useToastStore();

function showNotification(type, title, message) {
  const text = message ? `${title}: ${message}` : title;
  toast[type](text);
}

const repos = ref([]);
const loading = ref(false);
const drift = ref(null);
const driftLoading = ref(false);
const syncingId = ref('');
const driftMap = computed(() => {
  const map = {};
  for (const item of drift.value?.repos || []) map[item.repoId] = item;
  return map;
});
function driftDotClass(status) {
  return {
    clean: 'w-2 h-2 rounded-full shrink-0 mt-1 bg-emerald-400',
    behind: 'w-2 h-2 rounded-full shrink-0 mt-1 bg-sky-400',
    diverged: 'w-2 h-2 rounded-full shrink-0 mt-1 bg-amber-400',
    detached: 'w-2 h-2 rounded-full shrink-0 mt-1 bg-rose-400',
    not_cloned: 'w-2 h-2 rounded-full shrink-0 mt-1 bg-surface-500',
    error: 'w-2 h-2 rounded-full shrink-0 mt-1 bg-rose-400',
  }[status] || 'w-2 h-2 rounded-full shrink-0 mt-1 bg-surface-500';
}
async function loadDrift() {
  driftLoading.value = true;
  try {
    drift.value = await api.getGitOpsDrift();
  } catch (err) {
    drift.value = null;
  } finally {
    driftLoading.value = false;
  }
}
const showAddModal = ref(false);
const showEditModal = ref(false);
const showHistoryModal = ref(false);
const currentRepo = ref(null);
const commitHistory = ref([]);
const deleteTarget = ref(null);
const rollbackTarget = ref(null);

const formData = ref({
  name: '',
  url: '',
  branch: 'main',
  localPath: '',
  projectId: '',
  autoSync: false,
  sshKey: '',
});

const projects = ref([]);

async function loadProjects() {
  try {
    const data = await api.getProjects();
    projects.value = (data.projects || []).map((proj) => ({ id: proj.id, name: proj.projectName || proj.name || proj.id }));
  } catch (err) {
    showNotification('error', '加载项目列表失败', err.message);
  }
}

async function loadRepos() {
  loading.value = true;
  try {
    const data = await api.getGitOpsRepos();
    repos.value = data.repositories || [];
  } catch (err) {
    showNotification('error', '加载仓库列表失败', err.message);
  } finally {
    loading.value = false;
  }
}

function openAddModal() {
  formData.value = {
    name: '',
    url: '',
    branch: 'main',
    localPath: '',
    projectId: '',
    autoSync: false,
    sshKey: '',
  };
  showAddModal.value = true;
}

function openEditModal(repo) {
  currentRepo.value = repo;
  formData.value = { ...repo };
  showEditModal.value = true;
}

async function addRepo() {
  try {
    await api.addGitOpsRepo(formData.value);
    showNotification('success', '仓库添加成功');
    showAddModal.value = false;
    await loadRepos();
  } catch (err) {
    showNotification('error', '添加仓库失败', err.message);
  }
}

async function updateRepo() {
  try {
    await api.updateGitOpsRepo(currentRepo.value.id, formData.value);
    showNotification('success', '仓库更新成功');
    showEditModal.value = false;
    await loadRepos();
  } catch (err) {
    showNotification('error', '更新仓库失败', err.message);
  }
}

async function deleteRepo(id) {
  deleteTarget.value = id;
}
async function confirmDelete() {
  const id = deleteTarget.value;
  deleteTarget.value = null;
  if (!id) return;
  try {
    await api.deleteGitOpsRepo(id);
    showNotification('success', '仓库删除成功');
    await loadRepos();
  } catch (err) {
    showNotification('error', '删除仓库失败', err.message);
  }
}

async function syncRepo(id) {
  if (syncingId.value) return;
  syncingId.value = id;
  try {
    const data = await api.syncGitOpsRepo(id);
    showNotification('success', data.hasChanges ? '同步成功,发现新提交' : '同步成功,无新提交');
    await loadRepos();
  } catch (err) {
    showNotification('error', '同步失败', err.message);
  } finally {
    syncingId.value = '';
  }
}

async function loadHistory(id) {
  currentRepo.value = repos.value.find(r => r.id === id);
  try {
    const data = await api.getGitOpsHistory(id, 50);
    commitHistory.value = data.commits || [];
    showHistoryModal.value = true;
  } catch (err) {
    showNotification('error', '加载历史失败', err.message);
  }
}

async function rollback(commitHash) {
  rollbackTarget.value = commitHash;
}
async function confirmRollback() {
  const commitHash = rollbackTarget.value;
  rollbackTarget.value = null;
  if (!commitHash || !currentRepo.value) return;
  try {
    await api.rollbackGitOpsRepo(currentRepo.value.id, commitHash);
    showNotification('success', '回滚成功');
    showHistoryModal.value = false;
    await loadRepos();
  } catch (err) {
    showNotification('error', '回滚失败', err.message);
  }
}

function getStatusColor(status) {
  // 与 StatusBadge 语义对齐:pending 是等待态用中性灰,error 才是红。
  const colors = {
    synced: 'bg-emerald-500/10 text-emerald-400',
    pending: 'bg-surface-800/40 text-surface-400',
    error: 'bg-rose-500/10 text-rose-400',
  };
  return colors[status] || 'bg-surface-800 text-surface-400';
}

function getStatusLabel(status) {
  const labels = {
    synced: '已同步',
    pending: '待同步',
    error: '错误',
  };
  return labels[status] || '未知';
}

onMounted(() => {
  loadProjects();
  loadRepos();
  loadDrift();
});
let activatedOnce = false;
onActivated(() => { if (!activatedOnce) { activatedOnce = true; return; } void loadProjects(); void loadRepos(); void loadDrift(); });

</script>
