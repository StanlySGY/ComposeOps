<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">服务拓扑中心</h1>
        <p class="page-subtitle">架构流向与依赖关系图 · 自动解析 depends_on、共享网络与数据卷</p>
      </div>
      <div class="page-actions">
        <select v-model="selectedProjectId" class="input sm:w-56" aria-label="选择项目" @change="loadProject">
          <option value="">选择项目</option>
          <option v-for="p in composeProjects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
        </select>
        <label class="toggle-label whitespace-nowrap" title="同时展示所有项目的服务,支持跨项目依赖">
          <input v-model="crossProject" type="checkbox" @change="loadProject" />跨项目
        </label>
        <button class="btn-secondary" :disabled="loading" @click="loadProject">
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新
        </button>
      </div>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>

    <EmptyState v-if="!selectedProjectId && !crossProject" icon="Network" title="选择项目查看拓扑" description="从上方下拉框选择一个 Compose 项目,或开启跨项目模式查看全局依赖" class="flex-1" />

    <template v-else>
      <!-- 项目概览指标卡片 -->
      <div class="metric-grid">
        <div class="metric-tile"><span class="metric-icon text-blue-300"><Boxes class="h-5 w-5" /></span><span><strong>{{ services.length }}</strong><small>服务节点</small></span><span class="metric-meta">{{ project?.projectName }}</span></div>
        <div class="metric-tile"><span class="metric-icon text-emerald-300"><GitBranch class="h-5 w-5" /></span><span><strong>{{ edgeCount }}</strong><small>依赖关系</small></span><span class="metric-meta">depends_on 链路</span></div>
        <div class="metric-tile"><span class="metric-icon text-violet-300"><Network class="h-5 w-5" /></span><span><strong>{{ networkCount }}</strong><small>网络</small></span><span class="metric-meta">共享网络</span></div>
        <div class="metric-tile"><span class="metric-icon text-amber-300"><HardDrive class="h-5 w-5" /></span><span><strong>{{ volumeCount }}</strong><small>数据卷</small></span><span class="metric-meta">持久化存储</span></div>
        <div class="metric-tile"><span class="metric-icon text-rose-300"><Container class="h-5 w-5" /></span><span><strong>{{ runningContainers }} / {{ containerCount }}</strong><small>运行容器</small></span><span class="metric-meta">实时健康度</span></div>
      </div>

      <!-- iOS 拓扑架构图 -->
      <section class="section-panel flex-1 relative">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="section-title">服务架构图谱</h2>
            <p class="mt-1 text-muted">卡片展示服务状态与规格，贝塞尔曲线标明依赖流向；点击卡片可高亮上下游链路</p>
          </div>
          <div class="flex flex-wrap items-center gap-3 text-xs text-surface-400">
            <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-emerald-400"></span>运行正常</span>
            <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-rose-400"></span>停止/异常</span>
            <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-amber-400"></span>健康度告警</span>
            <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-surface-500"></span>静态声明</span>
          </div>
        </div>

        <Skeleton v-if="loading" variant="table" :rows="4" label="拓扑加载中" />
        <EmptyState v-else-if="!services.length" icon="Network" title="该项目没有可解析的服务" description="项目可能没有 Compose 配置,或配置中未定义 services" />
        
        <div v-else class="relative">
          <ForceGraph
            :nodes="graphNodes"
            :edges="graphEdges"
            :seed-positions="seedPositions"
            :selected-key="selectedService"
            height="580"
            default-layout="dag"
            aria-label="服务拓扑架构图"
            @node-click="toggleService"
          />

          <!-- 选中服务时的 iOS 浮动详情面板 (Inspector Card) -->
          <transition name="ios-sheet">
            <div v-if="selectedSvcData" class="ios-inspector-card">
              <div class="flex items-start justify-between gap-3 pb-3 border-b border-white/10">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full" :class="svcStateClassDot(selectedSvcData)"></span>
                    <h3 class="text-sm font-semibold text-surface-100 truncate font-mono">{{ selectedSvcData.name }}</h3>
                  </div>
                  <p class="text-xs text-surface-400 mt-1 truncate">{{ selectedSvcData.image || '本地镜像构建' }}</p>
                </div>
                <button class="icon-btn text-surface-400 hover:text-surface-100" title="取消选中" @click="selectedService = ''">
                  <X class="w-4 h-4" />
                </button>
              </div>

              <!-- 上下游依赖链路 -->
              <div class="mt-3 space-y-2 text-xs">
                <div>
                  <span class="text-surface-400">依赖项 (Upstream)：</span>
                  <div v-if="upstreamDeps.length" class="mt-1 flex flex-wrap gap-1.5">
                    <button
                      v-for="dep in upstreamDeps"
                      :key="dep"
                      class="ios-tag-btn"
                      @click="selectedService = dep"
                    >
                      <ArrowUpRight class="w-3 h-3 text-emerald-400" />
                      {{ dep }}
                    </button>
                  </div>
                  <span v-else class="text-surface-500 ml-1">无直接依赖 (基础服务)</span>
                </div>

                <div>
                  <span class="text-surface-400">被依赖 (Downstream)：</span>
                  <div v-if="downstreamDeps.length" class="mt-1 flex flex-wrap gap-1.5">
                    <button
                      v-for="down in downstreamDeps"
                      :key="down"
                      class="ios-tag-btn"
                      @click="selectedService = down"
                    >
                      <ArrowDownLeft class="w-3 h-3 text-sky-400" />
                      {{ down }}
                    </button>
                  </div>
                  <span v-else class="text-surface-500 ml-1">无下游服务依赖</span>
                </div>

                <div v-if="selectedSvcData.ports.length" class="pt-1">
                  <span class="text-surface-400">暴露端口：</span>
                  <span class="font-mono text-emerald-300 ml-1">{{ selectedSvcData.ports.join(', ') }}</span>
                </div>
                <div v-if="selectedSvcData.volumes.length">
                  <span class="text-surface-400">挂载卷：</span>
                  <span class="font-mono text-amber-300 ml-1">{{ selectedSvcData.volumes.length }} 个存储绑定</span>
                </div>
              </div>

              <!-- 快捷操作栏 -->
              <div class="mt-4 pt-3 border-t border-white/10 flex items-center gap-2">
                <router-link
                  :to="`/logs?projectId=${encodeURIComponent(selectedSvcData.projectId || selectedProjectId)}`"
                  class="btn-secondary text-xs! py-1.5! px-3!"
                >
                  <ScrollText class="w-3.5 h-3.5" />
                  实时日志
                </router-link>
                <router-link
                  :to="`/services?focus=${encodeURIComponent(selectedSvcData.projectId || selectedProjectId)}`"
                  class="btn-secondary text-xs! py-1.5! px-3!"
                >
                  <Sliders class="w-3.5 h-3.5" />
                  服务管理
                </router-link>
              </div>
            </div>
          </transition>
        </div>

        <p v-if="!selectedService" class="mt-3 text-xs text-surface-400">
          💡 提示：点击任意服务卡片可聚焦高亮其完整依赖链路；支持滚轮无级缩放与画布拖拽平移。
        </p>
      </section>

      <!-- 服务明细表格 -->
      <section class="section-panel">
        <div class="mb-4">
          <h2 class="section-title">服务清单明细</h2>
          <p class="mt-1 text-muted">服务依赖、端口映射、数据卷配置与容器健康状态</p>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>服务名称</th>
                <th>状态</th>
                <th>依赖服务</th>
                <th>端口暴露</th>
                <th>挂载卷</th>
                <th>镜像</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="svc in services"
                :key="svc.name"
                class="hover:bg-surface-800/25 transition-colors"
                :class="svc.name === selectedService ? 'topo-row-selected' : ''"
              >
                <td class="font-mono font-medium text-surface-100 flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full shrink-0" :class="svcStateClassDot(svc)"></span>
                  {{ svc.name }}
                </td>
                <td><span class="status-badge" :class="svcStateClass(svc)">{{ svcStateLabel(svc) }}</span></td>
                <td class="text-surface-300">
                  <span v-if="!svc.dependsOn.length" class="text-surface-500">—</span>
                  <span v-else class="inline-flex flex-wrap gap-1">
                    <span v-for="d in svc.dependsOn" :key="d" class="count-badge text-surface-300">{{ d }}</span>
                  </span>
                </td>
                <td class="font-mono text-xs text-emerald-300">{{ svc.ports.length ? svc.ports.join(', ') : '—' }}</td>
                <td class="font-mono text-xs text-amber-300">{{ svc.volumes.length ? svc.volumes.length + ' 个' : '—' }}</td>
                <td class="max-w-56 truncate text-muted" :title="svc.image">{{ svc.image || '—' }}</td>
                <td>
                  <button class="btn-ghost text-xs! py-1! px-2!" @click="toggleService(svc.name)">
                    {{ selectedService === svc.name ? '取消聚焦' : '图谱聚焦' }}
                  </button>
                </td>
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
import { ArrowDownLeft, ArrowUpRight, Boxes, Container, GitBranch, HardDrive, Network, RefreshCw, ScrollText, Sliders, X } from 'lucide-vue-next';
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

