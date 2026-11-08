<template>
  <div class="marketplace-view" :aria-busy="loading || (statsLoading && !statsLoaded)">
    <header class="page-header market-intro">
      <div class="market-intro-copy">
        <h1>应用市场</h1>
        <p class="page-subtitle">让好的应用，成为你的下一项服务。</p>
        <p class="market-intro-note">浏览模板 · 按需配置 · 确认部署</p>
<div class="page-actions page-actions-market">
        <button @click="openAgentRecommend" class="btn-secondary"><Bot class="w-4 h-4" />让 Agent 推荐</button>
        <button @click="openAiDiscover" class="btn-secondary" :disabled="aiDiscovering"><Sparkles class="w-4 h-4" :class="{ 'animate-pulse': aiDiscovering }" />{{ aiDiscovering ? 'AI 查找中...' : 'AI 找应用' }}</button>
        <button @click="openCreate" class="btn-primary" :disabled="savingTemplate">
          <span class="icon">+</span>
          创建模板
          <span v-if="hasCreateDraft" class="market-draft-dot" aria-label="有未保存草稿" />
        </button>
      </div>
      </div>
      <SceneIllustration kind="applications" class="market-intro-art" :min-width="768" sizes="240px" eager />
    </header>

    <button v-if="lastDeployment" class="market-last-deploy" @click="restoreDeployment"><Rocket :size="16" /><span>查看上次部署 · {{ lastDeployment.template.name }}<small>{{ lastDeployment.record.context.hostName }} · {{ lastDeployment.record.context.projectName }}</small></span><span aria-hidden="true">→</span></button>

    <p v-if="saveNotice" class="market-write-notice" :data-state="saveNotice.state" :role="saveNotice.state === 'error' ? 'alert' : 'status'"><LoaderCircle v-if="saveNotice.state === 'pending'" :size="15" class="animate-spin" /><span>{{ saveNotice.message }}</span><button v-if="saveNotice.state !== 'pending'" class="icon-btn" aria-label="关闭模板保存提示" @click="saveNotice = null"><X :size="14" /></button></p>

    <p v-if="deleteNotice" class="market-write-notice" :data-state="deleteNotice.state" :role="deleteNotice.state === 'error' ? 'alert' : 'status'"><LoaderCircle v-if="deleteNotice.state === 'pending'" :size="15" class="animate-spin" /><span>{{ deleteNotice.message }}</span><button v-if="deleteNotice.state !== 'pending'" class="icon-btn" aria-label="关闭模板删除提示" @click="deleteNotice = null"><X :size="14" /></button></p>

    <section class="market-browser" aria-label="查找应用模板">
      <div class="filter-bar">
        <div class="search-box">
          <Search class="search-icon" aria-hidden="true" />
          <input v-model="searchQuery" type="text" aria-label="搜索应用模板" placeholder="搜索应用名称或用途…" maxlength="200" class="input search-input" @input="handleSearch" />
          <button v-if="searchQuery" class="search-clear" aria-label="清空模板搜索" @click="clearSearch"><X class="h-4 w-4" /></button>
        </div>
        <select v-model="selectedCategory" @change="changeFilters" class="input filter-select" aria-label="筛选模板分类">
          <option value="all">全部分类</option><option v-if="selectedCategory !== 'all' && !stats.categories.includes(selectedCategory)" :value="selectedCategory">{{ categoryLabel(selectedCategory) }}</option>
          <option v-for="cat in stats.categories" :key="cat" :value="cat">{{ categoryLabel(cat) }}</option>
        </select>
      </div>
      <div class="market-scope-row">
        <div class="source-filters" role="group" aria-label="筛选模板来源">
          <button class="scope-chip" :aria-pressed="selectedSource === 'all'" @click="filterBySource('all')">全部模板</button>
          <button class="scope-chip" :aria-pressed="selectedSource === 'builtin'" @click="filterBySource('builtin')">内置模板 <span v-if="statsLoaded">{{ stats.totalBuiltin }}</span></button>
          <button v-if="stats.communityAvailable || selectedSource === 'community'" class="scope-chip" :aria-pressed="selectedSource === 'community'" @click="filterBySource('community')">社区模板 <span v-if="statsLoaded">{{ stats.totalCommunity }}</span></button>
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
      <span>{{ loading ? '正在查找模板…' : error ? '模板列表暂不可用' : `找到 ${filteredTemplates.length} 个模板` }}<span v-if="selectedCategory !== 'all'"> · {{ categoryLabel(selectedCategory) }}</span></span>
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
            class="btn-secondary btn-edit" :disabled="savingTemplate"
          >
            编辑
          </button>
          <button
            v-if="isCustomTemplate(template)"
            @click="deleteTemplate(template)"
            class="btn-ghost btn-delete" :disabled="deletingTemplate"
          >
            删除
          </button>
        </div>
      </div>
    </section>

    <!-- 创建/编辑模态框 -->
    <BaseModal :show="showCreateModal || !!editingTemplate" :close-disabled="savingTemplate" :title="editingTemplate ? '编辑模板' : '创建模板'" @close="closeModal" size-class="max-w-3xl max-h-[88dvh] flex flex-col" body-class="min-h-0 overflow-y-auto p-5 space-y-4">
          <div class="market-form-intro"><span><FileCode2 :size="21" /></span><div><h3>{{ editingTemplate ? '让配置继续完善' : '留一份可复用的配置' }}</h3><p>保存会校验 Compose，不会启动服务。关闭或切页会保留草稿，刷新后清除。</p></div></div>
          <p v-if="draftRestored" class="market-draft-note" role="status">已恢复上次未保存的内容。</p>
          <div class="market-form-toolbar"><span>{{ formData.envSchema?.length ? `${formData.envSchema.length} 个配置项随模板保留` : '草稿仅在本次页面会话内保留' }}</span><button class="btn-ghost" :disabled="savingTemplate" @click="resetDraft">{{ editingTemplate ? '恢复原内容' : '清空表单' }}</button></div>
          <p v-if="resetMessage" class="market-draft-note" role="status">{{ resetMessage }}<button v-if="resetBackup" class="ml-2 underline underline-offset-2" :disabled="savingTemplate" @click="undoReset">撤销</button></p>
          <div class="market-form-row">
            <div class="form-group"><label for="market-template-name">模板名称</label><input id="market-template-name" v-model="formData.name" type="text" class="input" placeholder="例如：团队知识库" maxlength="200" :disabled="savingTemplate" :aria-invalid="!!formErrors.name" @input="formErrors.name = ''" /><p v-if="formErrors.name" class="field-error">{{ formErrors.name }}</p></div>
            <div class="form-group"><label for="market-template-category">分类</label><input id="market-template-category" v-model="formData.category" type="text" class="input" placeholder="例如：Web" list="market-category-options" maxlength="50" :disabled="savingTemplate" /><datalist id="market-category-options"><option v-for="category in stats.categories" :key="category" :value="category">{{ categoryLabel(category) }}</option></datalist></div>
          </div>
          <div class="form-group"><label for="market-template-description">描述</label><textarea id="market-template-description" v-model="formData.description" rows="2" class="input" placeholder="写下用途，方便下次找到" maxlength="500" :disabled="savingTemplate"></textarea></div>
          <div class="form-group market-compose-editor"><div><label for="market-template-compose">Compose 内容</label><span>YAML · {{ formData.defaultCompose.split('\n').length }} 行</span></div><textarea id="market-template-compose" v-model="formData.defaultCompose" rows="10" class="input" placeholder="services:&#10;  app:&#10;    image: nginx:stable" spellcheck="false" :disabled="savingTemplate" :aria-invalid="!!formErrors.defaultCompose" @input="formErrors.defaultCompose = ''"></textarea><p v-if="formErrors.defaultCompose" class="field-error">{{ formErrors.defaultCompose }}</p></div>
          <details v-if="formData.envSchema?.length" class="market-variable-summary"><summary>随模板保留的配置项 · {{ formData.envSchema.length }}</summary><dl><div v-for="field in formData.envSchema" :key="field.key"><dt>{{ field.label || field.key }}<code>{{ field.key }}</code></dt><dd>{{ field.secret || field.type === 'password' ? '私密配置' : field.default || '未设默认值' }}</dd></div></dl></details>
          <p v-if="saveError" class="alert-error" role="alert">{{ saveError }}</p>

      <template #footer>
          <button @click="closeModal" class="btn-secondary btn-cancel" :disabled="savingTemplate">取消</button>
          <button @click="saveTemplate" class="btn-primary btn-save" :disabled="savingTemplate">{{ savingTemplate ? '保存中…' : '保存' }}</button>

      </template>
    </BaseModal>

    <!-- AI 发现应用模态框 -->
    <BaseModal :show="showAiModal" title="AI 找应用" @close="closeAiModal" size-class="max-w-3xl max-h-[88dvh] flex flex-col" body-class="min-h-0 overflow-y-auto p-5 space-y-4">
          <p class="text-xs text-surface-400 mb-3">输入应用名，AI 会检索部署资料并生成 Compose 草稿。请核对镜像、端口与数据目录；保存后可复制配置使用，自定义模板暂不提供直接部署。</p>
          <div class="form-group">
            <label for="market-ai-query">应用名称</label>
            <input id="market-ai-query" v-model="aiQuery" type="text" class="input" placeholder="例如：umami / immich / gitea" maxlength="120" @keydown.enter="runAiDiscover" />
          </div>
          <div v-if="aiDiscovering" class="market-ai-progress" role="status"><LoaderCircle :size="18" class="animate-spin" /><div><strong>正在整理部署草稿</strong><p>完成后可先阅读，再决定是否保存。关闭窗口会停止等待。</p></div></div>
          <p v-if="aiError" class="alert-error" role="alert">{{ aiError }}</p>
          <div v-if="aiPreview" class="form-group">
            <label>生成结果预览(确认后保存为自定义模板)</label>
            <div class="rounded-lg border border-surface-700/60 bg-surface-950/50 p-3 text-xs space-y-2">
              <p><b class="text-surface-200">{{ aiPreview.name }}</b> <span class="ml-1 text-surface-400">{{ aiPreview.category }}</span></p>
              <p class="text-surface-400">{{ aiPreview.description }}</p>
              <p v-if="aiPreview.envSchema?.length" class="text-surface-400">需要 {{ aiPreview.envSchema.length }} 个配置项:{{ aiPreview.envSchema.map((item) => item.key).join(', ') }}</p>
              <div class="market-code-heading"><span>Compose 草稿</span><button class="btn-ghost" :disabled="copyingCompose" @click="copyCompose(aiPreview)"><Copy :size="13" />{{ copyingCompose ? '复制中…' : '复制配置' }}</button></div><pre class="probe-output max-h-52" tabindex="0" aria-label="AI 生成的 Compose 草稿">{{ aiPreview.defaultCompose }}</pre>
              <p v-if="copyFeedback" role="status">{{ copyFeedback }}</p>
            </div>
          </div>

      <template #footer>
          <button @click="closeAiModal" class="btn-secondary btn-cancel">取消</button>
          <button v-if="!aiPreview" @click="runAiDiscover" class="btn-primary btn-save" :disabled="aiDiscovering || !aiQuery.trim()">{{ aiDiscovering ? '生成中…' : '生成模板' }}</button>
          <button v-else @click="useAiTemplate" class="btn-primary btn-save" :disabled="savingTemplate">{{ hasCreateDraft ? '替换草稿并填入' : '填入创建表单' }}</button>

      </template>
    </BaseModal>

    <!-- 查看模板模态框 -->
    <BaseModal :show="!!viewingTemplate" :title="viewingTemplate?.name || '模板详情'" @close="closeDetails" size-class="max-w-3xl max-h-[88dvh] flex flex-col" body-class="min-h-0 overflow-y-auto p-5 space-y-4">
          <div class="template-meta">
            <span class="action-label category-badge">{{ categoryLabel(viewingTemplate.category) }}</span>
            <span class="action-label source-badge">{{ getSourceLabel(viewingTemplate.id) }}</span>
          </div>
          <p class="template-description">{{ viewingTemplate.description || '暂无描述' }}</p>
          <div v-if="viewingTemplate.author" class="template-author">作者: {{ viewingTemplate.author }}</div>
          <div class="compose-preview">
            <div class="market-code-heading"><h3>Compose 配置</h3><button class="btn-ghost" :disabled="copyingCompose" @click="copyCompose(viewingTemplate)"><Copy :size="13" />{{ copyingCompose ? '复制中…' : '复制配置' }}</button></div>
            <pre tabindex="0" aria-label="模板 Compose 配置"><code>{{ viewingTemplate.defaultCompose || viewingTemplate.compose }}</code></pre>
          </div>
          <p v-if="copyFeedback" class="market-draft-note" role="status">{{ copyFeedback }}</p>
          <p v-if="!isDeployableTemplate(viewingTemplate)" class="market-template-help">此模板用于保存与复用配置。可复制 Compose，确认变量后在目标项目中使用。</p>

      <template #footer><button class="btn-secondary" @click="closeDetails">返回列表</button><button v-if="isDeployableTemplate(viewingTemplate)" class="btn-primary" @click="openDeploy(viewingTemplate)"><Rocket class="h-4 w-4" />配置并部署</button></template>
    </BaseModal>

    <BlueprintDeployModal v-if="deployTarget" :template="deployTarget" :record="deployRecord" :return-label="deployReturnTemplate ? '返回详情' : '取消'" @close="closeDeploy" @record="rememberDeployment" @deployed="onDeployed" />

    <ConfirmDialog
      :show="showDeleteDialog"
      title="删除自定义模板"
      :message="`确定删除模板“${pendingDelete?.name || ''}”？已部署的项目不受影响。`"
      tone="danger"
      :confirm-text="deletingTemplate ? '删除中…' : '删除'" :busy="deletingTemplate"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    ><p v-if="deleteError" class="alert-error mt-3" role="alert">{{ deleteError }}</p></ConfirmDialog>
  </div>
