<template>
  <div class="cost-analysis-view">
    <header class="page-header">
      <div>
        <h1>成本分析</h1>
        <p class="page-subtitle">项目/镜像/存储维度的资源与成本画像</p>
      </div>
      <div class="page-actions page-actions-cost">
        <button @click="refreshData" :disabled="loading" class="btn-secondary btn-refresh">
          <span class="icon">↻</span>
          刷新
        </button>
        <button @click="recordSnapshot" :disabled="loading" class="btn-primary">
          记录快照
        </button>
      </div>
    </header>

    <div v-if="loading && !report" class="loading-state">
      <div class="spinner"></div>
      <p>加载成本数据...</p>
    </div>

    <div v-else-if="error" class="error-state">
      <p>{{ error }}</p>
      <button @click="refreshData" class="btn-secondary btn-retry">重试</button>
    </div>

    <div v-else-if="report" class="content">
      <!-- 汇总卡片 -->
      <section class="summary-grid">
        <div class="stat-card">
          <div class="label">总项目数</div>
          <div class="value">{{ report.summary.totalProjects }}</div>
        </div>
        <div class="stat-card">
          <div class="label">容器总数</div>
          <div class="value">{{ report.summary.totalContainers }}</div>
          <div class="sub">运行中: {{ report.summary.runningContainers }}</div>
        </div>
        <div class="stat-card">
          <div class="label">CPU 使用</div>
          <div class="value">{{ numberValue(report.summary.totalCPUPercent).toFixed(1) }}%</div>
        </div>
        <div class="stat-card">
          <div class="label">内存使用</div>
          <div class="value">{{ formatSize(report.summary.totalMemoryMB) }}</div>
        </div>
        <div class="stat-card">
          <div class="label">镜像占用</div>
          <div class="value">{{ formatSize(report.summary.totalImagesMB) }}</div>
        </div>
        <div class="stat-card highlight">
          <div class="label">可回收空间</div>
          <div class="value">{{ formatSize(report.summary.reclaimableMB) }}</div>
        </div>
      </section>

      <!-- 优化建议 -->
      <section v-if="suggestions.length > 0" class="suggestions-section">
        <h2>优化建议</h2>
        <div class="suggestion-list">
          <div
            v-for="(sug, idx) in suggestions"
            :key="idx"
            class="suggestion-item"
            :class="`severity-${sug.severity}`"
          >
            <div class="sug-header">
              <span class="severity-badge">{{ severityLabel(sug.severity) }}</span>
              <h3>{{ sug.title }}</h3>
            </div>
            <p class="description">{{ sug.description }}</p>
            <p class="action"><strong>建议:</strong> {{ sug.action }}</p>
          </div>
        </div>
      </section>

      <!-- 趋势图 -->
      <section v-if="report.trends.length > 1" class="trends-section">
        <h2>资源趋势 (7天)</h2>
        <div class="trend-chart">
          <svg :viewBox="`0 0 ${chartWidth} ${chartHeight}`" class="chart-svg">
            <g class="grid-lines">
              <line
                v-for="i in 5"
                :key="`h-${i}`"
                :x1="chartPadding"
                :y1="chartPadding + ((chartHeight - chartPadding * 2) / 4) * (i - 1)"
                :x2="chartWidth - chartPadding"
                :y2="chartPadding + ((chartHeight - chartPadding * 2) / 4) * (i - 1)"
                stroke="var(--track-line-2)"
                stroke-width="1"
              />
            </g>
            <polyline
              :points="memoryTrendPoints"
              fill="none"
              stroke="var(--cost-accent)"
              stroke-width="2"
            />
            <polyline
              :points="cpuTrendPoints"
              fill="none"
              stroke="var(--cost-accent-2)"
              stroke-width="2"
            />
          </svg>
          <div class="legend">
            <div class="legend-item">
              <span class="line" style="background: var(--cost-accent)"></span>
              内存使用
            </div>
            <div class="legend-item">
              <span class="line" style="background: var(--cost-accent-2)"></span>
              CPU 使用
            </div>
          </div>
        </div>
      </section>

      <!-- 项目成本排行 -->
      <section class="projects-section">
        <h2>项目成本排行</h2>
        <div class="table-container">
          <table class="projects-table">
            <thead>
              <tr>
                <th>项目</th>
                <th>容器数</th>
                <th>运行中</th>
                <th>CPU 使用</th>
                <th>内存使用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="proj in report.projects" :key="proj.projectId">
                <td class="project-name">{{ proj.projectName }}</td>
                <td>{{ proj.containerCount }}</td>
                <td>{{ proj.runningCount }}</td>
        <td>{{ numberValue(proj.totalCPUPercent).toFixed(1) }}%</td>
                <td>{{ formatSize(proj.totalMemoryMB) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 大镜像列表 -->
      <section class="images-section">
        <h2>大镜像 TOP 10</h2>
        <div class="table-container">
          <table class="images-table">
            <thead>
              <tr>
                <th>镜像标签</th>
                <th>大小</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="img in report.images.slice(0, 10)" :key="img.id">
                <td class="image-tag">{{ img.tags[0] }}</td>
                <td>{{ formatSize(img.sizeMB) }}</td>
                <td class="image-id">{{ img.id }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 存储分布 -->
      <section class="storage-section">
        <h2>存储分布</h2>
        <div class="storage-grid">
          <div class="storage-card">
            <h3>镜像</h3>
            <div class="stat-row">
              <span>总数</span>
              <span>{{ report.storage.images.total }}</span>
            </div>
            <div class="stat-row">
              <span>使用中</span>
              <span>{{ report.storage.images.active }}</span>
            </div>
            <div class="stat-row">
              <span>占用</span>
              <span>{{ formatSize(report.storage.images.sizeMB) }}</span>
            </div>
            <div class="stat-row highlight">
              <span>可回收</span>
              <span>{{ formatSize(report.storage.images.reclaimableMB) }}</span>
            </div>
          </div>
          <div class="storage-card">
            <h3>容器</h3>
            <div class="stat-row">
              <span>总数</span>
              <span>{{ report.storage.containers.total }}</span>
            </div>
            <div class="stat-row">
              <span>运行中</span>
              <span>{{ report.storage.containers.active }}</span>
            </div>
            <div class="stat-row">
              <span>占用</span>
              <span>{{ formatSize(report.storage.containers.sizeMB) }}</span>
            </div>
          </div>
          <div class="storage-card">
            <h3>卷</h3>
            <div class="stat-row">
              <span>总数</span>
              <span>{{ report.storage.volumes.total }}</span>
            </div>
            <div class="stat-row">
              <span>使用中</span>
              <span>{{ report.storage.volumes.active }}</span>
            </div>
            <div class="stat-row">
              <span>占用</span>
              <span>{{ formatSize(report.storage.volumes.sizeMB) }}</span>
            </div>
          </div>
          <div class="storage-card">
            <h3>构建缓存</h3>
            <div class="stat-row">
              <span>占用</span>
              <span>{{ formatSize(report.storage.buildCache.sizeMB) }}</span>
            </div>
            <div class="stat-row highlight">
              <span>可回收</span>
              <span>{{ formatSize(report.storage.buildCache.reclaimableMB) }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onActivated, onMounted } from 'vue';
import { api } from '../api/client.js';
import { useToastStore } from '../stores/toast.js';

const toast = useToastStore();

const loading = ref(false);
const error = ref('');
const report = ref(null);
const suggestions = ref([]);

const chartWidth = 800;
const chartHeight = 300;
const chartPadding = 40;

async function loadReport() {
  loading.value = true;
  error.value = '';
  try {
    const [reportData, sugData] = await Promise.all([
      api.getCostAnalysisReport(),
      api.getCostSuggestions()
    ]);
    report.value = reportData;
    suggestions.value = sugData;
  } catch (err) {
    error.value = err.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

async function refreshData() {
  await loadReport();
  toast.success('数据已刷新');
}

async function recordSnapshot() {
  loading.value = true;
  try {
    await fetch('/api/v1/cost-analysis/snapshot', { method: 'POST' });
    toast.success('成本快照已记录');
    await loadReport();
  } catch (err) {
    toast.error(err.message || '记录快照失败');
  } finally {
    loading.value = false;
  }
}

function formatSize(mb) {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}
function numberValue(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }

function severityLabel(s) {
  const map = { high: '高', medium: '中', low: '低' };
  return map[s] || s;
}

const memoryTrendPoints = computed(() => {
  if (!report.value || report.value.trends.length < 2) return '';
  const trends = report.value.trends;
  const maxMem = Math.max(...trends.map(t => numberValue(t.totalMemoryMB))) || 1;
  const stepX = (chartWidth - chartPadding * 2) / (trends.length - 1);
  return trends
    .map((t, i) => {
      const x = chartPadding + i * stepX;
      const y = chartHeight - chartPadding - ((numberValue(t.totalMemoryMB) / maxMem) * (chartHeight - chartPadding * 2));
      return `${x},${y}`;
    })
    .join(' ');
});

const cpuTrendPoints = computed(() => {
  if (!report.value || report.value.trends.length < 2) return '';
  const trends = report.value.trends;
  const maxCpu = Math.max(...trends.map(t => numberValue(t.totalCPUPercent))) || 1;
  const stepX = (chartWidth - chartPadding * 2) / (trends.length - 1);
  return trends
    .map((t, i) => {
      const x = chartPadding + i * stepX;
      const y = chartHeight - chartPadding - ((numberValue(t.totalCPUPercent) / maxCpu) * (chartHeight - chartPadding * 2));
      return `${x},${y}`;
    })
    .join(' ');
});

onMounted(() => {
  loadReport();
});
let activatedOnce = false;
onActivated(() => { if (!activatedOnce) { activatedOnce = true; return; } void loadReport(); });

</script>

<style scoped>
@reference '../style.css';
/* 页面级配色/按钮/页眉改用全站 token(surface / accent / btn / page-header / card / data-table),
   scoped 内只保留本页布局与局部语义类的微调。 */
.cost-analysis-view {
  /* 图表用色:主折线 = 全站 accent,次折线 = emerald(与全站状态色系一致) */
  --cost-accent: #2563eb; /* = accent DEFAULT */
  --cost-accent-2: #34d399; /* = emerald-400 */
}

.page-actions-cost { @apply flex items-center gap-3; }

/* 统计卡片:在全站 .panel-card 基础上微调内边距 */
.stat-card { @apply panel-card !p-5; }
.stat-card.highlight { @apply border-accent/60 bg-accent/5; }
.stat-card .label { @apply mb-2 text-[13px] text-surface-400; }
.stat-card .value { @apply text-3xl font-semibold tracking-tight text-surface-50; }
.stat-card .sub { @apply mt-1 text-xs text-surface-500; }

.loading-state,
.error-state { @apply grid min-h-[60vh] place-items-center text-center text-surface-400; }

.spinner {
  width: 3rem;
  height: 3rem;
  border: 3px solid theme('colors.surface.800');
  border-top-color: theme('colors.accent.DEFAULT');
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.content { display: grid; gap: clamp(1.5rem, 3vw, 2.5rem); }

.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 1rem;
}

/* 区块容器:全站 section-panel 微调 */
.suggestions-section,
.trends-section,
.projects-section,
.images-section,
.storage-section { @apply section-panel p-5! sm:!p-6; }

section h2 { @apply section-title mb-5 !text-lg; }

.suggestion-list { display: grid; gap: 1rem; }

.suggestion-item { @apply rounded-xl border border-surface-800 bg-surface-950/40 p-4; }
.suggestion-item.severity-high { border-left: 3px solid theme('colors.rose.500'); }
.suggestion-item.severity-medium { border-left: 3px solid theme('colors.amber.500'); }
.suggestion-item.severity-low { border-left: 3px solid theme('colors.emerald.500'); }

.sug-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }

.severity-badge { @apply inline-block rounded-full bg-surface-800 px-2.5 py-1 text-xs font-semibold text-surface-400; }

.suggestion-item h3 { @apply m-0 text-[15px] font-medium text-surface-100; }
.suggestion-item .description { @apply my-2 text-sm text-surface-400; }
.suggestion-item .action { @apply m-0 text-sm text-surface-200; }

.trend-chart { margin-top: 1rem; }
.chart-svg { width: 100%; height: auto; max-width: 100%; }

.legend { display: flex; justify-content: center; gap: 2rem; margin-top: 1rem; }
.legend-item { @apply flex items-center gap-2 text-sm text-surface-400; }
.legend-item .line { width: 1.5rem; height: 2px; border-radius: 2px; }

/* 表格:直接复用全站 data-table 体系 */
.table-container { @apply table-wrap mt-4; }
table { @apply data-table; }
.project-name, .image-tag { @apply font-medium text-accent; }
.image-id { @apply font-mono text-[13px] text-surface-500; }

.storage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-top: 1rem;
}
.storage-card { @apply rounded-xl border border-surface-800 bg-surface-950/40 p-4; }
.storage-card h3 { @apply mb-4 text-[15px] font-medium text-surface-100; }

.stat-row { @apply flex justify-between border-b border-surface-800 py-2 text-sm text-surface-300; }
.stat-row:last-child { border-bottom: none; }
.stat-row.highlight { @apply font-medium text-accent; }
</style>
