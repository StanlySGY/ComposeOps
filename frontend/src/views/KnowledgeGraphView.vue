<template>
  <div :class="embedded ? '' : 'page-shell'">
    <div v-if="!embedded" class="page-header">
      <div>
        <h1 class="page-title">运维知识图谱</h1>
        <p class="page-subtitle">统一关联 Host、项目、容器、卷、网络、告警与 AI 分析,支撑智能运维决策</p>
      </div>
      <div class="page-actions">
        <button class="btn-secondary" :class="{ 'border-accent! text-accent!': useCmdb }" @click="toggleSource"><Database class="w-4 h-4" />{{ useCmdb ? '资产中心数据' : '实时数据' }}</button>
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>

    <!-- 图谱统计 -->
    <div class="metric-grid">
      <div class="metric-tile"><span class="metric-icon text-blue-300"><Server class="h-5 w-5" /></span><span><strong>{{ hosts.length }}</strong><small>节点</small></span><span class="metric-meta">{{ activeHostName }}</span></div>
      <div class="metric-tile"><span class="metric-icon text-emerald-300"><Boxes class="h-5 w-5" /></span><span><strong>{{ projects.length }}</strong><small>项目</small></span><span class="metric-meta">{{ containerCount }} 容器</span></div>
      <div class="metric-tile"><span class="metric-icon text-violet-300"><HardDrive class="h-5 w-5" /></span><span><strong>{{ volumeCount }}</strong><small>数据卷</small></span><span class="metric-meta">持久化存储</span></div>
      <div class="metric-tile"><span class="metric-icon text-rose-300"><AlertTriangle class="h-5 w-5" /></span><span><strong>{{ alertCount }}</strong><small>告警</small></span><span class="metric-meta">待处理事件</span></div>
      <div class="metric-tile"><span class="metric-icon text-amber-300"><Bot class="h-5 w-5" /></span><span><strong>{{ inspectionCount }}</strong><small>AI 分析</small></span><span class="metric-meta">巡检报告</span></div>
    </div>

    <!-- 关系图谱 -->
    <section class="section-panel flex-1">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="section-title">实体关系图</h2>
          <p class="mt-1 text-muted">节点为实体,连线为关联关系;颜色区分实体类型</p>
        </div>
        <div class="flex flex-wrap items-center gap-3 text-xs text-surface-400">
          <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full bg-sky-400"></span>节点</span>
          <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full bg-emerald-400"></span>项目</span>
          <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full bg-violet-400"></span>卷</span>
          <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full bg-rose-400"></span>告警</span>
        </div>
      </div>

      <Skeleton v-if="loading" variant="table" :rows="4" label="图谱加载中" />
      <EmptyState v-else-if="!projects.length" icon="Network" title="暂无项目数据" description="纳管项目后,知识图谱会自动生成实体关系" />
      <div v-else class="overflow-auto rounded-2xl border border-surface-800 bg-surface-950/60">
        <svg :viewBox="`0 0 ${svgWidth} ${svgHeight}`" class="min-w-[900px] w-full" role="img" aria-label="运维知识图谱">
          <defs>
            <marker id="kg-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#475569" />
            </marker>
          </defs>
          <!-- 连线 -->
          <g v-for="edge in edges" :key="edge.key">
            <path :d="edgePath(edge)" fill="none" stroke="#334155" stroke-width="1.2" marker-end="url(#kg-arrow)" />
          </g>
          <!-- 节点 -->
          <g v-for="node in nodes" :key="node.key" :transform="`translate(${node.x}, ${node.y})`">
            <rect :x="-nodeW/2" :y="-nodeH/2" :width="nodeW" :height="nodeH" rx="10" :fill="nodeFill(node)" :stroke="nodeStroke(node)" stroke-width="1.5" />
            <text :x="0" :y="-3" text-anchor="middle" class="kg-node-name" fill="#E2E8F0">{{ node.label }}</text>
            <text :x="0" :y="13" text-anchor="middle" class="kg-node-sub" :fill="nodeSubColor(node)">{{ node.sub }}</text>
          </g>
        </svg>
      </div>
    </section>

    <!-- 实体明细 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">实体明细</h2><p class="mt-1 text-muted">按类型查看图谱中的实体</p></div>
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
            <div v-for="project in projects" :key="project.id" class="flex items-center justify-between rounded-lg border border-surface-800 bg-surface-900/60 px-3 py-2">
              <span class="min-w-0 flex-1 truncate text-sm text-surface-200">{{ project.projectName }}</span>
              <span class="count-badge" :class="project.status === 'running' ? 'text-emerald-300' : 'text-rose-300'">{{ project.status === 'running' ? '运行' : '异常' }}</span>
            </div>
          </div>
        </div>
        <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
          <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold text-rose-300"><AlertTriangle class="h-4 w-4" />告警 ({{ alertCount }})</h3>
          <div v-if="!alerts.length" class="text-sm text-surface-500">暂无告警</div>
          <div v-else class="space-y-2">
            <div v-for="alert in alerts.slice(0, 6)" :key="alert.id" class="flex items-center gap-2 rounded-lg border border-surface-800 bg-surface-900/60 px-3 py-2">
              <span class="h-2 w-2 shrink-0 rounded-full" :class="alert.priority === 'danger' ? 'bg-rose-400' : 'bg-amber-400'"></span>
              <span class="min-w-0 flex-1 truncate text-sm text-surface-200">{{ alert.title }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
// embedded 模式供 CMDBView 的「知识图谱」tab 复用,隐藏独立页头
defineProps({ embedded: { type: Boolean, default: false } });
import { computed, onMounted, ref } from 'vue';
import { AlertTriangle, Bot, Boxes, Database, HardDrive, RefreshCw, Server } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { useServicesStore } from '../stores/services.js';
import { useCmdbStore } from '../stores/cmdb.js';
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

const nodeW = 150;
const nodeH = 44;

const projects = computed(() => useCmdb.value ? cmdb.projects : store.projects);
const containerCount = computed(() => useCmdb.value ? cmdb.containers.length : projects.value.reduce((n, p) => n + (p.containers?.length || 0), 0));
const volumeCount = computed(() => useCmdb.value ? cmdb.assets.filter((a) => a.kind === 'volume').length : projects.value.reduce((n, p) => n + (p.containers || []).reduce((m, c) => m + (c.volumes?.length || 0), 0), 0));
const alertCount = computed(() => alerts.value.length);
const activeHostName = computed(() => hosts.value.find((h) => h.active)?.name || 'Local Daemon');

// 图谱布局:Host 在左,项目居中,卷/告警在右
const nodes = computed(() => {
  const list = [];
  const hostY = 60;
  hosts.value.forEach((host, i) => {
    list.push({ key: `host-${host.id}`, type: 'host', label: host.name, sub: host.active ? '活跃节点' : host.type, x: 90, y: hostY + i * 90 });
  });
  const projectStartY = 60;
  projects.value.forEach((p, i) => {
    const label = useCmdb.value ? (p.displayName || p.name) : p.projectName;
    const sub = useCmdb.value ? (p.status || '') : `${p.containers?.length || 0} 容器`;
    list.push({ key: `project-${p.id}`, type: 'project', label, sub, x: 340, y: projectStartY + i * 90 });
  });
  const volumeStartY = 60;
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
  volumes.slice(0, 12).forEach((v, i) => {
    list.push({ key: `volume-${v}`, type: 'volume', label: v, sub: '数据卷', x: 590, y: volumeStartY + i * 70 });
  });
  const alertStartY = 60;
  alerts.value.slice(0, 8).forEach((a, i) => {
    list.push({ key: `alert-${a.id}`, type: 'alert', label: a.title, sub: a.priority === 'danger' ? '紧急' : '关注', x: 840, y: alertStartY + i * 70 });
  });
  return list;
});
const edges = computed(() => {
  const list = [];
  const activeHost = hosts.value.find((h) => h.active) || hosts.value[0];
  if (activeHost) {
    for (const p of projects.value) {
      list.push({ key: `${activeHost.id}->${p.id}`, from: `host-${activeHost.id}`, to: `project-${p.id}` });
    }
  }
  for (const p of projects.value) {
    for (const c of p.containers || []) {
      for (const v of c.volumes || []) {
        const name = String(v).split(':')[0];
        if (name) list.push({ key: `${p.id}->${name}`, from: `project-${p.id}`, to: `volume-${name}` });
      }
    }
  }
  for (const a of alerts.value.slice(0, 8)) {
    const target = projects.value.find((p) => a.target?.includes(p.id) || a.title?.includes(p.projectName || p.name));
    if (target) list.push({ key: `${a.id}->${target.id}`, from: `alert-${a.id}`, to: `project-${target.id}` });
  }
  return list;
});
const svgWidth = computed(() => 1000);
const svgHeight = computed(() => {
  const maxCount = Math.max(hosts.value.length, projects.value.length, Math.min(12, volumeCount.value), Math.min(8, alertCount.value));
  return 120 + maxCount * 90;
});

function nodePos(key) {
  return nodes.value.find((n) => n.key === key);
}
function edgePath(edge) {
  const from = nodePos(edge.from);
  const to = nodePos(edge.to);
  if (!from || !to) return '';
  const x1 = from.x + nodeW / 2;
  const y1 = from.y;
  const x2 = to.x - nodeW / 2;
  const y2 = to.y;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}
function nodeFill(node) {
  return { host: '#0C4A6E', project: '#052E16', volume: '#2E1065', alert: '#4C0519' }[node.type] || '#0F172A';
}
function nodeStroke(node) {
  return { host: '#38BDF8', project: '#10B981', volume: '#A78BFA', alert: '#F43F5E' }[node.type] || '#334155';
}
function nodeSubColor(node) {
  return { host: '#7DD3FC', project: '#6EE7B7', volume: '#C4B5FD', alert: '#FDA4AF' }[node.type] || '#64748B';
}

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
.kg-node-name { font-size: 12px; font-weight: 600; font-family: ui-monospace, monospace; }
.kg-node-sub { font-size: 10px; }
</style>