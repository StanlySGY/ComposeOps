<template>
  <div class="page-shell page-shell-workspace">
    <div class="page-header">
      <div><h1 class="page-title">Compose 配置</h1><p class="page-subtitle">保存前执行 YAML 与 docker compose config 校验</p></div>
      <div class="page-actions">
        <button class="btn-secondary" title="返回服务总览" @click="router.push('/services')"><ArrowLeft class="w-4 h-4" />返回</button>
        <select v-model="projectId" class="input min-w-52" @change="selectProject"><option value="">选择项目</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.projectName }}</option></select>
        <button v-if="projectId" class="btn-secondary" title="清除当前选择,回到引导页" @click="projectId = ''; selectProject()"><X class="w-4 h-4" /></button>
        <select v-if="project?.composeFiles.length > 1" v-model.number="fileIndex" class="input" @change="load"><option v-for="(file, i) in project.composeFiles" :key="file" :value="i">{{ shortName(file) }}</option></select>
        <button class="btn-secondary" :disabled="!content" @click="toggleEditorMode"><Layout class="w-4 h-4" />{{ editorMode === 'code' ? '可视化' : '代码' }}</button>
        <button class="btn-secondary" :disabled="!content" @click="validateSemantics"><ShieldCheck class="w-4 h-4" />语义校验</button>
        <select v-model="templateId" class="input w-40" title="常用服务模板" @change="insertTemplate">
          <option value="">插入模板...</option>
          <option v-for="template in templates" :key="template.id" :value="template.id">{{ template.label }} · {{ template.description }}</option>
          <option value="" disabled>──────────</option>
          <option value="__goto_marketplace__">前往模板市场</option>
        </select>
        <button class="btn-secondary" :disabled="!content" @click="formatYaml"><AlignLeft class="w-4 h-4" />格式化</button>
        <button class="btn-secondary" title="把 docker run 命令转换为 Compose 片段" @click="showConverter = true"><ArrowRightLeft class="w-4 h-4" />转换</button>
        <button class="btn-secondary" :disabled="!projectId" @click="loadBackups"><History class="w-4 h-4" />备份</button>
        <button class="btn-primary" :disabled="saving || previewLoading || !dirty" @click="save"><Save class="w-4 h-4" />{{ saving || previewLoading ? '校验中...' : '保存' }}</button>
      </div>
    </div>
    <div v-if="filePath" class="text-muted font-mono truncate">{{ filePath }}<span v-if="dirty" class="text-amber-400 ml-2">● 未保存</span></div>
    <p v-if="error" class="alert-error">{{ error }}</p><p v-if="message" class="alert-success">{{ message }}</p>
    <div v-if="semanticIssues.length" class="card p-3 space-y-1.5 border border-amber-900/40">
      <div class="flex items-center gap-2 text-xs font-semibold text-amber-300"><ShieldAlert class="w-4 h-4" />语义校验 {{ semanticIssues.filter((i) => i.level === 'error').length }} 个错误 · {{ semanticIssues.filter((i) => i.level === 'warn').length }} 个警告</div>
      <p v-for="(issue, index) in semanticIssues" :key="index" class="flex items-start gap-2 text-xs" :class="issue.level === 'error' ? 'text-rose-300' : issue.level === 'warn' ? 'text-amber-200' : 'text-surface-400'">
        <span class="shrink-0 font-semibold">{{ issue.level === 'error' ? '✕' : issue.level === 'warn' ? '!' : 'i' }}</span>
        <span>{{ issue.message }}<template v-if="issue.service"> · {{ issue.service }}</template></span>
      </p>
    </div>
    <EmptyState v-if="!projectId" icon="FileCode2" title="请先选择一个已挂载的项目" description="选择项目后即可查看与编辑 Compose 配置" class="flex-1" />
    <div v-else-if="editorMode === 'code'" class="card relative flex-1 min-h-[420px] overflow-hidden ring-1 ring-black/10">
      <Skeleton v-if="!editorReady" class="skeleton-workspace" rows="10" label="编辑器加载中" />
      <div ref="editorEl" class="absolute inset-0" :class="{ invisible: !editorReady }"></div>
    </div>
    <div v-else class="card flex-1 min-h-[420px] overflow-auto">
      <div class="p-4 space-y-3">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-semibold">服务列表</h3>
          <button class="btn-primary" @click="addService"><Plus class="w-4 h-4" />新增服务</button>
        </div>
        <EmptyState v-if="!visualServices.length" icon="Layers" compact title="暂无服务" description="点击上方「新增服务」按钮创建" />
        <div v-for="service in visualServices" :key="service.name" class="card p-4 space-y-3 border border-surface-700 hover:border-surface-600 transition-colors">
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <h4 class="font-semibold text-surface-100">{{ service.name }}</h4>
                <span class="text-xs px-2 py-0.5 rounded-full bg-surface-800 text-surface-300">{{ service.image || '未指定镜像' }}</span>
              </div>
              <div class="flex flex-wrap gap-2 text-xs text-surface-400">
                <span v-if="service.ports?.length" class="flex items-center gap-1"><Network class="w-3 h-3" />{{ service.ports.length }} 个端口</span>
                <span v-if="service.volumes?.length" class="flex items-center gap-1"><HardDrive class="w-3 h-3" />{{ service.volumes.length }} 个卷</span>
                <span v-if="service.environment?.length" class="flex items-center gap-1"><Variable class="w-3 h-3" />{{ service.environment.length }} 个环境变量</span>
                <span v-if="service.restart" class="flex items-center gap-1"><RotateCw class="w-3 h-3" />{{ service.restart }}</span>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button class="icon-btn" @click="editService(service)"><Pencil class="w-4 h-4" /></button>
              <button class="icon-btn text-rose-400 hover:text-rose-300" @click="deleteService(service.name)"><Trash2 class="w-4 h-4" /></button>
            </div>
          </div>
          <div v-if="service.ports?.length" class="pt-2 border-t border-surface-800">
            <div class="text-xs font-medium text-surface-300 mb-1.5">端口映射</div>
            <div class="flex flex-wrap gap-2">
              <span v-for="(port, idx) in service.ports" :key="idx" class="text-xs px-2 py-1 rounded bg-surface-900 text-emerald-300 font-mono">{{ port }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <BaseModal :show="showServiceEditor" title="" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[85vh] overflow-auto" body-class="p-0" @close="showServiceEditor = false">
      <ServiceEditor :model-value="currentService" :is-new="isNewService" @save="saveServiceFromEditor" @close="showServiceEditor = false" />
    </BaseModal>

    <BaseModal :show="showConverter" title="Docker Run 转换器" size-class="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden" body-class="min-h-0 flex-1 overflow-y-auto p-4" @close="showConverter = false">
      <DockerRunConverter />
    </BaseModal>

    <BaseModal :show="showBackups" title="配置备份（最近 20 份）" size-class="max-w-[calc(100vw-2rem)] sm:max-w-3xl" body-class="p-3 space-y-2 overflow-auto max-h-[60vh]" @close="showBackups = false">
      <EmptyState icon="History" compact title="暂无配置备份" description="保存一次配置后会自动产生备份" />
      <div v-for="backup in backups" :key="backup.id" class="card p-3 flex items-center gap-3">
        <div class="flex-1"><div class="text-sm">{{ formatTime(backup.createdAt) }}</div><div class="text-muted">{{ backup.reason }} · {{ backup.size }} 字符</div></div>
        <button class="btn-ghost" @click="previewBackup(backup)"><Eye class="w-4 h-4" />比较</button>
        <button class="btn-secondary" @click="restore(backup)"><Undo2 class="w-4 h-4" />恢复</button>
      </div>
    </BaseModal>

    <BaseModal :show="showPreview && !!changePreview" title="保存前变更预览" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl" body-class="p-3 space-y-3 max-h-[70vh] overflow-auto" @close="closePreview">
      <template v-if="changePreview">
        <div v-if="changePreview.added.length" class="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-2.5">
          <div class="text-xs font-semibold text-emerald-300">新增服务 {{ changePreview.added.length }}</div>
          <div class="mt-1 flex flex-wrap gap-1.5"><span v-for="item in changePreview.added" :key="item.service" class="count-badge text-emerald-300">{{ item.service }}</span></div>
        </div>
        <div v-if="changePreview.changed.length" class="rounded-lg border border-amber-900/40 bg-amber-950/20 p-2.5">
          <div class="text-xs font-semibold text-amber-300">配置变更,容器将被重建 {{ changePreview.changed.length }}</div>
          <div class="mt-1 space-y-1">
            <p v-for="item in changePreview.changed" :key="item.service" class="text-xs text-surface-300">{{ item.service }} <span class="text-surface-500">· {{ item.reasons.join(', ') }} · {{ item.container }}</span></p>
          </div>
        </div>
        <div v-if="changePreview.restarted.length" class="rounded-lg border border-sky-900/40 bg-sky-950/20 p-2.5">
          <div class="text-xs font-semibold text-sky-300">运行中容器将重启 {{ changePreview.restarted.length }}</div>
          <div class="mt-1 flex flex-wrap gap-1.5"><span v-for="item in changePreview.restarted" :key="item.service" class="count-badge text-sky-300">{{ item.service }}</span></div>
        </div>
        <div v-if="changePreview.removed.length" class="rounded-lg border border-rose-900/40 bg-rose-950/20 p-2.5">
          <div class="text-xs font-semibold text-rose-300">将被移除的服务 {{ changePreview.removed.length }}</div>
          <div class="mt-1 space-y-1"><p v-for="item in changePreview.removed" :key="item.service" class="text-xs text-surface-300">{{ item.service }} <span class="text-surface-500">· {{ item.container }} ({{ item.state }})</span></p></div>
        </div>
        <p v-if="!changePreview.added.length && !changePreview.changed.length && !changePreview.restarted.length && !changePreview.removed.length" class="text-xs text-surface-400">未检测到会影响现有容器的变更,可直接保存。</p>
      </template>
      <template #footer>
        <button class="btn-ghost" @click="closePreview">取消</button>
        <button class="btn-primary" @click="confirmSave"><Save class="w-4 h-4" />确认保存</button>
      </template>
    </BaseModal>

    <BaseModal :show="!!comparison" title="当前配置与备份比较" size-class="max-w-[calc(100vw-2rem)] sm:max-w-6xl" body-class="p-0" @close="comparison = null">
      <div class="grid md:grid-cols-2 gap-px bg-surface-800 max-h-[70vh] overflow-auto">
        <pre class="diff-pane"><template v-for="(row, index) in diffOld" :key="'o' + index"><span class="diff-line" :class="row.type === 'remove' ? 'diff-remove' : 'diff-same'">{{ row.text }}</span>
</template></pre>
        <pre class="diff-pane"><template v-for="(row, index) in diffNew" :key="'n' + index"><span class="diff-line" :class="row.type === 'add' ? 'diff-add' : 'diff-same'">{{ row.text }}</span>
</template></pre>
      </div>
    </BaseModal>

    <ConfirmDialog
      :show="showHostChangedDialog"
      title="节点已切换"
      message="节点已切换,当前未保存的修改将丢失,确认继续?"
      tone="warning"
      confirm-text="继续"
      @confirm="confirmHostChanged"
      @cancel="showHostChangedDialog = false"
    />

    <ConfirmDialog
      :show="showLeaveDialog"
      title="配置尚未保存"
      message="配置尚未保存,确认离开?"
      tone="warning"
      confirm-text="离开"
      @confirm="confirmLeave"
      @cancel="showLeaveDialog = false; leaveCallback = null"
    />

    <ConfirmDialog
      :show="showRestoreDialog"
      title="恢复配置备份"
      message="恢复该备份?当前配置也会先自动备份。"
      tone="warning"
      confirm-text="恢复"
      @confirm="confirmRestore"
      @cancel="showRestoreDialog = false; pendingBackup = null"
    />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useToastStore } from '../stores/toast.js';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { AlignLeft, ArrowLeft, ArrowRightLeft, Eye, FileCode2, HardDrive, History, Layout, Network, Pencil, Plus, RotateCw, Save, ShieldAlert, ShieldCheck, Trash2, Undo2, Variable, X } from 'lucide-vue-next';
