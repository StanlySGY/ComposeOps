<template>
  <div class="marketplace-view">
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

    <!-- 搜索和筛选 -->
    <section class="filter-bar">
      <div class="search-box">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索模板..."
          class="input search-input"
          @input="handleSearch"
        />
      </div>
      <div class="filters">
        <select v-model="selectedSource" @change="loadTemplates" class="input filter-select">
          <option value="all">全部来源</option>
          <option value="builtin">内置模板</option>
          <option value="community" :disabled="!stats.communityAvailable">社区模板(未接入)</option>
          <option value="custom">自定义模板</option>
        </select>
        <select v-model="selectedCategory" @change="loadTemplates" class="input filter-select">
          <option value="all">全部分类</option>
          <option v-for="cat in stats.categories" :key="cat" :value="cat">{{ cat }}</option>
        </select>
        <label class="input favorites-toggle">
          <input type="checkbox" v-model="onlyFavorites" @change="loadTemplates" />
          <span>仅收藏</span>
        </label>
      </div>
    </section>

    <p v-if="stats && !stats.communityAvailable" class="mx-4 mb-3 rounded-md border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-300 sm:mx-0">{{ stats.communityMessage || '社区模板源尚未接入,当前仅提供内置和自定义模板。' }}</p>

    <!-- 统计卡片 -->
    <section v-if="stats" class="stats-grid">
      <div class="stat-card">
        <div class="label">内置模板</div>
        <div class="value">{{ stats.totalBuiltin }}</div>
      </div>
      <div class="stat-card">
        <div class="label">社区模板</div>
        <div class="value">{{ stats.totalCommunity }}</div>
      </div>
      <div class="stat-card">
        <div class="label">自定义模板</div>
        <div class="value">{{ stats.totalCustom }}</div>
      </div>
      <div class="stat-card" :class="{ highlight: stats.totalFavorites > 0 }">
        <div class="label">我的收藏</div>
        <div class="value">{{ stats.totalFavorites }}</div>
      </div>
    </section>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>加载模板...</p>
    </div>

    <div v-else-if="error" class="error-state">
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
          <h3>{{ template.name }}<span v-if="template.featured" class="featured-badge">精选</span></h3>
          <button
            @click="toggleFavorite(template.id)"
            class="favorite-btn"
            :class="{ active: template.favorited }"
          >
            ★
          </button>
        </div>
        <div class="card-body">
          <div class="meta">
            <span class="action-label category-badge">{{ template.category }}</span>
            <span class="action-label source-badge">{{ getSourceLabel(template.id) }}</span>
          </div>
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
            class="btn-danger btn-delete"
          >
            删除
          </button>
        </div>
      </div>
    </section>

    <!-- 创建/编辑模态框 -->
    <div v-if="showCreateModal || editingTemplate" class="modal-backdrop" @click.self="closeModal">
      <div class="modal">
        <div class="modal-header">
          <h2>{{ editingTemplate ? '编辑模板' : '创建模板' }}</h2>
          <button @click="closeModal" class="icon-btn close-btn">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>模板名称</label>
            <input v-model="formData.name" type="text" class="input" placeholder="例如: LNMP Stack" />
          </div>
          <div class="form-group">
            <label>分类</label>
            <input v-model="formData.category" type="text" class="input" placeholder="例如: Web" />
          </div>
          <div class="form-group">
            <label>描述</label>
            <textarea v-model="formData.description" rows="3" class="input" placeholder="简要描述模板用途"></textarea>
          </div>
          <div class="form-group">
            <label>Compose 内容</label>
            <textarea v-model="formData.defaultCompose" rows="10" class="input" placeholder="version: '3'..."></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button @click="closeModal" class="btn-secondary btn-cancel">取消</button>
          <button @click="saveTemplate" class="btn-primary btn-save">保存</button>
        </div>
      </div>
    </div>

    <!-- AI 发现应用模态框 -->
    <div v-if="showAiModal" class="modal-backdrop" @click.self="showAiModal = false">
      <div class="modal">
        <div class="modal-header">
          <h2>AI 找应用</h2>
          <button @click="showAiModal = false" class="icon-btn close-btn">×</button>
        </div>
        <div class="modal-body">
          <p class="text-xs text-zinc-500 mb-3">输入应用名,Agent 会联网检索官方部署方式并生成可一键部署的 Compose 模板草稿,确认后保存为自定义模板。</p>
          <div class="form-group">
            <label>应用名称</label>
            <input v-model="aiQuery" type="text" class="input" placeholder="例如: umami / immich / gitea" @keydown.enter="runAiDiscover" />
          </div>
          <div v-if="aiPreview" class="form-group">
            <label>生成结果预览(确认后保存为自定义模板)</label>
            <div class="rounded-lg border border-surface-700/60 bg-surface-950/50 p-3 text-xs space-y-2">
              <p><b class="text-zinc-200">{{ aiPreview.name }}</b> <span class="ml-1 text-zinc-500">{{ aiPreview.category }}</span></p>
              <p class="text-zinc-400">{{ aiPreview.description }}</p>
              <p v-if="aiPreview.envSchema?.length" class="text-zinc-500">需要 {{ aiPreview.envSchema.length }} 个配置项:{{ aiPreview.envSchema.map((item) => item.key).join(', ') }}</p>
              <pre class="probe-output max-h-40">{{ aiPreview.defaultCompose }}</pre>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button @click="showAiModal = false" class="btn-secondary btn-cancel">取消</button>
          <button v-if="!aiPreview" @click="runAiDiscover" class="btn-primary btn-save" :disabled="aiDiscovering || !aiQuery.trim()">{{ aiDiscovering ? '生成中…' : '生成模板' }}</button>
          <button v-else @click="useAiTemplate" class="btn-primary btn-save">填入创建表单</button>
        </div>
      </div>
    </div>

    <!-- 查看模板模态框 -->
    <div v-if="viewingTemplate" class="modal-backdrop" @click.self="viewingTemplate = null">
      <div class="modal view-modal">
        <div class="modal-header">
          <h2>{{ viewingTemplate.name }}</h2>
          <button @click="viewingTemplate = null" class="icon-btn close-btn">×</button>
        </div>
        <div class="modal-body">
          <div class="template-meta">
            <span class="action-label category-badge">{{ viewingTemplate.category }}</span>
            <span class="action-label source-badge">{{ getSourceLabel(viewingTemplate.id) }}</span>
          </div>
          <p class="template-description">{{ viewingTemplate.description || '暂无描述' }}</p>
          <div v-if="viewingTemplate.author" class="template-author">作者: {{ viewingTemplate.author }}</div>
          <div class="compose-preview">
            <h3>Compose 配置</h3>
            <pre><code>{{ viewingTemplate.defaultCompose || viewingTemplate.compose }}</code></pre>
          </div>
        </div>
      </div>
    </div>

    <!-- 部署模板模态框 -->
    <div v-if="deployTarget" class="modal-backdrop" @click.self="closeDeploy" :class="{ 'pointer-events-none': deploying }">
      <div class="modal deploy-modal">
        <div class="modal-header">
          <h2>部署应用: {{ deployTarget.name }}</h2>
          <button @click="closeDeploy" class="icon-btn close-btn">×</button>
        </div>
        <div class="modal-body space-y-4">
          <p class="template-description">{{ deployTarget.description || '暂无描述' }}</p>
          <div class="form-group">
            <label>项目名称</label>
            <input v-model="deployProjectName" type="text" class="input" placeholder="留空使用默认名称" />
          </div>
          <div class="form-group">
            <label>部署变量</label>
            <p class="text-xs text-muted">按需填写,空值使用模板默认配置。</p>
            <div v-if="deployVariables.length" class="space-y-2 mt-2">
              <div v-for="field in deployVariables" :key="field.key" class="form-row">
                <label>{{ field.label || field.key }}</label>
                <input v-model="deployValues[field.key]" :type="field.type === 'password' ? 'password' : 'text'" class="input" :placeholder="field.default || ''" />
              </div>
            </div>
            <p v-else class="text-xs text-muted mt-2">该模板无需额外配置。</p>
          </div>
          <p v-if="deployError" class="text-xs text-rose-400">{{ deployError }}</p>
        </div>
        <div class="modal-footer">
          <button @click="closeDeploy" class="btn-secondary btn-cancel">取消</button>
          <button @click="deployTemplate" class="btn-primary btn-save" :disabled="deploying">
            <LoaderCircle v-if="deploying" class="w-4 h-4 animate-spin" />
            {{ deploying ? '部署中…' : '部署' }}
          </button>
        </div>
      </div>
    </div>

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
import { computed, onActivated, onMounted, ref, watch } from 'vue';
import { useToastStore } from '../stores/toast.js';
import { useAgentConsole } from '../composables/useAgentConsole.js';
import { api } from '../api/client.js';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import EmptyState from '../components/common/EmptyState.vue';
import { Bot, LoaderCircle, Rocket } from 'lucide-vue-next';

