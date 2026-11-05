# ComposeOps 后续改进路线图
> **归档说明（2026-11-05）**：本文是早期版本的构想路线图，仅保留作历史决策背景。文中“当前问题”“未完成”“计划版本”只代表当时判断，**不代表 2026-11-05 的实际代码状态，也不构成当前待办或验收标准**。后续已有大量能力在代码、`CHANGELOG.md` 和 `PROJECT_CONTEXT.md` 中落地。当前实现以默认分支代码和 `CHANGELOG.md` 为准；验收状态以 `docs/public/RELEASE_CHECKLIST.md` 为准。
>
> 新的功能需求应先核对当前代码和真实用户痛点，不得仅因为本文存在未勾选项就重新开发同类功能。
>

> **版本**: v1.1.0 → v2.0.0  
> **更新时间**: 2026-09-05  
> **目标**: 打造业界领先的轻量级 Docker Compose 运维面板

---

## 📋 改进概览

基于已完成的 InteractiveChart 集成，后续改进分为**四个阶段**，涵盖数据层、交互层、智能化和生态集成：

```
Phase 1: 数据层增强 (1-2 周)
├─ 真实历史指标存储与查询
├─ 异常检测与预警
└─ 性能优化与数据压缩

Phase 2: 交互体验升级 (2-3 周)
├─ 高级图表交互
├─ 仪表盘定制化
└─ 响应式与无障碍优化

Phase 3: 智能化增强 (2-3 周)
├─ AI 驱动的异常诊断
├─ 预测性维护
└─ 自动化运维建议

Phase 4: 生态集成与扩展 (3-4 周)
├─ 多节点集群支持
├─ Prometheus/Grafana 集成
└─ 插件系统与第三方集成
```

---

## 🎯 Phase 1: 数据层增强

### 1.1 真实历史指标存储与查询

**当前问题**:
- `chartData` 使用模拟数据，无法反映真实历史
- 前端 localStorage 存储不稳定，数据易丢失
- 缺少历史数据查询 API

**改进方案**:

#### 1.1.1 后端：指标历史 API 实现

**文件**: `backend/src/routes/metrics.js` (新建)

```javascript
// GET /api/v1/metrics/:containerId/history
// 查询参数:
// - metric: cpu | memory | network | disk
// - from: timestamp (毫秒)
// - to: timestamp (毫秒)
// - resolution: auto | 2s | 10s | 1m | 5m (数据聚合粒度)

export async function getMetricHistory(containerId, metric, from, to, resolution) {
  // 1. 从 SQLite metrics 表查询原始数据
  // 2. 根据 resolution 聚合（平均值/最大值）
  // 3. 返回 [{timestamp, value}] 数组
}
```

**数据库表优化** (`backend/src/db.js`):

```sql
-- 已有 metrics 表，添加索引优化查询性能
CREATE INDEX IF NOT EXISTS idx_metrics_container_timestamp 
  ON metrics(container_id, timestamp DESC);

-- 新增聚合视图表（可选，用于快速查询大时间范围）
CREATE TABLE IF NOT EXISTS metrics_hourly (
  container_id TEXT,
  metric_type TEXT,
  hour_timestamp INTEGER,
  avg_value REAL,
  max_value REAL,
  min_value REAL,
  PRIMARY KEY (container_id, metric_type, hour_timestamp)
);
```

**数据保留策略**:
```javascript
// backend/src/services/stats.js
const RETENTION_POLICY = {
  raw: 24 * 3600 * 1000,      // 原始数据保留 24 小时
  hourly: 7 * 24 * 3600 * 1000, // 小时聚合保留 7 天
  daily: 30 * 24 * 3600 * 1000  // 日聚合保留 30 天
};
```

#### 1.1.2 前端：集成真实数据

**文件**: `frontend/src/views/ResourceMonitorView.vue`

```javascript
// 替换模拟数据
const chartData = computed(() => {
  const metric = metricsData.value?.[selectedMetric.value];
  if (!metric?.history) return [];
  
  // history 来自 API: [{timestamp, value}]
  return metric.history;
});

// 添加时间范围选择
const timeRange = ref('1h'); // 1h | 6h | 24h | 7d
const timeRanges = [
  { key: '1h', label: '最近 1 小时', ms: 3600000 },
  { key: '6h', label: '最近 6 小时', ms: 6 * 3600000 },
  { key: '24h', label: '最近 24 小时', ms: 24 * 3600000 },
  { key: '7d', label: '最近 7 天', ms: 7 * 24 * 3600000 }
];

// 定时刷新历史数据
watchEffect(() => {
  if (!containerId.value) return;
  
  const range = timeRanges.find(r => r.key === timeRange.value);
  const to = Date.now();
  const from = to - range.ms;
  
  metricsApi.getHistory(containerId.value, selectedMetric.value, from, to)
    .then(data => {
      // 更新 metricsData
    });
});
```

**预期效果**:
- ✅ 图表显示真实历史数据（24 小时内 2 秒粒度，更长时间自动聚合）
- ✅ 支持时间范围切换（1h/6h/24h/7d）
- ✅ 数据持久化到 SQLite，不依赖浏览器存储

---

### 1.2 异常检测与智能预警

