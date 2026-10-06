<template>
  <!-- 刻意不加 overflow-hidden:它会裁掉 WebUiLauncher 的多端口下拉菜单(overflow 裁剪
       与 z-index 无关,菜单层级再高也逃不出去)。这里也不能用 isolate 代替 —— 那会让本卡片
       成为独立层叠上下文,菜单反而被后面的兄弟卡片盖住。卡片内各子元素自身不触及圆角,
       无需裁剪。 -->
  <article :id="`project-${project.id}`" class="card" :class="{ 'project-attention': attention, 'ring-1 ring-accent': focused }">
    <header class="min-h-16 flex items-center gap-1 px-2 md:px-4">
      <input type="checkbox" class="ml-2 accent-accent" :checked="selected" :disabled="!project.managed || busy" :aria-label="`选择 ${project.projectName}`" @click.stop @change="$emit('toggle-select')" />
      <button class="icon-btn" :title="project.favorite ? '取消收藏' : '收藏项目'" @click="toggleFavorite(project)">
        <Star class="w-4 h-4" :class="project.favorite ? 'fill-amber-400 text-amber-400' : ''" />
      </button>
      <button class="min-w-0 flex-1 self-stretch flex items-center gap-3 text-left px-1" :aria-expanded="expanded" @click="$emit('toggle-expand')">
        <div class="min-w-0 flex-1 sm:flex-none sm:w-48 md:w-60">
          <div class="font-mono text-sm font-medium truncate">{{ project.projectName }}</div>
        </div>
        <span class="status-dot sm:hidden" :class="statusDotClass"></span>
        <div class="hidden sm:block"><StatusBadge :status="project.status" /></div>
        <span class="count-badge shrink-0" :class="project.managed ? 'text-emerald-300' : ''">{{ project.managed ? '已纳管' : '未纳管' }}</span>
        <span v-if="imageState === 'updated'" class="count-badge shrink-0 bg-amber-950/50 text-amber-300">镜像待应用</span>
        <span v-else-if="imageState === 'failed'" class="count-badge hidden shrink-0 bg-rose-950/50 text-rose-300 lg:inline">镜像检查失败</span>
        <span v-else-if="imageState === 'current'" class="count-badge hidden shrink-0 text-emerald-300 xl:inline">镜像已检查</span>
        <span class="hidden sm:inline text-muted shrink-0">{{ project.containers.length }} 个容器</span>
        <span v-if="statusHint" class="hidden sm:inline text-muted shrink-0" :class="statusHintClass">{{ statusHint }}</span>
        <span class="hidden lg:inline text-muted shrink-0">{{ project.owner }}</span>
        <span class="hidden md:block text-muted font-mono truncate flex-1" :title="project.workingDir">{{ project.workingDir }}</span>
        <ChevronDown class="w-4 h-4 text-surface-500 shrink-0 transition-transform" :class="{ 'rotate-180': expanded }" />
      </button>
      <WebUiLauncher v-if="webuiLinks.length" :links="webuiLinks" class="hidden md:inline-flex" />
      <button v-if="updateInfo?.hasUpdate" class="update-badge shrink-0" title="检测到镜像可更新,点击一键升级" @click.stop="$emit('upgrade')"><Sparkles class="w-3.5 h-3.5" />Update Available</button>
      <button class="icon-btn" title="编辑备注" @click="editNote(project)"><Pencil class="w-4 h-4" /></button>
    </header>

    <div v-if="expanded" class="border-t border-surface-800 p-3 md:p-4 space-y-3">
      <div class="flex flex-col lg:flex-row lg:items-center gap-2">
        <div class="min-w-0 flex-1">
          <p class="text-muted font-mono break-all">{{ project.workingDir || 'Docker 标签未提供工作目录' }}</p>
          <div v-if="dependencyText" class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span class="count-badge text-[10px] bg-surface-800/60 text-surface-300"><GitBranch class="w-3 h-3" />依赖</span>
            <span class="text-xs text-surface-400">{{ dependencyText }}</span>
          </div>
          <div v-if="envPreview.length" class="mt-1.5">
            <div class="flex items-center gap-1.5"><span class="count-badge text-[10px] bg-surface-800/60 text-surface-300"><KeyRound class="w-3 h-3" />环境变量</span><button class="text-[10px] text-surface-500 hover:text-surface-300" @click="showEnvPreview = !showEnvPreview">{{ showEnvPreview ? '收起' : '预览' }}</button></div>
            <div v-if="showEnvPreview" class="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
              <span v-for="entry in envPreview" :key="entry.key" class="truncate font-mono text-[11px]"><span class="text-surface-500">{{ entry.key }}</span><span class="text-surface-400">={{ entry.masked }}</span></span>
            </div>
          </div>
          <p v-if="project.note" class="text-sm text-surface-300 border-l-2 border-surface-700 pl-2 mt-2">{{ project.note }}</p>
        </div>
        <span v-if="project.managed" class="count-badge self-start lg:self-auto">{{ project.editable ? 'Compose 模式' : '现有容器模式' }}</span>
      </div>

      <div class="flex flex-wrap gap-1.5">
        <button class="btn-primary" :disabled="!project.managed || locked" :title="project.editable ? '通过 Docker Compose 启动' : '启动项目中已有的容器'" @click="trigger('up')"><Play class="w-4 h-4" :class="{ 'animate-spin': actionRunning === 'up' }" />启动</button>
        <button class="btn-secondary" :disabled="!project.managed || locked" @click="trigger('restart')"><RotateCw class="w-4 h-4" :class="{ 'animate-spin': actionRunning === 'restart' }" />重启</button>
        <button class="btn-danger" :disabled="!project.managed || locked" @click="trigger('stop')"><Square class="w-4 h-4" :class="{ 'animate-spin': actionRunning === 'stop' }" />停止</button>
        <button class="btn-ghost" :disabled="!project.managed || locked" @click="trigger('ps')"><ListTree class="w-4 h-4" />状态</button>
        <button class="btn-secondary" :disabled="!project.editable || locked" title="需在项目纳管中勾选 Compose" @click="trigger('pull')"><Download class="w-4 h-4" :class="{ 'animate-spin': actionRunning === 'pull' }" />拉取</button>
        <button v-if="updateInfo?.hasUpdate" class="btn-secondary" :disabled="!project.editable || locked" title="一键平滑升级到最新镜像" @click="$emit('upgrade')"><Sparkles class="w-4 h-4" />平滑升级</button>
        <router-link class="btn-ghost" :class="{ 'pointer-events-none opacity-40': !project.editable }" :to="`/compose?projectId=${project.id}`"><FileCode2 class="w-4 h-4" />配置</router-link>
        <button class="btn-ghost" :class="{ 'pointer-events-none opacity-40': !project.editable }" :disabled="!project.editable || busy" title="编辑项目环境变量 (.env)" @click="$emit('env')"><KeyRound class="w-4 h-4" />环境变量</button>
        <button class="btn-ghost" :disabled="!project.managed || busy" @click="$emit('activity')"><History class="h-4 w-4" />活动</button>
        <button v-if="dbContainers.length" class="btn-ghost" :disabled="!project.managed || busy" title="一键导出数据库备份并下载" @click="$emit('db-dump')"><Database class="h-4 w-4 text-emerald-300" />备份数据库</button>
      </div>

      <div v-if="!project.managed" class="alert-warning flex flex-col sm:flex-row sm:items-center gap-2">
        <span class="flex-1">项目尚未纳管，所有控制与容器入口均已禁用。</span>
        <router-link class="btn-ghost shrink-0" :to="`/settings?tab=mounts&projectId=${project.id}`"><FolderCog class="w-4 h-4" />项目纳管</router-link>
      </div>
      <div v-else-if="!project.editable" class="alert-warning flex flex-col sm:flex-row sm:items-center gap-2">
        <span v-if="project.mountState === 'remote_api_only'" class="flex-1">当前节点只有 Docker API、没有 SSH,无法编辑远端 Compose 文件。容器启停、日志和终端仍可用。</span>
        <template v-else>
          <span class="flex-1">当前可控制已有容器；请勾选 Compose 目录并应用挂载，解锁拉取、创建缺失服务和配置编辑。</span>
          <router-link class="btn-ghost shrink-0" :to="`/settings?tab=mounts&projectId=${project.id}`"><FolderCog class="w-4 h-4" />选择 Compose 目录</router-link>
        </template>
      </div>

      <div class="divide-y divide-surface-800/60 border-t border-surface-800/80">
        <div v-for="container in project.containers" :key="container.id" class="py-2.5">
          <!-- 桌面端紧凑单行模式 -->
          <div class="hidden sm:flex items-center gap-2">
            <span class="status-dot shrink-0" :class="container.state === 'running' ? 'bg-emerald-400' : 'bg-rose-400'"></span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="text-sm font-mono truncate">{{ container.name }}</span>
                <span v-if="metrics[container.id]?.cpu != null" class="metric-chip" :class="metrics[container.id].cpu >= 85 ? 'bg-rose-950/50 text-rose-300' : metrics[container.id].cpu >= 60 ? 'bg-amber-950/50 text-amber-300' : 'text-emerald-300'">CPU {{ numberValue(metrics[container.id].cpu).toFixed(1) }}%</span>
                <span v-if="metrics[container.id]?.mem != null" class="metric-chip" :class="metrics[container.id].mem >= 90 ? 'bg-rose-950/50 text-rose-300' : 'text-emerald-300'">MEM {{ numberValue(metrics[container.id].memUsageMB).toFixed(0) }}MB / {{ numberValue(metrics[container.id].mem).toFixed(1) }}%</span>
              </div>
              <div class="text-muted truncate">{{ container.image }}<span v-if="container.ports.length"> · {{ portText(container) }}</span><span v-if="container.health" :class="healthClass(container.health)"> · {{ container.health }}</span></div>
              <div v-if="container.stoppedAt || container.startedAt" class="text-muted text-[11px]">{{ containerStateHint(container) }}</div>
            </div>
            <SparklineChart v-if="metrics[container.id]?.history && metrics[container.id].history.length >= 2" :cpu="metrics[container.id].history.map((point) => point.cpuPercent)" :mem="metrics[container.id].history.map((point) => point.memPercent)" class="hidden sm:block" />
            <router-link class="icon-btn" :class="{ 'pointer-events-none opacity-40': !project.managed }" title="实时日志" :to="`/logs?projectId=${project.id}&containerId=${container.id}`"><ScrollText class="w-4 h-4" /></router-link>
            <router-link v-if="dbContainers.length" class="icon-btn" :class="{ 'pointer-events-none opacity-40': !project.managed }" title="聚合日志(所有容器)" :to="`/logs?projectId=${project.id}`"><Layers class="w-4 h-4 text-emerald-300" /></router-link>
            <router-link class="icon-btn" :class="{ 'pointer-events-none opacity-40': !project.managed }" title="容器终端" :to="`/shell?projectId=${project.id}&containerId=${container.id}`"><TerminalSquare class="w-4 h-4" /></router-link>
            <router-link class="icon-btn" :class="{ 'pointer-events-none opacity-40': !project.managed }" title="AI 诊断" :to="`/agent?projectId=${project.id}&containerId=${container.id}&diagnose=1`"><Bot class="w-4 h-4" /></router-link>
          </div>

          <!-- 移动端触控友好卡片模式 -->
          <div class="flex sm:hidden flex-col gap-2 rounded-xl p-2.5 bg-surface-900/50 border border-surface-800/70">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="status-dot shrink-0" :class="container.state === 'running' ? 'bg-emerald-400' : 'bg-rose-400'"></span>
                <span class="text-sm font-mono font-medium truncate">{{ container.name }}</span>
              </div>
              <StatusBadge :status="container.state" size="sm" />
            </div>
            <div class="text-[11px] text-muted truncate font-mono">{{ container.image }}</div>
            <div v-if="container.ports.length" class="text-[11px] text-surface-400">{{ portText(container) }}</div>
            <div class="flex flex-wrap gap-1.5 mt-0.5">
              <span v-if="metrics[container.id]?.cpu != null" class="metric-chip text-[10px]">CPU {{ numberValue(metrics[container.id].cpu).toFixed(1) }}%</span>
              <span v-if="metrics[container.id]?.mem != null" class="metric-chip text-[10px]">MEM {{ numberValue(metrics[container.id].memUsageMB).toFixed(0) }}MB</span>
            </div>
            <!-- 异常时的一键 Agent 诊断 -->
            <router-link
              v-if="container.state !== 'running' && project.managed"
              :to="`/agent?projectId=${project.id}&containerId=${container.id}&diagnose=1`"
              class="flex items-center justify-center gap-1.5 rounded-lg bg-amber-950/40 border border-amber-500/30 px-3 py-1.5 text-xs text-amber-300 font-medium active:scale-98"
            >
              <Bot class="w-3.5 h-3.5" />
              <span>容器异常 · 唤醒 Agent 一键诊断</span>
            </router-link>
            <!-- 底部触控大按钮行 -->
            <div class="grid grid-cols-3 gap-1.5 pt-1 border-t border-surface-800/50">
              <router-link
                :to="`/logs?projectId=${project.id}&containerId=${container.id}`"
                class="flex items-center justify-center gap-1 rounded-lg bg-surface-800/80 py-1.5 text-xs text-surface-200 active:bg-surface-700"
                :class="{ 'pointer-events-none opacity-40': !project.managed }"
              >
                <ScrollText class="w-3.5 h-3.5" />
                <span>日志</span>
              </router-link>
              <router-link
                :to="`/shell?projectId=${project.id}&containerId=${container.id}`"
                class="flex items-center justify-center gap-1 rounded-lg bg-surface-800/80 py-1.5 text-xs text-surface-200 active:bg-surface-700"
                :class="{ 'pointer-events-none opacity-40': !project.managed }"
              >
                <TerminalSquare class="w-3.5 h-3.5" />
                <span>终端</span>
              </router-link>
              <router-link
                :to="`/agent?projectId=${project.id}&containerId=${container.id}&diagnose=1`"
                class="flex items-center justify-center gap-1 rounded-lg bg-accent/20 border border-accent/40 py-1.5 text-xs text-blue-300 active:bg-accent/30"
                :class="{ 'pointer-events-none opacity-40': !project.managed }"
              >
                <Bot class="w-3.5 h-3.5" />
                <span>AI 诊断</span>
              </router-link>
            </div>
          </div>
        </div>
      </div>
    </div>
  </article>
  <ConfirmDialog :show="stopConfirm" title="停止项目容器" :message="`确认停止 ${project.projectName} 中现有的容器?不会删除容器和网络。`" tone="warning" confirm-text="停止容器" @confirm="confirmStop" @cancel="stopConfirm = false" />
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Bot, ChevronDown, Database, Download, FileCode2, FolderCog, GitBranch, History, KeyRound, Layers, ListTree, Pencil, Play, RotateCw, ScrollText, Sparkles, Square, Star, TerminalSquare } from 'lucide-vue-next';
import StatusBadge from '../common/StatusBadge.vue';
import WebUiLauncher from './WebUiLauncher.vue';
import SparklineChart from '../common/SparklineChart.vue';
import { api, streamProjectStats } from '../../api/client.js';
import ConfirmDialog from '../common/ConfirmDialog.vue';

