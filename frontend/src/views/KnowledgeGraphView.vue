<template>
  <div :class="embedded ? '' : 'page-shell'">
    <div :class="embedded ? 'mb-4 flex flex-wrap justify-end gap-3' : 'page-header'">
      <div v-if="!embedded">
        <h1 class="page-title">运维资产关系图谱</h1>
        <p class="page-subtitle">节点、项目、容器、存储卷与实时告警的关联视图 · 支撑故障根因追溯</p>
      </div>
      <div class="page-actions">
        <div class="ios-segmented-control" role="group" aria-label="图谱呈现模式">
          <button
            class="ios-segment-btn"
            :class="{ active: viewMode === 'graph' }"
            type="button"
            :aria-pressed="viewMode === 'graph'"
            @click="viewMode = 'graph'"
          >
            <Waypoints class="w-3.5 h-3.5" />
            <span>架构图谱</span>
          </button>
          <button
            class="ios-segment-btn"
            :class="{ active: viewMode === 'tree' }"
            type="button"
            :aria-pressed="viewMode === 'tree'"
            @click="viewMode = 'tree'"
          >
            <GitMerge class="w-3.5 h-3.5" />
            <span>资产血缘树</span>
          </button>
        </div>
        <button v-if="!embedded" class="btn-secondary" :class="{ 'border-accent! text-status-info!': useCmdb }" @click="toggleSource">
          <Database class="w-4 h-4" />{{ useCmdb ? 'CMDB 资产数据' : '实时发现数据' }}
        </button>
        <button class="btn-secondary" :disabled="loading" @click="load">
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新图谱
        </button>
      </div>
    </div>

    <p v-if="useCmdb" class="mb-3 text-muted">台账快照 · 最多 500 项资产与 500 条关系；按所属节点区分同名资源。实时状态请进入服务页核对。</p>
    <p v-if="error" class="alert-error" role="alert"><span class="min-w-0 flex-1">{{ error }}<span v-if="graphNodes.length"> · 以下保留上次读取的数据。</span></span><button class="text-link shrink-0" :disabled="loading" @click="load">重试图谱</button></p>

    <!-- 图谱概览统计 -->
    <div class="metric-grid">
      <MetricTile title="宿主节点" :value="hosts.length" :sub="activeHostName" :icon="Server" tone="text-blue-300" />
      <MetricTile title="项目" :value="projects.length" :sub="`${containerCount} 容器`" :icon="Boxes" tone="text-status-ok" />
      <MetricTile title="持久化卷" :value="volumeCount" :sub="useCmdb ? '按节点独立计数' : '发现的存储绑定'" :icon="HardDrive" tone="text-violet-300" />
      <MetricTile v-if="!useCmdb" title="关联事件" :value="alertCount" sub="监控告警" :icon="AlertTriangle" tone="text-status-error" />
      <MetricTile v-if="!useCmdb" title="智能巡检" :value="inspectionCount" sub="巡检档案" :icon="Bot" tone="text-status-warn" />
    </div>

    <!-- 实体关系图谱 -->
    <section v-if="viewMode === 'graph'" class="section-panel flex-1">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="section-title">实体全景拓扑</h2>
          <p class="mt-1 text-muted">{{ useCmdb ? '节点、项目与持久卷的台账关系' : '节点、项目、持久卷与告警事件的关联网络' }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-3 text-xs text-surface-400">
          <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-sky-400"></span>宿主</span>
          <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-status-ok"></span>项目</span>
          <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-violet-400"></span>卷</span>
          <span v-if="!useCmdb" class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-status-error"></span>告警</span>
        </div>
      </div>

      <Skeleton v-if="loading" variant="table" :rows="4" label="图谱加载中" />
      <EmptyState v-else-if="!graphNodes.length && !error" icon="Network" title="暂无资产图谱" description="在资产清单同步当前节点后，可查看已记录的资产关系。" />
      <ForceGraph
        v-else-if="graphNodes.length"
        :nodes="graphNodes"
        :edges="graphEdges"
        :show-health-summary="!useCmdb"
        :height="embedded ? 480 : 560"
        default-layout="dag"
        :lane-titles="{ single: '资产实体', first: useCmdb ? '宿主节点' : '宿主与告警', middle: '项目', last: '存储卷' }"
        aria-label="运维资产关系图谱"
      />
    </section>

    <!-- 按宿主分组的资产血缘树 -->
    <section v-else class="section-panel flex-1 space-y-4">
      <div class="mb-2">
        <h2 class="section-title">资产层级血缘结构</h2>
        <p class="mt-1 text-muted">宿主机 ➔ Compose 项目 ➔ 运行容器 ➔ 存储卷与挂载，直观查看链路</p>
      </div>

      <section v-for="host in hostGroups" :key="host.id" :aria-label="`节点 ${host.name}`" class="rounded-2xl border border-white/10 bg-surface-900/40 p-4 space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <span class="grid h-8 w-8 place-items-center rounded-xl bg-sky-500/15 text-sky-400 border border-sky-500/25">
              <Server class="w-4 h-4" />
            </span>
            <div>
              <h3 class="text-sm font-semibold text-surface-100">{{ host.name }}</h3>
              <p class="text-[11px] text-surface-400 font-mono">{{ host.type || 'unknown' }} · {{ useCmdb ? '台账归属' : host.active ? '当前活跃宿主' : 'Docker 节点' }}</p>
            </div>
          </div>
          <span class="count-badge" :class="host.active ? 'text-status-ok' : 'text-surface-400'">
            {{ projectsForHost(host).length }} 个项目
          </span>
        </div>

        <!-- 项目卡片网格 -->
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 pt-2">
          <div
            v-for="p in projectsForHost(host)"
            :key="p.id"
            class="rounded-xl border border-white/8 bg-surface-950/60 p-3.5 space-y-2.5 transition-all hover:border-status-ok/30"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full" :class="p.status === 'running' ? 'bg-status-ok' : p.status === 'partial' ? 'bg-status-warn' : 'bg-surface-500'"></span>
                  <h4 class="text-sm font-semibold text-surface-100 truncate font-mono">{{ p.projectName || p.name }}</h4>
                </div>
                <p class="text-[11px] text-surface-400 mt-0.5 truncate">{{ projectStatus(p.status) }} · {{ p.workingDir || '未记录配置路径' }}</p>
              </div>
              <router-link :to="deepLink('/services', { focus: p.id, hostId: p.hostId, from: 'cmdb' })" class="icon-btn text-surface-400 hover:text-surface-100" :title="`进入服务 ${p.projectName}`" :aria-label="`进入服务 ${p.projectName}`">
                <ChevronRight class="w-4 h-4" />
              </router-link>
            </div>

            <!-- 包含容器 -->
            <div class="text-xs space-y-1">
              <span class="text-surface-400">容器服务 ({{ p.containers?.length || 0 }})：</span>
              <div class="flex flex-wrap gap-1">
                <span
                  v-for="c in (p.containers || []).slice(0, 4)"
                  :key="c.id"
                  class="ios-mini-tag"
                  :class="c.state === 'running' ? 'text-status-ok border-status-ok/20' : 'text-surface-400 border-white/5'"
                >
                  {{ c.name || c.id }}
                </span>
                <span v-if="(p.containers?.length || 0) > 4" class="text-[10px] text-surface-400 self-center">
                  +{{ p.containers.length - 4 }}
                </span>
              </div>
            </div>

            <!-- 数据卷 -->
            <div v-if="projectVolumes(p).length" class="text-xs pt-1 border-t border-white/5">
              <span class="text-surface-400">存储卷：</span>
              <span class="font-mono text-[11px] text-violet-300 ml-1">{{ projectVolumes(p).join(', ') }}</span>
            </div>
          </div>
        </div>
        <p v-if="!projectsForHost(host).length" class="text-muted">此节点在当前快照中暂无项目。</p>
      </section>
    </section>

    <!-- 底部实体明细 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">实体资产分布</h2><p class="mt-1 text-muted">当前快照中的节点与项目基础属性</p></div>
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
          <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold text-sky-300"><Server class="h-4 w-4" />节点 ({{ hosts.length }})</h3>
          <div class="space-y-2">
            <div v-for="host in hosts" :key="host.id" class="flex items-center justify-between rounded-lg border border-surface-800 bg-surface-900/60 px-3 py-2">
              <span class="text-sm text-surface-200">{{ host.name }}</span>
              <span class="count-badge" :class="host.active ? 'text-status-ok' : 'text-surface-400'">{{ host.active ? '活跃' : host.type }}</span>
            </div>
          </div>
        </div>
        <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
          <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold text-status-ok"><Boxes class="h-4 w-4" />项目 ({{ projects.length }})</h3>
          <div class="space-y-2">
            <div v-for="project in projects.slice(0, 6)" :key="project.id" class="flex items-center justify-between rounded-lg border border-surface-800 bg-surface-900/60 px-3 py-2">
              <span class="min-w-0 flex-1 truncate text-sm text-surface-200">{{ project.projectName }}</span>
              <span class="count-badge" :class="project.status === 'running' ? 'text-status-ok' : 'text-surface-400'">{{ (project.containers?.length || 0) + ' 容器' }}</span>
            </div>
          </div>
        </div>
        <div v-if="!useCmdb" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
          <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold text-status-error"><AlertTriangle class="h-4 w-4" />待处理告警 ({{ alertCount }})</h3>
          <EmptyState v-if="!alerts.length" compact icon="Bell" title="暂无活动告警" description="可在事件中心查看历史记录。"><router-link to="/events?from=cmdb" class="btn-secondary btn-sm">查看事件</router-link></EmptyState>
          <div v-else class="space-y-2">
            <div v-for="alert in alerts.slice(0, 4)" :key="alert.id" class="flex items-center gap-2 rounded-lg border border-surface-800 bg-surface-900/60 px-3 py-2">
              <span class="h-2 w-2 shrink-0 rounded-full" :class="alert.priority === 'danger' ? 'bg-status-error' : 'bg-status-warn'"></span>
              <span class="min-w-0 flex-1 truncate text-xs text-surface-200">{{ alert.title }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import MetricTile from '../components/common/MetricTile.vue';
import { deepLink } from '../lib/deep-links.js';
const props = defineProps({ embedded: { type: Boolean, default: false } });
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { buildCmdbGraph } from '../lib/cmdb-graph.js';
import { onAuthEpochChange } from '../lib/auth-context.js';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { AlertTriangle, Bot, Boxes, ChevronRight, Database, GitMerge, HardDrive, RefreshCw, Server, Waypoints } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { useServicesStore } from '../stores/services.js';
import { useCmdbStore } from '../stores/cmdb.js';
import ForceGraph from '../components/ForceGraph.vue';
import Skeleton from '../components/common/Skeleton.vue';
import EmptyState from '../components/common/EmptyState.vue';

const store = useServicesStore();
const cmdb = useCmdbStore();
const busy = ref(false);
const loadError = ref('');
const liveHosts = ref([]);
const alerts = ref([]);
const inspectionCount = ref(0);
const useCmdb = ref(props.embedded);
const viewMode = ref('graph'); // 'graph' | 'tree'

// 直接派生共享台账快照，身份清空、同步与删除均自动反映到图谱。
const snapshot = computed(() => buildCmdbGraph(cmdb.assets, cmdb.relations));
const hosts = computed(() => useCmdb.value ? snapshot.value.hosts : liveHosts.value);
const projects = computed(() => useCmdb.value ? snapshot.value.projects : store.projects);
const loading = computed(() => busy.value || (useCmdb.value && cmdb.loading));
const error = computed(() => useCmdb.value ? cmdb.error : loadError.value);
const containerCount = computed(() => useCmdb.value ? cmdb.containers.length : projects.value.reduce((n, p) => n + (p.containers?.length || 0), 0));
const volumeCount = computed(() => useCmdb.value ? snapshot.value.volumes.length : projects.value.reduce((n, p) => n + projectVolumes(p).length, 0));
const alertCount = computed(() => alerts.value.length);
const activeHostName = computed(() => useCmdb.value ? '多节点台账快照' : hosts.value.find(h => h.active)?.name || '未选择节点');
const hostGroups = computed(() => {
  const known = new Set(hosts.value.map(h => h.hostId || h.id));
  return projects.value.some(p => !known.has(p.hostId))
    ? [...hosts.value, { id: '__unassigned__', name: '归属节点未载入', type: 'unknown', unassigned: true }]
    : hosts.value;
});
function projectsForHost(host) {
  return projects.value.filter(project => host.unassigned
    ? !hosts.value.some(h => (h.hostId || h.id) === project.hostId)
    : project.hostId === (host.hostId || host.id));
}
function projectStatus(status) { return { running: '运行中', stopped: '已停止', partial: '部分运行', unknown: '未知' }[status] || '未知'; }

function projectVolumes(p) {
  const set = new Set();
  for (const c of p.containers || []) {
    for (const v of c.volumes || []) {
      const name = String(v).split(':')[0];
      if (name && !name.startsWith('/')) set.add(name);
    }
  }
  return [...set];
}

const graphNodes = computed(() => {
  if (useCmdb.value) return snapshot.value.nodes;
  const list = [];
  const truncate = (text) => (text.length > 22 ? `${text.slice(0, 21)}…` : text);
  hosts.value.forEach((host) => {
    list.push({ key: `host-${host.id}`, label: truncate(host.name), fullLabel: host.name, sub: host.active ? '活跃宿主' : host.type, state: 'host' });
  });
  projects.value.forEach((p) => {
    const label = p.projectName || p.displayName || p.name || p.id || '未命名项目';
    const sub = `${p.containers?.length || 0} 个服务容器`;
    list.push({ key: `project-${p.id}`, label: truncate(String(label)), fullLabel: String(label), sub, state: 'project' });
  });
  const volumes = [];
  projects.value.forEach((p) => {
    for (const c of p.containers || []) {
      for (const v of c.volumes || []) {
        const name = String(v).split(':')[0];
        if (name && !volumes.includes(name)) volumes.push(name);
      }
    }
  });
  volumes.slice(0, 10).forEach((v) => {
    list.push({ key: `volume-${v}`, label: truncate(v), fullLabel: v, sub: '持久卷', state: 'volume' });
  });
  alerts.value.slice(0, 6).forEach((a) => {
    list.push({ key: `alert-${a.id}`, label: truncate(a.title), fullLabel: a.title, sub: a.priority === 'danger' ? '紧急告警' : '关注告警', state: 'alert' });
  });
  return list;
});

const graphEdges = computed(() => {
  if (useCmdb.value) return snapshot.value.edges;
  const list = [];
  for (const p of projects.value) {
    const host = hosts.value.find(h => h.id === p.hostId);
    if (host) list.push({ source: `host-${host.id}`, target: `project-${p.id}` });
  }
  for (const p of projects.value) {
    for (const c of p.containers || []) {
      for (const v of c.volumes || []) {
        const name = String(v).split(':')[0];
        if (name) list.push({ source: `project-${p.id}`, target: `volume-${name}` });
      }
    }
  }
  for (const a of alerts.value.slice(0, 6)) {
    const target = projects.value.find((p) => a.target?.includes(p.id) || a.title?.includes(p.projectName || p.name));
    if (target) list.push({ source: `alert-${a.id}`, target: `project-${target.id}` });
  }
  return list;
});

let active = true, requestVersion = 0;
async function load() {
  if (!active) return;
  const request = ++requestVersion;
  busy.value = true; loadError.value = '';
  try {
    if (useCmdb.value) {
      await cmdb.loadTopology(true, { throwOnError: true });
    } else {
      const [hostData, alertData, inspectionData] = await Promise.allSettled([
        api.getHosts(), api.getAlertEvents(50), api.getInspectionOverview(20), store.refresh(false),
      ]);
      if (!active || request !== requestVersion) return;
      if (hostData.status === 'fulfilled') liveHosts.value = hostData.value.hosts || [];
      if (alertData.status === 'fulfilled') alerts.value = alertData.value.events || [];
      if (inspectionData.status === 'fulfilled') inspectionCount.value = inspectionData.value.reports?.length || 0;
      const failed = [hostData, alertData, inspectionData].filter(r => r.status === 'rejected');
      if (failed.length) loadError.value = '部分实时数据读取失败，保留上次结果，请重试。';
    }
  } catch (e) {
    if (active && request === requestVersion) loadError.value = e.message || '图谱加载失败';
  } finally {
    if (active && request === requestVersion) busy.value = false;
  }
}
function invalidate() { ++requestVersion; busy.value = false; loadError.value = ''; }
function toggleSource() { invalidate(); useCmdb.value = !useCmdb.value; void load(); }
function onHostChanged() { invalidate(); if (active) void load(); }
const stopAuthListener = onAuthEpochChange(() => {
  invalidate(); liveHosts.value = []; alerts.value = []; inspectionCount.value = 0;
});
usePullRefresh(load, { keepAlive: true });
onMounted(() => { window.addEventListener('composeops:host-changed', onHostChanged); void load(); });
let activatedOnce = false;
onActivated(() => { active = true; if (activatedOnce) void load(); activatedOnce = true; });
onDeactivated(() => { active = false; invalidate(); });
onBeforeUnmount(() => {
  active = false; invalidate(); stopAuthListener();
  window.removeEventListener('composeops:host-changed', onHostChanged);
});

</script>

<style scoped>
.ios-segmented-control {
  display: inline-flex;
  padding: 3px;
  border-radius: 12px;
  background: rgba(var(--ui-panel-rgb), 0.7);
  border: 1px solid rgba(var(--ui-ink-rgb), 0.1);
}
.ios-segment-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-soft);
  border-radius: 9px;
  transition: all 0.18s ease;
}
.ios-segment-btn:hover {
  color: var(--text-bright);
}
.ios-segment-btn.active {
  color: var(--text-bright);
  background: rgba(var(--ui-ink-rgb), 0.12);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}
.ios-mini-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: rgba(var(--ui-ink-rgb), 0.04);
  border: 1px solid;
}
</style>