**当前问题**:
- `chartAnomalies` 返回空数组，无异常标记
- 告警仅基于固定阈值，误报率高
- 缺少趋势预测

**改进方案**:

#### 1.2.1 后端：异常检测算法

**文件**: `backend/src/services/anomaly-detector.js` (新建)

```javascript
/**
 * 基于统计学的异常检测
 * 算法: Z-Score + 移动平均 + 趋势分析
 */
export class AnomalyDetector {
  /**
   * 检测异常数据点
   * @param {Array} timeseries - [{timestamp, value}]
   * @param {Object} options - { sensitivity: 1-3, windowSize: 20 }
   * @returns {Array} - [{start, end, severity, reason}]
   */
  detectAnomalies(timeseries, options = {}) {
    const { sensitivity = 2, windowSize = 20 } = options;
    const anomalies = [];
    
    // 1. 计算移动平均和标准差
    const stats = this.computeMovingStats(timeseries, windowSize);
    
    // 2. Z-Score 检测突变
    for (let i = windowSize; i < timeseries.length; i++) {
      const { value, timestamp } = timeseries[i];
      const { mean, stdDev } = stats[i - windowSize];
      
      const zScore = Math.abs((value - mean) / stdDev);
      
      if (zScore > sensitivity) {
        anomalies.push({
          start: timestamp,
          end: timestamp + 2000, // 单点异常
          severity: zScore > 3 ? 'high' : 'medium',
          reason: value > mean ? 'spike' : 'drop',
          value,
          baseline: mean
        });
      }
    }
    
    // 3. 合并连续异常
    return this.mergeConsecutiveAnomalies(anomalies);
  }
  
  /**
   * 趋势预测（线性回归）
   */
  predictTrend(timeseries, horizonMs = 3600000) {
    // 简单线性回归预测未来 1 小时趋势
    // 返回: { slope, intercept, predictedMax }
  }
}
```

#### 1.2.2 前端：异常可视化

**文件**: `frontend/src/views/ResourceMonitorView.vue`

```javascript
const chartAnomalies = computed(() => {
  const metric = metricsData.value?.[selectedMetric.value];
  if (!metric?.anomalies) return [];
  
  // anomalies 来自后端 API
  return metric.anomalies.map(a => ({
    start: a.start,
    end: a.end,
    severity: a.severity, // low | medium | high
    label: a.reason === 'spike' ? '⚠️ 峰值' : '⚠️ 骤降'
  }));
});

// 添加异常详情面板
const selectedAnomaly = ref(null);

function onAnomalyClick(anomaly) {
  selectedAnomaly.value = anomaly;
  // 显示详情：时间、原因、建议操作
}
```

**预期效果**:
- ✅ 自动检测 CPU 飙升、内存泄漏、网络抖动
- ✅ 异常区域用红色图案填充标记
- ✅ 点击异常查看详情（时间、原因、建议）
- ✅ 降低误报率（基于历史基线）

---

### 1.3 性能优化与数据压缩

**问题**:
- 大时间范围查询返回数据过大（7 天 × 43200 个点）
- WebSocket 推送频率过高（2 秒）可能影响低配服务器

**改进方案**:

#### 1.3.1 自适应数据聚合

```javascript
// backend/src/routes/metrics.js
function calculateResolution(from, to) {
  const duration = to - from;
  
  if (duration <= 3600000) return 2000;        // 1 小时内: 2 秒
  if (duration <= 6 * 3600000) return 10000;   // 6 小时内: 10 秒
  if (duration <= 24 * 3600000) return 60000;  // 24 小时内: 1 分钟
  return 300000;                                // 更长: 5 分钟
}
```

#### 1.3.2 增量更新

```javascript
// frontend/src/composables/useMetricsHistory.js
export function useMetricsHistory(containerId, metric, timeRange) {
  const data = ref([]);
  let lastFetch = 0;
  
  async function fetchIncremental() {
    const now = Date.now();
    const from = lastFetch || (now - timeRange.value);
    
    const newData = await metricsApi.getHistory(containerId, metric, from, now);
    
    // 追加新数据，移除过期数据
    data.value = [...data.value, ...newData]
      .filter(d => d.timestamp > now - timeRange.value)
      .sort((a, b) => a.timestamp - b.timestamp);
    
    lastFetch = now;
  }
  
  // 每 10 秒增量拉取
  const timer = setInterval(fetchIncremental, 10000);
  
  onUnmounted(() => clearInterval(timer));
  
  return { data };
}
```

**预期效果**:
- ✅ 7 天历史查询从 43200 点降至 ~2000 点
- ✅ 减少 95% 的数据传输量
- ✅ 前端更新延迟从 2 秒降至 10 秒（不影响体验）

---

## 🎨 Phase 2: 交互体验升级

### 2.1 高级图表交互

**新功能列表**:

#### 2.1.1 图表联动

**场景**: 在 CPU 图表上选择时间范围，其他指标图表（内存/网络/磁盘）自动对齐

**实现** (`frontend/src/views/ResourceMonitorView.vue`):

```javascript
// 全局时间选择器
const globalTimeSelection = ref(null);

function onChartBrushEnd(selection) {
  if (!selection) return;
  
  globalTimeSelection.value = {
    start: selection.start,
    end: selection.end
  };
  
  // 所有图表组件监听此值并更新 x 轴范围
}
```

