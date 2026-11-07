<template>
  <div class="marketplace-view" :aria-busy="loading || (statsLoading && !statsLoaded)">
    <header class="page-header">
      <div>
        <h1>应用市场</h1>
        <p class="page-subtitle">浏览、收藏并一键部署 Compose 应用模板</p>
      </div>
<div class="page-actions page-actions-market">
        <button @click="openAgentRecommend" class="btn-secondary"><Bot class="w-4 h-4" />让 Agent 推荐</button>
        <button @click="openAiDiscover" class="btn-secondary" :disabled="aiDiscovering"><Sparkles class="w-4 h-4" :class="{ 'animate-pulse': aiDiscovering }" />{{ aiDiscovering ? 'AI 查找中...' : 'AI 找应用' }}</button>
        <button @click="showCreateModal = true" class="btn-primary">
          <span class="icon">+</span>
          创建模板
        </button>
      </div>
    </header>

    <section class="market-browser" aria-label="查找应用模板">
      <div class="filter-bar">
        <div class="search-box">
          <Search class="search-icon" aria-hidden="true" />
          <input v-model="searchQuery" type="text" aria-label="搜索应用模板" placeholder="搜索应用名称或用途…" class="input search-input" @input="handleSearch" />
          <button v-if="searchQuery" class="search-clear" aria-label="清空模板搜索" @click="clearSearch"><X class="h-4 w-4" /></button>
        </div>
        <select v-model="selectedCategory" @change="loadTemplates" class="input filter-select" aria-label="筛选模板分类">
          <option value="all">全部分类</option>
          <option v-for="cat in stats.categories" :key="cat" :value="cat">{{ categoryLabel(cat) }}</option>
        </select>
      </div>
      <div class="market-scope-row">
        <div class="source-filters" role="group" aria-label="筛选模板来源">
          <button class="scope-chip" :aria-pressed="selectedSource === 'all'" @click="filterBySource('all')">全部模板</button>
          <button class="scope-chip" :aria-pressed="selectedSource === 'builtin'" @click="filterBySource('builtin')">内置模板 <span v-if="statsLoaded">{{ stats.totalBuiltin }}</span></button>
          <button v-if="stats.communityAvailable" class="scope-chip" :aria-pressed="selectedSource === 'community'" @click="filterBySource('community')">社区模板 <span v-if="statsLoaded">{{ stats.totalCommunity }}</span></button>
          <button class="scope-chip" :aria-pressed="selectedSource === 'custom'" @click="filterBySource('custom')">自定义模板 <span v-if="statsLoaded">{{ stats.totalCustom }}</span></button>
        </div>
        <button class="scope-chip favorites-filter" :aria-pressed="onlyFavorites" @click="filterFavorites"><Star class="h-3.5 w-3.5" :fill="onlyFavorites ? 'currentColor' : 'none'" />我的收藏 <span v-if="statsLoaded">{{ stats.totalFavorites }}</span></button>
      </div>
    </section>
    <p v-if="statsLoading && !statsLoaded" class="sr-only" role="status">正在加载应用市场统计</p>
    <p v-if="statsError" class="alert-error" role="alert">
      应用市场统计加载失败：{{ statsError }}<span v-if="statsLoaded">，以下显示的是上次成功读取的数据。</span><span v-else>，统计数据暂不可用。</span>
      <button type="button" class="ml-2 underline underline-offset-2" @click="loadStats">重试统计</button>
    </p>
    <div class="market-results" role="status" aria-live="polite">
      <span>{{ loading ? '正在查找模板…' : `找到 ${filteredTemplates.length} 个模板` }}<span v-if="selectedCategory !== 'all'"> · {{ categoryLabel(selectedCategory) }}</span></span>
      <button v-if="hasFilters" class="btn-ghost" @click="clearFilters">重置筛选</button>
      <span v-else-if="statsLoaded && !stats.communityAvailable" class="market-source-note">内置与自定义模板</span>
    </div>
    <Skeleton v-if="loading && !filteredTemplates.length" variant="cards" :rows="4" label="正在加载应用模板" />

    <div v-else-if="error" class="error-state" role="alert">
      <p>{{ error }}</p>
      <button @click="loadTemplates" class="btn-secondary btn-retry">重试</button>
    </div>

    <EmptyState
      v-else-if="!filteredTemplates.length"
      icon="Search"
      title="没有匹配的模板"
      description="调整搜索关键字或分类筛选,或通过 AI 找应用创建自定义模板。"
    >
      <button class="btn-secondary" @click="clearFilters">清除筛选条件</button>
    </EmptyState>

    <!-- 模板列表 -->
    <section v-else class="templates-grid">
      <div
        v-for="template in filteredTemplates"
        :key="template.id"
        class="template-card"
        :class="{ featured: template.featured }"
      >
        <div class="card-header">
          <span class="template-avatar" :data-category="template.category"><component :is="categoryIcon(template.category)" class="h-6 w-6" aria-hidden="true" /></span>
          <div class="template-heading"><h2>{{ template.name }}</h2><span class="template-kind">{{ categoryLabel(template.category) }} · {{ getSourceLabel(template.id) }}</span></div>
          <button
            @click="toggleFavorite(template.id)"
            :disabled="favoritePending.has(template.id)"
            :aria-busy="favoritePending.has(template.id)"
            class="favorite-btn"
            :class="{ active: template.favorited }"
            :aria-label="template.favorited ? `取消收藏：${template.name}` : `收藏：${template.name}`"
            :aria-pressed="Boolean(template.favorited)"
          >
            <Star class="h-5 w-5" :fill="template.favorited ? 'currentColor' : 'none'" />
          </button>
        </div>
        <div class="card-body">
          <span v-if="template.featured" class="featured-badge">精选模板</span>
          <p class="description">{{ template.description || '暂无描述' }}</p>
          <div v-if="template.author" class="author">作者: {{ template.author }}</div>
          <div v-if="template.downloads" class="stats-row">
            <span>下载: {{ template.downloads }}</span>
            <span v-if="template.rating">评分: {{ template.rating }}/5</span>
          </div>
        </div>
        <div class="card-actions">
          <button @click="viewTemplate(template)" class="btn-secondary btn-view">查看</button>
          <button v-if="isDeployableTemplate(template)" @click="openDeploy(template)" class="btn-secondary btn-deploy">
            <Rocket class="w-4 h-4" />部署
          </button>
          <button
            v-if="isCustomTemplate(template)"
            @click="editTemplate(template)"
            class="btn-secondary btn-edit"
          >
            编辑
          </button>
          <button
            v-if="isCustomTemplate(template)"
            @click="deleteTemplate(template.id)"
            class="btn-ghost btn-delete"
          >
            删除
          </button>
        </div>
      </div>
    </section>

    <!-- 创建/编辑模态框 -->
    <BaseModal :show="showCreateModal || !!editingTemplate" :close-disabled="savingTemplate" :title="editingTemplate ? '编辑模板' : '创建模板'" @close="closeModal" size-class="max-w-3xl max-h-[88dvh] flex flex-col" body-class="min-h-0 overflow-y-auto p-5 space-y-4">
          <div class="form-group">
            <label for="market-template-name">模板名称</label>
            <input id="market-template-name" v-model="formData.name" type="text" class="input" placeholder="例如: LNMP Stack" />
          </div>
          <div class="form-group">
            <label for="market-template-category">分类</label>
            <input id="market-template-category" v-model="formData.category" type="text" class="input" placeholder="例如: Web" />
          </div>
          <div class="form-group">
            <label for="market-template-description">描述</label>
            <textarea id="market-template-description" v-model="formData.description" rows="3" class="input" placeholder="简要描述模板用途"></textarea>
          </div>
          <div class="form-group">
            <label for="market-template-compose">Compose 内容</label>
            <textarea id="market-template-compose" v-model="formData.defaultCompose" rows="10" class="input" placeholder="version: '3'..."></textarea>
          </div>

      <template #footer>
          <button @click="closeModal" class="btn-secondary btn-cancel">取消</button>
          <button @click="saveTemplate" class="btn-primary btn-save" :disabled="savingTemplate">{{ savingTemplate ? '保存中…' : '保存' }}</button>

      </template>
    </BaseModal>

    <!-- AI 发现应用模态框 -->
    <BaseModal :show="showAiModal" title="AI 找应用" @close="showAiModal = false" size-class="max-w-3xl max-h-[88dvh] flex flex-col" body-class="min-h-0 overflow-y-auto p-5 space-y-4">
          <p class="text-xs text-surface-400 mb-3">输入应用名,Agent 会联网检索官方部署方式并生成可一键部署的 Compose 模板草稿,确认后保存为自定义模板。</p>
          <div class="form-group">
            <label for="market-ai-query">应用名称</label>
            <input id="market-ai-query" v-model="aiQuery" type="text" class="input" placeholder="例如: umami / immich / gitea" @keydown.enter="runAiDiscover" />
          </div>
          <div v-if="aiPreview" class="form-group">
            <label>生成结果预览(确认后保存为自定义模板)</label>
            <div class="rounded-lg border border-surface-700/60 bg-surface-950/50 p-3 text-xs space-y-2">
              <p><b class="text-surface-200">{{ aiPreview.name }}</b> <span class="ml-1 text-surface-400">{{ aiPreview.category }}</span></p>
              <p class="text-surface-400">{{ aiPreview.description }}</p>
              <p v-if="aiPreview.envSchema?.length" class="text-surface-400">需要 {{ aiPreview.envSchema.length }} 个配置项:{{ aiPreview.envSchema.map((item) => item.key).join(', ') }}</p>
              <pre class="probe-output max-h-40">{{ aiPreview.defaultCompose }}</pre>
            </div>
          </div>

      <template #footer>
          <button @click="showAiModal = false" class="btn-secondary btn-cancel">取消</button>
          <button v-if="!aiPreview" @click="runAiDiscover" class="btn-primary btn-save" :disabled="aiDiscovering || !aiQuery.trim()">{{ aiDiscovering ? '生成中…' : '生成模板' }}</button>
          <button v-else @click="useAiTemplate" class="btn-primary btn-save">填入创建表单</button>

      </template>
    </BaseModal>

    <!-- 查看模板模态框 -->
    <BaseModal :show="!!viewingTemplate" :title="viewingTemplate?.name || '模板详情'" @close="viewingTemplate = null" size-class="max-w-3xl max-h-[88dvh] flex flex-col" body-class="min-h-0 overflow-y-auto p-5 space-y-4">
          <div class="template-meta">
            <span class="action-label category-badge">{{ categoryLabel(viewingTemplate.category) }}</span>
            <span class="action-label source-badge">{{ getSourceLabel(viewingTemplate.id) }}</span>
          </div>
          <p class="template-description">{{ viewingTemplate.description || '暂无描述' }}</p>
          <div v-if="viewingTemplate.author" class="template-author">作者: {{ viewingTemplate.author }}</div>
          <div class="compose-preview">
            <h3>Compose 配置</h3>
            <pre><code>{{ viewingTemplate.defaultCompose || viewingTemplate.compose }}</code></pre>
          </div>

      <template #footer><button class="btn-secondary" @click="viewingTemplate = null">返回列表</button><button v-if="isDeployableTemplate(viewingTemplate)" class="btn-primary" @click="openDeploy(viewingTemplate)"><Rocket class="h-4 w-4" />配置并部署</button></template>
    </BaseModal>

    <!-- 部署模板模态框 -->
    <BaseModal :show="!!deployTarget" :title="`部署应用：${deployTarget?.name || ''}`" :close-disabled="deploying" @close="closeDeploy" size-class="max-w-3xl max-h-[88dvh] flex flex-col" body-class="min-h-0 overflow-y-auto p-5 space-y-4">
          <p class="template-description">{{ deployTarget.description || '暂无描述' }}</p>
          <div class="form-group">
            <label for="market-deploy-project-name">项目名称</label>
            <input id="market-deploy-project-name" v-model="deployProjectName" type="text" class="input" placeholder="留空使用默认名称" />
          </div>
          <div class="form-group">
            <label>部署变量</label>
            <p class="text-xs text-muted">按需填写,空值使用模板默认配置。</p>
            <div v-if="deployVariables.length" class="space-y-2 mt-2">
              <div v-for="field in deployVariables" :key="field.key" class="form-row">
                <label :for="`market-deploy-variable-${field.key}`">{{ field.label || field.key }}</label>
                <input :id="`market-deploy-variable-${field.key}`" v-model="deployValues[field.key]" :type="field.type === 'password' ? 'password' : 'text'" class="input" :placeholder="field.default || ''" />
              </div>
            </div>
            <p v-else class="text-xs text-muted mt-2">该模板无需额外配置。</p>
          </div>
          <p v-if="deployError" class="text-xs text-status-error" role="alert">{{ deployError }}</p>

      <template #footer>
          <button @click="closeDeploy" class="btn-secondary btn-cancel" :disabled="deploying">{{ deployReturnTemplate ? '返回详情' : '取消' }}</button>
          <button @click="deployTemplate" class="btn-primary btn-save" :disabled="deploying">
            <LoaderCircle v-if="deploying" class="w-4 h-4 animate-spin" />
            {{ deploying ? '部署中…' : '部署' }}
          </button>

      </template>
    </BaseModal>

    <ConfirmDialog
      :show="showDeleteDialog"
      title="删除自定义模板"
      message="确定删除此模板？"
      tone="danger"
      confirm-text="删除"
      @confirm="confirmDelete"
      @cancel="showDeleteDialog = false; pendingDeleteId = null"
    />
  </div>
