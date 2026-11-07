<template>
  <div class="page-shell">
    <header class="page-header">
      <div><h1 class="page-title">成本分析</h1><p class="page-subtitle">看清资源去向，发现可以释放的空间</p></div>
      <div class="page-actions">
        <button class="btn-secondary" :disabled="loading" @click="refreshData"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button>
        <button class="btn-primary" :disabled="loading" @click="recordSnapshot"><Camera class="h-4 w-4" />记录快照</button>
      </div>
    </header>
    <div v-if="error" class="alert-error flex items-center justify-between gap-3" role="alert"><span>{{ error }}</span><button class="btn-secondary btn-sm" :disabled="loading" @click="loadReport">重试</button></div>
    <Skeleton v-if="loading && !report" variant="cards" :rows="6" label="成本数据加载中" />
    <template v-if="report">
      <section class="grid grid-cols-2 gap-3 xl:grid-cols-3" aria-label="资源概况">
        <MetricTile title="项目" :value="report.summary.totalProjects" :icon="Boxes" sub="当前节点已发现" to="/services?from=cost" />
        <MetricTile title="容器" :value="report.summary.totalContainers" :sub="`运行中 ${report.summary.runningContainers}`" :icon="Container" to="/services?from=cost" />
        <MetricTile title="CPU 使用" :value="`${numberValue(report.summary.totalCPUPercent).toFixed(1)}%`" :icon="Cpu" to="/monitor?from=cost" />
        <MetricTile title="内存使用" :value="formatSize(report.summary.totalMemoryMB)" :icon="MemoryStick" to="/monitor?from=cost" />
        <MetricTile title="镜像占用" :value="formatSize(report.summary.totalImagesMB)" :icon="Layers" to="/resources?tab=images&from=cost" />
        <MetricTile title="可回收空间" :value="formatSize(report.summary.reclaimableMB)" :icon="HardDrive" tone="text-status-ok" sub="查看资源后选择清理" to="/resources?from=cost" />
      </section>
      <section class="section-panel space-y-4">
        <div class="flex items-center justify-between"><h2 class="section-title">优化建议</h2><span class="count-badge">{{ suggestions.length }} 项</span></div>
        <div v-if="suggestions.length" class="grid gap-3 lg:grid-cols-2">
          <article v-for="(suggestion, index) in suggestions" :key="index" class="panel-card space-y-3">
            <div class="flex flex-wrap items-center gap-2"><RiskBadge :risk="suggestion.severity" /><h3 class="text-sm font-medium text-surface-100">{{ suggestion.title }}</h3></div>
            <p class="text-sm leading-6 text-surface-300">{{ suggestion.description }}</p>
            <p class="text-muted">建议：{{ suggestion.action }}</p>
          </article>
        </div>
        <EmptyState v-else compact icon="CircleCheckBig" title="当前没有优化建议" description="记录快照可以持续观察资源变化。" action-label="记录快照" :action-disabled="loading" @action="recordSnapshot" />
      </section>
      <section class="section-panel space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2"><h2 class="section-title">近 7 天资源趋势</h2><span class="text-muted">{{ report.trends?.length || 0 }} 个快照 · 各图独立刻度</span></div>
        <div v-if="report.trends?.length > 1" class="grid gap-4 md:grid-cols-2">
          <figure v-for="series in trendSeries" :key="series.title" class="rounded-xl border border-surface-800 bg-surface-950/50 p-4" :aria-label="`${series.title}，最新 ${series.latest}，峰值 ${series.peak}`">
            <figcaption class="mb-4 flex items-center justify-between gap-3 text-sm"><span class="text-surface-300">{{ series.title }}</span><span class="font-mono text-surface-100">{{ series.latest }}</span></figcaption>
            <SparklineChart :cpu="series.cpu" :mem="series.mem" :cpu-threshold="Infinity" :mem-threshold="Infinity" :width="600" :height="100" class="w-full" />
            <div class="mt-3 flex justify-between text-muted"><span>{{ trendStart }}</span><span>峰值 {{ series.peak }}</span><span>{{ trendEnd }}</span></div>
          </figure>
        </div>
        <EmptyState v-else compact icon="History" title="再记录一个快照，即可查看趋势" description="趋势来自真实资源快照，便于比较变更前后的资源占用。" action-label="记录快照" :action-disabled="loading" @action="recordSnapshot" />
      </section>
      <div class="grid gap-5 xl:grid-cols-2">
        <section class="section-panel min-w-0 space-y-4">
          <h2 class="section-title">项目资源排行</h2>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>项目</th><th>容器</th><th>CPU</th><th>内存</th></tr></thead><tbody>
            <tr v-for="project in report.projects" :key="project.projectId"><td><router-link :to="deepLink('/services', { focus: project.projectId, from: 'cost' })" class="text-status-info hover:underline">{{ project.projectName }}</router-link></td><td>{{ project.runningCount }} / {{ project.containerCount }}</td><td>{{ numberValue(project.totalCPUPercent).toFixed(1) }}%</td><td class="whitespace-nowrap">{{ formatSize(project.totalMemoryMB) }}</td></tr>
            <tr v-if="!report.projects.length"><td colspan="4"><EmptyState compact icon="Boxes" title="暂无项目数据" description="先纳管一个项目，便可查看其资源占用。"><router-link to="/services?from=cost" class="btn-secondary btn-sm">查看服务</router-link></EmptyState></td></tr>
          </tbody></table></div>
        </section>
        <section class="section-panel min-w-0 space-y-4">
          <h2 class="section-title">占用最大的 10 个镜像</h2>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>镜像</th><th>大小</th></tr></thead><tbody>
            <tr v-for="image in report.images.slice(0, 10)" :key="image.id"><td class="max-w-64 truncate" :title="image.tags?.[0] || image.id">{{ image.tags?.[0] || image.id }}</td><td class="whitespace-nowrap">{{ formatSize(image.sizeMB) }}</td></tr>
            <tr v-if="!report.images.length"><td colspan="2"><EmptyState compact title="暂无镜像数据" description="可前往资源页检查当前节点的镜像。"><router-link to="/resources?from=cost" class="btn-secondary btn-sm">查看资源</router-link></EmptyState></td></tr>
          </tbody></table></div>
        </section>
      </div>
      <section class="section-panel space-y-4">
        <div class="flex items-center justify-between gap-3"><h2 class="section-title">存储分布</h2><router-link to="/resources?from=cost" class="btn-ghost btn-sm">管理存储<ArrowUpRight class="h-4 w-4" /></router-link></div>
        <div class="grid grid-cols-2 gap-3 xl:grid-cols-4"><MetricTile v-for="item in storageItems" :key="item.key" :title="item.label" :value="formatSize(report.storage[item.key]?.sizeMB)" :sub="item.key === 'buildCache' ? `可回收 ${formatSize(report.storage[item.key]?.reclaimableMB)}` : `${report.storage[item.key]?.active || 0} 使用中 / ${report.storage[item.key]?.total || 0} 总数`" /></div>
      </section>
    </template>
  </div>