#### 2.1.2 多容器对比视图

**文件**: `frontend/src/components/charts/ComparisonChart.vue` (新建)

```vue
<template>
  <div class="comparison-chart">
    <InteractiveChart
      :data="mergedData"
      :series="containerSeries"
      :anomalies="[]"
      title="容器对比"
    />
  </div>
</template>

<script setup>
// 支持选择多个容器，在同一图表叠加显示
// 每个容器用不同颜色区分
const containerSeries = computed(() => [
  { id: 'container-1', label: 'Web', color: '#06B6D4', data: [...] },
  { id: 'container-2', label: 'DB', color: '#10B981', data: [...] }
]);
</script>
```

#### 2.1.3 导出与分享

```javascript
// 功能按钮
const chartActions = [
  { icon: Download, label: '导出 PNG', action: exportChart },
  { icon: Share, label: '分享链接', action: shareChart },
  { icon: Code, label: '导出数据 (CSV)', action: exportCSV }
];

function exportChart() {
  // 使用 html2canvas 或 SVG 导出
}

function shareChart() {
  // 生成短链接，包含时间范围和指标类型
  const url = `${location.origin}/metrics/${containerId}?metric=${metric}&from=${from}&to=${to}`;
  navigator.clipboard.writeText(url);
}
```

**预期效果**:
- ✅ 多图表时间范围联动
- ✅ 同一图表对比多个容器
- ✅ 一键导出图表 PNG/CSV
- ✅ 分享链接直达特定时间范围

---

### 2.2 仪表盘定制化

**当前问题**:
- 资源监控视图布局固定，无法调整
- 缺少自定义仪表盘功能

**改进方案**:

#### 2.2.1 拖拽式仪表盘编辑器

**文件**: `frontend/src/views/CustomDashboardView.vue` (新建)

```vue
<template>
  <div class="custom-dashboard">
    <div class="dashboard-toolbar">
      <button @click="toggleEditMode">{{ editMode ? '保存布局' : '编辑布局' }}</button>
      <button @click="addWidget">添加组件</button>
    </div>
    
    <GridLayout
      v-model="layout"
      :col-num="12"
      :row-height="60"
      :is-draggable="editMode"
      :is-resizable="editMode"
    >
      <GridItem
        v-for="item in layout"
        :key="item.i"
        :x="item.x"
        :y="item.y"
        :w="item.w"
        :h="item.h"
      >
        <DashboardWidget
          :type="item.type"
          :config="item.config"
          @remove="removeWidget(item.i)"
        />
      </GridItem>
    </GridLayout>
  </div>
</template>

<script setup>
import { GridLayout, GridItem } from 'vue-grid-layout';
import DashboardWidget from '../components/dashboard/DashboardWidget.vue';

// 支持的组件类型
const widgetTypes = [
  { type: 'metric-chart', label: '指标图表', icon: ChartLine },
  { type: 'status-card', label: '状态卡片', icon: Activity },
  { type: 'alert-list', label: '告警列表', icon: Bell },
  { type: 'container-list', label: '容器列表', icon: Box },
  { type: 'log-stream', label: '日志流', icon: Terminal }
];

// 布局持久化到 localStorage
const layout = useLocalStorage('dashboard-layout', [
  { i: '1', x: 0, y: 0, w: 6, h: 4, type: 'metric-chart', config: { metric: 'cpu' } },
  { i: '2', x: 6, y: 0, w: 6, h: 4, type: 'metric-chart', config: { metric: 'memory' } }
]);
</script>
```

**依赖**: `npm install vue-grid-layout`

#### 2.2.2 组件库

**文件**: `frontend/src/components/dashboard/widgets/` (新目录)

- `MetricChartWidget.vue` - 指标图表组件
- `StatusCardWidget.vue` - 状态卡片（运行/停止容器数）
- `AlertListWidget.vue` - 最近告警列表
- `ContainerListWidget.vue` - 容器列表（快速操作）
- `LogStreamWidget.vue` - 实时日志流（迷你版）

#### 2.2.3 预设模板

```javascript
const dashboardTemplates = [
  {
    id: 'overview',
    name: '总览仪表盘',
    layout: [
      // CPU/内存/网络/磁盘 2x2 布局 + 告警列表
    ]
  },
  {
    id: 'performance',
    name: '性能分析',
    layout: [
      // 大图表 + 异常列表
    ]
  },
  {
    id: 'operations',
    name: '运维控制台',
    layout: [
      // 容器列表 + 日志流 + 快速操作
    ]
  }
];
```

**预期效果**:
- ✅ 拖拽调整组件位置和大小
- ✅ 自定义显示的指标和容器
- ✅ 布局保存到浏览器（可导出/导入）
- ✅ 预设模板一键应用

---

### 2.3 响应式与无障碍优化

#### 2.3.1 移动端适配

**文件**: `frontend/src/components/charts/InteractiveChart.vue`

