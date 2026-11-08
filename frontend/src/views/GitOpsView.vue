<template>
  <div class="page-shell" :aria-busy="loading || driftLoading">
    <div class="page-header">
      <div>
        <h1 class="page-title">GitOps 集成</h1>
        <p class="page-subtitle">连接代码与工作区，让每一次变更都有迹可循</p>
      </div>
      <div class="page-actions">
        <button class="btn-primary" :disabled="operationBusy" @click="openAddModal"><Plus class="h-4 w-4" />添加仓库</button>
      </div>
    </div>

    <section class="gitops-overview" aria-label="GitOps 工作区概览">
      <div class="min-w-0 relative z-10">
        <p class="gitops-eyebrow"><GitBranch class="h-3.5 w-3.5" />版本可追溯 · 变更可检查</p>
        <h2 class="mt-3 text-lg font-medium text-surface-100">从一次提交，到稳妥的配置变更</h2>
        <p class="mt-2 max-w-xl text-sm leading-6 text-surface-400">同步和回滚会更新工作区文件。确认变更后，再到项目中应用配置。</p>
        <div class="gitops-steps" aria-label="GitOps 操作顺序"><span><b>01</b>同步工作区</span><span><b>02</b>检查配置</span><span><b>03</b>应用到容器</span></div>
        <p class="mt-4 text-xs text-surface-400">{{ repos.length }} 个仓库<span class="mx-2 text-surface-600">/</span>{{ syncedCount }} 个已同步工作区</p>
      </div>
      <SceneIllustration kind="gitops" :min-width="768" sizes="240px" class="gitops-art" eager />
    </section>
    <div v-if="feedback" ref="feedbackEl" tabindex="-1" :role="feedback.error ? 'alert' : 'status'" class="gitops-feedback" :class="{ 'is-error': feedback.error }">
      <p>{{ feedback.text }}</p>
      <div v-if="feedback.projectId" class="mt-3 flex flex-wrap gap-2">
        <RouterLink class="btn-primary btn-sm" :to="deepLink('/services', { focus: feedback.projectId, from: 'gitops' })">检查并应用配置<ArrowUpRight class="h-3.5 w-3.5" /></RouterLink>
        <RouterLink class="btn-secondary btn-sm" :to="deepLink('/compose', { projectId: feedback.projectId, from: 'gitops' })">查看配置文件</RouterLink>
      </div>
    </div>

    <!-- 漂移状态条：加载失败不能静默等同于“无漂移” -->
    <div v-if="(drift && drift.repos?.length) || driftLoading || driftError" class="section-panel py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="font-medium text-surface-300">漂移检测</span>
          <template v-if="drift && drift.repos?.length">
            <span class="count-badge text-status-ok">一致 {{ drift.counts?.clean || 0 }}</span>
            <span class="count-badge text-status-warn">有差异 {{ drift.counts?.diverged || 0 }}</span>
            <span class="count-badge text-sky-300">落后远端 {{ drift.counts?.behind || 0 }}</span>
            <span v-if="drift.counts?.not_cloned" class="count-badge text-surface-400">待克隆 {{ drift.counts.not_cloned }}</span>
            <span v-if="drift.counts?.error" class="count-badge text-status-error">扫描失败 {{ drift.counts.error }}</span>
            <span v-if="drift.counts?.detached" class="count-badge text-status-error">游离提交 {{ drift.counts.detached }}</span>
            <span v-if="drift.scannedAt" class="text-surface-400">扫描于 {{ new Date(drift.scannedAt).toLocaleString('zh-CN') }}</span>
          </template>
        </div>
        <p class="text-xs leading-5 text-surface-500">基于本地文件与最近拉取的远端引用检查；重新检测不会拉取远端新提交。</p>
        <p v-if="driftLoading" class="sr-only" role="status" aria-live="polite" aria-atomic="true">正在检测 GitOps 漂移状态</p>
        <p v-if="driftError" class="alert-error" role="alert">漂移检测失败：{{ driftError }}。现有结果可能已过期。</p>
      </div>
      <button class="btn-secondary btn-sm" :disabled="driftLoading" :aria-label="driftLoading ? '正在检测 GitOps 漂移状态' : '重新检测 GitOps 漂移状态'" @click="loadDrift">
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': driftLoading }" />{{ driftLoading ? '检测中…' : '重新检测' }}
      </button>
    </div>

    <p v-if="loading" class="sr-only" role="status" aria-live="polite" aria-atomic="true">正在加载 GitOps 仓库</p>
    <p v-if="repoError" class="alert-error" role="alert"><span class="min-w-0 flex-1">仓库列表加载失败：{{ repoError }}</span><button class="text-link shrink-0" :disabled="loading" @click="loadRepos">重试列表</button></p>
    <div v-if="loading && repos.length === 0" class="loading-state" aria-hidden="true">
      <div class="spinner"></div>
      <p>加载仓库...</p>
    </div>

    <EmptyState
      v-else-if="!loading && !repoError && repos.length === 0"
      icon="Inbox"
      title="暂无 GitOps 仓库"
      description="添加第一个仓库开始同步代码:配置仓库地址、分支与本地路径,可开启自动同步与漂移检测。"
      action-label="添加仓库"
      @action="openAddModal"
    />

    <div v-else-if="repos.length > 0" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3"><p class="text-xs text-surface-400">仓库工作区<span class="ml-2 text-surface-200">{{ visibleRepos.length }} / {{ repos.length }}</span></p><label class="gitops-search"><Search class="h-4 w-4" /><input v-model="search" type="search" aria-label="搜索 GitOps 仓库" placeholder="搜索仓库、分支或项目" /></label></div>
      <EmptyState v-if="!visibleRepos.length" compact icon="Search" title="没有匹配的仓库" description="尝试其他名称、分支或路径。" action-label="清除搜索" @action="search = ''" />
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <article v-for="repo in visibleRepos" :key="repo.id" class="card gitops-repo p-4 flex flex-col gap-4">
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
              class="flex items-center gap-2 truncate font-mono text-[11px]" :class="item.type === 'deleted' ? 'text-status-error' : 'text-status-warn'">
              <span class="shrink-0 rounded-sm border border-current/20 px-1">{{ item.type === 'deleted' ? '删除' : '修改' }}</span>
              <span class="truncate">{{ item.file }}</span>
            </p>
            <p v-if="driftMap[repo.id].drifts.length > 5" class="text-[11px] text-surface-400">等共 {{ driftMap[repo.id].drifts.length }} 处</p>
          </div>
          <div v-if="driftMap[repo.id].behind > 0" class="text-[11px] text-sky-300">
            落后远端 {{ driftMap[repo.id].behind }} 个提交,执行同步可拉齐
          </div>
          <div v-if="driftMap[repo.id].repairs?.length && !['not_cloned', 'error'].includes(driftMap[repo.id].status)" class="flex flex-wrap gap-1.5">
            <span v-for="(repair, index) in driftMap[repo.id].repairs" :key="index"
              :title="repair.description" class="count-badge text-[11px]">{{ repairLabel(repair.action) }}</span>
          </div>
        </div>

        <p v-if="repo.lastError" class="text-xs leading-5 text-status-error break-words">{{ repo.lastError }}</p>
        <div class="grid min-w-0 grid-cols-2 gap-3 text-xs">
          <div>
            <p class="text-surface-400">分支</p>
            <p class="mt-1 break-all font-medium text-surface-300">{{ repo.branch || 'main' }}</p>
          </div>
          <div>
            <p class="text-surface-400">自动同步</p>
            <p class="mt-1 font-medium text-surface-300">{{ repo.autoSync ? '开启' : '关闭' }}</p>
          </div>
        </div>

        <div class="gitops-checkout"><div class="flex min-w-0 flex-wrap items-center justify-between gap-2"><span class="truncate">{{ projectName(repo.projectId) }}</span><code v-if="repo.lastCommit">{{ repo.lastCommit.slice(0, 7) }}</code></div><p class="mt-1.5 text-xs text-surface-400">{{ repo.lastSync ? '最后同步 · ' + formatDate(repo.lastSync) : '尚未执行首次同步' }}</p><details class="mt-2"><summary>查看工作区路径</summary><p class="mt-2 break-all font-mono text-xs">{{ repo.localPath }}</p></details></div>

        <div class="mt-auto flex flex-wrap gap-2 border-t border-surface-800 pt-3">
          <button class="btn-secondary flex-1 btn-sm" :disabled="operationBusy" @click="syncRepo(repo.id)">
            <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': syncingId === repo.id }" />{{ syncingId === repo.id ? '同步中…' : '同步' }}
          </button>
          <button class="btn-secondary flex-1 btn-sm" :disabled="operationBusy" @click="loadHistory(repo.id)">
            <History class="h-3.5 w-3.5" />历史
          </button>
          <button class="btn-secondary btn-sm" :disabled="operationBusy" @click="openEditModal(repo)">编辑</button>
          <button class="btn-danger btn-sm" :disabled="operationBusy" @click="deleteRepo(repo.id)">删除</button>
        </div>
      </article>
      </div>
    </div>

    <!-- 添加/编辑仓库 -->
    <BaseModal
      :show="showAddModal || showEditModal"
      :title="showAddModal ? '添加仓库' : '编辑仓库'"
      size-class="sm:max-w-lg flex max-h-[90dvh] flex-col"
      body-class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
      :close-disabled="saving"
      @close="closeForm"
    >
      <form id="gitops-repo-form" @submit.prevent="showAddModal ? addRepo() : updateRepo()" class="space-y-4" :aria-busy="saving">
        <p v-if="formError" ref="formErrorEl" tabindex="-1" class="alert-error" role="alert">{{ formError }}。草稿已保留，可重试。</p>
        <p v-if="projectsError" class="alert-error" role="alert"><span class="min-w-0 flex-1">项目读取失败：{{ projectsError }}</span><button class="text-link shrink-0" type="button" :disabled="projectsLoading" @click="loadProjects">重试项目</button></p>
        <p v-if="projectsLoading" role="status" class="text-xs text-surface-400">正在读取可关联项目…</p>
        <fieldset :disabled="saving" class="min-w-0 space-y-4">
        <label class="block">
          <span class="text-xs font-medium text-surface-400">仓库名称</span>
          <input v-model="formData.name" required maxlength="200" class="input mt-1.5 w-full" aria-label="仓库名称" placeholder="例:my-app" />
        </label>

        <label class="block">
          <span class="text-xs font-medium text-surface-400">Git URL(http(s)://、ssh:// 或 git@ 形式)</span>
          <input v-model="formData.url" required maxlength="500" class="input mt-1.5 w-full" placeholder="git@github.com:user/repo.git" />
        </label>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label class="block">
            <span class="text-xs font-medium text-surface-400">分支</span>
            <input v-model="formData.branch" maxlength="100" class="input mt-1.5 w-full" placeholder="main" />
          </label>
          <label class="block">
            <span class="text-xs font-medium text-surface-400">关联项目</span>
            <select v-model="formData.projectId" required class="input mt-1.5 w-full">
              <option value="">选择项目</option>
              <option v-if="formData.projectId && !projects.some(project => project.id === formData.projectId)" :value="formData.projectId">{{ formData.projectId }}（当前关联）</option>
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
          <input v-model="formData.sshKey" aria-label="SSH 私钥路径(可选)" aria-describedby="gitops-ssh-hint" maxlength="10000" class="input mt-1.5 w-full font-mono text-xs" placeholder="/root/.ssh/id_ed25519" /><span id="gitops-ssh-hint" class="mt-1.5 block text-xs leading-5 text-surface-500">填写服务端可访问的密钥文件路径，无需粘贴私钥内容。</span>
        </label>

        <label class="flex items-center gap-2 text-sm text-surface-300">
          <input v-model="formData.autoSync" type="checkbox" class="h-4 w-4 rounded-sm border-surface-700 bg-surface-900 accent-accent" />
          启用自动同步
        </label>
        <p class="text-xs leading-5 text-surface-400">自动同步只更新工作区文件；回滚后仍会在下一次同步时恢复远端分支版本。</p>
        </fieldset>

      </form>
      <template #footer>
        <button type="button" class="btn-secondary flex-1 justify-center" :disabled="saving" @click="closeForm">取消</button>
        <button type="submit" form="gitops-repo-form" class="btn-primary flex-1 justify-center" :disabled="saving || !formData.projectId"><RefreshCw v-if="saving" class="h-4 w-4 animate-spin" />{{ saving ? '保存中…' : showAddModal ? '添加' : '保存' }}</button>
      </template>
    </BaseModal>

    <!-- 提交历史 -->
    <BaseModal
      :show="showHistoryModal"
      :title="`提交历史 · ${currentRepo?.name || ''}`"
      size-class="sm:max-w-2xl"
      body-class="flex h-[65vh] flex-col overflow-hidden p-0"
      :close-disabled="rollingBack"
      @close="closeHistory"
    >
      <div class="flex-1 overflow-auto p-4 sm:p-6" :aria-busy="historyLoading">
        <p v-if="historyLoading" class="sr-only" role="status" aria-live="polite" aria-atomic="true">正在加载 {{ currentRepo?.name || 'GitOps 仓库' }} 的提交历史</p>
        <p v-if="historyError" class="alert-error" role="alert">
          提交历史加载失败：{{ historyError }}
          <button type="button" class="ml-2 underline underline-offset-2" @click="loadHistory(currentRepo?.id)">重试</button>
        </p>
        <p class="mb-4 text-xs leading-5 text-surface-400">最近 100 条提交 · 回滚只更新工作区，需检查后另行应用到容器。</p>
        <HistoryControls v-model:page="page" v-model:sort-key="sortKey" v-model:descending="descending" :total="total" :page-size="pageSize" :options="sortOptions" label="提交历史" />
        <EmptyState v-if="!historyLoading && !historyError && commitHistory.length === 0" compact icon="History" title="暂无提交历史" description="仓库尚未克隆或没有任何提交记录。" />

        <div v-if="commitHistory.length > 0" class="gitops-history space-y-3">
          <article v-for="commit in pagedRows" :key="commit.hash" class="flex flex-col items-start gap-3 rounded-lg border border-surface-800 bg-surface-950/40 p-3 sm:flex-row sm:gap-4 sm:p-4">
            <div class="flex-1 min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <code class="rounded-sm bg-surface-800 px-2 py-0.5 text-xs font-mono text-status-info">{{ commit.hash.substring(0, 7) }}</code>
                <span class="text-xs text-surface-400">{{ formatDate(commit.date) }}</span>
              </div>
              <p class="mt-2 break-words text-sm text-surface-300">{{ commit.message }}</p>
              <p class="mt-1 break-words text-xs text-surface-400">{{ commit.author }}</p>
            </div>
            <button
              v-if="commit.hash !== currentRepo?.lastCommit"
              class="btn-secondary flex-none text-status-warn btn-sm"
              :disabled="operationBusy"
              @click="rollback(commit.hash)"
            >
              回滚
            </button>
            <span v-else class="status-badge flex-none bg-status-ok/10 text-status-ok">当前</span>
          </article>
        </div>
      </div>

      <template #footer>
        <button class="btn-secondary w-full justify-center" :disabled="rollingBack" @click="closeHistory">关闭</button>
      </template>
    </BaseModal>
    <ConfirmDialog :show="!!deleteTarget" title="删除 GitOps 仓库" :message="`确认移除 ${deleteTarget?.name || ''} 的 GitOps 配置？本地仓库文件会保留。`" tone="danger" :busy="deleting" :confirm-text="deleting ? '删除中…' : '删除仓库'" @confirm="confirmDelete" @cancel="!deleting && (deleteTarget = null)"><p v-if="deleteError" class="text-status-error text-xs" role="alert">{{ deleteError }}。可重试删除。</p></ConfirmDialog>
    <ConfirmDialog :show="!!rollbackTarget" title="回滚 GitOps 仓库" :message="`确认将 ${rollbackTarget?.repo.name || ''} 回滚到提交 ${rollbackTarget?.hash.slice(0, 7) || ''}？这会更新工作区文件，不会应用到容器。仓库将进入游离提交状态，之后手动或自动同步会恢复配置分支版本。`" tone="warning" :busy="rollingBack" :confirm-text="rollingBack ? '回滚中…' : '确认回滚'" @confirm="confirmRollback" @cancel="!rollingBack && (rollbackTarget = null)"><p v-if="rollbackError" class="text-status-error text-xs" role="alert">{{ rollbackError }}。目标版本已保留，可重试。</p></ConfirmDialog>
  </div>
</template>

<script setup>
import { computed, ref, nextTick, watch, onActivated, onDeactivated, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { GitBranch, History, Plus, RefreshCw, Search, ArrowUpRight } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { deepLink } from '../lib/deep-links.js';
import { useToastStore } from '../stores/toast.js';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { usePagedRows } from '../composables/usePagedRows.js';
import HistoryControls from '../components/common/HistoryControls.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import BaseModal from '../components/common/BaseModal.vue';
import EmptyState from '../components/common/EmptyState.vue';
import SceneIllustration from '../components/common/SceneIllustration.vue';

const route = useRoute();
const toast = useToastStore();
const repos = ref([]);
const loading = ref(false);
const repoError = ref('');
const search = ref('');
const visibleRepos = computed(() => {
  const query = search.value.trim().toLowerCase();
  return repos.value.filter(repo => !query || [repo.name, repo.url, repo.branch, repo.localPath, projectName(repo.projectId)].some(value => String(value || '').toLowerCase().includes(query)));
});
const syncedCount = computed(() => repos.value.filter(repo => repo.status === 'synced').length);
const drift = ref(null);
const driftLoading = ref(false);
const driftError = ref('');
const projects = ref([]);
const projectsLoading = ref(false);
const projectsError = ref('');
const showAddModal = ref(false);
const showEditModal = ref(false);
const showHistoryModal = ref(false);
const currentRepo = ref(null);
const editRepoId = ref('');
const commitHistory = ref([]);
const historyLoading = ref(false);
const historyError = ref('');
const deleteTarget = ref(null);
const rollbackTarget = ref(null);
const saving = ref(false);
const deleting = ref(false);
const rollingBack = ref(false);
const syncingId = ref('');
const formError = ref('');
const formErrorEl = ref(null);
const deleteError = ref('');
const rollbackError = ref('');
const feedback = ref(null);
const feedbackEl = ref(null);
const operationBusy = computed(() => saving.value || deleting.value || rollingBack.value || !!syncingId.value);
const emptyForm = () => ({ name: '', url: '', branch: 'main', localPath: '', projectId: '', autoSync: false, sshKey: '' });
const formData = ref(emptyForm());
let active = true;
let contextVersion = 0;
let reposRequestId = 0;
let driftRequestId = 0;
let projectsRequestId = 0;
let historyRequestId = 0;
let mutationRequestId = 0;
let consumedHistoryRepo = '';
const current = version => active && version === contextVersion;
const driftMap = computed(() => Object.fromEntries((drift.value?.repos || []).map(item => [item.repoId, item])));
function projectName(id) { return projects.value.find(item => item.id === id)?.name || id || '未关联项目'; }
function driftDotClass(status) {
  return 'w-2 h-2 rounded-full shrink-0 mt-1 ' + ({ clean: 'bg-status-ok', behind: 'bg-sky-400', diverged: 'bg-status-warn', detached: 'bg-status-error', error: 'bg-status-error' }[status] || 'bg-surface-500');
}
function repairLabel(action) { return { none: '无需处理', checkout: '同步回配置分支', 'commit-or-restore': '提交或恢复本地改动', sync: '同步远端提交' }[action] || '检查工作区'; }
function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : value || '尚未同步';
}
async function loadProjects() {
  if (!active) return;
  const request = ++projectsRequestId;
  projectsLoading.value = true; projectsError.value = '';
  try {
    const data = await api.getProjects(true);
    if (active && request === projectsRequestId) projects.value = (data.projects || []).map(item => ({ id: item.id, name: item.projectName || item.name || item.id }));
  } catch (error) {
    if (active && request === projectsRequestId) projectsError.value = error.message || '项目读取失败';
  } finally { if (active && request === projectsRequestId) projectsLoading.value = false; }
}
async function loadDrift() {
  if (!active) return;
  const request = ++driftRequestId;
  driftLoading.value = true; driftError.value = '';
  try {
    const data = await api.getGitOpsDrift();
    if (active && request === driftRequestId) {
      const rows = Array.isArray(data) ? data : data?.repos;
      if (!Array.isArray(rows)) throw new Error('漂移响应格式不完整，请重试');
      const counts = Array.isArray(data) ? rows.reduce((result, row) => { result[row.status] = (result[row.status] || 0) + 1; return result; }, {}) : data.counts || {};
      const scannedAt = Array.isArray(data) ? rows.map(row => row.scannedAt).filter(Boolean).sort().at(-1) : data.scannedAt;
      drift.value = { repos: rows, counts, scannedAt };
    }
  } catch (error) {
    if (active && request === driftRequestId) driftError.value = error.message || '漂移读取失败';
  } finally { if (active && request === driftRequestId) driftLoading.value = false; }
}
function consumeHistoryLink() {
  const id = String(route.query.repo || '');
  if (!active || !id || consumedHistoryRepo === id || !repos.value.some(repo => repo.id === id)) return;
  consumedHistoryRepo = id;
  void loadHistory(id);
}
async function loadRepos() {
  if (!active) return;
  const request = ++reposRequestId;
  loading.value = true; repoError.value = '';
  try {
    const data = await api.getGitOpsRepos();
    if (!active || request !== reposRequestId) return;
    repos.value = data.repositories || [];
    if (currentRepo.value) currentRepo.value = repos.value.find(repo => repo.id === currentRepo.value.id) || currentRepo.value;
    consumeHistoryLink();
  } catch (error) {
    if (active && request === reposRequestId) repoError.value = error.message || '仓库读取失败';
  } finally { if (active && request === reposRequestId) loading.value = false; }
}
watch(() => route.query.repo, () => { consumedHistoryRepo = ''; consumeHistoryLink(); });
function editableFields(repo) {
  return { name: String(repo.name || '').trim(), url: String(repo.url || '').trim(), branch: String(repo.branch || 'main').trim(), localPath: String(repo.localPath || '').trim(), projectId: String(repo.projectId || ''), autoSync: !!repo.autoSync, sshKey: String(repo.sshKey || '').trim() };
}
function closeForm() { if (!saving.value) { showAddModal.value = false; showEditModal.value = false; } }
function openAddModal() {
  if (operationBusy.value || !active) return;
  formData.value = emptyForm(); editRepoId.value = ''; formError.value = '';
  showEditModal.value = false; showAddModal.value = true;
}
function openEditModal(repo) {
  if (operationBusy.value || !active) return;
  editRepoId.value = repo.id; formData.value = editableFields(repo); formError.value = '';
  showAddModal.value = false; showEditModal.value = true;
}
function beginMutation() {
  ++reposRequestId; ++driftRequestId;
  loading.value = false; driftLoading.value = false;
  feedback.value = null;
  return { version: contextVersion, request: ++mutationRequestId };
}
const currentMutation = token => current(token.version) && token.request === mutationRequestId;
function patchRepo(repo) {
  const existing = repos.value.find(item => item.id === repo.id);
  if (existing) Object.assign(existing, repo); else repos.value = [...repos.value, repo];
  if (currentRepo.value?.id === repo.id) currentRepo.value = { ...currentRepo.value, ...repo };
}
async function announce(text, projectId = '', error = false) {
  feedback.value = { text, projectId, error };
  toast[error ? 'error' : 'success'](text);
  await nextTick();
  feedbackEl.value?.focus({ preventScroll: true });
  feedbackEl.value?.scrollIntoView?.({ block: 'nearest' });
}
function refreshAfterMutation(token) {
  void Promise.all([loadRepos(), loadDrift()]).then(async () => {
    await nextTick();
    if (currentMutation(token) && document.activeElement === feedbackEl.value) feedbackEl.value?.scrollIntoView?.({ block: 'nearest' });
  });
}
async function saveRepo(editing) {
  if (operationBusy.value || !active) return;
  const id = editRepoId.value;
  if (editing && !id) return;
  const payload = editableFields(formData.value);
  const token = beginMutation(); saving.value = true; formError.value = '';
  try {
    const repo = editing ? await api.updateGitOpsRepo(id, payload) : await api.addGitOpsRepo(payload);
    if (!currentMutation(token)) return;
    patchRepo(repo); showAddModal.value = false; showEditModal.value = false; search.value = '';
    await announce(editing ? '仓库配置已保存；下次同步使用新配置。' : '仓库已添加，可执行首次同步拉取工作区文件。');
    if (currentMutation(token)) refreshAfterMutation(token);
  } catch (error) {
    if (currentMutation(token)) {
      formError.value = error.message || '保存失败，请重试';
      await nextTick();
      if (currentMutation(token)) { formErrorEl.value?.focus({ preventScroll: true }); formErrorEl.value?.scrollIntoView?.({ block: 'nearest' }); }
    }
  }
  finally { if (currentMutation(token)) saving.value = false; }
}
function addRepo() { return saveRepo(false); }
function updateRepo() { return saveRepo(true); }
function deleteRepo(id) {
  if (operationBusy.value || !active) return;
  deleteTarget.value = { ...repos.value.find(repo => repo.id === id) }; deleteError.value = '';
}
async function confirmDelete() {
  const repo = deleteTarget.value;
  if (!repo?.id || operationBusy.value || !active) return;
  const token = beginMutation(); deleting.value = true; deleteError.value = '';
  try {
    await api.deleteGitOpsRepo(repo.id);
    if (!currentMutation(token)) return;
    repos.value = repos.value.filter(item => item.id !== repo.id); deleteTarget.value = null;
    if (currentRepo.value?.id === repo.id) closeHistory();
    await announce(`仓库 ${repo.name} 的 GitOps 配置已删除，本地文件保留。`);
    if (currentMutation(token)) refreshAfterMutation(token);
  } catch (error) { if (currentMutation(token)) deleteError.value = error.message || '删除失败，请重试'; }
  finally { if (currentMutation(token)) deleting.value = false; }
}
async function syncRepo(id) {
  if (operationBusy.value || !active) return;
  const repo = repos.value.find(item => item.id === id);
  if (!repo) return;
  const token = beginMutation(); syncingId.value = id;
  try {
    const data = await api.syncGitOpsRepo(id);
    if (!currentMutation(token)) return;
    patchRepo({ id, lastCommit: data.commit, lastSync: data.syncedAt, status: 'synced', lastError: null });
    await announce(`${repo.name} 工作区已同步${data.hasChanges ? '到新提交' : ''}，尚未应用到容器。`, repo.projectId);
    if (currentMutation(token)) refreshAfterMutation(token);
  } catch (error) {
    if (currentMutation(token)) { await announce(`同步失败：${error.message}。可检查仓库后重新同步。`, '', true); if (currentMutation(token)) refreshAfterMutation(token); }
  } finally { if (currentMutation(token)) syncingId.value = ''; }
}
function closeHistory() {
  if (rollingBack.value) return;
  ++historyRequestId; showHistoryModal.value = false; historyLoading.value = false;
}
async function loadHistory(id) {
  const repo = repos.value.find(item => item.id === id);
  if (!repo || !active || rollingBack.value) return;
  const request = ++historyRequestId;
  if (currentRepo.value?.id !== id) { commitHistory.value = []; page.value = 1; }
  currentRepo.value = repo; historyError.value = ''; historyLoading.value = true; showHistoryModal.value = true;
  try {
    const data = await api.getGitOpsHistory(id, 100);
    if (active && request === historyRequestId && showHistoryModal.value) commitHistory.value = data.commits || [];
  } catch (error) {
    if (active && request === historyRequestId && showHistoryModal.value) historyError.value = error.message || '历史读取失败';
  } finally { if (active && request === historyRequestId) historyLoading.value = false; }
}
function rollback(hash) {
  if (operationBusy.value || !active || !currentRepo.value) return;
  ++historyRequestId; historyLoading.value = false;
  rollbackTarget.value = { repo: { ...currentRepo.value }, hash }; rollbackError.value = '';
}
async function confirmRollback() {
  const target = rollbackTarget.value;
  if (!target || operationBusy.value || !active) return;
  const token = beginMutation(); rollingBack.value = true; rollbackError.value = '';
  try {
    const data = await api.rollbackGitOpsRepo(target.repo.id, target.hash);
    if (!currentMutation(token)) return;
    patchRepo({ id: target.repo.id, lastCommit: data.commit, status: 'rolled_back', lastError: null });
    rollbackTarget.value = null; showHistoryModal.value = false;
    await announce(`${target.repo.name} 工作区已回滚到 ${data.commit.slice(0, 7)}，尚未应用到容器。`, target.repo.projectId);
    if (currentMutation(token)) refreshAfterMutation(token);
  } catch (error) { if (currentMutation(token)) rollbackError.value = error.message || '回滚失败，请重试'; }
  finally { if (currentMutation(token)) rollingBack.value = false; }
}
function getStatusColor(status) {
  return { synced: 'bg-status-ok/10 text-status-ok', rolled_back: 'bg-status-warn/10 text-status-warn', pending: 'bg-surface-800/40 text-surface-400', error: 'bg-status-error/10 text-status-error' }[status] || 'bg-surface-800 text-surface-400';
}
function getStatusLabel(status) { return { synced: '已同步', rolled_back: '已回滚', pending: '待同步', error: '错误' }[status] || '未知'; }
function invalidateContext() {
  ++contextVersion; ++mutationRequestId; ++reposRequestId; ++driftRequestId; ++historyRequestId; ++projectsRequestId;
  saving.value = deleting.value = rollingBack.value = loading.value = driftLoading.value = projectsLoading.value = historyLoading.value = false;
  syncingId.value = ''; showAddModal.value = showEditModal.value = showHistoryModal.value = false;
  deleteTarget.value = rollbackTarget.value = null; feedback.value = null;
}
function refreshAll() { return Promise.all([loadProjects(), loadRepos(), loadDrift()]); }
function hostChanged() {
  invalidateContext(); repos.value = []; projects.value = []; drift.value = null; consumedHistoryRepo = '';
  if (active) void refreshAll();
}
usePullRefresh(refreshAll, { keepAlive: true });
onMounted(() => { window.addEventListener('composeops:host-changed', hostChanged); void refreshAll(); });
let activatedOnce = false;
onActivated(() => { active = true; if (!activatedOnce) { activatedOnce = true; return; } void refreshAll(); });
onDeactivated(() => { active = false; invalidateContext(); });
onBeforeUnmount(() => { active = false; invalidateContext(); window.removeEventListener('composeops:host-changed', hostChanged); });
const { rows: pagedRows, page, pageSize, total, sortKey, descending } = usePagedRows(commitHistory, { date: item => Date.parse(item.date) || 0, author: item => item.author, message: item => item.message }, 'date');
const sortOptions = [{ key: 'date', label: '提交时间' }, { key: 'author', label: '作者' }, { key: 'message', label: '提交摘要' }];
</script>

<style scoped>
.gitops-overview { position: relative; overflow: hidden; display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; padding: 1.5rem; border: 1px solid var(--color-surface-800); border-radius: 1rem; background: radial-gradient(ellipse at 92% 40%, rgb(16 185 129 / .06), transparent 60%), var(--color-surface-900); }
.gitops-eyebrow { display: flex; align-items: center; gap: .5rem; color: var(--color-status-ok); font-size: .7rem; letter-spacing: .08em; }
.gitops-art { width: 240px; margin: -1.5rem -.5rem; }
.gitops-steps { display: flex; flex-wrap: wrap; gap: .75rem 1.25rem; margin-top: 1.25rem; font-size: .7rem; color: var(--color-surface-300); }
.gitops-steps span { display: inline-flex; align-items: center; gap: .5rem; }
.gitops-steps b { font: 500 .6rem ui-monospace, monospace; color: var(--color-status-ok); border: 1px solid rgb(16 185 129 / .2); border-radius: .3rem; padding: .25rem; }
.gitops-feedback { border: 1px solid rgb(16 185 129 / .3); border-radius: .75rem; padding: 1rem; background: rgb(16 185 129 / .06); font-size: .85rem; line-height: 1.6; outline-offset: 3px; }
.gitops-feedback.is-error { border-color: rgb(239 68 68 / .3); background: rgb(239 68 68 / .06); }
.gitops-search { display: flex; align-items: center; gap: .5rem; min-width: 0; max-width: 100%; padding: .6rem .75rem; border: 1px solid var(--color-surface-700); border-radius: .6rem; color: var(--color-surface-400); background: var(--color-surface-900); }
.gitops-search:focus-within { border-color: var(--color-accent); }
.gitops-search input { width: 15rem; max-width: 100%; min-width: 0; background: transparent; outline: none; font-size: .75rem; }
.gitops-repo { min-width: 0; transition: border-color 160ms ease, box-shadow 160ms ease; }
.gitops-repo:hover, .gitops-repo:focus-within { border-color: rgb(110 231 183 / .25); box-shadow: 0 6px 20px rgb(0 0 0 / .12); }
.gitops-checkout { min-width: 0; padding: .75rem; border-radius: .5rem; background: rgb(0 0 0 / .12); color: var(--color-surface-300); font-size: .75rem; }
.gitops-checkout code { color: var(--color-status-ok); font-size: .7rem; }
.gitops-checkout summary { cursor: pointer; width: fit-content; color: var(--color-surface-400); font-size: .7rem; }
.gitops-history { padding-top: .5rem; }
@media (max-width: 767px) { .gitops-art { display: none; } .gitops-overview { padding: 1rem; } .gitops-search { width: 100%; } .gitops-search input { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .gitops-repo { transition: none; } }
</style>