import DockerRunConverter from '../components/DockerRunConverter.vue';
import Skeleton from '../components/common/Skeleton.vue';
import { diffLines } from '../lib/diff.js';
// 移除硬编码模板,改用模板市场 API
import EmptyState from '../components/common/EmptyState.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import BaseModal from '../components/common/BaseModal.vue';
import ServiceEditor from '../components/compose/ServiceEditor.vue';
import * as YAML from 'yaml';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { configureMonacoYaml } from 'monaco-yaml';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import YamlWorker from 'monaco-yaml/yaml.worker?worker';
import { api } from '../api/client.js';

self.MonacoEnvironment = { 
  getWorker: (moduleId, label) => {
    if (label === 'yaml') {
      return new YamlWorker();
    }
    return new EditorWorker();
  }
};

// Configure Docker Compose schema for YAML validation
configureMonacoYaml(monaco, {
  enableSchemaRequest: true,
  hover: true,
  completion: true,
  validate: true,
  format: true,
  schemas: [
    {
      uri: 'https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json',
      fileMatch: ['*'],
    }
  ]
});

// Popular Docker images for intelligent suggestions
const popularImages = [
  { label: 'postgres:16-alpine', detail: 'PostgreSQL 16', description: '轻量级 PostgreSQL 数据库' },
  { label: 'postgres:15-alpine', detail: 'PostgreSQL 15', description: 'PostgreSQL 数据库' },
  { label: 'redis:7-alpine', detail: 'Redis 7', description: '内存数据库和缓存' },
  { label: 'redis:6-alpine', detail: 'Redis 6', description: 'Redis 缓存服务器' },
  { label: 'mysql:8', detail: 'MySQL 8', description: 'MySQL 数据库服务器' },
  { label: 'mysql:5.7', detail: 'MySQL 5.7', description: 'MySQL 数据库' },
  { label: 'mariadb:11', detail: 'MariaDB 11', description: 'MariaDB 数据库' },
  { label: 'mongo:7', detail: 'MongoDB 7', description: 'NoSQL 文档数据库' },
  { label: 'mongo:6', detail: 'MongoDB 6', description: 'MongoDB 数据库' },
  { label: 'nginx:alpine', detail: 'Nginx', description: 'Web 服务器和反向代理' },
  { label: 'nginx:latest', detail: 'Nginx', description: '高性能 Web 服务器' },
  { label: 'node:20-alpine', detail: 'Node.js 20', description: 'Node.js 运行时' },
  { label: 'node:18-alpine', detail: 'Node.js 18', description: 'Node.js LTS' },
  { label: 'python:3.12-slim', detail: 'Python 3.12', description: 'Python 运行时' },
  { label: 'python:3.11-slim', detail: 'Python 3.11', description: 'Python 解释器' },
  { label: 'golang:1.22-alpine', detail: 'Go 1.22', description: 'Go 编译器和运行时' },
  { label: 'openjdk:21-jdk-slim', detail: 'OpenJDK 21', description: 'Java JDK' },
  { label: 'rabbitmq:3-management', detail: 'RabbitMQ 3', description: '消息队列服务器' },
  { label: 'elasticsearch:8.11.0', detail: 'Elasticsearch 8', description: '搜索和分析引擎' },
  { label: 'kibana:8.11.0', detail: 'Kibana 8', description: 'Elasticsearch 可视化' },
  { label: 'grafana/grafana:latest', detail: 'Grafana', description: '监控数据可视化' },
  { label: 'prom/prometheus:latest', detail: 'Prometheus', description: '监控和告警系统' },
  { label: 'traefik:v2.10', detail: 'Traefik', description: '现代反向代理和负载均衡' },
  { label: 'caddy:alpine', detail: 'Caddy', description: '自动 HTTPS Web 服务器' },
];
const route = useRoute(); const router = useRouter();
const editorEl = ref(null); const editorReady = ref(false); const projects = ref([]); const projectsLoaded = ref(false); const projectId = ref('');
const fileIndex = ref(0); const filePath = ref(''); const content = ref(''); const original = ref('');
const saving = ref(false); const error = ref(''); const message = ref(''); const backups = ref([]);
const showBackups = ref(false); const comparison = ref(null); const showConverter = ref(false);
const diffOld = computed(() => comparison.value ? diffLines(comparison.value.content, content.value).filter((row) => row.type !== 'add') : []);
const diffNew = computed(() => comparison.value ? diffLines(comparison.value.content, content.value).filter((row) => row.type !== 'remove') : []);
const semanticIssues = ref([]);
const changePreview = ref(null);
const showPreview = ref(false);
const previewLoading = ref(false);
const templateId = ref('');
const templates = ref([]); // 动态加载的模板列表(收藏+内置)
const showHostChangedDialog = ref(false);
const showLeaveDialog = ref(false);
const showRestoreDialog = ref(false);
const pendingBackup = ref(null);
const leaveCallback = ref(null);
const editorMode = ref('code');
const visualServices = ref([]);
const showServiceEditor = ref(false);
const currentService = ref(null);
const isNewService = ref(false);
let editor;
let completionDisposable;
let contentDisposable;
const project = computed(() => projects.value.find((p) => p.id === projectId.value));
const dirty = computed(() => content.value !== original.value);
const toast = useToastStore();