```vue
<script setup>
// 触摸手势支持
const touchStart = ref(null);

function onTouchStart(e) {
  if (e.touches.length === 1) {
    touchStart.value = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  } else if (e.touches.length === 2) {
    // 双指缩放
    isPinching.value = true;
  }
}

function onTouchMove(e) {
  if (e.touches.length === 1 && touchStart.value) {
    const dx = e.touches[0].clientX - touchStart.value.x;
    panOffset.value.x += dx;
    touchStart.value = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  } else if (e.touches.length === 2 && isPinching.value) {
    // 计算两指距离变化，调整 zoomLevel
  }
}
</script>

<style scoped>
/* 移动端优化 */
@media (max-width: 768px) {
  .chart-controls {
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .chart-stats {
    grid-template-columns: repeat(2, 1fr); /* 2 列布局 */
  }
  
  .chart-type-buttons button {
    padding: 0.5rem; /* 更大触摸区域 */
  }
}
</style>
```

#### 2.3.2 键盘导航

```vue
<template>
  <div
    class="interactive-chart"
    tabindex="0"
    @keydown="onKeyDown"
    role="img"
    :aria-label="`${title} 图表，当前值 ${currentValue}`"
  >
    <!-- ... -->
  </div>
</template>

<script setup>
function onKeyDown(e) {
  switch (e.key) {
    case 'ArrowLeft':
      panOffset.value.x -= 50;
      break;
    case 'ArrowRight':
      panOffset.value.x += 50;
      break;
    case '+':
    case '=':
      zoomLevel.value = Math.min(10, zoomLevel.value + 0.5);
      break;
    case '-':
      zoomLevel.value = Math.max(1, zoomLevel.value - 0.5);
      break;
    case 'r':
      resetZoom();
      break;
  }
}
</script>
```

#### 2.3.3 色盲模式

```javascript
// frontend/src/lib/colorSchemes.js
export const colorSchemes = {
  default: {
    cpu: '#06B6D4',
    memory: '#10B981',
    network: '#F59E0B',
    disk: '#EF4444'
  },
  deuteranopia: { // 红绿色盲
    cpu: '#3B82F6',
    memory: '#FBBF24',
    network: '#8B5CF6',
    disk: '#F97316'
  },
  protanopia: { // 红色盲
    cpu: '#0EA5E9',
    memory: '#FCD34D',
    network: '#A855F7',
    disk: '#FB923C'
  }
};

// 设置中添加颜色方案选择
const colorScheme = useLocalStorage('color-scheme', 'default');
```

**预期效果**:
- ✅ 手机端支持触摸平移/双指缩放
- ✅ 键盘完整操作图表（方向键/+/-/r）
- ✅ 屏幕阅读器友好（ARIA 标签）
- ✅ 色盲模式（3 种预设方案）

---

## 🤖 Phase 3: 智能化增强

### 3.1 AI 驱动的异常诊断

**当前状态**:
- AI 诊断需手动触发
- 仅分析日志，不结合指标数据

**改进方案**:

#### 3.1.1 自动异常诊断

**文件**: `backend/src/services/auto-diagnosis.js` (新建)

```javascript
/**
 * 当检测到异常时，自动触发 AI 诊断
 */
export class AutoDiagnosisService {
  constructor(aiService, anomalyDetector) {
    this.aiService = aiService;
    this.anomalyDetector = anomalyDetector;
  }
  
  async diagnoseAnomaly(containerId, anomaly) {
    // 1. 收集上下文数据
    const context = await this.collectContext(containerId, anomaly);
    
    // 2. 构建诊断提示词
    const prompt = this.buildDiagnosisPrompt(context);
    
    // 3. 调用 AI 模型
    const diagnosis = await this.aiService.chat([
      { role: 'system', content: 'You are a Docker container expert.' },
      { role: 'user', content: prompt }
    ]);
    
    // 4. 保存诊断结果
    await db.run(
      'INSERT INTO ai_diagnoses (container_id, anomaly_id, diagnosis, created_at) VALUES (?, ?, ?, ?)',
      [containerId, anomaly.id, diagnosis, Date.now()]
    );
    
    // 5. 推送通知
    await this.notifyUser(containerId, diagnosis);
  }
  
  async collectContext(containerId, anomaly) {
    return {
      anomaly: {
        metric: anomaly.metric,
        timestamp: anomaly.start,
        severity: anomaly.severity,
        value: anomaly.value,
        baseline: anomaly.baseline
      },
      metrics: await this.getRecentMetrics(containerId, anomaly.start),
      logs: await this.getRelevantLogs(containerId, anomaly.start),
      container: await docker.getContainer(containerId).inspect(),
      events: await this.getDockerEvents(containerId, anomaly.start)
    };
  }
}
```

#### 3.1.2 前端：诊断结果展示

**文件**: `frontend/src/components/charts/InteractiveChart.vue`

```vue
<template>
  <!-- 异常标记上添加 AI 诊断徽章 -->
  <div
    v-for="anomaly in anomalies"
    :key="anomaly.start"
    class="anomaly-marker"
    @click="showDiagnosis(anomaly)"
  >
    <span v-if="anomaly.diagnosis" class="ai-badge">
      <Sparkles class="h-3 w-3" />
      AI 已诊断
    </span>
  </div>
</template>

<script setup>
function showDiagnosis(anomaly) {
  // 显示 AI 诊断结果面板
  diagnosisModal.value = {
    open: true,
    title: '异常诊断',
    content: anomaly.diagnosis,
    timestamp: anomaly.start,
    suggestions: anomaly.suggestions // 推荐操作
  };
}
</script>
```