</template>

<script setup>
import Skeleton from '../components/common/Skeleton.vue';
import BaseModal from '../components/common/BaseModal.vue';
import { computed, onActivated, onDeactivated, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useToastStore } from '../stores/toast.js';
import { useAgentConsole } from '../composables/useAgentConsole.js';
import { api } from '../api/client.js';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import EmptyState from '../components/common/EmptyState.vue';
import { Bot, Box, Database, FolderOpen, Globe, Wrench, Search, Star, X, LoaderCircle, Rocket, Sparkles } from 'lucide-vue-next';

const toast = useToastStore();
const { openAgent, updateAgentContext } = useAgentConsole();

let active = true;
const savingTemplate = ref(false);
const loading = ref(false);
const error = ref('');
const stats = ref({ totalBuiltin: 0, totalCommunity: 0, totalCustom: 0, totalFavorites: 0, categories: [], communityAvailable: false, communityMessage: '' });
const statsLoaded = ref(false);
const statsLoading = ref(false);
const statsError = ref('');
let statsRequestId = 0;
const filteredTemplates = ref([]);
const searchQuery = ref('');
const selectedSource = ref('all');
const selectedCategory = ref('all');
const onlyFavorites = ref(false);
const favoritePending = ref(new Set());
const hasFilters = computed(() => searchQuery.value || selectedSource.value !== 'all' || selectedCategory.value !== 'all' || onlyFavorites.value);
function filterBySource(source) {
  selectedSource.value = source;
  void loadTemplates();
}
function filterFavorites() {
  onlyFavorites.value = !onlyFavorites.value;
  void loadTemplates();
}