</template>

<script setup>
import Skeleton from '../components/common/Skeleton.vue';
import BaseModal from '../components/common/BaseModal.vue';
import BlueprintDeployModal from '../components/marketplace/BlueprintDeployModal.vue';
import { computed, nextTick, onActivated, onDeactivated, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMarketplaceEditor } from '../composables/useMarketplaceEditor.js';
import { copyText } from '../lib/clipboard.js';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useToastStore } from '../stores/toast.js';
import { useAgentConsole } from '../composables/useAgentConsole.js';
import { api } from '../api/client.js';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import SceneIllustration from '../components/common/SceneIllustration.vue';
import EmptyState from '../components/common/EmptyState.vue';
import { Bot, Box, Database, FolderOpen, Globe, Wrench, Search, Star, X, Rocket, Sparkles, Copy, FileCode2, LoaderCircle } from 'lucide-vue-next';

const toast = useToastStore();
const { openAgent, updateAgentContext } = useAgentConsole();

let active = true;
const route = useRoute(); const router = useRouter();
const { showCreateModal, editingTemplate, formData, savingTemplate, saveError, formErrors, saveNotice, draftRestored, hasCreateDraft,
  openCreate, editTemplate, closeModal, saveTemplate, adoptTemplate, resetBackup, resetMessage, resetDraft, undoReset } = useMarketplaceEditor(() => Promise.all([loadTemplates(), loadStats()]));