**预期效果**:
- ✅ 检测到异常后 30 秒内自动诊断
- ✅ 诊断结果关联到异常标记
- ✅ 推送通知到告警渠道
- ✅ 诊断历史可查询

---

### 3.2 预测性维护

#### 3.2.1 趋势预测与预警

**文件**: `backend/src/services/predictive-maintenance.js` (新建)

```javascript
export class PredictiveMaintenance {
  /**
   * 预测未来 N 小时内是否会触发阈值
   */
  async predictThresholdBreach(containerId, metric, horizonHours = 24) {
    // 1. 获取最近 7 天历史数据
    const history = await this.getMetricHistory(containerId, metric, 7);
    
    // 2. 时间序列分析（趋势 + 周期性）
    const model = this.buildTimeSeriesModel(history);
    
    // 3. 预测未来值
    const predictions = model.forecast(horizonHours * 60); // 每分钟一个点
    
    // 4. 检查是否会超阈值
    const threshold = await this.getAlertThreshold(containerId, metric);
    const breachTime = predictions.find(p => p.value > threshold)?.timestamp;
    
    if (breachTime) {
      // 5. 创建预警
      await this.createPredictiveAlert({
        containerId,
        metric,
        predictedTime: breachTime,
        confidence: model.confidence,
        recommendation: this.getRecommendation(metric, breachTime)
      });
    }
  }
  
  getRecommendation(metric, breachTime) {
    const hoursUntil = (breachTime - Date.now()) / 3600000;
    
    if (metric === 'memory' && hoursUntil < 6) {
      return '建议在 6 小时内重启容器或增加内存限制';
    }
    if (metric === 'disk' && hoursUntil < 24) {
      return '建议清理日志文件或扩展存储空间';
    }
    return '建议监控并准备干预';
  }
}
```

#### 3.2.2 前端：预测曲线

**文件**: `frontend/src/components/charts/InteractiveChart.vue`

```vue
<script setup>
// 添加预测数据支持
const props = defineProps({
  // ...
  predictions: { type: Array, default: () => [] } // 预测值 [{timestamp, value, confidence}]
});

// 渲染预测曲线（虚线 + 置信区间）
function renderPredictionLine(ctx) {
  if (!props.predictions.length) return;
  
  ctx.setLineDash([5, 5]); // 虚线
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 2;
  
  ctx.beginPath();
  props.predictions.forEach((point, i) => {
    const x = timeToX(point.timestamp);
    const y = valueToY(point.value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  
  // 置信区间（浅色填充）
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.beginPath();
  props.predictions.forEach(p => {
    const x = timeToX(p.timestamp);
    ctx.lineTo(x, valueToY(p.value + p.confidence));
  });
  props.predictions.reverse().forEach(p => {
    const x = timeToX(p.timestamp);
    ctx.lineTo(x, valueToY(p.value - p.confidence));
  });
  ctx.closePath();
  ctx.fill();
}
</script>
```

**预期效果**:
- ✅ 预测未来 24 小时趋势
- ✅ 提前 6 小时预警内存/磁盘问题
- ✅ 虚线显示预测曲线 + 置信区间
- ✅ 推荐操作建议

---

### 3.3 自动化运维建议

#### 3.3.1 智能优化建议

**文件**: `backend/src/services/optimization-advisor.js` (新建)

```javascript
export class OptimizationAdvisor {
  async analyzeContainer(containerId) {
    const recommendations = [];
    
    // 1. 资源配置分析
    const config = await this.getContainerConfig(containerId);
    const usage = await this.getAverageUsage(containerId, 7); // 最近 7 天
    
    // CPU 过度分配检测
    if (config.cpuLimit && usage.cpu < config.cpuLimit * 0.3) {
      recommendations.push({
        type: 'resource',
        severity: 'low',
        title: 'CPU 限制过高',
        description: `实际使用 ${usage.cpu}%，限制为 ${config.cpuLimit}%`,
        suggestion: `建议降至 ${Math.ceil(usage.cpu * 1.5)}%`,
        impact: '节省资源调度'
      });
    }
    
    // 内存泄漏检测
    if (this.detectMemoryLeak(usage.memoryHistory)) {
      recommendations.push({
        type: 'stability',
        severity: 'high',
        title: '疑似内存泄漏',
        description: '内存使用持续增长，未出现回收',
        suggestion: '建议启用定期重启或检查应用代码',
        impact: '避免 OOM 崩溃'
      });
    }
    
    // 网络优化
    if (usage.networkLatency > 100) {
      recommendations.push({
        type: 'performance',
        severity: 'medium',
        title: '网络延迟较高',
        description: `平均延迟 ${usage.networkLatency}ms`,
        suggestion: '检查网络模式（bridge/host）和 DNS 配置',
        impact: '提升响应速度'
      });
    }
    
    return recommendations;
  }
}
```

#### 3.3.2 前端：优化建议面板

**文件**: `frontend/src/views/ResourceMonitorView.vue`