const showCreateModal = ref(false);
const editingTemplate = ref(null);
const aiDiscovering = ref(false);
const showAiModal = ref(false);
const aiQuery = ref('');
const aiPreview = ref(null);
const viewingTemplate = ref(null);
const formData = ref({
  name: '',
  category: '',
  description: '',
  defaultCompose: ''
});

const showDeleteDialog = ref(false);
const pendingDeleteId = ref(null);

async function loadStats() {
  if (!active) return;
  const requestId = ++statsRequestId;
  statsLoading.value = true;
  statsError.value = '';
  try {
    const data = await api.getMarketplaceStats();
    if (requestId !== statsRequestId) return;
    stats.value = data;
    statsLoaded.value = true;
  } catch (err) {
    if (requestId !== statsRequestId) return;
    statsError.value = err?.message || '未知错误';
    console.error('Failed to load stats:', err);
  } finally {
    if (requestId === statsRequestId) statsLoading.value = false;
  }
}

let templatesRequestId = 0;
async function loadTemplates() {
  if (!active) return;
  clearTimeout(searchTimeout);
  const requestId = ++templatesRequestId;
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (searchQuery.value) params.set('q', searchQuery.value);
    if (selectedCategory.value !== 'all') params.set('category', selectedCategory.value);
    if (selectedSource.value !== 'all') params.set('source', selectedSource.value);
    if (onlyFavorites.value) params.set('onlyFavorites', 'true');

    const data = await api.searchMarketplaceTemplates(params);
    if (requestId !== templatesRequestId) return;
    filteredTemplates.value = data.results || [];
  } catch (err) {
    if (requestId !== templatesRequestId) return;
    error.value = err.message || '加载失败';
  } finally {
    if (requestId === templatesRequestId) loading.value = false;
  }
}