onMounted(async () => {
  await Promise.all([reloadProjects(), loadTemplates()]);
  projectsLoaded.value = true;
  await nextTick(); createEditor(); await syncProjectFromRoute();
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('composeops:host-changed', onHostChanged);
});
async function reloadProjects() { projects.value = (await api.getProjects()).projects.filter((p) => p.editable); }
function resetLoadedConfig() {
  fileIndex.value = 0;
  filePath.value = '';
  content.value = '';
  original.value = '';
  error.value = '';
  message.value = '';
  semanticIssues.value = [];
  changePreview.value = null;
  showPreview.value = false;
  visualServices.value = [];
  editor?.setValue('');
}
async function syncProjectFromRoute() {
  if (!projectsLoaded.value) return;
  const requestedId = String(route.query.projectId || '');
  if (!requestedId) {
    if (projectId.value) {
      projectId.value = '';
      resetLoadedConfig();
    }
    return;
  }
  if (!projects.value.some((item) => item.id === requestedId)) {
    projectId.value = '';
    resetLoadedConfig();
    const query = { ...route.query };
    delete query.projectId;
    await router.replace({ query });
    return;
  }
  if (projectId.value === requestedId) return;
  projectId.value = requestedId;
  resetLoadedConfig();
  await load();
}
watch(() => route.query.projectId, () => { void syncProjectFromRoute(); });
async function loadTemplates() {
  try {
    const [favoriteResult, builtinResult] = await Promise.all([
      api.searchMarketplaceTemplates({ source: 'all', limit: 20 }),
      api.searchMarketplaceTemplates({ source: 'builtin', limit: 10 })
    ]);
    const favorites = (favoriteResult.templates || []).filter(t => t.isFavorite);
    const builtins = (builtinResult.templates || []).slice(0, 5);
    const merged = [...favorites];
    for (const tpl of builtins) {
      if (!merged.find(m => m.id === tpl.id)) merged.push(tpl);
    }
    templates.value = merged.map(t => ({
      id: t.id,
      label: t.name,
      description: t.description,
      source: t.source,
      compose: t.defaultCompose,
      isFavorite: t.isFavorite
    }));
  } catch (e) {
    console.warn('加载模板失败:', e);
  }
}
function onHostChanged() {
  if (dirty.value) {
    showHostChangedDialog.value = true;
    return;
  }
  void reloadProjects().then(() => { if (projectId.value && !projects.value.some((p) => p.id === projectId.value)) { projectId.value = ''; selectProject(); } });
}
function confirmHostChanged() {
  showHostChangedDialog.value = false;
  void reloadProjects().then(() => { if (projectId.value && !projects.value.some((p) => p.id === projectId.value)) { projectId.value = ''; selectProject(); } });
}
onBeforeUnmount(() => {
  contentDisposable?.dispose();
  completionDisposable?.dispose();
  editor?.getModel()?.dispose();
  editor?.dispose();
  editor = null;
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('composeops:host-changed', onHostChanged);
});
onBeforeRouteLeave((to, from, next) => {
  if (!dirty.value) { next(); return; }
  leaveCallback.value = next;
  showLeaveDialog.value = true;
});
function confirmLeave() {
  showLeaveDialog.value = false;
  if (leaveCallback.value) { leaveCallback.value(); leaveCallback.value = null; }
}
function beforeUnload(event) { if (dirty.value) { event.preventDefault(); event.returnValue = ''; } }
function createEditor() {
  if (!editorEl.value || editor) return;
  editor = monaco.editor.create(editorEl.value, { value: '', language: 'yaml', theme: 'vs-dark', automaticLayout: true, fontSize: 13, minimap: { enabled: false }, tabSize: 2, scrollBeyondLastLine: false });
  contentDisposable = editor.onDidChangeModelContent(() => {
    content.value = editor.getValue(); 
    message.value = ''; 
    validateInlineErrors();
  });
  
  // Register custom completion provider for intelligent suggestions
  completionDisposable = monaco.languages.registerCompletionItemProvider('yaml', {
    provideCompletionItems: (model, position) => {
      const textUntilPosition = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      
      const suggestions = [];
      
      // Suggest popular Docker images when typing after "image:"
      if (/image:\s*['"]?[\w/-]*$/.test(textUntilPosition)) {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        
        popularImages.forEach((image) => {
          suggestions.push({
            label: image.label,
            kind: monaco.languages.CompletionItemKind.Value,
            detail: image.detail,
            documentation: image.description,
            insertText: image.label,
            range: range,
          });
        });
      }
      
      // Suggest existing service names for depends_on, links, etc.
      if (/(?:depends_on|links):\s*$/.test(textUntilPosition) || /(?:depends_on|links):\s*-\s*$/.test(textUntilPosition)) {
        const serviceNames = extractServiceNames(model.getValue());
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        
        serviceNames.forEach((serviceName) => {
          suggestions.push({
            label: serviceName,
            kind: monaco.languages.CompletionItemKind.Reference,
            detail: '现有服务',
            documentation: `引用服务: ${serviceName}`,
            insertText: serviceName,
            range: range,
          });
        });
      }
      
      return { suggestions };
    },
  });
  
  editorReady.value = true;
}

// Extract service names from YAML content
function extractServiceNames(yamlContent) {
  try {
    const parsed = YAML.parse(yamlContent);
    if (parsed?.services) {
      return Object.keys(parsed.services);
    }
  } catch {
    // If parsing fails, return empty array
  }
  return [];
}

// Validate YAML and set inline error markers
function validateInlineErrors() {
  if (!editor) return;
  
  const model = editor.getModel();
  if (!model) return;
  
  const markers = [];
  const yamlContent = model.getValue();
  
  // Basic YAML syntax validation
  try {
    const parsed = YAML.parse(yamlContent);
    
    // Check for common Docker Compose errors
    if (parsed?.services) {
      Object.entries(parsed.services).forEach(([serviceName, serviceConfig]) => {
        // Find line number for this service (approximate)
        const lines = yamlContent.split('\n');
        let serviceLine = 0;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(serviceName + ':')) {
            serviceLine = i + 1;
            break;
          }
        }
        
        // Check for missing image
        if (!serviceConfig.image && !serviceConfig.build) {
          markers.push({
            severity: monaco.MarkerSeverity.Error,
            startLineNumber: serviceLine,
            startColumn: 1,
            endLineNumber: serviceLine,
            endColumn: 999,
            message: `服务 "${serviceName}" 缺少 image 或 build 字段`,
          });
        }
        
        // Check for invalid port format
        if (serviceConfig.ports) {
          serviceConfig.ports.forEach((port, idx) => {
            const portStr = String(port);
            if (!/^\d+:\d+$/.test(portStr) && !/^\d+$/.test(portStr) && !/^[\d.]+:\d+:\d+$/.test(portStr)) {
              const portLine = findLineByContent(yamlContent, portStr, serviceLine);
              markers.push({
                severity: monaco.MarkerSeverity.Warning,
                startLineNumber: portLine,
                startColumn: 1,
                endLineNumber: portLine,
                endColumn: 999,
                message: `端口格式可能不正确: "${portStr}" (建议格式: "8080:80" 或 "3000")`,
              });
            }
          });
        }
        
        // Check for invalid depends_on references
        if (serviceConfig.depends_on) {
          const allServices = Object.keys(parsed.services);
          const deps = Array.isArray(serviceConfig.depends_on) ? serviceConfig.depends_on : Object.keys(serviceConfig.depends_on);
          deps.forEach((dep) => {
            if (!allServices.includes(dep)) {
              const depLine = findLineByContent(yamlContent, dep, serviceLine);
              markers.push({
                severity: monaco.MarkerSeverity.Error,
                startLineNumber: depLine,
                startColumn: 1,
                endLineNumber: depLine,
                endColumn: 999,
                message: `depends_on 引用的服务 "${dep}" 不存在`,
              });
            }
          });
        }
        
        // Check for volumes with potentially wrong syntax
        if (serviceConfig.volumes) {
          serviceConfig.volumes.forEach((volume) => {
            const volStr = String(volume);
            // Named volumes or bind mounts should have ":" or be named volumes
            if (!volStr.includes(':') && !volStr.startsWith('/') && volStr.includes(' ')) {
              const volLine = findLineByContent(yamlContent, volStr, serviceLine);
              markers.push({
                severity: monaco.MarkerSeverity.Warning,
                startLineNumber: volLine,
                startColumn: 1,
                endLineNumber: volLine,
                endColumn: 999,
                message: `卷路径可能包含空格,建议使用引号包裹: "${volStr}"`,
              });
            }
          });
        }
      });
    }
  } catch (e) {
    // YAML parse error - show syntax error
    if (e instanceof Error) {
      // Try to extract line number from YAML parse error
      const lineMatch = e.message.match(/line (\d+)/i);
      const line = lineMatch ? parseInt(lineMatch[1]) : 1;
      
      markers.push({
        severity: monaco.MarkerSeverity.Error,
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: 999,
        message: `YAML 语法错误: ${e.message}`,
      });
    }
  }
  
  monaco.editor.setModelMarkers(model, 'yaml-validator', markers);
}

