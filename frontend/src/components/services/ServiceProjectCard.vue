<template>
  <article :id="`project-${project.id}`" class="card service-project-card" :class="{ 'project-attention': attention, 'ring-1 ring-accent': focused, 'is-expanded': expanded }">
    <header class="service-project-card__header">
      <input type="checkbox" class="accent-accent" :checked="selected" :disabled="!project.managed || busy" :aria-label="`选择 ${project.projectName}`" @change="$emit('toggle-select')" />
      <button class="icon-btn" :title="project.favorite ? '取消收藏' : '收藏项目'" :aria-label="project.favorite ? '取消收藏' : '收藏项目'" :aria-pressed="!!project.favorite" :disabled="favoriteSaving" @click="toggleFavorite(project)"><Star class="w-4 h-4" :class="project.favorite ? 'fill-amber-400 text-status-warn' : ''" /></button>
      <button class="service-project-card__toggle" :aria-expanded="expanded" :aria-controls="`project-detail-${project.id}`" @click="$emit('toggle-expand')">
        <span class="project-identity"><strong>{{ project.projectName }}</strong><span>{{ project.note || project.owner || 'Compose 项目' }}</span></span>
        <span class="project-health-summary"><StatusBadge :status="project.status" :health="attention && project.status === 'running' ? 'unhealthy' : ''" /><span class="project-container-count">{{ runningCount }}/{{ project.containers.length }} 容器运行</span></span>
        <span class="project-mode">{{ project.managed ? (project.editable ? 'Compose' : '容器模式') : '未纳管' }}</span>
        <span class="project-path" :title="project.workingDir">{{ project.workingDir }}</span>
        <ChevronDown class="w-4 h-4 text-surface-400 shrink-0 transition-transform" :class="{ 'rotate-180': expanded }" />
      </button>
      <WebUiLauncher v-if="webuiLinks.length" :links="webuiLinks" class="hidden lg:inline-flex" />
      <ImageUpdatePanel :project="project" compact @result="updateInfo = $event" @open="$emit('upgrade')" />
      <button class="icon-btn hidden sm:inline-flex" title="编辑备注" aria-label="编辑备注" @click="editNote"><Pencil class="w-4 h-4" /></button>
    </header>
    <nav class="flex flex-wrap items-center gap-1 border-t border-surface-800/50 px-3 py-2" :aria-label="`${project.projectName} 快捷操作`">
      <CapabilityLink v-for="action in quickActions" :key="action.label" class="btn-ghost btn-sm gap-1.5" :disabled="!project.managed || action.disabled" :reason="!project.managed ? '项目尚未纳管' : '容器运行后才能打开终端'" :to="action.to"><component :is="action.icon" class="h-3.5 w-3.5" />{{ action.label }}</CapabilityLink>
      <span class="ml-auto text-xs text-muted">{{ project.containers.length }} 个容器</span>
    </nav>

    <div v-if="expanded" :id="`project-detail-${project.id}`" class="project-detail">
      <div v-if="attention" class="project-attention-summary"><AlertTriangle :size="16" /><span><strong>{{ attentionSummary.label }}</strong> · {{ attentionSummary.detail }}</span><span class="hidden md:inline text-muted ml-auto">先查看日志定位原因，再决定是否重启</span></div>
      <div class="project-actions" role="group" :aria-label="`${project.projectName} 项目操作`">
        <CapabilityLink class="btn-primary" :disabled="!project.managed" reason="纳管项目后可查看日志" :to="toolLocation('logs', attentionContainer?.id)"><ScrollText :size="16" />{{ attention ? '查看异常日志' : '项目日志' }}</CapabilityLink>
        <CapabilityLink class="btn-secondary" :disabled="!project.editable" reason="需要可访问的 Compose 目录" :to="toolLocation('compose')"><FileCode2 :size="16" />配置</CapabilityLink>
        <button class="btn-ghost" :disabled="!project.editable || locked" @click="$emit('env')"><KeyRound :size="16" />环境变量</button>
        <button class="btn-ghost" :disabled="!project.managed || locked" @click="$emit('activity')"><History :size="16" />活动</button>
        <span v-if="actionRunning" class="text-xs text-muted" role="status"><LoaderCircle class="inline w-3.5 h-3.5 animate-spin" />正在执行…</span>
        <ActionDisclosure class="ml-auto">
          <button :disabled="!project.managed || locked" @click="trigger('up')"><Play :size="15" />{{ project.editable ? '应用配置 / 启动' : '启动容器' }}</button>
          <button :disabled="!project.managed || locked" @click="trigger('restart')"><RotateCw :size="15" />重启项目</button>
          <button :disabled="!project.editable || locked" @click="trigger('pull')"><Download :size="15" />拉取镜像</button>
          <button v-if="updateInfo?.hasUpdate" :disabled="!project.editable || locked" @click="$emit('upgrade')"><Sparkles :size="15" />平滑升级</button>
          <button :disabled="!project.managed || locked" @click="trigger('ps')"><ListTree :size="15" />查看详细状态</button>
          <button v-if="dbContainers.length" :disabled="!project.managed || locked" @click="$emit('db-dump')"><Database :size="15" />备份数据库</button>
          <button @click="editNote"><Pencil :size="15" />编辑备注</button>
          <hr />
          <button class="text-status-error" :disabled="!project.managed || locked" @click="trigger('stop')"><Square :size="15" />停止项目</button>
        </ActionDisclosure>
      </div>
      <div v-if="!project.managed" class="alert-warning flex flex-wrap items-center gap-2"><span class="flex-1">项目尚未纳管。纳管后可操作容器、查看日志与终端。</span><router-link class="btn-secondary" :to="`/settings?tab=mounts&projectId=${project.id}`"><FolderCog :size="16" />项目纳管</router-link></div>
      <div v-else-if="!project.editable" class="project-capability-note"><FolderCog :size="15" /><span>{{ project.mountState === 'remote_api_only' ? '此节点仅提供 Docker API。可管理容器，配置编辑需要 SSH 访问。' : '当前管理已有容器。挂载 Compose 目录后可编辑并应用配置。' }}</span><router-link v-if="project.mountState !== 'remote_api_only'" :to="`/settings?tab=mounts&projectId=${project.id}`">设置挂载</router-link></div>

      <div class="project-container-table">
        <div class="project-container-heading"><span>容器 / 镜像</span><span>状态与资源</span><span>快捷操作</span></div>
        <div v-for="container in project.containers" :key="container.id" class="project-container-row" :data-container="container.id">
          <div class="project-container-identity"><Box :size="17" class="text-surface-400 shrink-0" /><div class="min-w-0"><strong>{{ container.name }}</strong><span :title="container.image">{{ container.image }}</span><small v-if="container.ports.length">{{ portText(container) }}</small></div></div>
          <div class="project-container-state"><StatusBadge :status="container.state" :health="container.health" /><span v-if="metrics[container.id]?.cpu != null" class="text-xs text-muted font-mono">{{ numberValue(metrics[container.id].cpu).toFixed(1) }}% · {{ numberValue(metrics[container.id].memUsageMB).toFixed(0) }} MB</span><SparklineChart v-if="metrics[container.id]?.history?.length >= 2" :cpu="metrics[container.id].history.map(p => p.cpuPercent)" :mem="metrics[container.id].history.map(p => p.memPercent)" class="hidden lg:block" /><span v-if="containerStateHint(container)" class="text-xs text-muted">{{ containerStateHint(container) }}</span></div>
          <div class="project-container-actions">
            <CapabilityLink :disabled="!project.managed" reason="项目尚未纳管" :to="toolLocation('logs', container.id)" class="container-action" aria-label="实时日志"><ScrollText :size="15" /><span>日志</span></CapabilityLink>
            <CapabilityLink :disabled="!project.managed || container.state !== 'running'" :reason="!project.managed ? '项目尚未纳管' : '容器运行后才能打开终端'" :to="toolLocation('shell', container.id)" class="container-action" aria-label="容器终端"><TerminalSquare :size="15" /><span>终端</span></CapabilityLink>
            <CapabilityLink :disabled="!project.managed" reason="项目尚未纳管" :to="{ ...toolLocation('agent', container.id), query: { ...toolLocation('agent', container.id).query, diagnose: '1' } }" class="container-action" aria-label="AI 诊断"><Bot :size="15" /><span>诊断</span></CapabilityLink>
          </div>
        </div>
        <p v-if="!project.containers.length" class="p-4 text-xs text-muted">还没有容器。可通过「更多操作 → 应用配置 / 启动」创建服务。</p>
      </div>
      <footer class="project-detail-footer">
        <span class="truncate" :title="project.workingDir"><FolderOpen :size="13" />{{ project.workingDir || '未提供工作目录' }}</span>
        <span v-if="dependencyText" class="truncate" :title="dependencyText"><GitBranch :size="13" />{{ dependencyText }}</span>
        <span v-if="imageState === 'updated'" class="text-status-warn">镜像待应用</span><span v-else-if="imageState === 'failed'" class="text-status-error">镜像检查失败</span>
      </footer>
    </div>
  </article>
  <ConfirmDialog :show="!!pendingAction" :title="confirmationTitle" :message="confirmationMessage" tone="warning" :confirm-text="confirmationTitle" @confirm="confirmAction" @cancel="pendingAction = ''" />
  <BaseModal :show="noteOpen" title="编辑项目备注" :close-disabled="noteSaving" size-class="max-w-lg" @close="noteOpen = false">
    <form id="project-note-form" class="space-y-3" @submit.prevent="saveNote">
      <label class="block text-sm">{{ project.projectName }}<textarea v-model="noteDraft" aria-label="项目备注" class="input mt-2 min-h-28 w-full resize-y" maxlength="500" placeholder="记录用途、负责人或操作提醒" :disabled="noteSaving"></textarea></label>
      <div class="text-right text-xs text-muted">{{ noteDraft.length }} / 500</div><p v-if="noteError" class="alert-error" role="alert">{{ noteError }}</p>
    </form>
    <template #footer><button class="btn-secondary" :disabled="noteSaving" @click="noteOpen = false">取消</button><button class="btn-primary" form="project-note-form" type="submit" :disabled="noteSaving">{{ noteSaving ? '保存中…' : '保存备注' }}</button></template>
  </BaseModal>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { AlertTriangle, Bot, Box, ChevronDown, Database, Download, FileCode2, FolderCog, FolderOpen, GitBranch, History, KeyRound, ListTree, LoaderCircle, Pencil, Play, RotateCw, ScrollText, Sparkles, Square, Star, TerminalSquare } from 'lucide-vue-next';