const loading = ref(false);
const error = ref('');
const stats = ref({ totalBuiltin: 0, totalCommunity: 0, totalCustom: 0, totalFavorites: 0, categories: [], communityAvailable: false, communityMessage: '' });
const statsLoaded = ref(false);
const statsLoading = ref(false);
const statsError = ref('');
let statsRequestId = 0;
const filteredTemplates = ref([]);
function readFilters(query = {}) {
  return { q: typeof query.q === 'string' ? query.q.slice(0, 200) : '',
    source: ['builtin', 'community', 'custom'].includes(query.source) ? query.source : 'all',
    category: typeof query.category === 'string' ? query.category.slice(0, 50) : 'all', favorites: query.favorites === '1' };
}
const initialFilters = readFilters(route?.query);
const searchQuery = ref(initialFilters.q);
const selectedSource = ref(initialFilters.source);
const selectedCategory = ref(initialFilters.category);
const onlyFavorites = ref(initialFilters.favorites);
const onMarketRoute = () => route?.name === 'marketplace' || route?.fullPath?.split('?')[0] === '/marketplace';
function syncFilterQuery() {
  if (!active || !onMarketRoute()) return;
  const query = { ...route.query };
  for (const [key, value] of Object.entries({ q: searchQuery.value || undefined, source: selectedSource.value === 'all' ? undefined : selectedSource.value,
    category: selectedCategory.value === 'all' ? undefined : selectedCategory.value, favorites: onlyFavorites.value ? '1' : undefined })) {
    if (value === undefined) delete query[key]; else query[key] = value;
  }
  // 输入细化只替换当前历史项，离开后返回能恢复完整筛选。
  if (router.replace) void router.replace({ query });
}
function changeFilters() { syncFilterQuery(); void loadTemplates(); }
watch(() => route?.fullPath, () => {
  if (!onMarketRoute()) return;
  const next = readFilters(route.query);
  if (next.q === searchQuery.value && next.source === selectedSource.value && next.category === selectedCategory.value && next.favorites === onlyFavorites.value) return;
  searchQuery.value = next.q; selectedSource.value = next.source; selectedCategory.value = next.category; onlyFavorites.value = next.favorites;
  void loadTemplates();
});
const favoritePending = ref(new Set());
const hasFilters = computed(() => searchQuery.value || selectedSource.value !== 'all' || selectedCategory.value !== 'all' || onlyFavorites.value);
function filterBySource(source) {
  selectedSource.value = source;
  changeFilters();
}
function filterFavorites() {
  onlyFavorites.value = !onlyFavorites.value;
  changeFilters();
}