const props = defineProps({
  project: { type: Object, required: true },
  expanded: Boolean,
  selected: Boolean,
  focused: Boolean,
  busy: Boolean,
  actionRunning: { type: String, default: '' },
  lastResults: { type: Array, default: () => [] },
});
const emit = defineEmits(['toggle-expand', 'toggle-select', 'action', 'activity', 'env', 'db-dump', 'upgrade', 'refresh']);
const stopConfirm = ref(false);

const metrics = ref({});
const updateInfo = ref(null);
const webuiLinks = ref([]);
const dependencyMap = ref(new Map());
const envPreview = ref([]);
const showEnvPreview = ref(false);
let statsAbort = null;
let statsTimer = null;

watch(() => props.expanded, (expanded) => {
  if (!expanded) { closeStats(); return; }
  openStats();
});
watch(() => props.project.id, () => { closeStats(); checkUpdates(); loadWebUi(); loadDependencies(); loadEnvPreview(); if (props.expanded) openStats(); });
onMounted(() => { checkUpdates(); loadWebUi(); loadDependencies(); loadEnvPreview(); if (props.expanded) openStats(); });
onBeforeUnmount(closeStats);

async function checkUpdates() {
  updateInfo.value = null;
  if (!props.project.managed) return;
  try {
    updateInfo.value = await api.getProjectUpdates(props.project.id);
  } catch {
    updateInfo.value = null; // 检测失败静默,不打断列表
  }
}

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

