<template>
  <div class="page-shell page-shell-workspace">
    <ProjectContextNav :project="project" :container-id="String(route.query.containerId || '')" :disabled="hostStale" />
    <div class="page-header">
      <div><h1 class="page-title">Compose 配置</h1><p class="page-subtitle">保存前执行 YAML 与 docker compose config 校验</p></div>
      <div class="page-actions compose-toolbar-actions">
        <div class="compose-toolbar-group" role="group" aria-label="项目与配置文件">
        <select :value="projectId" class="input min-w-52" aria-label="选择 Compose 项目" :disabled="saving || restoring || previewLoading || hostStale" @change="selectProject($event.target.value); $event.target.value = projectId"><option value="">选择项目</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.projectName }}</option></select>
        <button v-if="projectId" class="btn-secondary" title="清除当前选择,回到引导页" aria-label="清除当前 Compose 项目" :disabled="saving || restoring || previewLoading || hostStale" @click="selectProject('')"><X class="w-4 h-4" /></button>
        <select v-if="project?.composeFiles.length > 1" :value="fileIndex" class="input" aria-label="选择 Compose 配置文件" :disabled="saving || restoring || previewLoading || hostStale" @change="selectFile($event)"><option v-for="(file, i) in project.composeFiles" :key="file" :value="i">{{ shortName(file) }}</option></select>
        </div>
        <div class="compose-toolbar-group compose-toolbar-tools" role="group" aria-label="编辑与辅助工具">
        <button class="btn-secondary" :disabled="!content" @click="toggleEditorMode"><Layout class="w-4 h-4" />{{ editorMode === 'code' ? '可视化' : '代码' }}</button>
        <button class="btn-secondary" :disabled="!content || saving || previewLoading || loadingConfig || hostStale" @click="validateSemantics()"><ShieldCheck class="w-4 h-4" />语义校验</button>
        <select v-model="templateId" class="input w-40" title="常用服务模板" aria-label="插入常用服务模板" @change="insertTemplate">
          <option value="">插入模板...</option>
          <option v-for="template in templates" :key="template.id" :value="template.id">{{ template.label }} · {{ template.description }}</option>
          <option value="" disabled>──────────</option>
          <option value="__goto_marketplace__">前往模板市场</option>
        </select>
        <button class="btn-secondary" :disabled="!content" @click="formatYaml"><AlignLeft class="w-4 h-4" />格式化</button>
        <button class="btn-secondary" title="把 docker run 命令转换为 Compose 片段" @click="showConverter = true"><ArrowRightLeft class="w-4 h-4" />转换</button>
        <button class="btn-secondary" :disabled="!projectId || hostStale || restoring || saving || loadingConfig" @click="loadBackups"><History class="w-4 h-4" />备份</button>
        </div>
        <div class="compose-toolbar-group compose-toolbar-primary" role="group" aria-label="保存配置">
        <button class="btn-primary" :disabled="saving || restoring || previewLoading || loadingConfig || hostStale || !filePath || !dirty" @click="save"><Save class="w-4 h-4" />{{ saving ? '保存中…' : previewLoading ? '校验中…' : '保存' }}</button>
        </div>
      </div>
    </div>
    <div v-if="filePath" class="text-muted font-mono truncate">{{ filePath }}<span v-if="dirty" class="text-status-warn ml-2">● 未保存</span></div>
    <div v-if="hostStale" class="alert-warning flex flex-wrap items-center gap-3" role="alert"><span class="flex-1">节点已切换，当前草稿属于原节点。请先复制保留需要的内容，再重新载入。</span><button class="btn-secondary" @click="showHostChangedDialog = true">重新载入当前节点</button></div>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p><p v-if="message" class="alert-success" role="status" aria-live="polite" aria-atomic="true">{{ message }}</p>
    <div v-if="savedPendingApply && !dirty && !hostStale" class="compose-saved-next" role="status">
      <CircleCheck :size="18" class="text-status-ok shrink-0" />
      <div class="min-w-0 flex-1"><strong>配置文件已保存</strong><p>保存文件不会自动更新容器。返回项目后选择「应用配置」，再查看状态或日志确认结果。</p></div>
      <RouterLink class="btn-secondary" :to="projectReturnLocation(route.query.returnTo, projectId)">返回项目<ArrowRight :size="15" /></RouterLink>
    </div>
    <div v-if="semanticIssues.length" class="card p-3 space-y-1.5 border border-status-warn/40">
      <div class="flex items-center gap-2 text-xs font-semibold text-status-warn"><ShieldAlert class="w-4 h-4" />语义校验 {{ semanticIssues.filter((i) => i.level === 'error').length }} 个错误 · {{ semanticIssues.filter((i) => i.level === 'warn').length }} 个警告</div>
      <p v-for="(issue, index) in semanticIssues" :key="index" class="flex items-start gap-2 text-xs" :class="issue.level === 'error' ? 'text-status-error' : issue.level === 'warn' ? 'text-status-warn' : 'text-surface-400'">
        <span class="shrink-0 font-semibold">{{ issue.level === 'error' ? '✕' : issue.level === 'warn' ? '!' : 'i' }}</span>
        <span>{{ issue.message }}<template v-if="issue.service"> · {{ issue.service }}</template></span>
      </p>
    </div>
    <EmptyState v-if="!projectId" icon="FileCode2" title="请先选择一个已挂载的项目" description="选择项目后即可查看与编辑 Compose 配置" class="flex-1" />
    <div v-else-if="editorMode === 'code'" class="card relative flex-1 min-h-[420px] overflow-hidden ring-1 ring-black/10">
      <Skeleton v-if="!editorReady || loadingConfig" class="skeleton-workspace" :rows="10" label="配置加载中" />
      <div ref="editorEl" class="absolute inset-0" :class="{ invisible: !editorReady || loadingConfig }"></div>
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
              <button class="icon-btn" :aria-label="`编辑服务 ${service.name}`" :title="`编辑服务 ${service.name}`" @click="editService(service)"><Pencil class="w-4 h-4" /></button>
              <button class="icon-btn text-status-error hover:text-status-error" :aria-label="`删除服务 ${service.name}`" :title="`删除服务 ${service.name}`" @click="deleteService(service.name)"><Trash2 class="w-4 h-4" /></button>
            </div>
          </div>
          <div v-if="service.ports?.length" class="pt-2 border-t border-surface-800">
            <div class="text-xs font-medium text-surface-300 mb-1.5">端口映射</div>
            <div class="flex flex-wrap gap-2">
              <span v-for="(port, idx) in service.ports" :key="idx" class="text-xs px-2 py-1 rounded-sm bg-surface-900 text-status-ok font-mono">{{ port }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <BaseModal :show="showServiceEditor" :title="isNewService ? '新增服务' : '编辑服务'" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[85vh] overflow-auto" body-class="p-0" @close="showServiceEditor = false">
      <ServiceEditor :model-value="currentService" :is-new="isNewService" @save="saveServiceFromEditor" @close="showServiceEditor = false" />
    </BaseModal>

    <BaseModal :show="showConverter" title="Docker Run 转换器" size-class="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden" body-class="min-h-0 flex-1 overflow-y-auto p-4" @close="showConverter = false">
      <DockerRunConverter />
    </BaseModal>

    <BaseModal :show="showBackups" :close-disabled="restoring" title="配置备份（最近 20 份）" size-class="max-w-[calc(100vw-2rem)] sm:max-w-3xl" body-class="p-4 space-y-3 overflow-auto max-h-[65vh]" @close="closeBackups()">
      <div class="compose-version-intro"><History class="h-5 w-5 shrink-0 text-emerald-300" /><div><p class="text-sm font-medium text-surface-200">{{ project?.projectName }} · 配置版本</p><p class="mt-1 text-xs leading-5 text-surface-400">先比较目标文件，再恢复。恢复只改文件，应用配置后容器才会更新。</p></div></div>
      <p v-if="backupError" class="alert-error" role="alert">{{ backupError }} <button :disabled="backupsLoading" class="underline" @click="loadBackups">重新读取版本</button></p>
      <Skeleton v-if="backupsLoading && !backups.length" :rows="3" label="正在读取配置版本" />
      <EmptyState v-else-if="!backups.length && !backupError" icon="History" compact title="暂无配置备份" description="保存一次配置后会自动产生备份" />
      <div v-for="backup in backups" :key="backup.id" class="compose-version-card" :data-backup-id="backup.id" :aria-busy="comparisonLoadingId === backup.id">
        <div class="min-w-0 flex-1"><p class="compose-version-file"><FileCode2 class="h-4 w-4 shrink-0" /><span>{{ shortName(backup.filePath || '') || '文件未知' }}</span><span v-if="backup.filePath === filePath" class="count-badge text-emerald-300 shrink-0">当前文件</span></p><p class="mt-2 text-sm tabular-nums text-surface-300">{{ formatTime(backup.createdAt) }}</p><p class="mt-1 text-xs text-surface-400">{{ backupReason(backup.reason) }} · {{ backup.size }} 字符</p><p v-if="backupFileIndex(backup) < 0" class="mt-1 text-xs text-status-warn">原文件已不在当前项目中，无法恢复。</p></div>
        <div class="compose-version-actions"><button class="btn-ghost" :disabled="comparisonLoadingId === backup.id || restoring || backupFileIndex(backup) < 0" @click="previewBackup(backup)"><Loader2 v-if="comparisonLoadingId === backup.id" class="w-4 h-4 animate-spin" /><Eye v-else class="w-4 h-4" />比较</button><button class="btn-secondary" :disabled="restoring || backupFileIndex(backup) < 0" @click="restore(backup)"><Undo2 class="w-4 h-4" />恢复</button></div>
      </div>
    </BaseModal>

    <BaseModal :show="showPreview && !!changePreview" title="保存前变更预览" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl" body-class="p-3 space-y-3 max-h-[70vh] overflow-auto" @close="closePreview">
      <template v-if="changePreview">
        <p class="text-sm leading-6 text-surface-300">仅保存配置，不会重启服务。以下对比当前文件的已保存版本；多文件合并、环境变量展开后的实际影响，请在部署前预演。</p>
        <div v-if="changePreview.added.length" class="rounded-lg border border-status-ok/40 bg-status-ok/20 p-2.5">
          <div class="text-xs font-semibold text-status-ok">新增服务 {{ changePreview.added.length }}</div>
          <div class="mt-1 flex flex-wrap gap-1.5"><span v-for="item in changePreview.added" :key="item.service" class="count-badge text-status-ok">{{ item.service }}</span></div>
        </div>
        <div v-if="changePreview.changed.length" class="rounded-lg border border-status-warn/40 bg-status-warn/20 p-2.5">
          <div class="text-xs font-semibold text-status-warn">配置变更的服务 {{ changePreview.changed.length }}</div>
          <div class="mt-1 space-y-1">
            <p v-for="item in changePreview.changed" :key="item.service" class="text-xs text-surface-300">{{ item.service }} <span class="text-surface-400">· {{ item.reasons.join(', ') }} · {{ item.container }}</span></p>
          </div>
        </div>
        <div v-if="changePreview.restarted.length" class="rounded-lg border border-sky-900/40 bg-sky-950/20 p-2.5">
          <div class="text-xs font-semibold text-sky-300">应用配置时可能受影响的运行容器 {{ changePreview.restarted.length }}</div>
          <div class="mt-1 flex flex-wrap gap-1.5"><span v-for="item in changePreview.restarted" :key="item.service" class="count-badge text-sky-300">{{ item.service }}</span></div>
        </div>
        <div v-if="changePreview.removed.length" class="rounded-lg border border-status-error/40 bg-status-error/15 p-2.5">
          <div class="text-xs font-semibold text-status-error">从当前文件移除的服务 {{ changePreview.removed.length }}</div>
          <div class="mt-1 space-y-1"><p v-for="item in changePreview.removed" :key="item.service" class="text-xs text-surface-300">{{ item.service }} <span class="text-surface-400">· {{ item.container }} ({{ item.state }})</span></p></div>
        </div>
        <div v-if="changePreview.portConflicts?.length" class="rounded-lg border border-status-error/50 bg-status-error/15 p-2.5">
          <div class="text-xs font-semibold text-status-error">宿主端口冲突 {{ changePreview.portConflicts.length }}</div>
          <p v-for="(item, index) in changePreview.portConflicts" :key="`${item.service}-${item.port}-${index}`" class="mt-1 text-xs text-surface-300">{{ item.service }} · {{ item.ip }}:{{ item.port }}/{{ item.protocol }} 已被 {{ item.holder }} 占用</p>
        </div>
        <p v-else-if="changePreview.portConflictsKnown === false" class="text-xs text-status-warn">未能读取宿主容器端口占用情况，本次未完成端口冲突检测。</p>
        <p v-if="changePreview.changeAnalysisKnown === false" class="text-xs text-status-warn">未能读取当前 Compose 文件，本次无法比较服务配置差异。</p>
        <p v-if="!changePreview.added.length && !changePreview.changed.length && !changePreview.restarted.length && !changePreview.removed.length && !changePreview.portConflicts.length" class="text-xs text-surface-400">未检测到已确认的容器变更。</p>
      </template>
      <template #footer>
        <button class="btn-ghost" :disabled="saving" @click="closePreview">取消</button>
        <button class="btn-primary" :disabled="saving" @click="confirmSave">
          <Save class="w-4 h-4" />{{ saving ? '保存中…' : '确认保存' }}
        </button>
      </template>
    </BaseModal>

    <BaseModal :show="!!comparison" title="当前配置与备份比较" size-class="max-w-[calc(100vw-2rem)] sm:max-w-6xl" body-class="p-0" @close="comparison = null">
      <p class="border-b border-surface-800 px-4 py-3 text-xs text-surface-400">{{ comparison?.filePath }} · 比较内容固定于打开时刻</p>
      <div class="grid md:grid-cols-2 gap-px bg-surface-800 max-h-[70vh] overflow-auto">
        <section class="min-w-0"><h3 class="compose-diff-label">备份版本 · {{ formatTime(comparison?.createdAt) }}</h3><pre class="diff-pane"><template v-for="(row, index) in diffOld" :key="'o' + index"><span class="diff-line" :class="row.type === 'remove' ? 'diff-remove' : 'diff-same'">{{ row.text }}</span>
</template></pre></section>
        <section class="min-w-0"><h3 class="compose-diff-label">{{ comparison?.baselineLabel }}</h3><pre class="diff-pane"><template v-for="(row, index) in diffNew" :key="'n' + index"><span class="diff-line" :class="row.type === 'add' ? 'diff-add' : 'diff-same'">{{ row.text }}</span>
</template></pre></section>
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
      message="当前配置有未保存的修改。切换项目或文件会丢弃这些修改，确认继续?"
      tone="warning"
      confirm-text="继续"
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />

    <ConfirmDialog
      :show="showRestoreDialog"
      title="恢复配置备份"
      :message="restoreMessage"
      tone="warning"
      confirm-text="恢复"
      :busy="restoring"
      @confirm="confirmRestore"
      @cancel="showRestoreDialog = false; pendingBackup = null"
    ><p v-if="restoreError" class="alert-error" role="alert">{{ restoreError }}</p></ConfirmDialog>
  </div>
</template>

<script setup>
import { useHostsStore } from '../stores/hosts.js';
import { projectReturnLocation } from '../lib/project-navigation.js';
import ProjectContextNav from '../components/services/ProjectContextNav.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useToastStore } from '../stores/toast.js';
import { RouterLink, onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { ArrowRight, CircleCheck, AlignLeft, ArrowRightLeft, Eye, FileCode2, HardDrive, History, Layout, Loader2, Network, Pencil, Plus, RotateCw, Save, ShieldAlert, ShieldCheck, Trash2, Undo2, Variable, X } from 'lucide-vue-next';
import DockerRunConverter from '../components/DockerRunConverter.vue';
import Skeleton from '../components/common/Skeleton.vue';
import { diffLines } from '../lib/diff.js';
import { formatTimestamp } from '../lib/date-time.js';
// 移除硬编码模板,改用模板市场 API
import EmptyState from '../components/common/EmptyState.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import BaseModal from '../components/common/BaseModal.vue';
import ServiceEditor from '../components/compose/ServiceEditor.vue';
import * as YAML from 'yaml';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { configureMonacoYaml } from 'monaco-yaml';
// monaco-yaml 只注册 yaml 语言与 worker 能力(hover/校验/补全/格式化),不提供 Monarch 词法;
// 缺了它编辑器只有纯文本着色。这里补 monaco 自带的 yaml 语法(约 7 kB,按需懒加载)。
// 放在 configureMonacoYaml 之后触发:两份 setLanguageConfiguration 同优先级时后注册的胜出,
// monaco 的 conf 更全(带 onEnterRules/indentationRules)。
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
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
const loadingConfig = ref(false);
const hostStale = ref(false);
const savedPendingApply = ref(false);
let configVersion = 0;
let pendingSave = null;
const showBackups = ref(false); const comparison = ref(null); const showConverter = ref(false);
const diffOld = computed(() => comparison.value ? diffLines(comparison.value.content, comparison.value.baseline).filter((row) => row.type !== 'add') : []);
const diffNew = computed(() => comparison.value ? diffLines(comparison.value.content, comparison.value.baseline).filter((row) => row.type !== 'remove') : []);
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
const restoring = ref(false);
const restoreError = ref('');
const backupsLoading = ref(false);
const backupError = ref('');
const comparisonLoadingId = ref(null);
let backupListRequest = 0;
let comparisonRequest = 0;
let restoreRequest = 0;
const restoreMessage = computed(() => `恢复「${shortName(pendingBackup.value?.backup.filePath || '')}」的此版本？磁盘上的当前文件会先自动备份。${dirty.value ? '编辑器中未保存的修改将丢弃，不会进入自动备份。' : ''}恢复只修改文件，不会自动更新容器。`);
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
const hostsStore = useHostsStore();

// 编辑器有未保存改动时不响应下拉刷新,否则本地内容会被远端版本覆盖。
usePullRefresh(async () => {
  await reloadProjects();
  if (projectId.value && !dirty.value && !saving.value && !restoring.value && !previewLoading.value) await load({ background: true });
}, { keepAlive: true, refreshOnActivate: true, enabled: () => !dirty.value && !saving.value && !restoring.value && !previewLoading.value && !hostStale.value });
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('composeops:host-changed', onHostChanged);
  try {
    await Promise.all([reloadProjects(), loadTemplates()]);
    projectsLoaded.value = true;
    await nextTick(); createEditor(); await syncProjectFromRoute();
  } catch (e) { error.value = e.message; }
});
async function reloadProjects() { projects.value = (await api.getProjects(true)).projects.filter((p) => p.editable); }
function resetLoadedConfig() {
  configVersion += 1;
  loadingConfig.value = false;
  pendingSave = null;
  fileIndex.value = 0;
  filePath.value = '';
  content.value = '';
  original.value = '';
  error.value = '';
  message.value = '';
  savedPendingApply.value = false;
  semanticIssues.value = [];
  changePreview.value = null;
  showPreview.value = false;
  visualServices.value = [];
  resetBackupContext();
  editor?.setValue('');
}
async function syncProjectFromRoute() {
  if (!projectsLoaded.value || route.name !== 'compose' || hostStale.value) return;
  let requestedId = String(route.query.projectId || '');
  if (!requestedId && !dirty.value) {
    let remembered = null;
    try { remembered = sessionStorage.getItem(selectionKey()); } catch { /* 浏览器可能禁用存储 */ }
    const choice = projects.value.find(item => item.id === remembered)
      || (remembered !== '' && projects.value.length === 1 ? projects.value[0] : null);
    if (choice) {
      requestedId = choice.id;
      // 导航参数成为唯一选择来源；下一次 watch 完成装载。
      await router.replace({ query: { ...route.query, projectId: requestedId } });
      return;
    }
  }
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
  rememberSelection();
  resetLoadedConfig();
  await load();
}
watch(() => [route.name, route.query.projectId], () => { void syncProjectFromRoute(); });
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
  configVersion += 1;
  hostStale.value = true;
  loadingConfig.value = false;
  closePreview();
  resetBackupContext();
  if (dirty.value) {
    showHostChangedDialog.value = true;
    return;
  }
  void confirmHostChanged();
}
async function confirmHostChanged() {
  showHostChangedDialog.value = false;
  try {
    await reloadProjects();
    resetLoadedConfig();
    projectId.value = '';
    hostStale.value = false;
    await syncProjectFromRoute();
  } catch (e) { error.value = e.message; }
}
onBeforeUnmount(() => {
  configVersion++;
  resetBackupContext();
  disposeEditor();
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('composeops:host-changed', onHostChanged);
  cancelLeave();
});
function allowConfigSwitch() {
  if (saving.value || restoring.value || previewLoading.value) {
    toast.info('正在校验、保存或恢复配置，请稍后再切换');
    return false;
  }
  if (!dirty.value) return true;
  // 新的导航必须先结束旧导航，取消时也必须显式 resolve(false)。
  leaveCallback.value?.(false);
  return new Promise((resolve) => {
    leaveCallback.value = resolve;
    showLeaveDialog.value = true;
  });
}
onBeforeRouteLeave(() => allowConfigSwitch());
onBeforeRouteUpdate((to, from) => {
  if (to.query.projectId !== from.query.projectId) return allowConfigSwitch();
});
function confirmLeave() {
  showLeaveDialog.value = false;
  leaveCallback.value?.(true);
  leaveCallback.value = null;
}
function cancelLeave() {
  showLeaveDialog.value = false;
  leaveCallback.value?.(false);
  leaveCallback.value = null;
}
function beforeUnload(event) { if (dirty.value || restoring.value) { event.preventDefault(); event.returnValue = ''; } }
watch(restoring, value => { editor?.updateOptions?.({ readOnly: value }); });
function disposeEditor() {
  completionDisposable?.dispose();
  contentDisposable?.dispose();
  editor?.getModel()?.dispose();
  editor?.dispose();
  completionDisposable = null;
  contentDisposable = null;
  editor = null;
  editorReady.value = false;
}
// The editor host is conditional on both the project and view mode. Recreate
// Monaco when Vue mounts a new host, including direct links into a project.
watch(editorEl, (element, previous) => {
  if (element === previous) return;
  disposeEditor();
  if (element) createEditor();
}, { flush: 'post' });