import ImageUpdatePanel from './ImageUpdatePanel.vue';
import StatusBadge from '../common/StatusBadge.vue';
import SparklineChart from '../common/SparklineChart.vue';
import WebUiLauncher from './WebUiLauncher.vue';
import ActionDisclosure from '../common/ActionDisclosure.vue';
import CapabilityLink from '../common/CapabilityLink.vue';
import BaseModal from '../common/BaseModal.vue';
import { useRoute } from 'vue-router';
import { projectAttention } from '../../lib/project-health.js';
import { projectToolLocation } from '../../lib/project-navigation.js';
import { api, streamProjectStats } from '../../api/client.js';
import ConfirmDialog from '../common/ConfirmDialog.vue';
import { useToastStore } from '../../stores/toast.js';

const props = defineProps({
  project: { type: Object, required: true },
  expanded: Boolean,
  selected: Boolean,
  focused: Boolean,
  busy: Boolean,
  actionRunning: { type: String, default: '' },
  lastResults: { type: Array, default: () => [] },
});
const emit = defineEmits(['toggle-expand', 'toggle-select', 'action', 'activity', 'env', 'db-dump', 'upgrade', 'refresh', 'note-saved']);
const route = useRoute();
const pendingAction = ref('');
const noteOpen = ref(false);
const noteDraft = ref('');
const noteError = ref('');
const noteSaving = ref(false);
const runningCount = computed(() => props.project.containers.filter(c => c.state === 'running').length);
const attentionSummary = computed(() => projectAttention(props.project));
const attentionContainer = computed(() => props.project.containers.find(c => c.state !== 'running') || props.project.containers.find(c => c.health === 'unhealthy'));
function toolLocation(name, containerId = '') { return projectToolLocation(name, props.project, containerId, { from: 'services', returnTo: route.fullPath }); }
const confirmationTitle = computed(() => ({ up: '应用配置', restart: '重启项目', stop: '停止项目' })[pendingAction.value] || '确认操作');
const confirmationMessage = computed(() => {
  const name = props.project.projectName;
  if (pendingAction.value === 'up') return `将对 ${name} 执行 Docker Compose up。新增服务会被创建，配置变化的容器可能重建。执行后请确认容器状态。`;
  if (pendingAction.value === 'restart') return `确认重启 ${name}？服务会短暂中断。重启不会应用 Compose 文件中的配置变更。`;
  return `确认停止 ${name} 中的容器？服务将不可访问，容器和数据会保留。`;
});
const favoriteSaving = ref(false);
const toast = useToastStore();
const quickActions = computed(() => [
  { label: '聚合日志', icon: ScrollText, to: toolLocation('logs') },
  { label: '终端', disabled: !props.project.containers.some(c => c.state === 'running'), icon: TerminalSquare, to: toolLocation('shell', props.project.containers.find(c => c.state === 'running')?.id) },
  { label: 'AI 诊断', icon: Bot, to: { ...toolLocation('agent'), query: { ...toolLocation('agent').query, diagnose: '1' } } },
]);