</template>
<script setup>
import { computed, onActivated, onMounted, ref } from 'vue';
import { ArrowUpRight, Boxes, Camera, Container, Cpu, HardDrive, Layers, MemoryStick, RefreshCw } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { deepLink } from '../lib/deep-links.js';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useToastStore } from '../stores/toast.js';
import MetricTile from '../components/common/MetricTile.vue';
import SparklineChart from '../components/common/SparklineChart.vue';
import Skeleton from '../components/common/Skeleton.vue';
import EmptyState from '../components/common/EmptyState.vue';
import RiskBadge from '../components/common/RiskBadge.vue';
const toast = useToastStore();
const loading = ref(false); const error = ref(''); const report = ref(null); const suggestions = ref([]);
const storageItems = [{ key: 'images', label: '镜像' }, { key: 'containers', label: '容器' }, { key: 'volumes', label: '卷' }, { key: 'buildCache', label: '构建缓存' }];
function numberValue(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function formatSize(mb) { return numberValue(mb) >= 1024 ? `${(numberValue(mb) / 1024).toFixed(1)} GB` : `${Math.round(numberValue(mb))} MB`; }
const trendSeries = computed(() => {
  const cpu = (report.value?.trends || []).map(item => numberValue(item.totalCPUPercent));
  const mem = (report.value?.trends || []).map(item => numberValue(item.totalMemoryMB));
  return [{ title: 'CPU 使用', cpu, mem: [], latest: `${(cpu.at(-1) || 0).toFixed(1)}%`, peak: `${Math.max(0, ...cpu).toFixed(1)}%` }, { title: '内存使用', cpu: [], mem, latest: formatSize(mem.at(-1)), peak: formatSize(Math.max(0, ...mem)) }];
});
function trendDate(item) { const date = new Date(item?.timestamp || item?.createdAt || item?.date || ''); return Number.isNaN(date.getTime()) ? '快照' : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }); }
const trendStart = computed(() => trendDate(report.value?.trends?.[0]));
const trendEnd = computed(() => trendDate(report.value?.trends?.at(-1)));
async function loadReport() {
  if (loading.value) return false;
  loading.value = true; error.value = '';
  try { const [data, advice, trends] = await Promise.all([api.getCostAnalysisReport(), api.getCostSuggestions(), api.getCostTrends()]); report.value = { ...data, trends }; suggestions.value = Array.isArray(advice) ? advice : advice?.suggestions || []; return true; }
  catch (err) { error.value = err.message; return false; }
  finally { loading.value = false; }
}
async function refreshData() { if (await loadReport()) toast.success('数据已刷新'); }
async function recordSnapshot() {
  if (loading.value) return;
  loading.value = true;
  try { await api.recordCostSnapshot(); toast.success('成本快照已记录'); }
  catch (err) { toast.error(err); }
  finally { loading.value = false; }
  await loadReport();
}
usePullRefresh(loadReport, { keepAlive: true });
onMounted(loadReport);
let activatedOnce = false;
onActivated(() => { if (!activatedOnce) { activatedOnce = true; return; } void loadReport(); });
</script>