async function loadEnvPreview() {
  envPreview.value = [];
  if (!props.project.editable) return;
  try {
    const data = await api.getProjectEnv(props.project.id, true);
    const entries = data?.entries || data?.env || [];
    if (!Array.isArray(entries)) return;
    envPreview.value = entries.slice(0, 24).map((entry) => {
      const key = String(entry.key || '').split('=')[0];
      const value = String(entry.value ?? entry[key] ?? '');
      const isSecret = /(SECRET|TOKEN|PASSWORD|PASSWD|\bPASS\b|(?:API|PRIVATE|ACCESS|SECRET|AUTH|SIGNING)[_-]?KEY)/i.test(key);
      return { key, masked: isSecret ? '••••••' : (value.length > 28 ? value.slice(0, 28) + '…' : value) };
    });
  } catch { envPreview.value = []; }
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
const statusDotClass = computed(() => (props.project.status === 'running' ? 'bg-emerald-400' : props.project.status === 'partial' ? 'bg-amber-400' : 'bg-rose-400'));
const statusHint = computed(() => {
  if (!props.project.containers.length) return '';
  // 最近一次状态变化:优先 'x 分钟前停止',其次启动时间
  const stopped = props.project.containers.filter((c) => c.state !== 'running' && c.stoppedAt);
  if (stopped.length) {
    const latest = stopped.reduce((a, b) => (a.stoppedAt > b.stoppedAt ? a : b));
    return `${timeAgo(latest.stoppedAt)}前停止`;
  }
  const running = props.project.containers.filter((c) => c.state === 'running' && c.startedAt);
  if (running.length) {
    const latest = running.reduce((a, b) => (a.startedAt > b.startedAt ? a : b));
    return `${timeAgo(latest.startedAt)}前启动`;
  }
  return '';
});
const statusHintClass = computed(() => (props.project.status === 'running' ? 'text-emerald-300/80' : 'text-amber-300/80'));
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
  if (action === 'stop') { stopConfirm.value = true; return; }
  emit('action', action);
}
function confirmStop() { stopConfirm.value = false; if (!locked.value) emit('action', 'stop'); }
async function toggleFavorite(project) { project.favorite = !project.favorite; await api.saveProjectPreference(project.id, { favorite: project.favorite }); emit('refresh'); }
async function editNote(project) {
  const note = window.prompt('项目备注（最多 500 字）', project.note || '');
  if (note === null) return;
  project.note = note.slice(0, 500); await api.saveProjectPreference(project.id, { note: project.note });
}
function portText(container) { return container.ports.map((port) => `${port.public}:${port.private}`).join(', '); }
function healthClass(health) { return health === 'unhealthy' ? 'text-rose-400' : health === 'healthy' ? 'text-emerald-400' : 'text-amber-400'; }
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