const aiDiscovering = ref(false);
const showAiModal = ref(false);
const aiQuery = ref('');
const aiPreview = ref(null);
const viewingTemplate = ref(null);

const showDeleteDialog = ref(false);
const pendingDelete = ref(null); const deletingTemplate = ref(false); const deleteError = ref(''); const deleteNotice = ref(null);
const aiError = ref(''); let aiRequestId = 0; let aiController; let aiPreviewQuery = '';
const copyingCompose = ref(false); const copyFeedback = ref(''); let copyRequestId = 0; let detailTrigger;
function clearCopyFeedback() { copyRequestId++; copyingCompose.value = false; copyFeedback.value = ''; }
async function copyCompose(template) {
  if (copyingCompose.value) return;
  const id = ++copyRequestId; copyingCompose.value = true; copyFeedback.value = '';
  try {
    await copyText(template.defaultCompose || template.compose || '');
    if (active && id === copyRequestId) copyFeedback.value = 'Compose 配置已复制';
  } catch { if (active && id === copyRequestId) copyFeedback.value = '复制失败，请选择配置文本后手动复制。'; }
  finally { if (id === copyRequestId) copyingCompose.value = false; }
}

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
  changeFilters();
}

let searchTimeout = null;
function handleSearch(event) {
  if (event?.isComposing) return;
  syncFilterQuery();
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
  clearCopyFeedback(); detailTrigger = document.activeElement; viewingTemplate.value = template;
}
function closeDetails() {
  viewingTemplate.value = null; clearCopyFeedback();
  void nextTick(() => { if (active && detailTrigger && document.contains(detailTrigger)) detailTrigger.focus({ preventScroll: true }); });
}