```vue
<template>
  <div class="resource-monitor">
    <!-- ... 现有图表 ... -->
    
    <!-- 优化建议卡片 -->
    <div v-if="recommendations.length" class="recommendations-panel">
      <h3>💡 优化建议</h3>
      <div v-for="rec in recommendations" :key="rec.title" class="recommendation-card">
        <div class="rec-header">
          <span :class="`severity-${rec.severity}`">{{ severityLabel(rec.severity) }}</span>
          <strong>{{ rec.title }}</strong>
        </div>
        <p>{{ rec.description }}</p>
        <div class="rec-action">
          <button @click="applyRecommendation(rec)">
            <Check class="h-4 w-4" />
            采纳建议
          </button>
          <span class="impact">{{ rec.impact }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
const recommendations = ref([]);

async function loadRecommendations() {
  const data = await api.getOptimizationRecommendations(containerId.value);
  recommendations.value = data.recommendations || [];
}

async function applyRecommendation(rec) {
  // 根据建议类型自动应用或引导用户操作
  if (rec.type === 'resource') {
    // 打开配置编辑器，预填建议值
  } else if (rec.type === 'stability') {
    // 创建定时重启任务
  }
}

onMounted(() => {
  loadRecommendations();
  setInterval(loadRecommendations, 300000); // 每 5 分钟刷新
});
</script>
```

**预期效果**:
- ✅ 自动分析容器配置与实际使用
- ✅ 检测内存泄漏、过度分配、性能瓶颈
- ✅ 一键采纳建议（自动调整配置）
- ✅ 量化优化收益（节省资源/提升性能）

---

## 🌐 Phase 4: 生态集成与扩展

### 4.1 多节点集群支持

**当前限制**:
- 仅管理本地 Docker 节点
- 无法统一管理多台服务器

**改进方案**:

#### 4.1.1 节点管理

**文件**: `backend/src/services/node-manager.js` (新建)

```javascript
export class NodeManager {
  constructor() {
    this.nodes = new Map(); // nodeId -> Docker client
  }
  
  async addNode(config) {
    const { id, host, port, tlsCert, tlsKey } = config;
    
    // 创建远程 Docker 客户端
    const docker = new Docker({
      host,
      port,
      ca: tlsCert,
      cert: tlsKey,
      key: tlsKey
    });
    
    // 测试连接
    await docker.ping();
    
    this.nodes.set(id, { config, docker });
    
    // 保存到数据库
    await db.run(
      'INSERT INTO nodes (id, name, host, port, tls_cert, tls_key) VALUES (?, ?, ?, ?, ?, ?)',
      [id, config.name, host, port, tlsCert, tlsKey]
    );
  }
  
  async removeNode(id) {
    this.nodes.delete(id);
    await db.run('DELETE FROM nodes WHERE id = ?', [id]);
  }
  
  getNode(id) {
    return this.nodes.get(id)?.docker;
  }
  
  getAllNodes() {
    return Array.from(this.nodes.entries()).map(([id, { config }]) => ({
      id,
      name: config.name,
      host: config.host,
      status: 'online' // 需定期心跳检测
    }));
  }
}
```

#### 4.1.2 前端：节点切换器

**文件**: `frontend/src/components/NodeSwitcher.vue` (新建)

```vue
<template>
  <div class="node-switcher">
    <button @click="showNodeList = !showNodeList">
      <Server class="h-4 w-4" />
      {{ currentNode?.name || '本地节点' }}
      <ChevronDown class="h-4 w-4" />
    </button>
    
    <div v-if="showNodeList" class="node-dropdown">
      <div
        v-for="node in nodes"
        :key="node.id"
        class="node-item"
        :class="{ active: node.id === currentNodeId }"
        @click="switchNode(node.id)"
      >
        <Server class="h-4 w-4" />
        <span>{{ node.name }}</span>
        <span :class="`status-${node.status}`">{{ node.status }}</span>
      </div>
      <div class="node-actions">
        <button @click="openAddNodeModal">
          <Plus class="h-4 w-4" />
          添加节点
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
const nodes = ref([]);
const currentNodeId = ref('local');

async function switchNode(nodeId) {
  currentNodeId.value = nodeId;
  localStorage.setItem('selected-node', nodeId);
  
  // 刷新项目列表
  await loadProjects(nodeId);
}
</script>
```

**预期效果**:
- ✅ 添加多个 Docker 节点（远程 TCP/TLS）
- ✅ 顶部节点切换器
- ✅ 每个节点独立显示项目/容器
- ✅ 节点状态监控（在线/离线）

---

### 4.2 Prometheus/Grafana 集成

#### 4.2.1 Prometheus 指标导出

**文件**: `backend/src/routes/prometheus.js` (新建)

```javascript
/**
 * GET /metrics (Prometheus 格式)
 */
export async function prometheusMetrics(req, res) {
  const containers = await docker.listContainers();
  const metrics = [];
  
  for (const container of containers) {
    const stats = await docker.getContainer(container.Id).stats({ stream: false });
    
    // CPU 使用率
    metrics.push(
      `composeops_container_cpu_usage{id="${container.Id}",name="${container.Names[0]}"} ${stats.cpu_percent}`
    );
    
    // 内存使用
    metrics.push(
      `composeops_container_memory_bytes{id="${container.Id}",name="${container.Names[0]}"} ${stats.memory_stats.usage}`
    );
    
    // 网络 I/O
    const netRx = Object.values(stats.networks || {}).reduce((sum, net) => sum + net.rx_bytes, 0);
    const netTx = Object.values(stats.networks || {}).reduce((sum, net) => sum + net.tx_bytes, 0);
    metrics.push(
      `composeops_container_network_rx_bytes{id="${container.Id}",name="${container.Names[0]}"} ${netRx}`,
      `composeops_container_network_tx_bytes{id="${container.Id}",name="${container.Names[0]}"} ${netTx}`
    );
  }
  
  res.type('text/plain').send(metrics.join('\n'));
}
```