/** 清空全部筛选条件并重新加载(空态"清除筛选"入口)。 */
function clearFilters() {
  searchQuery.value = '';
  selectedCategory.value = 'all';
  selectedSource.value = 'all';
  onlyFavorites.value = false;
  void loadTemplates();
}

let searchTimeout = null;
function handleSearch(event) {
  if (event?.isComposing) return;
  clearTimeout(searchTimeout);
  templatesRequestId++;
  error.value = '';
  loading.value = true;
  searchTimeout = setTimeout(() => loadTemplates(), 300);
}

async function toggleFavorite(templateId) {
  if (favoritePending.value.has(templateId)) return;
  favoritePending.value.add(templateId);
  try {
    const isFavorited = filteredTemplates.value.find(t => t.id === templateId)?.favorited;
    await api.toggleMarketplaceFavorite(templateId, isFavorited);

    await Promise.all([loadTemplates(), loadStats()]);
    toast.success(isFavorited ? '已取消收藏' : '已添加收藏');
  } catch (err) {
    toast.error(err);
  } finally { favoritePending.value.delete(templateId); }
}

function viewTemplate(template) {
  viewingTemplate.value = template;
}

function editTemplate(template) {
  editingTemplate.value = template;
  formData.value = {
    name: template.name,
    category: template.category,
    description: template.description || '',
    defaultCompose: template.defaultCompose || ''
  };
}