const toast = useToastStore();
const { openAgent, updateAgentContext } = useAgentConsole();

const loading = ref(false);
const error = ref('');
const stats = ref({ totalBuiltin: 0, totalCommunity: 0, totalCustom: 0, totalFavorites: 0, categories: [], communityAvailable: false, communityMessage: '' });
const filteredTemplates = ref([]);
const searchQuery = ref('');
const selectedSource = ref('all');
const selectedCategory = ref('all');
const onlyFavorites = ref(false);

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
  try {
    const data = await api.getMarketplaceStats();
    stats.value = data;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

async function loadTemplates() {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (searchQuery.value) params.set('q', searchQuery.value);
    if (selectedCategory.value !== 'all') params.set('category', selectedCategory.value);
    if (selectedSource.value !== 'all') params.set('source', selectedSource.value);
    if (onlyFavorites.value) params.set('onlyFavorites', 'true');

    const data = await api.searchMarketplaceTemplates(params);
    filteredTemplates.value = data.results || [];
  } catch (err) {
    error.value = err.message || '加载失败';
  } finally {
    loading.value = false;
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
function handleSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => loadTemplates(), 300);
}

async function toggleFavorite(templateId) {
  try {
    const isFavorited = filteredTemplates.value.find(t => t.id === templateId)?.favorited;
    await api.toggleMarketplaceFavorite(templateId, isFavorited);
    
    await Promise.all([loadTemplates(), loadStats()]);
    toast.success(isFavorited ? '已取消收藏' : '已添加收藏');
  } catch (err) {
    toast.error(err.message || '操作失败');
  }
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
  if (!formData.value.name.trim()) {
    toast.error('模板名称不能为空');
    return;
  }
  if (!formData.value.defaultCompose.trim()) {
    toast.error('Compose 内容不能为空');
    return;
  }

  try {
    if (editingTemplate.value) {
      await api.updateMarketplaceTemplate(editingTemplate.value.id, formData.value);
    } else {
      await api.createMarketplaceTemplate(formData.value);
    }

    toast.success(editingTemplate.value ? '模板已更新' : '模板已创建');
    closeModal();
    await Promise.all([loadTemplates(), loadStats()]);
  } catch (err) {
    toast.error(err.message || '保存失败');
  }
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
    toast.error(err.message || '删除失败');
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
    useToastStore().error(error.message);
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
  showCreateModal.value = false;
  editingTemplate.value = null;
  formData.value = { name: '', category: '', description: '', defaultCompose: '' };
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
  deployTarget.value = template;
  deployProjectName.value = '';
  deployValues.value = {};
  deployError.value = '';
}

