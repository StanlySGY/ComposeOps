<template>
  <div :class="embedded ? '' : 'page-shell'">
    <div v-if="!embedded" class="page-header">
      <div>
        <h1 class="page-title">运维资产关系图谱</h1>
        <p class="page-subtitle">节点、项目、容器、存储卷与实时告警的关联视图 · 支撑故障根因追溯</p>
      </div>
      <div class="page-actions">
        <div class="ios-segmented-control" role="tablist" aria-label="图谱呈现模式">
          <button
            class="ios-segment-btn"
            :class="{ active: viewMode === 'graph' }"
            role="tab"
            @click="viewMode = 'graph'"
          >
            <Waypoints class="w-3.5 h-3.5" />
            <span>架构图谱</span>
          </button>
          <button
            class="ios-segment-btn"
            :class="{ active: viewMode === 'tree' }"
            role="tab"
            @click="viewMode = 'tree'"
          >
            <GitMerge class="w-3.5 h-3.5" />
            <span>资产血缘树</span>
          </button>
        </div>
        <button class="btn-secondary" :class="{ 'border-accent! text-accent!': useCmdb }" @click="toggleSource">
          <Database class="w-4 h-4" />{{ useCmdb ? 'CMDB 资产数据' : '实时发现数据' }}
        </button>
        <button class="btn-secondary" :disabled="loading" @click="load">
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新
        </button>
      </div>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>

    <!-- 图谱概览统计 -->
    <div class="metric-grid">
      <div class="metric-tile"><span class="metric-icon text-blue-300"><Server class="h-5 w-5" /></span><span><strong>{{ hosts.length }}</strong><small>宿主节点</small></span><span class="metric-meta">{{ activeHostName }}</span></div>
      <div class="metric-tile"><span class="metric-icon text-emerald-300"><Boxes class="h-5 w-5" /></span><span><strong>{{ projects.length }}</strong><small>纳管项目</small></span><span class="metric-meta">{{ containerCount }} 容器</span></div>
      <div class="metric-tile"><span class="metric-icon text-violet-300"><HardDrive class="h-5 w-5" /></span><span><strong>{{ volumeCount }}</strong><small>持久化卷</small></span><span class="metric-meta">本地存储绑定</span></div>
      <div class="metric-tile"><span class="metric-icon text-rose-300"><AlertTriangle class="h-5 w-5" /></span><span><strong>{{ alertCount }}</strong><small>关联事件</small></span><span class="metric-meta">监控告警</span></div>
      <div class="metric-tile"><span class="metric-icon text-amber-300"><Bot class="h-5 w-5" /></span><span><strong>{{ inspectionCount }}</strong><small>智能巡检</small></span><span class="metric-meta">巡检档案</span></div>
    </div>

    <!-- 视图 1：iOS 实体关系图谱 -->
    <section v-if="viewMode === 'graph'" class="section-panel flex-1">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="section-title">实体全景拓扑</h2>
          <p class="mt-1 text-muted">节点、项目、持久卷与告警事件的关联网络</p>
        </div>
        <div class="flex flex-wrap items-center gap-3 text-xs text-surface-400">
          <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-sky-400"></span>宿主</span>
          <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-emerald-400"></span>项目</span>
          <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-violet-400"></span>卷</span>
          <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-rose-400"></span>告警</span>
        </div>
      </div>

      <Skeleton v-if="loading" variant="table" :rows="4" label="图谱加载中" />
      <EmptyState v-else-if="!projects.length" icon="Network" title="暂无项目数据" description="纳管项目后,知识图谱会自动生成实体关系" />
      <ForceGraph
        v-else
        :nodes="graphNodes"
        :edges="graphEdges"
        :height="embedded ? 480 : 560"
        default-layout="dag"
        :lane-titles="{ single: '资产实体', first: '宿主与告警', middle: '纳管项目', last: '存储卷' }"
        aria-label="运维资产关系图谱"
      />
    </section>

    <!-- 视图 2：清晰可操作的资产血缘树 (消除图谱的做作感) -->
    <section v-else class="section-panel flex-1 space-y-4">
      <div class="mb-2">
        <h2 class="section-title">资产层级血缘结构</h2>
        <p class="mt-1 text-muted">宿主机 ➔ Compose 项目 ➔ 运行容器 ➔ 存储卷与挂载，直观查看链路</p>
      </div>

      <div v-for="host in hosts" :key="host.id" class="rounded-2xl border border-white/10 bg-surface-900/40 p-4 space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <span class="grid h-8 w-8 place-items-center rounded-xl bg-sky-500/15 text-sky-400 border border-sky-500/25">
              <Server class="w-4 h-4" />
            </span>
            <div>
              <h3 class="text-sm font-semibold text-surface-100">{{ host.name }}</h3>
              <p class="text-[11px] text-surface-400 font-mono">{{ host.type || 'local' }} 节点 · {{ host.active ? '当前活跃宿主' : '从节点' }}</p>
            </div>
          </div>
          <span class="count-badge" :class="host.active ? 'text-emerald-300' : 'text-surface-500'">
            {{ projects.length }} 个管理项目
          </span>
        </div>

        <!-- 项目卡片网格 -->
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 pt-2">
          <div
            v-for="p in projects"
            :key="p.id"
            class="rounded-xl border border-white/8 bg-surface-950/60 p-3.5 space-y-2.5 transition-all hover:border-emerald-500/30"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full" :class="p.status === 'running' || (p.containers && p.containers.length) ? 'bg-emerald-400' : 'bg-surface-500'"></span>
                  <h4 class="text-sm font-semibold text-surface-100 truncate font-mono">{{ p.projectName || p.name }}</h4>
                </div>
                <p class="text-[11px] text-surface-400 mt-0.5 truncate">{{ p.workingDir || '标准项目路径' }}</p>
              </div>
              <router-link :to="`/services?focus=${encodeURIComponent(p.id)}`" class="icon-btn text-surface-400 hover:text-surface-100" title="进入服务">
                <ChevronRight class="w-4 h-4" />
              </router-link>
            </div>

            <!-- 包含容器 -->
            <div class="text-xs space-y-1">
              <span class="text-surface-500">容器服务 ({{ p.containers?.length || 0 }})：</span>
              <div class="flex flex-wrap gap-1">
                <span
                  v-for="c in (p.containers || []).slice(0, 4)"
                  :key="c.id"
                  class="ios-mini-tag"
                  :class="c.state === 'running' ? 'text-emerald-300 border-emerald-500/20' : 'text-surface-400 border-white/5'"
                >
                  {{ c.name.split('_').pop() || c.name }}
                </span>
                <span v-if="(p.containers?.length || 0) > 4" class="text-[10px] text-surface-500 self-center">
                  +{{ p.containers.length - 4 }}
                </span>
              </div>
            </div>

            <!-- 数据卷 -->
            <div v-if="projectVolumes(p).length" class="text-xs pt-1 border-t border-white/5">
              <span class="text-surface-500">存储卷：</span>
              <span class="font-mono text-[11px] text-violet-300 ml-1">{{ projectVolumes(p).join(', ') }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 底部实体明细 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">实体资产分布</h2><p class="mt-1 text-muted">各类被纳管实体的基础属性与健康概况</p></div>
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
          <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold text-sky-300"><Server class="h-4 w-4" />节点 ({{ hosts.length }})</h3>
          <div class="space-y-2">
            <div v-for="host in hosts" :key="host.id" class="flex items-center justify-between rounded-lg border border-surface-800 bg-surface-900/60 px-3 py-2">
              <span class="text-sm text-surface-200">{{ host.name }}</span>
              <span class="count-badge" :class="host.active ? 'text-emerald-300' : 'text-surface-500'">{{ host.active ? '活跃' : host.type }}</span>
            </div>
          </div>
        </div>
        <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
          <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-300"><Boxes class="h-4 w-4" />项目 ({{ projects.length }})</h3>
          <div class="space-y-2">
            <div v-for="project in projects.slice(0, 6)" :key="project.id" class="flex items-center justify-between rounded-lg border border-surface-800 bg-surface-900/60 px-3 py-2">
              <span class="min-w-0 flex-1 truncate text-sm text-surface-200">{{ project.projectName }}</span>
              <span class="count-badge" :class="project.status === 'running' || (project.containers && project.containers.length) ? 'text-emerald-300' : 'text-rose-300'">{{ (project.containers?.length || 0) + ' 容器' }}</span>
            </div>
          </div>
        </div>
        <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
          <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold text-rose-300"><AlertTriangle class="h-4 w-4" />待处理告警 ({{ alertCount }})</h3>
          <div v-if="!alerts.length" class="text-sm text-surface-500 py-3 text-center">暂无活动告警</div>
          <div v-else class="space-y-2">
            <div v-for="alert in alerts.slice(0, 4)" :key="alert.id" class="flex items-center gap-2 rounded-lg border border-surface-800 bg-surface-900/60 px-3 py-2">
              <span class="h-2 w-2 shrink-0 rounded-full" :class="alert.priority === 'danger' ? 'bg-rose-400' : 'bg-amber-400'"></span>
              <span class="min-w-0 flex-1 truncate text-xs text-surface-200">{{ alert.title }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
defineProps({ embedded: { type: Boolean, default: false } });
import { computed, onMounted, ref } from 'vue';
import { AlertTriangle, Bot, Boxes, ChevronRight, Database, GitMerge, HardDrive, RefreshCw, Server, Waypoints } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { useServicesStore } from '../stores/services.js';
import { useCmdbStore } from '../stores/cmdb.js';
import ForceGraph from '../components/ForceGraph.vue';
import Skeleton from '../components/common/Skeleton.vue';
import EmptyState from '../components/common/EmptyState.vue';

const store = useServicesStore();
const cmdb = useCmdbStore();
const loading = ref(false);
const error = ref('');
const hosts = ref([]);
const alerts = ref([]);
const inspectionCount = ref(0);
const useCmdb = ref(false);
const viewMode = ref('graph'); // 'graph' | 'tree'

const projects = computed(() => useCmdb.value ? cmdb.projects : store.projects);
const containerCount = computed(() => useCmdb.value ? cmdb.containers.length : projects.value.reduce((n, p) => n + (p.containers?.length || 0), 0));
const volumeCount = computed(() => useCmdb.value ? cmdb.assets.filter((a) => a.kind === 'volume').length : projects.value.reduce((n, p) => n + (p.containers || []).reduce((m, c) => m + (c.volumes?.length || 0), 0), 0));
const alertCount = computed(() => alerts.value.length);
const activeHostName = computed(() => hosts.value.find((h) => h.active)?.name || 'Local Daemon');

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
  const list = [];
  const truncate = (text) => (text.length > 22 ? `${text.slice(0, 21)}…` : text);
  hosts.value.forEach((host) => {
    list.push({ key: `host-${host.id}`, label: truncate(host.name), fullLabel: host.name, sub: host.active ? '活跃宿主' : host.type, state: 'host' });
  });
  projects.value.forEach((p) => {
    const label = useCmdb.value ? (p.displayName || p.name) : p.projectName;
    const sub = `${p.containers?.length || 0} 个服务容器`;
    list.push({ key: `project-${p.id}`, label: truncate(String(label)), fullLabel: String(label), sub, state: 'project' });
  });
  const volumes = [];
  if (useCmdb.value) {
    cmdb.assets.filter((a) => a.kind === 'volume').forEach((v) => volumes.push(v.name));
  } else {
    projects.value.forEach((p) => {
      for (const c of p.containers || []) {
        for (const v of c.volumes || []) {
          const name = String(v).split(':')[0];
          if (name && !volumes.includes(name)) volumes.push(name);
        }
      }
    });
  }
  volumes.slice(0, 10).forEach((v) => {
    list.push({ key: `volume-${v}`, label: truncate(v), fullLabel: v, sub: '持久卷', state: 'volume' });
  });
  alerts.value.slice(0, 6).forEach((a) => {
    list.push({ key: `alert-${a.id}`, label: truncate(a.title), fullLabel: a.title, sub: a.priority === 'danger' ? '紧急告警' : '关注告警', state: 'alert' });
  });
  return list;
});