#### 4.2.2 Grafana Dashboard 模板

**文件**: `docs/grafana-dashboard.json` (新建)

```json
{
  "dashboard": {
    "title": "ComposeOps 容器监控",
    "panels": [
      {
        "id": 1,
        "title": "容器 CPU 使用率",
        "targets": [
          {
            "expr": "composeops_container_cpu_usage",
            "legendFormat": "{{name}}"
          }
        ]
      },
      {
        "id": 2,
        "title": "容器内存使用",
        "targets": [
          {
            "expr": "composeops_container_memory_bytes / 1024 / 1024",
            "legendFormat": "{{name}}"
          }
        ]
      }
    ]
  }
}
```

**配置说明** (`README.md` 新增):

```markdown
### Prometheus 集成

在 `prometheus.yml` 中添加 ComposeOps 作为抓取目标:

```yaml
scrape_configs:
  - job_name: 'composeops'
    static_configs:
      - targets: ['127.0.0.1:3001']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

导入 Grafana Dashboard:
```bash
# 导入 docs/grafana-dashboard.json
```
```

**预期效果**:
- ✅ 暴露 Prometheus 格式指标端点
- ✅ Grafana 预制仪表盘模板
- ✅ 与现有监控栈无缝集成
- ✅ 长期历史数据存储（Prometheus TSDB）

---

### 4.3 插件系统与第三方集成

#### 4.3.1 插件架构

**文件**: `backend/src/plugin-system/` (新目录)

```javascript
// plugin-manager.js
export class PluginManager {
  constructor() {
    this.plugins = new Map();
  }
  
  async loadPlugin(pluginPath) {
    const manifest = await fs.readJson(path.join(pluginPath, 'plugin.json'));
    
    // 验证权限
    if (!this.validatePermissions(manifest.permissions)) {
      throw new Error('Plugin requires dangerous permissions');
    }
    
    // 加载插件代码（沙箱隔离）
    const plugin = await import(path.join(pluginPath, manifest.entry));
    
    // 注册钩子
    this.plugins.set(manifest.id, {
      manifest,
      hooks: plugin.hooks,
      api: this.createPluginAPI(manifest.id)
    });
    
    // 调用初始化
    await plugin.hooks.onLoad?.(this.plugins.get(manifest.id).api);
  }
  
  createPluginAPI(pluginId) {
    return {
      // 受限的 Docker API
      docker: {
        listContainers: () => docker.listContainers(),
        inspectContainer: (id) => docker.getContainer(id).inspect()
        // 不暴露启停控制
      },
      
      // 数据库访问（插件专用表）
      db: {
        query: (sql, params) => db.all(sql, params),
        run: (sql, params) => db.run(sql, params)
      },
      
      // 注册 UI 组件
      ui: {
        registerView: (route, component) => { /* ... */ },
        registerWidget: (type, component) => { /* ... */ }
      },
      
      // 发送通知
      notify: (message, level) => { /* ... */ }
    };
  }
}
```

#### 4.3.2 插件示例

**文件**: `plugins/cost-calculator/` (示例插件)

```javascript
// plugin.json
{
  "id": "cost-calculator",
  "name": "成本计算器",
  "version": "1.0.0",
  "entry": "index.js",
  "permissions": ["docker:read", "db:read"]
}

// index.js
export const hooks = {
  async onLoad(api) {
    console.log('成本计算器插件已加载');
    
    // 注册定时任务：每天计算成本
    setInterval(async () => {
      const containers = await api.docker.listContainers();
      const totalCost = calculateCost(containers);
      
      await api.db.run(
        'INSERT INTO plugin_cost_history (date, cost) VALUES (?, ?)',
        [Date.now(), totalCost]
      );
    }, 24 * 3600 * 1000);
    
    // 注册 UI 组件
    api.ui.registerWidget('cost-summary', {
      component: 'CostSummaryWidget',
      defaultSize: { w: 4, h: 3 }
    });
  }
};

function calculateCost(containers) {
  // 根据 CPU/内存使用量估算云成本
  return containers.reduce((sum, c) => {
    const cpuCost = c.cpu * 0.02; // $0.02/vCPU/小时
    const memCost = c.memory / 1024 * 0.01; // $0.01/GB/小时
    return sum + cpuCost + memCost;
  }, 0);
}
```

#### 4.3.3 插件市场

**文件**: `frontend/src/views/PluginMarketView.vue` (新建)

```vue
<template>
  <div class="plugin-market">
    <div class="page-header">
      <h1>插件市场</h1>
      <button @click="openInstallDialog">从 URL 安装</button>
    </div>
    
    <div class="plugin-grid">
      <div v-for="plugin in availablePlugins" :key="plugin.id" class="plugin-card">
        <h3>{{ plugin.name }}</h3>
        <p>{{ plugin.description }}</p>
        <div class="plugin-meta">
          <span>{{ plugin.author }}</span>
          <span>{{ plugin.downloads }} 安装</span>
        </div>
        <button
          v-if="!installedPlugins.includes(plugin.id)"
          @click="installPlugin(plugin.id)"
        >
          安装
        </button>
        <button v-else @click="uninstallPlugin(plugin.id)" class="btn-ghost">
          已安装
        </button>
      </div>
    </div>
  </div>