async function saveTemplate() {
  if (savingTemplate.value) return;
  if (!formData.value.name.trim()) {
    toast.error('模板名称不能为空');
    return;
  }
  if (!formData.value.defaultCompose.trim()) {
    toast.error('Compose 内容不能为空');
    return;
  }

  savingTemplate.value = true;
  try {
    if (editingTemplate.value) {
      await api.updateMarketplaceTemplate(editingTemplate.value.id, formData.value);
    } else {
      await api.createMarketplaceTemplate(formData.value);
    }

    toast.success(editingTemplate.value ? '模板已更新' : '模板已创建');
    savingTemplate.value = false;
    closeModal();
    await Promise.all([loadTemplates(), loadStats()]);
  } catch (err) {
    toast.error(err);
  } finally { savingTemplate.value = false; }
}

function deleteTemplate(id) {
  pendingDeleteId.value = id;
  showDeleteDialog.value = true;
}

async function confirmDelete() {
  const id = pendingDeleteId.value;
  showDeleteDialog.value = false;

  try {
    await api.deleteMarketplaceTemplate(id);
    toast.success('模板已删除');
    await Promise.all([loadTemplates(), loadStats()]);
  } catch (err) {
    toast.error(err);
  } finally {
    pendingDeleteId.value = null;
  }
}