// Helper function to find approximate line number by content
function findLineByContent(yamlContent, searchText, startLine = 0) {
  const lines = yamlContent.split('\n');
  for (let i = startLine; i < lines.length; i++) {
    if (lines[i].includes(searchText)) {
      return i + 1;
    }
  }
  return startLine || 1;
}
async function selectProject() { resetLoadedConfig(); await router.replace({ query: projectId.value ? { projectId: projectId.value } : {} }); await nextTick(); createEditor(); if (projectId.value) load(); }
async function load() {
  const requestedProjectId = projectId.value;
  const requestedFileIndex = fileIndex.value;
  error.value = ''; message.value = ''; semanticIssues.value = []; showPreview.value = false; changePreview.value = null;
  try {
    const data = await api.getComposeFile(requestedProjectId, requestedFileIndex);
    if (projectId.value !== requestedProjectId || fileIndex.value !== requestedFileIndex || String(route.query.projectId || '') !== requestedProjectId) return;
    filePath.value = data.path; original.value = content.value = data.content; editor?.setValue(data.content);
  } catch (e) {
    if (projectId.value === requestedProjectId && fileIndex.value === requestedFileIndex) error.value = e.message;
  }
}
async function validateSemantics() {
  error.value = '';
  if (!content.value.trim()) { semanticIssues.value = []; error.value = 'Compose 内容不能为空'; return false; }
  try {
    const result = await api.validateCompose(projectId.value, fileIndex.value, content.value);
    semanticIssues.value = result.issues || [];
    if (semanticIssues.value.some((issue) => issue.level === 'error')) {
      error.value = '语义校验未通过,请修复错误后再保存';
      return false;
    }
    return true;
  } catch (e) { error.value = e.message; }
  return false;
}
async function save() {
  error.value = '';
  if (!await validateSemantics()) return;
  // 保存前展示变更预览(影响哪些容器会被重建/重启)
  previewLoading.value = true;
  try {
    changePreview.value = await api.previewCompose(projectId.value, content.value);
    if (!changePreview.value) {
      error.value = '变更预览未返回结果,未保存,请重试';
      return;
    }
    const preview = changePreview.value || {};
    const impactful = (preview.added || []).length + (preview.changed || []).length + (preview.restarted || []).length + (preview.removed || []).length;
    if (impactful) { showPreview.value = true; return; } // 有影响,等用户确认
  } catch (e) {
    changePreview.value = null;
    error.value = `变更预览失败,未保存: ${e.message}`;
    return;
  }
  finally { previewLoading.value = false; }
  await confirmSave(); // 无影响时直接保存
}
async function confirmSave() {
  saving.value = true; error.value = '';
  try {
    await api.saveComposeFile(projectId.value, fileIndex.value, content.value);
    original.value = content.value; message.value = `已校验并保存 · ${new Date().toLocaleTimeString()}`;
    showPreview.value = false; changePreview.value = null; semanticIssues.value = [];
  }
  catch (e) { error.value = e.message; }
  finally { saving.value = false; }
}
function closePreview() { showPreview.value = false; changePreview.value = null; }
function insertTemplate() {
  // 处理"前往模板市场"选项
  if (templateId.value === '__goto_marketplace__') {
    templateId.value = '';
    router.push('/marketplace');
    return;
  }
  
  const template = templates.value.find((item) => item.id === templateId.value);
  templateId.value = '';
  if (!template || !editor) return;
  const current = editor.getValue();
  
  // 模板市场的模板使用 compose 字段(完整 YAML),需要提取 services 部分
  let servicesToInsert = '';
  try {
    if (template.compose) {
      const parsed = YAML.parse(template.compose);
      if (parsed?.services) {
        // 提取所有服务定义,转为 YAML 字符串
        const servicesYaml = YAML.stringify({ services: parsed.services }, { indent: 2, lineWidth: 0 });
        // 去掉外层的 "services:\n" 前缀,只保留服务内容
        servicesToInsert = servicesYaml.replace(/^services:\n/, '').split('\n').map(line => line ? '  ' + line : '').join('\n');
      }
    } else if (template.insert) {
      // 兼容旧的硬编码模板格式(如果还有的话)
      servicesToInsert = template.insert;
    }
  } catch (e) {
    error.value = `模板解析失败: ${e.message}`;
    return;
  }
  
  if (!servicesToInsert) {
    error.value = '模板内容为空';
    return;
  }
  
  const snippet = `\n${servicesToInsert}\n`;
  const hasServices = /^services:/m.test(current);
  const next = hasServices
    ? current.replace(/(^services:\n)/, `$1${snippet}`)
    : `${current}${current ? '\n' : ''}services:\n${servicesToInsert}\n`;
  editor.setValue(next);
  editor.trigger('keyboard', 'editor.action.formatDocument', {});
  
  const sourceLabel = template.source === 'builtin' ? '内置' : template.source === 'community' ? '社区' : '自定义';
  message.value = `已插入${sourceLabel}模板「${template.label}」,请按需修改`;
}
function formatYaml() { try { const next = YAML.stringify(YAML.parse(content.value), { indent: 2, lineWidth: 0 }); editor.setValue(next); } catch (e) { error.value = e.message; } }
async function loadBackups() { backups.value = (await api.getBackups(projectId.value)).backups || []; showBackups.value = true; }
async function previewBackup(backup) { comparison.value = await api.getBackup(projectId.value, backup.id); }
async function restore(backup) {
  pendingBackup.value = backup;
  showRestoreDialog.value = true;
}
async function confirmRestore() {
  const backup = pendingBackup.value;
  showRestoreDialog.value = false;
  try {
    await api.restoreBackup(projectId.value, backup.id);
    showBackups.value = false;
    await load();
    toast.success('配置版本已成功回滚并生效');
  } catch (e) {
    toast.error(`备份恢复失败:${e.message}`);
  } finally {
    pendingBackup.value = null;
  }
}
function shortName(file) { return file.split('/').pop(); }
function formatTime(value) { return new Date(`${value}Z`).toLocaleString(); }