const selectedSvcData = computed(() => services.value.find((s) => s.name === selectedService.value) || null);
const upstreamDeps = computed(() => selectedSvcData.value?.dependsOn || []);
const downstreamDeps = computed(() => services.value.filter((s) => s.dependsOn.includes(selectedService.value)).map((s) => s.name));

const graphNodes = computed(() =>
  services.value.map((svc) => ({
    key: svc.name,
    label: svc.name,
    fullLabel: svc.name,
    sub: svc.ports.length ? `端口 ${svc.ports[0]}` : svcStateLabel(svc),
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
  // 力模拟会在此基础上松弛成自然形态。
  // 跨项目时不同项目的同层服务会算出相同坐标,确定性错开,避免出生点重叠。
  const levels = assignLevels(services.value);
  const maxLevel = Math.max(0, ...levels.map((l) => l.level));
  const left = 220;
  const right = 1100;
  const seen = new Map();
  const map = {};
  for (const item of levels) {
    const slot = `${item.level}:${item.index}`;
    const dup = seen.get(slot) || 0;
    seen.set(slot, dup + 1);
    map[item.name] = {
      x: (maxLevel === 0 ? 600 : left + (item.level / maxLevel) * (right - left)) + dup * 96,
      y: 350 + (item.index - (item.count - 1) / 2) * 110 + (dup ? (dup % 2 ? 1 : -1) * Math.ceil(dup / 2) * 84 : 0),
    };
  }
  return map;
});

function toggleService(key) {
  selectedService.value = selectedService.value === key ? '' : key;
}

function svcState(svc) {
  const projectData = crossProject.value ? store.projects.find((p) => p.id === svc.projectId) : project.value;
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
function svcStateClassDot(svc) {
  const s = svcState(svc);
  return { running: 'bg-emerald-400', unhealthy: 'bg-amber-400', stopped: 'bg-rose-400', none: 'bg-surface-500' }[s] || 'bg-surface-500';
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
  selectedService.value = '';
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

/* iOS 浮动抽屉/检测器卡片 */
.ios-inspector-card {
  position: absolute;
  top: 72px;
  right: 16px;
  width: 320px;
  max-width: calc(100% - 32px);
  padding: 16px;
  border-radius: 18px;
  background: rgba(15, 23, 42, 0.88);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  z-index: 20;
}

.ios-tag-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 10px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.09);
  color: #E2E8F0;
  transition: all 0.18s ease;
}
.ios-tag-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #FFFFFF;
}

/* 动效 */
.ios-sheet-enter-active,
.ios-sheet-leave-active {
  transition: all 0.24s cubic-bezier(0.16, 1, 0.3, 1);
}
.ios-sheet-enter-from,
.ios-sheet-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.96);
}
</style>