function openAiDiscover() {
  aiQuery.value = '';
  aiPreview.value = null;
  showAiModal.value = true;
}
/** 让 Agent 推荐 → 打开 Agent 抽屉,预填一段带模板/变量上下文的需求描述。 */
function openAgentRecommend() {
  const list = (filteredTemplates.value || []).slice(0, 30);
  const brief = list.length
    ? list.map((item) => `- ${item.id.replace(/^builtin-/i, '')}:${item.name}(${item.category || '未分类'})${(item.variables || item.envSchema)?.length ? `,变量:${(item.variables || item.envSchema).map((v) => v.key || v.label).join(',')}` : ''}`).join('\n')
    : '应用市场模板列表为空';
  updateAgentContext({
    page: '应用市场',
    mode: 'marketplace-recommend',
    summary: '请根据用户需求从应用市场模板中推荐并说明差异',
    state: JSON.stringify({ templates: brief }),
  });
  openAgent();
  window.dispatchEvent(new CustomEvent('composeops:agent-prompt', {
    detail: {
      prompt: `用户在这里想部署一个应用,请澄清或直接推荐最合适的模板。可用模板与所需变量:\n\n${brief}\n\n请先调用 app.list 确认可选应用(只读),结合用户需求给出 1-3 个推荐并说明差异;确定后可以调用 app.deploy 一键部署(需要用户确认)。`,
    },
  }));
}
async function runAiDiscover() {
  if (!aiQuery.value.trim() || aiDiscovering.value) return;
  aiDiscovering.value = true;
  try {
    const { template } = await api.discoverAiTemplate(aiQuery.value.trim());
    aiPreview.value = template;
  } catch (error) {
    toast.error(error);
  } finally {
    aiDiscovering.value = false;
  }
}
function useAiTemplate() {
  if (!aiPreview.value) return;
  formData.value = {
    name: aiPreview.value.name || '',
    category: aiPreview.value.category || 'Custom',
    description: aiPreview.value.description || '',
    defaultCompose: aiPreview.value.defaultCompose || '',
  };
  showAiModal.value = false;
  showCreateModal.value = true;
}

function closeModal() {
  if (savingTemplate.value) return;
  showCreateModal.value = false;
  editingTemplate.value = null;
  formData.value = { name: '', category: '', description: '', defaultCompose: '' };
}

function clearSearch() {
  searchQuery.value = '';
  void loadTemplates();
}
function categoryLabel(category) {
  return { Web: '网站与代理', Network: '网络与代理', Database: '数据库与缓存', DevOps: '运维工具', Tools: '实用工具', Media: '媒体与文件', AI: '智能应用', Custom: '自定义', Monitoring: '监控' }[category] || category || '未分类';
}
function categoryIcon(category) {
  return { Web: Globe, Network: Globe, Database, DevOps: Wrench, Tools: Wrench, Media: FolderOpen, AI: Bot, Monitoring: Wrench }[category] || Box;
}
function getSourceLabel(id) {
  if (typeof id === 'string' && id.startsWith('custom-')) return '自定义';
  if (typeof id === 'string' && id.startsWith('community-')) return '社区';
  return '内置';
}
function isCustomTemplate(template) {
  return typeof template?.id === 'string' && template.id.startsWith('custom-');
}
function isDeployableTemplate(template) {
  const id = typeof template?.id === 'string' ? template.id : '';
  return id && !id.startsWith('custom-') && !id.startsWith('community-');
}

const deployTarget = ref(null);
const deployReturnTemplate = ref(null);
const deployProjectName = ref('');
const deployValues = ref({});
const deploying = ref(false);
const deployError = ref('');
const deployVariables = computed(() => {
  const template = deployTarget.value;
  if (!template) return [];
  const schema = template.envSchema || template.variables || [];
  if (Array.isArray(schema)) return schema;
  return Object.entries(schema).map(([name, config]) =>
    config && typeof config === 'object' ? { key: name, ...config } : { key: name, default: config }
  );
});

function openDeploy(template) {
  deployReturnTemplate.value = viewingTemplate.value;
  viewingTemplate.value = null;
  deployTarget.value = template;
  deployProjectName.value = '';
  deployValues.value = {};
  deployError.value = '';
}