function toggleEditorMode() {
  editorMode.value = editorMode.value === 'code' ? 'visual' : 'code';
  if (editorMode.value === 'visual') {
    parseYamlToServices();
  }
}

function parseYamlToServices() {
  visualServices.value = [];
  if (!content.value.trim()) return;
  try {
    const parsed = YAML.parse(content.value);
    if (!parsed?.services) return;
    visualServices.value = Object.entries(parsed.services).map(([name, service]) => ({
      name,
      ...service,
    }));
  } catch (e) {
    error.value = `YAML 解析失败: ${e.message}`;
  }
}

function syncServicesToYaml() {
  try {
    const parsed = content.value.trim() ? YAML.parse(content.value) : {};
    const services = {};
    visualServices.value.forEach((service) => {
      const { name, ...serviceConfig } = service;
      services[name] = serviceConfig;
    });
    parsed.services = services;
    const newYaml = YAML.stringify(parsed, { indent: 2, lineWidth: 0 });
    content.value = newYaml;
    editor?.setValue(newYaml);
  } catch (e) {
    error.value = `YAML 生成失败: ${e.message}`;
  }
}

function addService() {
  currentService.value = null;
  isNewService.value = true;
  showServiceEditor.value = true;
}

function editService(service) {
  currentService.value = { ...service };
  isNewService.value = false;
  showServiceEditor.value = true;
}

function deleteService(serviceName) {
  visualServices.value = visualServices.value.filter((s) => s.name !== serviceName);
  syncServicesToYaml();
  message.value = `已删除服务 ${serviceName}`;
}

function saveServiceFromEditor({ name, service }) {
  if (isNewService.value) {
    visualServices.value.push({ name, ...service });
    message.value = `已添加服务 ${name}`;
  } else {
    const index = visualServices.value.findIndex((s) => s.name === (currentService.value?.name || name));
    if (index !== -1) {
      const oldName = visualServices.value[index].name;
      visualServices.value[index] = { name, ...service };
      message.value = oldName !== name ? `已重命名服务 ${oldName} → ${name}` : `已更新服务 ${name}`;
    }
  }
  syncServicesToYaml();
  showServiceEditor.value = false;
}

watch(editorMode, (newMode) => {
  if (newMode === 'visual') {
    parseYamlToServices();
  }
});
</script>