function deleteTemplate(template) {
  if (deletingTemplate.value) return;
  pendingDelete.value = { id: template.id, name: template.name }; deleteError.value = ''; showDeleteDialog.value = true;
}
function cancelDelete() {
  if (deletingTemplate.value) return;
  showDeleteDialog.value = false; pendingDelete.value = null; deleteError.value = '';
}
async function confirmDelete() {
  if (deletingTemplate.value || !pendingDelete.value) return;
  const target = { ...pendingDelete.value }; deletingTemplate.value = true; deleteError.value = '';
  deleteNotice.value = { state: 'pending', message: `正在删除模板“${target.name}”…` };
  try {
    await api.deleteMarketplaceTemplate(target.id);
    filteredTemplates.value = filteredTemplates.value.filter(item => item.id !== target.id); templatesRequestId++;
    deleteNotice.value = { state: 'success', message: `模板“${target.name}”已删除` };
    showDeleteDialog.value = false; pendingDelete.value = null;
    if (active) toast.success(deleteNotice.value.message);
    void Promise.all([loadTemplates(), loadStats()]);
  } catch (error) {
    deleteError.value = error?.message || '删除失败，请重试。';
    deleteNotice.value = { state: 'error', message: `模板“${target.name}”未删除：${deleteError.value}` };
  } finally { deletingTemplate.value = false; }
}