const metrics = ref({});
const updateInfo = ref(null);
const webuiLinks = ref([]);
const dependencyMap = ref(new Map());
let statsAbort = null;
let statsTimer = null;

watch(() => props.expanded, (expanded) => {
  if (!expanded) { closeStats(); return; }
  loadDependencies();
  openStats();
});
watch(() => props.project.id, () => { closeStats(); loadWebUi(); if (props.expanded) { loadDependencies(); openStats(); } });
onMounted(() => { loadWebUi(); if (props.expanded) { loadDependencies(); openStats(); } });
let activatedBefore = false;
onActivated(() => {
  if (!activatedBefore) { activatedBefore = true; return; }
  if (props.expanded) openStats();
});
onDeactivated(closeStats);
onBeforeUnmount(closeStats);



async function loadWebUi() {
  webuiLinks.value = [];
  if (!props.project.managed) return;
  try {
    const data = await api.getProjectWebUi(props.project.id);
    webuiLinks.value = (data?.links || []).flatMap((entry) => entry.ports.map((port) => ({ port: port.port, url: port.url, containerName: entry.containerName })));
  } catch {
    webuiLinks.value = []; // 检测失败静默
  }
}

async function loadDependencies() {
  dependencyMap.value = new Map();
  if (!props.project.editable) return;
  try {
    const file = await api.getComposeFile(props.project.id, 0, true);
    const doc = (await import('yaml')).parse(file.content || '');
    if (doc?.services && typeof doc.services === 'object') {
      const map = new Map();
      for (const [name, service] of Object.entries(doc.services)) {
        const raw = service?.depends_on;
        if (!raw) continue;
        const deps = Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.keys(raw) : String(raw).split(',');
        map.set(name, deps);
      }
      dependencyMap.value = map;
    }
  } catch {
    dependencyMap.value = new Map(); // 静默失败
  }
}