function closeDeploy(returnToDetails = true) {
  if (deploying.value) return;
  if (returnToDetails) viewingTemplate.value = deployReturnTemplate.value;
  deployReturnTemplate.value = null;
  deployTarget.value = null;
  deployProjectName.value = '';
  deployValues.value = {};
  deployError.value = '';
}

async function deployTemplate() {
  if (!deployTarget.value || deploying.value) return;
  const template = deployTarget.value;
  deploying.value = true;
  deployError.value = '';

  const values = { ...deployValues.value };
  for (const field of deployVariables.value) {
    if ((values[field.key] === undefined || values[field.key] === '') && field.default !== undefined) {
      values[field.key] = field.default;
    }
  }
  if (deployProjectName.value.trim()) values.projectName = deployProjectName.value.trim();

  let succeeded = false;
  try {
    await api.streamBlueprintDeploy(template.id, values, (frame) => {
      if (frame.type === 'result') {
        if (frame.data?.ok) {
          succeeded = true;
          toast.success(`应用 ${template.name} 已开始部署`);
        } else if (frame.data?.message) {
          deployError.value = frame.data.message;
        }
      } else if (frame.type === 'stderr' || frame.type === 'error') {
        deployError.value = String(frame.data || '').slice(0, 500) || deployError.value;
      }
    });
    if (succeeded) {
      deploying.value = false;
      closeDeploy(false);
      await Promise.all([loadTemplates(), loadStats()]);
    }
  } catch (err) {
    deployError.value = err.message || '部署失败';
  } finally {
    deploying.value = false;
  }
}

watch(deployTarget, (template) => {
  if (!template) {
    deployValues.value = {};
    deployProjectName.value = '';
    deployError.value = '';
  }
});

usePullRefresh(() => Promise.all([loadStats(), loadTemplates()]), { keepAlive: true });
onMounted(async () => {
  await Promise.all([loadStats(), loadTemplates()]);
});
let activatedOnce = false;
onActivated(() => { active = true; if (!activatedOnce) { activatedOnce = true; return; } void Promise.all([loadStats(), loadTemplates()]); });

function stopPendingReads() {
  active = false;
  clearTimeout(searchTimeout);
  templatesRequestId++;
  statsRequestId++;
  loading.value = false;
  statsLoading.value = false;
}
onDeactivated(stopPendingReads);
onBeforeUnmount(stopPendingReads);
</script>

<style scoped>
@reference '../style.css';
/* 页面级配色/按钮/页眉改用全站 token(surface / accent / btn / page-header / input / modal),
   scoped 内只保留市场页布局与局部语义类的微调。 */
.marketplace-view {
  /* 部署按钮的强调色:沿用全站 emerald 状态色 */
  --market-accent-2: var(--color-status-ok);
}

.page-actions-market { @apply flex items-center gap-3; }

.market-browser { @apply mt-5 mb-4 rounded-xl border border-surface-800 bg-surface-900/50 p-4; }
.filter-bar { @apply flex flex-wrap gap-3; }
.search-box { @apply relative min-w-0 flex-1; min-width: min(100%, 240px); }
.search-input { @apply w-full pl-10 pr-10; min-height: 44px; }
.search-icon { @apply pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-surface-400; }
.search-clear { @apply absolute right-0 top-0 grid h-11 w-11 place-items-center text-surface-400 hover:text-surface-100; }
.filter-select { @apply cursor-pointer; min-height: 44px; }
.market-scope-row { @apply mt-3 flex flex-wrap items-center justify-between gap-2; }
.source-filters { @apply flex flex-wrap gap-1; }
.scope-chip { @apply inline-flex min-h-11 items-center gap-2 rounded-lg border border-transparent px-3 text-sm text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-100; }
.scope-chip[aria-pressed="true"] { @apply border-emerald-400/25 bg-emerald-400/10 text-emerald-300; }
.scope-chip span { @apply rounded-md bg-surface-950/50 px-1.5 text-xs tabular-nums; }
.market-results { @apply mb-4 flex min-h-10 items-center justify-between gap-3 text-xs text-surface-400; }
.market-source-note { @apply text-surface-500; }
.error-state { @apply grid min-h-[40vh] place-items-center text-center text-surface-400; }