function cancelAiRequest() { aiRequestId++; aiController?.abort(); aiController = null; aiDiscovering.value = false; }
function closeAiModal() { cancelAiRequest(); showAiModal.value = false; clearCopyFeedback(); }
function openAiDiscover() { clearCopyFeedback(); showAiModal.value = true; }
watch(() => aiQuery.value.trim(), () => { cancelAiRequest(); aiPreview.value = null; aiPreviewQuery = ''; aiError.value = ''; clearCopyFeedback(); });
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
async function runAiDiscover(event) {
  if (event?.isComposing || event?.keyCode === 229 || !aiQuery.value.trim() || aiDiscovering.value) return;
  const query = aiQuery.value.trim(); const id = ++aiRequestId; aiController = new AbortController();
  aiDiscovering.value = true; aiError.value = ''; aiPreview.value = null; clearCopyFeedback();
  const current = () => active && showAiModal.value && id === aiRequestId && query === aiQuery.value.trim();
  try {
    const { template } = await api.discoverAiTemplate(query, aiController.signal);
    if (!current()) return;
    if (!template?.defaultCompose) throw new Error('未收到有效的 Compose 草稿，请重试。');
    aiPreview.value = template; aiPreviewQuery = query;
  } catch (error) { if (current()) aiError.value = error?.message || '生成失败，请重试。'; }
  finally { if (id === aiRequestId) { aiDiscovering.value = false; aiController = null; } }
}
function useAiTemplate() {
  if (!aiPreview.value || aiPreviewQuery !== aiQuery.value.trim() || !adoptTemplate(aiPreview.value)) return;
  closeAiModal();
}