function closeDeploy() {
  if (deploying.value) return;
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
      closeDeploy();
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

onMounted(async () => {
  await Promise.all([loadStats(), loadTemplates()]);
});
let activatedOnce = false;
onActivated(() => { if (!activatedOnce) { activatedOnce = true; return; } void Promise.all([loadStats(), loadTemplates()]); });

</script>

<style scoped>
@reference '../style.css';
/* 页面级配色/按钮/页眉改用全站 token(surface / accent / btn / page-header / input / modal),
   scoped 内只保留市场页布局与局部语义类的微调。 */
.marketplace-view {
  /* 部署按钮的强调色:沿用全站 emerald 状态色 */
  --market-accent-2: #34d399; /* = emerald-400 */
}

.page-actions-market { @apply flex items-center gap-3; }

.filter-bar { @apply mb-6 flex flex-wrap gap-3; }
.search-box { @apply min-w-[200px] flex-1; }
.search-input { @apply w-full; }
.filters { @apply flex flex-wrap gap-3; }
.filter-select { @apply cursor-pointer; }
.favorites-toggle { @apply flex cursor-pointer items-center gap-2; }
.favorites-toggle input { cursor: pointer; }

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}
.stat-card { @apply panel-card !p-5; }
.stat-card.highlight { @apply border-accent/60 bg-accent/5; }
.stat-card .label { @apply mb-2 text-[13px] text-surface-400; }
.stat-card .value { @apply text-3xl font-semibold tracking-tight text-surface-50; }

