<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">服务拓扑中心</h1>
        <p class="page-subtitle">自动生成 Compose 服务依赖关系图,可视化 depends_on、端口与卷</p>
      </div>
      <div class="page-actions">
        <select v-model="selectedProjectId" class="input sm:w-56" aria-label="选择项目" @change="loadProject">
          <option value="">选择项目</option>
          <option v-for="p in composeProjects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
        </select>
        <label class="toggle-label whitespace-nowrap" title="同时展示所有项目的服务,支持跨项目依赖"><input v-model="crossProject" type="checkbox" @change="loadProject" />跨项目</label>
        <button class="btn-secondary" :disabled="loading" @click="loadProject"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>

    <EmptyState v-if="!selectedProjectId && !crossProject" icon="Network" title="选择项目查看拓扑" description="从上方下拉框选择一个 Compose 项目,或开启跨项目模式查看全局依赖" class="flex-1" />

    <template v-else>
      <!-- 项目概览 -->
      <div class="metric-grid">
        <div class="metric-tile"><span class="metric-icon text-blue-300"><Boxes class="h-5 w-5" /></span><span><strong>{{ services.length }}</strong><small>服务节点</small></span><span class="metric-meta">{{ project?.projectName }}</span></div>
        <div class="metric-tile"><span class="metric-icon text-emerald-300"><GitBranch class="h-5 w-5" /></span><span><strong>{{ edgeCount }}</strong><small>依赖关系</small></span><span class="metric-meta">depends_on</span></div>
        <div class="metric-tile"><span class="metric-icon text-violet-300"><Network class="h-5 w-5" /></span><span><strong>{{ networkCount }}</strong><small>网络</small></span><span class="metric-meta">共享网络</span></div>
        <div class="metric-tile"><span class="metric-icon text-amber-300"><HardDrive class="h-5 w-5" /></span><span><strong>{{ volumeCount }}</strong><small>数据卷</small></span><span class="metric-meta">持久化存储</span></div>
        <div class="metric-tile"><span class="metric-icon text-rose-300"><Container class="h-5 w-5" /></span><span><strong>{{ runningContainers }} / {{ containerCount }}</strong><small>运行容器</small></span><span class="metric-meta">实时状态</span></div>
      </div>

      <!-- 拓扑图 -->
      <section class="section-panel flex-1">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="section-title">依赖关系图</h2>
            <p class="mt-1 text-muted">节点为服务,连线为 depends_on 依赖;颜色表示容器运行状态</p>
          </div>
          <div class="flex flex-wrap items-center gap-3 text-xs text-surface-400">
            <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full bg-emerald-400"></span>运行中</span>
            <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full bg-rose-400"></span>已停止</span>
            <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full bg-amber-400"></span>不健康</span>
            <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full bg-surface-500"></span>无容器</span>
          </div>
        </div>

        <Skeleton v-if="loading" variant="table" :rows="4" label="拓扑加载中" />
        <EmptyState v-else-if="!services.length" icon="Network" title="该项目没有可解析的服务" description="项目可能没有 Compose 配置,或配置中未定义 services" />
        <ForceGraph
          v-else
          :nodes="graphNodes"
          :edges="graphEdges"
          :seed-positions="seedPositions"
          :selected-key="selectedService"
          height="560"
          aria-label="服务拓扑力导向图"
          @node-click="toggleService"
        />
        <p v-if="selectedService" class="mt-3 text-xs text-surface-400">
          已选中 <span class="font-mono text-surface-200">{{ selectedService }}</span>,服务明细中对应行已高亮;拖拽气泡可整理布局,滚轮缩放,空白处拖拽平移。
        </p>
      </section>

      <!-- 服务明细 -->
      <section class="section-panel">
        <div class="mb-4"><h2 class="section-title">服务明细</h2><p class="mt-1 text-muted">每个服务的依赖、端口、卷与运行状态</p></div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>服务</th><th>状态</th><th>依赖</th><th>端口</th><th>卷</th><th>镜像</th></tr></thead>
            <tbody>
              <tr
                v-for="svc in services"
                :key="svc.name"
                class="hover:bg-surface-800/25"
                :class="svc.name === selectedService ? 'topo-row-selected' : ''"
              >
                <td class="font-mono font-medium text-surface-100">{{ svc.name }}</td>
                <td><span class="status-badge" :class="svcStateClass(svc)">{{ svcStateLabel(svc) }}</span></td>
                <td class="text-surface-300">{{ svc.dependsOn.length ? svc.dependsOn.join(', ') : '—' }}</td>
                <td class="font-mono text-xs text-emerald-300">{{ svc.ports.length ? svc.ports.join(', ') : '—' }}</td>
                <td class="font-mono text-xs text-amber-300">{{ svc.volumes.length ? svc.volumes.length + ' 个' : '—' }}</td>
                <td class="max-w-56 truncate text-muted" :title="svc.image">{{ svc.image || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Boxes, Container, GitBranch, HardDrive, Network, RefreshCw } from 'lucide-vue-next';
import * as YAML from 'yaml';
import { api } from '../api/client.js';
import { useServicesStore } from '../stores/services.js';
import { assignLevels } from '../lib/topology-layout.js';
import ForceGraph from '../components/ForceGraph.vue';
import Skeleton from '../components/common/Skeleton.vue';
import EmptyState from '../components/common/EmptyState.vue';

const store = useServicesStore();
const selectedProjectId = ref('');
const crossProject = ref(false);
const loading = ref(false);
const error = ref('');
const services = ref([]);
const networks = ref([]);
const volumes = ref([]);
const selectedService = ref('');
const composeProjects = computed(() => store.projects.filter((project) => project.editable));

const project = computed(() => composeProjects.value.find((p) => p.id === selectedProjectId.value));
const containerCount = computed(() => (crossProject.value ? store.projects.reduce((n, p) => n + (p.containers?.length || 0), 0) : project.value?.containers?.length || 0));
const runningContainers = computed(() => (crossProject.value ? store.projects.reduce((n, p) => n + (p.containers || []).filter((c) => c.state === 'running').length, 0) : (project.value?.containers || []).filter((c) => c.state === 'running').length));
const networkCount = computed(() => networks.value.length);
const volumeCount = computed(() => volumes.value.length);
const edgeCount = computed(() => services.value.reduce((n, s) => n + s.dependsOn.length, 0));

// 力导向图:气泡 = 服务,连线 = depends_on;初始坐标继承分层布局的左→右依赖流
const graphNodes = computed(() =>
  services.value.map((svc) => ({
    key: svc.name,
    label: svc.name.length > 24 ? `${svc.name.slice(0, 23)}…` : svc.name,
    fullLabel: svc.name,
    sub: svcStateLabel(svc),
    state: svcState(svc),
  }))
);
const graphEdges = computed(() => {
  const list = [];
  for (const svc of services.value) {
    for (const dep of svc.dependsOn) {
      list.push({ source: dep, target: svc.name });
    }
  }
  return list;
});
const seedPositions = computed(() => {
  if (!services.value.length) return null;
  // 按依赖层级比例铺到世界坐标(被依赖者在左),单层图水平居中;
  // 力模拟会在此基础上松弛成自然形态
  const levels = assignLevels(services.value);
  const maxLevel = Math.max(0, ...levels.map((l) => l.level));
  const left = 220;
  const right = 1200 - 220;
  const map = {};
  for (const item of levels) {
    map[item.name] = {
      x: maxLevel === 0 ? 600 : left + (item.level / maxLevel) * (right - left),
      y: 350 + (item.index - (item.count - 1) / 2) * 110,
    };
  }
  return map;
});

function toggleService(key) {
  selectedService.value = selectedService.value === key ? '' : key;
}

function svcState(svc) {
  const projectData = crossProject.value ? store.projects.find((p) => p.id === svc.projectId) : project.value;
  // 跨项目模式下服务名带 "项目/" 前缀,容器名匹配要用裸服务名
  const matchName = crossProject.value ? svc.rawName : svc.name;
  const container = (projectData?.containers || []).find((c) => c.name.includes(matchName));
  if (!container) return 'none';
  if (container.health === 'unhealthy') return 'unhealthy';
  return container.state === 'running' ? 'running' : 'stopped';
}
function svcStateClass(svc) {
  const s = svcState(svc);
  return { running: 'bg-emerald-500/10 text-emerald-400', unhealthy: 'bg-amber-500/10 text-amber-400', stopped: 'bg-rose-500/10 text-rose-400', none: 'bg-surface-800 text-surface-400' }[s] || 'bg-surface-800 text-surface-400';
}
function svcStateLabel(svc) {
  const s = svcState(svc);
  return { running: '运行中', unhealthy: '不健康', stopped: '已停止', none: '无容器' }[s] || '无容器';
}

async function loadProject() {
  if (!selectedProjectId.value && !crossProject.value) return;
  loading.value = true;
  error.value = '';
  services.value = [];
  networks.value = [];
  volumes.value = [];
  try {
    const targets = crossProject.value ? composeProjects.value : composeProjects.value.filter((p) => p.id === selectedProjectId.value);
    const results = await Promise.allSettled(targets.map((p) => api.getComposeFile(p.id, 0)));
    const allServices = [];
    const allNetworks = new Set();
    const allVolumes = new Set();
    results.forEach((result, idx) => {
      if (result.status !== 'fulfilled') return;
      const target = targets[idx];
      const parsed = YAML.parse(result.value.content || '');
      const svcMap = parsed?.services || {};
      for (const [name, cfg] of Object.entries(svcMap)) {
        const displayName = crossProject.value ? `${target.projectName}/${name}` : name;
        allServices.push({
          name: displayName,
          rawName: name,
          projectId: target.id,
          projectName: target.projectName,
          image: cfg.image || '',
          dependsOn: (Array.isArray(cfg.depends_on) ? cfg.depends_on : cfg.depends_on ? Object.keys(cfg.depends_on) : []).map((d) => (crossProject.value ? `${target.projectName}/${d}` : d)),
          ports: (cfg.ports || []).map((p) => String(p)),
          volumes: (cfg.volumes || []).map((v) => String(v)),
        });
      }
      for (const n of Object.keys(parsed?.networks || {})) allNetworks.add(n);
      for (const v of Object.keys(parsed?.volumes || {})) allVolumes.add(v);
    });
    services.value = allServices;
    networks.value = [...allNetworks];
    volumes.value = [...allVolumes];
  } catch (e) {
    error.value = `拓扑解析失败: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await store.refresh(false);
  // 空画布对首次访问不友好:有项目时默认选中第一个,直接展示拓扑
  if (!selectedProjectId.value && !crossProject.value && composeProjects.value.length) {
    selectedProjectId.value = composeProjects.value[0].id;
    await loadProject();
  }
});
</script>

<style scoped>
.topo-row-selected {
  background: rgba(16, 185, 129, 0.08);
  box-shadow: inset 2px 0 0 var(--color-emerald-400, #34D399);
}
</style>