async function openStats() {
  closeStats();
  if (!props.project.managed || !props.project.containers.some((c) => c.state === 'running')) return;
  statsAbort = new AbortController();
  try {
    await streamProjectStats(props.project.id, (frame) => {
      if (frame.type === 'stats') applyStats(frame.data || []);
      else if (frame.type === 'error') { /* 指标流按节点能力静默降级 */ }
    }, statsAbort.signal, 2500);
  } catch {
    // fetch abort 或网络错误:静默降级,不打断卡片交互
  }
}
function applyStats(rows) {
  const next = { ...metrics.value };
  for (const row of rows) {
    const prev = next[row.containerId] || { history: [] };
    const history = [...prev.history, { cpuPercent: numberValue(row.cpuPercent), memPercent: numberValue(row.memPercent) }];
    if (history.length > 26) history.shift();
    next[row.containerId] = { cpu: numberValue(row.cpuPercent), mem: numberValue(row.memPercent), memUsageMB: numberValue(row.memUsageMB), history };
  }
  metrics.value = next;
}
function numberValue(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function closeStats() {
  if (statsAbort) {
    try { statsAbort.abort(); } catch {
      // 流已结束时 abort 可能抛错,清理本地引用仍然必须继续。
    }
    statsAbort = null;
  }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  metrics.value = {};
}

const locked = computed(() => props.busy || !!props.actionRunning);
const dbContainers = computed(() => props.project.containers.filter((c) => /(postgres|postgis|mysql|mariadb|redis|valkey|mongo)/i.test(c.image)));
const attention = computed(() => props.project.status !== 'running' || props.project.containers.some((container) => container.health === 'unhealthy'));
const dependencyText = computed(() => {
  const entries = [...dependencyMap.value.entries()]
    .filter(([, deps]) => deps && deps.length)
    .map(([name, deps]) => `${name} → ${deps.join(', ')}`);
  return entries.slice(0, 3).join(' · ');
});
const imageState = computed(() => {
  const matches = props.lastResults.filter((result) => props.project.containers.some((container) => container.image === result.image));
  if (matches.some((result) => result.status === 'updated' && props.project.containers.some((container) => container.image === result.image && container.imageId !== result.after))) return 'updated';
  if (matches.some((result) => result.status === 'failed')) return 'failed';
  return matches.length ? 'current' : '';
});

function trigger(action) {
  if (!props.project.managed || locked.value) return;
  if (action === 'pull' && !props.project.editable) return;
  if (['stop', 'restart'].includes(action) || (action === 'up' && props.project.editable)) { pendingAction.value = action; return; }
  emit('action', action);
}
function confirmAction() { const action = pendingAction.value; pendingAction.value = ''; if (!locked.value && props.project.managed && action) emit('action', action); }
async function toggleFavorite(project) {
  if (favoriteSaving.value) return;
  favoriteSaving.value = true;
  const favorite = !project.favorite;
  try {
    await api.saveProjectPreference(project.id, { favorite });
    project.favorite = favorite;
    emit('refresh');
  } catch (error) {
    toast.error(`收藏未保存：${error.message}`);
  } finally { favoriteSaving.value = false; }
}
function editNote() { noteDraft.value = props.project.note || ''; noteError.value = ''; noteOpen.value = true; }
async function saveNote() {
  if (noteSaving.value) return;
  noteSaving.value = true;
  noteError.value = '';
  const note = noteDraft.value.slice(0, 500);
  try {
    await api.saveProjectPreference(props.project.id, { note });
    emit('note-saved', note);
    noteOpen.value = false;
    toast.success('项目备注已保存');
    emit('refresh');
  } catch (error) { noteError.value = `备注未保存：${error.message}`; }
  finally { noteSaving.value = false; }
}
function portText(container) { return container.ports.map((port) => `${port.public}:${port.private}`).join(', '); }
function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.max(0, Date.now() - Number(ts));
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天`;
}
function containerStateHint(container) {
  if (container.state !== 'running' && container.stoppedAt) return `${timeAgo(container.stoppedAt)}前停止`;
  if (container.state === 'running' && container.startedAt) return `${timeAgo(container.startedAt)}前启动`;
  return '';
}
</script>

<style scoped>
.service-project-card { border-radius: 11px; }
.service-project-card__header { display: flex; align-items: center; gap: 6px; padding: 4px 12px; min-height: 78px; }
.service-project-card__toggle { display: flex; flex: 1; align-self: stretch; align-items: center; min-width: 0; gap: 18px; padding: 8px 6px; text-align: left; background: transparent !important; }
.project-identity { min-width: 0; flex: 1; }
.project-identity strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.project-identity > span { display: block; margin-top: 5px; color: var(--color-surface-400); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-health-summary { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.project-container-count { color: var(--color-surface-400); font-size: 11px; font-variant-numeric: tabular-nums; }
.project-mode { color: var(--color-surface-400); border: 1px solid var(--line-subtle); border-radius: 5px; padding: 2px 5px; font-size: 10px; white-space: nowrap; }
.project-path { width: 22%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-surface-500); font-size: 11px; }
.project-detail { padding: 0 18px; border-top: 1px solid var(--line-subtle); }
.project-attention-summary { display: flex; align-items: center; gap: 8px; padding: 14px 0 0; color: #f4c575; font-size: 12px; }
.project-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 16px 0; }
.project-capability-note { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--color-surface-400); padding-bottom: 12px; }
.project-capability-note a { color: var(--link-color); }
.project-container-table { border-top: 1px solid var(--line-subtle); }
.project-container-heading, .project-container-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, .6fr) auto; gap: 20px; align-items: center; }
.project-container-heading { padding: 10px 0; font-size: 10px; color: var(--color-surface-500); }
.project-container-heading > :last-child { width: 180px; text-align: right; }
.project-container-row { padding: 15px 0; border-top: 1px solid var(--line-subtle); }
.project-container-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.project-container-identity strong { display: block; font-family: var(--font-mono); font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-container-identity span, .project-container-identity small { display: block; color: var(--color-surface-400); font-size: 11px; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-container-state { display: flex; align-items: flex-start; flex-direction: column; gap: 5px; }
.project-container-actions { display: flex; justify-content: flex-end; gap: 3px; }
.container-action { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 36px; padding: 7px; border-radius: 6px; font-size: 11px; color: var(--color-surface-300); }
a.container-action:hover { background: var(--panel-raised); color: var(--color-surface-50); }
.project-detail-footer { display: flex; gap: 16px; padding: 12px 0; border-top: 1px solid var(--line-subtle); font-size: 10px; color: var(--color-surface-500); }
.project-detail-footer span { display: inline-flex; align-items: center; gap: 6px; }
@media (max-width: 1100px) { .project-path { display: none; } .project-container-count { display: none; } .project-container-row, .project-container-heading { gap: 12px; } }
@media (max-width: 639px) {
  .service-project-card__header { min-height: 76px; padding-inline: 8px; gap: 2px; }
  .service-project-card__toggle { gap: 8px; }
  .project-identity strong { font-size: 13px; }
  .project-health-summary { flex-direction: column; align-items: flex-end; }
  .project-mode { display: none; }
  .project-detail { padding: 0 12px; }
  .project-actions { gap: 6px; } .project-actions > .btn-ghost { font-size: 11px; padding-inline: 6px; }
  .project-container-heading { display: none; }
  .project-container-row { grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 14px 0; }
  .project-container-state { align-items: flex-end; }
  .project-container-actions { grid-column: 1 / -1; justify-content: stretch; gap: 8px; }
  .container-action { flex: 1; min-height: 40px; background: var(--panel-raised); }
  .project-detail-footer { flex-direction: column; gap: 8px; }
}
</style>