const graphEdges = computed(() => {
  const list = [];
  const activeHost = hosts.value.find((h) => h.active) || hosts.value[0];
  if (activeHost) {
    for (const p of projects.value) {
      list.push({ source: `host-${activeHost.id}`, target: `project-${p.id}` });
    }
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

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    if (useCmdb.value) {
      await cmdb.loadTopology();
      hosts.value = cmdb.hosts.map((h) => ({ id: h.id, name: h.displayName || h.name, type: h.properties?.type || 'local', active: h.hostId === 'local' }));
    } else {
      const [hostData, alertData, inspectionData] = await Promise.allSettled([
        api.getHosts(),
        api.getAlertEvents(50),
        api.getInspectionOverview(20),
      ]);
      hosts.value = hostData.status === 'fulfilled' ? (hostData.value.hosts || []) : [];
      alerts.value = alertData.status === 'fulfilled' ? (alertData.value.events || []) : [];
      inspectionCount.value = inspectionData.status === 'fulfilled' ? (inspectionData.value.reports?.length || 0) : 0;
    }
  } catch (e) {
    error.value = e.message || '图谱加载失败';
  } finally {
    loading.value = false;
  }
}

function toggleSource() {
  useCmdb.value = !useCmdb.value;
  void load();
}

onMounted(async () => {
  await store.refresh(false);
  await load();
});
</script>

<style scoped>
.ios-segmented-control {
  display: inline-flex;
  padding: 3px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.ios-segment-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 500;
  color: #94A3B8;
  border-radius: 9px;
  transition: all 0.18s ease;
}
.ios-segment-btn:hover {
  color: #F8FAFC;
}
.ios-segment-btn.active {
  color: #FFFFFF;
  background: rgba(255, 255, 255, 0.12);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}
.ios-mini-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid;
}
</style>