.templates-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 1rem;
}

.template-card {
  @apply panel-card grid p-5;
  grid-template-rows: auto 1fr auto;
  gap: 1rem;
  transition: border-color 0.2s ease, transform 0.2s ease;
}
.template-card:hover { @apply border-accent/60; transform: translateY(-2px); }

/* 精选模板用小徽章标注,不再整卡高亮边框(避免与收藏态混淆) */
.featured-badge {
  @apply inline-block w-fit rounded-full border border-accent/40 bg-accent/10 px-1.5 py-px align-middle text-[11px] font-medium text-status-info;
}

.card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
.template-heading { @apply min-w-0 flex-1; }
.template-heading h2 { @apply m-0 break-words text-base font-semibold leading-6 text-surface-50; }
.template-kind { @apply mt-1 block text-xs text-surface-400; }
.template-avatar { @apply grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300; }
.template-avatar[data-category="Database"] { @apply border-sky-400/20 bg-sky-400/10 text-sky-300; }
.template-avatar[data-category="DevOps"], .template-avatar[data-category="Tools"], .template-avatar[data-category="Monitoring"] { @apply border-violet-400/20 bg-violet-400/10 text-violet-300; }
.template-avatar[data-category="Custom"], .template-avatar[data-category="Media"] { @apply border-amber-400/20 bg-amber-400/10 text-amber-300; }
.template-avatar[data-category="AI"] { @apply border-rose-400/20 bg-rose-400/10 text-rose-300; }

.favorite-btn { min-height: 44px; min-width: 44px; @apply grid place-items-center rounded-lg px-2 py-1 text-xl text-surface-400 transition-colors hover:text-status-warn; background: transparent; border: none; cursor: pointer; }
.favorite-btn.active { @apply text-status-warn; }

.card-body { display: flex; flex-direction: column; gap: 0.75rem; }
.meta { display: flex; gap: 0.5rem; flex-wrap: wrap; }

.description { @apply m-0 text-sm leading-6 text-surface-400; }
.author, .stats-row { @apply text-[13px] text-surface-400; }
.stats-row { display: flex; gap: 1rem; }

.card-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.card-actions .btn-secondary,
.card-actions .btn-ghost { @apply min-w-fit flex-1; }

.btn-deploy {
  border-color: color-mix(in srgb, var(--market-accent-2) 35%, transparent) !important;
  background: color-mix(in srgb, var(--market-accent-2) 12%, transparent) !important;
  color: var(--market-accent-2) !important;
}
.btn-deploy:hover {
  background: color-mix(in srgb, var(--market-accent-2) 20%, transparent) !important;
  border-color: var(--market-accent-2) !important;
}

.form-group { display: grid; gap: 0.5rem; margin-bottom: 1rem; }
.form-group label { @apply text-sm font-medium text-surface-400; }
.form-group textarea { resize: vertical; font-family: ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace; }

.form-row { display: grid; gap: 0.35rem; }
.form-row label { @apply text-[13px] text-surface-400; }

.template-meta { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
.template-description { @apply mb-4 text-[15px] leading-7 text-surface-300; }
.template-author { @apply mb-6 text-sm text-surface-400; }

.compose-preview h3 { @apply mb-3 mt-0 text-sm font-medium text-surface-200; }
.compose-preview pre { @apply m-0 overflow-x-auto rounded-lg border border-surface-800 bg-surface-950/70 p-4; }
.compose-preview code { @apply font-mono text-[13px] leading-6 text-surface-200; }
.template-card:focus-within { @apply border-emerald-400/50; }
.btn-delete { @apply text-surface-400 hover:text-status-error; }
@media (max-width: 639px) {
  .page-actions-market { @apply gap-2; }
  .market-browser { @apply p-3; }
  .filter-select { @apply w-full; }
  .market-source-note { display: none; }
  .template-card { @apply p-4; }
}
@media (prefers-reduced-motion: reduce) {
  .template-card { transition: none; }
  .template-card:hover { transform: none; }
}
</style>