.loading-state,
.error-state { @apply grid min-h-[40vh] place-items-center text-center text-surface-400; }

.spinner {
  width: 3rem;
  height: 3rem;
  border: 3px solid theme('colors.surface.800');
  border-top-color: theme('colors.accent.DEFAULT');
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.templates-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1.5rem;
}

.template-card {
  @apply panel-card grid !p-5;
  grid-template-rows: auto 1fr auto;
  gap: 1rem;
  transition: border-color 0.2s ease, transform 0.2s ease;
}
.template-card:hover { @apply border-accent/60; transform: translateY(-2px); }

/* 精选模板用小徽章标注,不再整卡高亮边框(避免与收藏态混淆) */
.featured-badge {
  @apply ml-2 inline-block rounded-full border border-accent/40 bg-accent/10 px-1.5 py-px align-middle text-[11px] font-medium text-accent;
}

.card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
.card-header h3 { @apply m-0 flex-1 text-lg font-semibold text-surface-50; }

.favorite-btn { @apply px-2 py-1 text-xl text-surface-500 transition-colors hover:text-amber-400; background: transparent; border: none; cursor: pointer; }
.favorite-btn.active { @apply text-amber-400; }

.card-body { display: grid; gap: 0.75rem; }
.meta { display: flex; gap: 0.5rem; flex-wrap: wrap; }

.description { @apply m-0 text-sm leading-6 text-surface-400; }
.author, .stats-row { @apply text-[13px] text-surface-500; }
.stats-row { display: flex; gap: 1rem; }

.card-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.card-actions .btn-secondary,
.card-actions .btn-danger { @apply min-w-fit flex-1 rounded-lg! px-3 py-2 !text-[13px]; }

.btn-deploy {
  border-color: color-mix(in srgb, var(--market-accent-2) 35%, transparent) !important;
  background: color-mix(in srgb, var(--market-accent-2) 12%, transparent) !important;
  color: var(--market-accent-2) !important;
}
.btn-deploy:hover {
  background: color-mix(in srgb, var(--market-accent-2) 20%, transparent) !important;
  border-color: var(--market-accent-2) !important;
}

/* 模态微调:尺寸与布局,颜色全部来自全站 .modal */
.view-modal { @apply sm:!max-w-3xl; }
.modal-header h2 { @apply m-0 text-base font-semibold text-surface-100; }
.modal-body { @apply overflow-y-auto p-5; }
.modal-footer { @apply flex justify-end gap-3 border-t border-surface-800 p-4; }

.form-group { display: grid; gap: 0.5rem; margin-bottom: 1rem; }
.form-group label { @apply text-sm font-medium text-surface-400; }
.form-group textarea { resize: vertical; font-family: ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace; }

.form-row { display: grid; gap: 0.35rem; }
.form-row label { @apply text-[13px] text-surface-400; }

.template-meta { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
.template-description { @apply mb-4 text-[15px] leading-7 text-surface-300; }
.template-author { @apply mb-6 text-sm text-surface-500; }

.compose-preview h3 { @apply mb-3 mt-0 text-sm font-medium text-surface-200; }
.compose-preview pre { @apply m-0 overflow-x-auto rounded-lg border border-surface-800 bg-surface-950/70 p-4; }
.compose-preview code { @apply font-mono text-[13px] leading-6 text-surface-200; }
</style>