function createEditor() {
  if (!editorEl.value || editor) return;
  editor = monaco.editor.create(editorEl.value, { value: content.value, language: 'yaml', theme: 'vs-dark', automaticLayout: true, fontSize: 13, minimap: { enabled: false }, tabSize: 2, scrollBeyondLastLine: false });
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
          serviceConfig.ports.forEach((port) => {
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
function selectionKey() { return `composeops:compose-project:${hostsStore.activeHostId || 'local'}`; }
function rememberSelection() { try { sessionStorage.setItem(selectionKey(), projectId.value); } catch { /* 选择不依赖存储可用性 */ } }
async function selectProject(nextProjectId) {
  if (hostStale.value || saving.value || restoring.value || previewLoading.value) return;
  const query = { ...route.query };
  if (nextProjectId) query.projectId = nextProjectId; else delete query.projectId;
  // 路由守卫确认后才提交选择，取消时原项目和草稿均保持不变。
  const key = selectionKey();
  let previous;
  try { previous = sessionStorage.getItem(key); sessionStorage.setItem(key, nextProjectId); } catch { /* Optional browser storage. */ }
  const failure = await router.replace({ query });
  if (failure) {
    try { if (previous == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, previous); } catch { /* Optional browser storage. */ }
  }
}
async function selectFile(event) {
  const nextIndex = Number(event.target.value);
  event.target.value = String(fileIndex.value);
  if (hostStale.value || nextIndex === fileIndex.value || !await allowConfigSwitch()) return;
  fileIndex.value = nextIndex;
  await load();
}
function captureDraft() {
  return { projectId: projectId.value, fileIndex: fileIndex.value, content: content.value, original: original.value, version: configVersion };
}
function sameContext(snapshot) {
  return snapshot && !hostStale.value && snapshot.version === configVersion
    && snapshot.projectId === projectId.value && snapshot.fileIndex === fileIndex.value;
}
function sameDraft(snapshot) {
  return sameContext(snapshot) && snapshot.content === content.value && snapshot.original === original.value;
}
async function load({ background = false } = {}) {
  if (!projectId.value || hostStale.value) return;
  const requestedProjectId = projectId.value;
  const requestedFileIndex = fileIndex.value;
  const previousContent = content.value;
  const previousOriginal = original.value;
  const version = ++configVersion;
  if (!background) {
    savedPendingApply.value = false;
    loadingConfig.value = true;
    error.value = ''; message.value = ''; semanticIssues.value = []; closePreview();
    filePath.value = ''; original.value = ''; content.value = ''; editor?.setValue('');
  }
  try {
    const data = await api.getComposeFile(requestedProjectId, requestedFileIndex);
    if (version !== configVersion || hostStale.value) return;
    if (background) {
      // 保存广播也会回到本页。内容未变化时保留下一步入口、光标和视图；
      // 请求期间产生的新草稿或保存预览，不能被迟到的刷新覆盖。
      if (content.value !== previousContent || original.value !== previousOriginal || saving.value || restoring.value || previewLoading.value) return;
      if (data.content === original.value && data.path === filePath.value) return;
      savedPendingApply.value = false;
      error.value = ''; message.value = ''; semanticIssues.value = []; closePreview();
    }
    filePath.value = data.path; original.value = content.value = data.content; editor?.setValue(data.content);
  } catch (e) {
    if (version === configVersion) error.value = e.message;
  } finally {
    if (version === configVersion) loadingConfig.value = false;
  }
}
async function validateSemantics(snapshot = captureDraft()) {
  if (!sameDraft(snapshot) || loadingConfig.value || !filePath.value) return false;
  error.value = '';
  if (!snapshot.content.trim()) { semanticIssues.value = []; error.value = 'Compose 内容不能为空'; return false; }
  try {
    const result = await api.validateCompose(snapshot.projectId, snapshot.fileIndex, snapshot.content);
    if (!sameDraft(snapshot)) {
      if (sameContext(snapshot)) error.value = '校验期间配置已变化，请重新校验并保存';
      return false;
    }
    semanticIssues.value = result.issues || [];
    if (semanticIssues.value.some((issue) => issue.level === 'error')) {
      error.value = '语义校验未通过,请修复错误后再保存';
      return false;
    }
    return true;
  } catch (e) { if (sameContext(snapshot)) error.value = e.message; }
  return false;
}
async function save() {
  if (saving.value || restoring.value || previewLoading.value || loadingConfig.value || hostStale.value || !filePath.value || !projectId.value || !dirty.value) return;
  const snapshot = captureDraft();
  // 在第一个 await 之前锁定，快捷键连按也只发出一轮校验和预览。
  previewLoading.value = true;
  closePreview();
  error.value = '';
  try {
    if (!await validateSemantics(snapshot)) return;
    const preview = await api.previewCompose(snapshot.projectId, snapshot.content, snapshot.fileIndex);
    if (!sameDraft(snapshot)) {
      if (sameContext(snapshot)) error.value = '预览期间配置已变化，请重新保存';
      return;
    }
    if (!preview) {
      error.value = '变更预览未返回结果,未保存,请重试';
      return;
    }
    changePreview.value = preview;
    pendingSave = snapshot;
    const impactful = (preview.added || []).length + (preview.changed || []).length + (preview.restarted || []).length + (preview.removed || []).length + (preview.portConflicts || []).length + Number(preview.portConflictsKnown === false || preview.changeAnalysisKnown === false);
    if (impactful) { showPreview.value = true; return; }
  } catch (e) {
    closePreview();
    if (sameContext(snapshot)) error.value = `变更预览失败,未保存: ${e.message}`;
    return;
  } finally { previewLoading.value = false; }
  await confirmSave();
}
async function confirmSave() {
  if (saving.value || !pendingSave) return;
  const snapshot = pendingSave;
  if (!sameDraft(snapshot)) {
    closePreview();
    error.value = '配置或节点已变化，请重新校验并预览后保存';
    return;
  }
  saving.value = true; error.value = '';
  try {
    await api.saveComposeFile(snapshot.projectId, snapshot.fileIndex, snapshot.content, snapshot.original);
    if (!sameContext(snapshot)) return;
    // 请求期间仍可编辑；只有服务器确认的快照成为基线，后来输入的内容继续标记未保存。
    original.value = snapshot.content;
    savedPendingApply.value = true;
    message.value = dirty.value ? '已保存提交的版本；后续修改仍未保存' : `已校验并保存文件 · ${new Date().toLocaleTimeString()}`;
    closePreview(); semanticIssues.value = [];
  } catch (e) { if (sameContext(snapshot)) error.value = e.message; }
  finally { saving.value = false; }
}
function closePreview() { showPreview.value = false; changePreview.value = null; pendingSave = null; }
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
async function loadBackups() {
  if (hostStale.value || restoring.value || saving.value || loadingConfig.value || !projectId.value) return;
  const snapshot = captureDraft();
  const request = ++backupListRequest;
  showBackups.value = true;
  backupsLoading.value = true;
  backupError.value = '';
  try {
    const data = await api.getBackups(snapshot.projectId);
    if (request !== backupListRequest || !sameContext(snapshot)) return;
    backups.value = data.backups || [];
  } catch (e) { if (request === backupListRequest && sameContext(snapshot)) backupError.value = e.message; }
  finally { if (request === backupListRequest) backupsLoading.value = false; }
}
function closeBackups(force = false) {
  if (restoring.value && !force) return;
  showBackups.value = false;
  backupListRequest++;
  comparisonRequest++;
  backupsLoading.value = false;
  comparisonLoadingId.value = null;
}
function resetBackupContext() {
  // A submitted operation remains bound to its old project on the server. Its
  // completion must not keep the new host locked or release a newer operation.
  restoreRequest++;
  restoring.value = false;
  closeBackups(true);
  backups.value = [];
  backupError.value = '';
  comparison.value = null;
  pendingBackup.value = null;
  restoreError.value = '';
  showRestoreDialog.value = false;
}
function backupFileIndex(backup) { return project.value?.composeFiles.indexOf(backup.filePath) ?? -1; }
function backupReason(reason) { return { save: '保存前自动备份', restore: '恢复前自动备份' }[reason] || reason || '配置快照'; }
async function previewBackup(backup) {
  const targetIndex = backupFileIndex(backup);
  if (hostStale.value || restoring.value || targetIndex < 0) return;
  const snapshot = captureDraft();
  const request = ++comparisonRequest;
  comparisonLoadingId.value = backup.id;
  backupError.value = '';
  try {
    const [version, current] = await Promise.all([
      api.getBackup(snapshot.projectId, backup.id),
      targetIndex === snapshot.fileIndex ? Promise.resolve({ content: snapshot.content }) : api.getComposeFile(snapshot.projectId, targetIndex),
    ]);
    if (request !== comparisonRequest || !showBackups.value || !sameContext(snapshot)) return;
    comparison.value = { ...version, baseline: current.content, baselineLabel: targetIndex === snapshot.fileIndex ? (snapshot.content === snapshot.original ? '当前编辑器版本' : '当前编辑器版本 · 含未保存修改') : '目标文件当前版本' };
  } catch (e) {
    if (request === comparisonRequest && sameContext(snapshot)) backupError.value = e.message || '比较失败，请重试';
  } finally { if (request === comparisonRequest) comparisonLoadingId.value = null; }
}
async function restore(backup) {
  const targetIndex = backupFileIndex(backup);
  if (hostStale.value || restoring.value || saving.value || previewLoading.value || targetIndex < 0) return;
  comparisonRequest++;
  comparisonLoadingId.value = null;
  comparison.value = null;
  pendingBackup.value = { backup, snapshot: captureDraft(), fileIndex: targetIndex };
  restoreError.value = '';
  showRestoreDialog.value = true;
}
async function confirmRestore() {
  const target = pendingBackup.value;
  if (!target || restoring.value || hostStale.value) return;
  const { backup, snapshot } = target;
  if (!sameDraft(snapshot)) { restoreError.value = '配置已变化，请取消后重新选择需要恢复的版本。'; return; }
  const request = ++restoreRequest;
  restoring.value = true;
  restoreError.value = '';
  try {
    await api.restoreBackup(snapshot.projectId, backup.id);
    if (!sameContext(snapshot)) return;
    showRestoreDialog.value = false;
    pendingBackup.value = null;
    closeBackups(true);
    comparison.value = null;
    fileIndex.value = target.fileIndex;
    const reload = load();
    const reloadVersion = configVersion;
    await reload;
    if (hostStale.value || reloadVersion !== configVersion) return;
    savedPendingApply.value = true;
    message.value = '配置文件已恢复，尚未应用到容器。请返回项目应用配置并检查结果。';
    toast.success('配置文件已恢复，尚未应用到容器');
  } catch (e) {
    if (sameContext(snapshot)) { restoreError.value = e.message || '恢复失败，请重试'; toast.error(`备份恢复失败：${e.message}`); }
  } finally { if (request === restoreRequest) restoring.value = false; }
}
function shortName(file) { return file.split('/').pop(); }
function formatTime(value) { return formatTimestamp(value); }

function toggleEditorMode() {
  // 内容与视图模式分别异步更新；切到可视化后若 YAML 尚未加载，content watcher 会补齐解析。
  editorMode.value = editorMode.value === 'code' ? 'visual' : 'code';
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
    if (visualServices.value.some(item => item.name === name)) {
      toast.error(`服务 ${name} 已存在，请使用其他名称`);
      return;
    }
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
  if (newMode === 'visual') parseYamlToServices();
});
// 路由 keep-alive 可能保留 visual 模式，而项目/配置文件内容在返回页面后才异步载入。
// 每次内容变更都同步可视化模型，避免首次进入或切换项目时短暂显示“暂无服务”。
watch(content, () => {
  if (editorMode.value === 'visual') parseYamlToServices();
});
</script>

<style scoped>
.compose-version-intro { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border: 1px solid var(--color-surface-800); border-radius: 12px; background: var(--color-surface-900); }
.compose-version-card { display: flex; align-items: center; gap: 16px; padding: 16px; border: 1px solid var(--color-surface-800); border-radius: 12px; background: var(--color-surface-950); transition: border-color 160ms ease; }
.compose-version-card:hover, .compose-version-card:focus-within { border-color: var(--color-surface-600); }
.compose-version-file { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--color-surface-200); font-size: 14px; }
.compose-version-file > span { overflow-wrap: anywhere; }
.compose-version-actions { display: flex; flex-shrink: 0; align-items: center; gap: 8px; }
.compose-diff-label { margin: 0; padding: 12px 16px; font-size: 12px; font-weight: 500; color: var(--color-surface-300); background: var(--color-surface-900); border-bottom: 1px solid var(--color-surface-800); }
@media (max-width: 639px) {
  .compose-version-card { flex-wrap: wrap; gap: 12px; padding: 14px; }
  .compose-version-card > div:first-child { flex-basis: 100%; }
  .compose-version-actions { justify-content: flex-end; width: 100%; border-top: 1px solid var(--color-surface-800); padding-top: 10px; }
  .compose-version-actions button { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) { .compose-version-card { transition: none; } }
.compose-toolbar-actions {
  align-items: stretch;
}

.compose-toolbar-group {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: .5rem;
}

.compose-toolbar-tools {
  border-inline: 1px solid var(--color-surface-800);
  padding-inline: .75rem;
}

.compose-toolbar-primary {
  margin-left: auto;
}

@media (max-width: 1023px) {
  .compose-toolbar-tools {
    border-inline: 0;
    padding-inline: 0;
  }
}

@media (max-width: 639px) {
  .compose-toolbar-group {
    width: 100%;
  }

  .compose-toolbar-group .input {
    min-width: 0;
    flex: 1 1 10rem;
  }

  .compose-toolbar-primary {
    justify-content: flex-end;
  }
}
</style>

<style scoped>
.compose-saved-next { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; border: 1px solid #34d39940; border-radius: 10px; padding: 14px 16px; background: #10b98108; font-size: 12px; }
.compose-saved-next strong { font-weight: 600; }
.compose-saved-next p { color: var(--color-surface-400); margin-top: 4px; }
</style>