</template>
```

**预制插件列表**:
- `cost-calculator` - 成本估算
- `backup-manager` - 自动备份管理
- `security-scanner` - 镜像漏洞扫描
- `log-analyzer` - 日志分析与报告
- `slack-notifier` - Slack 集成
- `jira-integration` - Jira 工单同步

**预期效果**:
- ✅ 插件沙箱隔离（受限 API）
- ✅ 插件市场（安装/卸载/更新）
- ✅ 注册自定义视图和组件
- ✅ 社区插件生态

---

## 📊 改进总结与优先级

### 优先级矩阵

| 改进项 | 优先级 | 难度 | 影响力 | 预计工期 |
|-------|-------|------|--------|----------|
| 1.1 真实历史指标存储 | ⭐⭐⭐⭐⭐ | 中 | 高 | 3-4 天 |
| 1.2 异常检测与预警 | ⭐⭐⭐⭐⭐ | 中 | 高 | 4-5 天 |
| 1.3 性能优化 | ⭐⭐⭐⭐ | 低 | 中 | 2-3 天 |
| 2.1 高级图表交互 | ⭐⭐⭐⭐ | 中 | 中 | 3-4 天 |
| 2.2 仪表盘定制化 | ⭐⭐⭐ | 高 | 高 | 5-7 天 |
| 2.3 响应式优化 | ⭐⭐⭐ | 中 | 中 | 3-4 天 |
| 3.1 自动异常诊断 | ⭐⭐⭐⭐ | 中 | 高 | 3-5 天 |
| 3.2 预测性维护 | ⭐⭐⭐ | 高 | 高 | 5-7 天 |
| 3.3 优化建议 | ⭐⭐⭐ | 中 | 中 | 3-4 天 |
| 4.1 多节点集群 | ⭐⭐ | 高 | 高 | 7-10 天 |
| 4.2 Prometheus 集成 | ⭐⭐⭐ | 低 | 中 | 2-3 天 |
| 4.3 插件系统 | ⭐⭐ | 高 | 高 | 10-14 天 |

### 快速胜利（Quick Wins）

**第一周可完成**:
1. ✅ 真实历史指标 API（3 天）
2. ✅ 异常检测算法（2 天）
3. ✅ Prometheus 指标导出（1 天）
4. ✅ 性能优化（数据聚合）（1 天）

**预期成果**:
- 图表显示真实历史数据
- 自动标记异常区域
- 支持 Grafana 集成
- 大时间范围查询快 10 倍

---

## 🎯 里程碑与发布计划

### v1.1.0 - "数据增强版" (2 周)
- [x] InteractiveChart 组件
- [ ] 真实历史指标存储
- [ ] 异常检测与标记
- [ ] 性能优化（聚合查询）
- [ ] Prometheus 集成

### v1.2.0 - "交互升级版" (3 周)
- [ ] 图表联动与多容器对比
- [ ] 导出/分享功能
- [ ] 响应式优化（移动端）
- [ ] 键盘导航与无障碍

### v1.3.0 - "智能运维版" (3 周)
- [ ] 自动异常诊断
- [ ] 趋势预测与预警
- [ ] 优化建议引擎

### v2.0.0 - "企业级版" (4 周)
- [ ] 自定义仪表盘
- [ ] 多节点集群管理
- [ ] 插件系统与市场

---

## 🔧 技术债务清理

在实现新功能的同时，需要处理以下技术债务：

### 代码质量
- [ ] 统一错误处理（前后端）
- [ ] 补充单元测试（覆盖率 > 80%）
- [ ] TypeScript 类型定义（前端）
- [ ] API 文档生成（OpenAPI 3.0）

### 性能优化
- [ ] 前端代码分割（按路由）
- [ ] 图片/字体资源 CDN
- [ ] WebSocket 消息压缩
- [ ] 数据库查询优化（索引）

### 安全加固
- [ ] API 速率限制
- [ ] CSRF Token 验证
- [ ] 输入校验增强
- [ ] 依赖漏洞扫描（定期）

---

## 📝 结语

本路线图基于现有架构和用户需求设计，**分阶段实施可确保渐进式改进**。

**建议执行顺序**:
1. 先完成 Phase 1（数据层），为后续交互打下基础
2. 再完成 Phase 2（交互层），提升用户体验
3. 然后完成 Phase 3（智能化），增加差异化竞争力
4. 最后完成 Phase 4（生态集成），扩大用户群体

每个 Phase 结束后发布一个小版本，持续交付价值。

---

**文档维护**: 每完成一个改进项，在此文档中标记 `[x]` 并更新 CHANGELOG.md