function clearSearch() {
  searchQuery.value = '';
  changeFilters();
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
const deployRecord = ref(null);
const lastDeployment = ref(null);
function rememberDeployment(record) {
  if (deployTarget.value) lastDeployment.value = { template: { id: deployTarget.value.id, name: deployTarget.value.name }, record };
}
function restoreDeployment() {
  deployReturnTemplate.value = null;
  deployRecord.value = lastDeployment.value.record;
  deployTarget.value = lastDeployment.value.template;
}
function openDeploy(template) {
  deployRecord.value = null;
  deployReturnTemplate.value = viewingTemplate.value;
  viewingTemplate.value = null;
  deployTarget.value = template;
}
function closeDeploy(returnToDetails = true) {
  if (!deployTarget.value) return;
  if (returnToDetails) viewingTemplate.value = deployReturnTemplate.value;
  deployReturnTemplate.value = null;
  deployTarget.value = null;
}
function onDeployed() {
  deployReturnTemplate.value = null;
  void Promise.all([loadTemplates(), loadStats()]);
}


usePullRefresh(() => Promise.all([loadStats(), loadTemplates()]), { keepAlive: true });
onMounted(async () => {
  await Promise.all([loadStats(), loadTemplates()]);
});
let activatedOnce = false;
onActivated(() => { active = true; if (!activatedOnce) { activatedOnce = true; return; } void Promise.all([loadStats(), loadTemplates()]); });

function stopPendingReads() {
  active = false;
  viewingTemplate.value = null;
  showDeleteDialog.value = false;
  closeAiModal();
  clearCopyFeedback();
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
.market-write-notice { @apply mb-3 flex items-center gap-2 rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-surface-300; }
.market-write-notice > span { @apply flex-1 break-words; }.market-write-notice[data-state=error] { @apply border-amber-400/25 text-amber-200; }.market-write-notice[data-state=success] { @apply border-emerald-400/20 text-emerald-200; }
.market-form-intro { @apply mb-1 flex items-start gap-3; }.market-form-intro > span { @apply grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-emerald-400/20 bg-emerald-400/5 text-emerald-300; }.market-form-intro h3 { @apply text-sm font-medium text-surface-100; }.market-form-intro p, .market-template-help { @apply mt-1 text-xs leading-5 text-surface-400; }
.market-draft-note { @apply rounded-lg border border-emerald-400/15 bg-emerald-400/5 px-3 py-2 text-xs text-emerald-200; }
.market-form-toolbar { @apply flex items-center justify-between gap-3 text-[11px] text-surface-500; }.market-form-toolbar button { @apply min-h-10 shrink-0; }.market-draft-dot { @apply h-1.5 w-1.5 rounded-full bg-white; }
.market-form-row { @apply grid grid-cols-[2fr_1fr] gap-4; }.market-form-row .input { @apply min-h-11; }
.market-compose-editor > div, .market-code-heading { @apply flex items-center justify-between gap-3; }.market-compose-editor > div > span { @apply text-[10px] text-surface-500; }.market-compose-editor textarea { @apply min-h-52 resize-y font-mono text-xs leading-6; tab-size: 2; }.market-compose-editor > div label { margin-bottom: 0; }.field-error { @apply mt-1 text-xs text-status-error; }
.market-variable-summary { @apply rounded-lg border border-surface-800 px-3 py-2 text-xs; }.market-variable-summary summary { @apply min-h-8 cursor-pointer text-surface-300; }.market-variable-summary dl > div { @apply flex items-center justify-between gap-3 border-t border-surface-800 py-2; }.market-variable-summary dt { @apply text-surface-300; }.market-variable-summary code { @apply ml-2 text-[10px] text-surface-500; }.market-variable-summary dd { @apply max-w-40 break-words text-surface-400; }
.market-ai-progress { @apply flex items-start gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-emerald-300; }.market-ai-progress strong { @apply text-xs font-medium; }.market-ai-progress p { @apply mt-1 text-xs leading-5 text-surface-400; }
.market-code-heading { @apply mb-2 text-xs text-surface-400; }.market-code-heading h3 { margin: 0; }.market-code-heading button { @apply min-h-10; }
@media (max-width: 480px) { .market-form-row { grid-template-columns: 1fr; gap: 0; } .market-compose-editor textarea { min-height: 13rem; font-size: 16px; line-height: 1.5; } }

.market-last-deploy { @apply mb-5 flex w-full items-center gap-3 rounded-xl border border-emerald-400/15 bg-emerald-400/5 px-4 py-3 text-left text-xs text-emerald-200 transition-colors hover:border-emerald-400/35 hover:bg-emerald-400/10; }
.market-last-deploy > span:first-of-type { @apply min-w-0 flex-1 break-words; }
.market-last-deploy small { @apply mt-1 block text-[11px] text-surface-400; }
/* 页面级配色/按钮/页眉改用全站 token(surface / accent / btn / page-header / input / modal),
   scoped 内只保留市场页布局与局部语义类的微调。 */
.marketplace-view {
  /* 部署按钮的强调色:沿用全站 emerald 状态色 */
  --market-accent-2: var(--color-status-ok);
}

.page-actions-market { @apply flex items-center gap-3; }
.market-intro { position: relative; align-items: center; justify-content: space-between; min-height: 182px; padding: 22px 26px; overflow: hidden; border: 1px solid var(--line-subtle); border-radius: 16px; background: linear-gradient(110deg, rgba(110,231,183,.045), transparent 65%), var(--panel-surface); }
.market-intro-copy { position: relative; z-index: 1; min-width: 0; }
.market-intro-note { margin: 8px 0 16px; color: var(--color-surface-400); font-size: 11px; letter-spacing: .045em; }
.market-intro-art { width: 240px; margin: -26px -8px -26px 0; }
.template-avatar svg { stroke-width: 1.65; position: relative; }
.btn-deploy svg { transition: transform 180ms ease; }
@media (hover: hover) { .btn-deploy:hover:not(:disabled) svg { transform: translate(1px,-1px); } }
@media (max-width: 1000px) { .market-intro-art { width: 190px; }.market-intro { padding: 20px; } }
@media (max-width: 767px) { .market-intro-art { display: none; }.market-intro { min-height: 0; padding: 18px; }.market-intro-note { margin-bottom: 14px; } }


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
@media (hover: hover) { .template-card:hover { @apply border-accent/60; transform: translateY(-2px); } }

/* 精选模板用小徽章标注,不再整卡高亮边框(避免与收藏态混淆) */
.featured-badge {
  @apply inline-block w-fit rounded-full border border-accent/40 bg-accent/10 px-1.5 py-px align-middle text-[11px] font-medium text-status-info;
}

.card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
.template-heading { @apply min-w-0 flex-1; }
.template-heading h2 { @apply m-0 break-words text-base font-semibold leading-6 text-surface-50; }
.template-kind { @apply mt-1 block text-xs text-surface-400; }
.template-avatar { position: relative; overflow: hidden; box-shadow: inset 0 1px 0 rgba(255,255,255,.07), 0 4px 10px rgba(0,0,0,.08); background-image: linear-gradient(145deg, rgba(255,255,255,.05), transparent); @apply grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300; }
.template-avatar[data-category="Database"] { @apply border-sky-400/20 bg-sky-400/10 text-sky-300; }
.template-avatar[data-category="DevOps"], .template-avatar[data-category="Tools"], .template-avatar[data-category="Monitoring"] { @apply border-violet-400/20 bg-violet-400/10 text-violet-300; }
.template-avatar[data-category="Custom"], .template-avatar[data-category="Media"] { @apply border-amber-400/20 bg-amber-400/10 text-amber-300; }
.template-avatar[data-category="AI"] { @apply border-rose-400/20 bg-rose-400/10 text-rose-300; }

.favorite-btn { min-height: 44px; min-width: 44px; @apply grid place-items-center rounded-lg px-2 py-1 text-xl text-surface-400 transition-colors hover:text-status-warn; background: transparent; border: none; cursor: pointer; }
.favorite-btn svg { transition: transform 180ms ease, fill 180ms ease; }
.favorite-btn.active { @apply text-status-warn; }
.favorite-btn.active svg { transform: scale(1.1); }
.favorite-btn:active:not(:disabled) svg { transform: scale(.88); }

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
  .template-card, .favorite-btn svg, .btn-deploy svg { transition: none; }
  .btn-deploy:hover:not(:disabled) svg { transform: none; }
  .template-card:hover { transform: none; }
}
</style>
