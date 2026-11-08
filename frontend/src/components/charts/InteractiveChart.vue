<template>
  <div class="interactive-chart-wrapper" ref="wrapperRef">
    <ChartToolbar v-model="chartType"
                  :chart-types="chartTypes"
                  :stats="stats"
                  :exporting="exporting"
                  @export="handleExport" />
    <p v-if="exportError" class="alert-error mb-3" role="alert"><span class="min-w-0 flex-1">{{ exportError }}</span><button class="text-link shrink-0" @click="handleExport(lastExportFormat)">重试导出</button></p>
    <p v-else-if="exportFeedback" class="mb-3 text-xs text-surface-400" role="status">{{ exportFeedback }}</p>
    <!-- Main Chart Canvas -->
    <div class="chart-canvas-wrapper" ref="canvasWrapper">
      <svg :viewBox="`0 0 ${width} ${height}`" class="chart-canvas"
           role="img"
           :aria-label="ariaLabel"
           :aria-describedby="descriptionId"
           tabindex="0"
           @focus="enableKeyboardNav"
           @blur="disableKeyboardNav"
           @keydown="handleKeyDown"
           @pointerdown="onPointerDown"
           @pointermove="onPointerMove"
           @pointerup="onPointerUp"
           @pointercancel="touchStart = null"
           @mousedown="onMouseDown"
           @mousemove="onMouseMove"
           @mouseleave="onMouseLeave"
           @wheel="onWheel">
        <desc :id="descriptionId">{{ ariaDescription || '使用左右方向键逐点查看，+ / - 缩放，R 重置。普通滚轮滚动页面，Ctrl 或 Command 加滚轮缩放图表。' }}</desc>
        <defs>
          <!-- Area gradient (单指标) -->
          <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" :stop-color="color" stop-opacity="0.3" />
            <stop offset="100%" :stop-color="color" stop-opacity="0.05" />
          </linearGradient>
          
          <!-- Phase 2: 多指标渐变 -->
          <linearGradient v-for="(dataset, idx) in activeDatasets" :key="`grad-${idx}`"
                          :id="`grad-${idx}-${gradientId}`" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" :stop-color="dataset.color" stop-opacity="0.3" />
            <stop offset="100%" :stop-color="dataset.color" stop-opacity="0.05" />
          </linearGradient>
          
          <!-- Anomaly pattern -->
          <pattern :id="anomalyPatternId" patternUnits="userSpaceOnUse" width="8" height="8">
            <rect width="8" height="8" fill="#DC2626" opacity="0.1" />
            <path d="M0 8 L8 0 M-2 2 L2 -2 M6 10 L10 6" stroke="#DC2626" stroke-width="1" opacity="0.3" />
          </pattern>
        </defs>

        <!-- Grid lines -->
        <g class="grid">
          <line v-for="i in gridLines" :key="`h-${i}`"
                :x1="padding.left" :y1="padding.top + plotHeight * i / gridLines"
                :x2="width - padding.right" :y2="padding.top + plotHeight * i / gridLines"
                class="grid-line" />
          <line v-for="i in verticalGridCount" :key="`v-${i}`"
                :x1="padding.left + plotWidth * (i - 1) / Math.max(1, verticalGridCount - 1)" :y1="padding.top"
                :x2="padding.left + plotWidth * (i - 1) / Math.max(1, verticalGridCount - 1)" :y2="height - padding.bottom"
                class="grid-line" />
        </g>

        <!-- Anomaly bands (behind chart) -->
        <g v-if="anomalies.length > 0" class="anomaly-bands">
          <rect v-for="(anomaly, idx) in visibleAnomalies" :key="`anomaly-${idx}`"
                :x="anomaly.x" :y="padding.top"
                :width="anomaly.width" :height="plotHeight"
                :fill="`url(#${anomalyPatternId})`" />
        </g>

        <!-- Phase 2: 多指标模式 -->
        <template v-if="compareMode && visibleDatasets.length > 0">
          <!-- 面积:chartType=area 时渲染多面积 -->
          <template v-if="chartType === 'area'">
            <path v-for="(areaData, idx) in multiAreaPaths" :key="`area-${idx}`"
                  :d="areaData.path"
                  :fill="`url(#${areaData.gradientId})`"
                  class="chart-area" />
          </template>

          <!-- 折线:area 或 line 都叠线 -->
          <template v-if="chartType === 'line' || chartType === 'area'">
            <path v-for="(lineData, idx) in multiLinePaths" :key="`line-${idx}`"
                  :d="lineData.path"
                  fill="none"
                  :stroke="lineData.color"
                  stroke-width="2"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                  class="chart-line" />
          </template>

          <template v-if="chartType === 'bar'">
            <g v-for="(dataset, dsIdx) in visibleDatasets" :key="`bars-${dsIdx}`">
              <rect v-for="(point, idx) in dataset.visibleData" :key="idx" class="chart-bar"
                    :x="getXForDataset(idx, dataset.visibleData.length) - barWidth / 2 + dsIdx * barWidth / visibleDatasets.length"
                    :y="getYForScale(point.value, yScales[dsIdx])"
                    :width="barWidth / visibleDatasets.length"
                    :height="Math.max(0, height - padding.bottom - getYForScale(point.value, yScales[dsIdx]))"
                    :fill="dataset.color" opacity="0.8" />
            </g>
          </template>

          <!-- Multi-metric hover crosshair -->
          <g v-if="hoverIndex !== null && visiblePoints[hoverIndex]" class="crosshair">
            <line :x1="getX(hoverIndex)" :y1="padding.top"
                  :x2="getX(hoverIndex)" :y2="height - padding.bottom"
                  class="crosshair-line" />
            <circle v-for="(dataset, idx) in hoveredDatasets" :key="`dot-${idx}`"
                    :cx="getX(hoverIndex)"
                    :cy="getYForScale(dataset.visibleData[hoverIndex].value, yScales[visibleDatasets.indexOf(dataset)])"
                    r="4" :fill="dataset.color" class="crosshair-dot" />
            <!-- Keyboard focus indicators -->
            <template v-if="keyboardEnabled && focusedPointIndex === hoverIndex">
              <circle v-for="(dataset, idx) in hoveredDatasets" :key="`focus-${idx}`"
                      :cx="getX(hoverIndex)"
                      :cy="getYForScale(dataset.visibleData[hoverIndex].value, yScales[visibleDatasets.indexOf(dataset)])"
                      r="8" fill="none" stroke="#38BDF8" stroke-width="2" class="keyboard-focus-ring" />
            </template>
          </g>
        </template>

        <!-- 单指标模式 -->
        <template v-else>
          <!-- Area chart -->
          <path v-if="chartType === 'area' && areaPath"
                :d="areaPath"
                :fill="`url(#${gradientId})`"
                class="chart-area" />

          <!-- Line chart -->
          <path v-if="(chartType === 'line' || chartType === 'area') && linePath"
                :d="linePath"
                fill="none"
                :stroke="color"
                stroke-width="2"
                stroke-linejoin="round"
                stroke-linecap="round"
                class="chart-line" />

          <!-- Bar chart -->
          <g v-if="chartType === 'bar'">
            <rect v-for="(point, idx) in visiblePoints" :key="`bar-${idx}`"
                  :x="getX(idx) - barWidth / 2"
                  :y="getY(point.value)"
                  :width="barWidth"
                  :height="Math.max(0, height - padding.bottom - getY(point.value))"
                  :fill="color"
                  opacity="0.8"
                  class="chart-bar" />
          </g>

          <circle v-if="visiblePoints.length === 1 && chartType !== 'bar'" class="chart-single-point" :cx="getX(0)" :cy="getY(visiblePoints[0].value)" r="4" :fill="color" />

          <!-- Hover crosshair -->
          <g v-if="hoverIndex !== null && visiblePoints[hoverIndex]" class="crosshair">
            <line :x1="getX(hoverIndex)" :y1="padding.top"
                  :x2="getX(hoverIndex)" :y2="height - padding.bottom"
                  class="crosshair-line" />
            <circle :cx="getX(hoverIndex)" :cy="getY(visiblePoints[hoverIndex].value)"
                    r="4" :fill="color" class="crosshair-dot" />
            <!-- Keyboard focus indicator -->
            <circle v-if="keyboardEnabled && focusedPointIndex === hoverIndex"
                    :cx="getX(hoverIndex)" :cy="getY(visiblePoints[hoverIndex].value)"
                    r="8" fill="none" stroke="#38BDF8" stroke-width="2" class="keyboard-focus-ring" />
          </g>
        </template>

        <!-- Zoom selection -->
        <rect v-if="isDragging && dragStart && dragEnd"
              :x="Math.min(dragStart.x, dragEnd.x)" :y="padding.top"
              :width="Math.abs(dragEnd.x - dragStart.x)" :height="plotHeight"
              fill="#3B82F6" opacity="0.2" stroke="#3B82F6" stroke-width="1" />
      </svg>

      <ChartTooltip :visible="hoverIndex !== null && !!visiblePoints[hoverIndex]"
                    @resize="tooltipSize = $event"
                    :x="tooltipX"
                    :y="tooltipY"
                    :multi="compareMode && visibleDatasets.length > 0"
                    :datasets="visibleDatasets"
                    :hover-index="hoverIndex"
                    :point="!compareMode ? visiblePoints[hoverIndex] : null"
                    :unit="unit" />
    </div>

    <!-- Zoom controls -->
    <div class="chart-range-labels" v-if="visiblePoints.length"><span>{{ pointTime(visiblePoints[0]) }}</span><span>{{ pointTime(visiblePoints.at(-1)) }}</span></div>
    <p v-if="keyboardEnabled && hoverIndex !== null && visiblePoints[hoverIndex]" class="sr-only" aria-live="polite">{{ pointTime(visiblePoints[hoverIndex]) }}，{{ formatValue(visiblePoints[hoverIndex].value) }}</p>
    <div class="zoom-controls" role="group" aria-label="图表缩放">
      <span class="chart-zoom-summary" aria-live="polite">{{ zoomLevel > 1 ? `已放大 ${zoomLevel.toFixed(1)} 倍 · ${visiblePoints.length} 个样本` : `${visiblePoints.length} 个样本` }}</span>
      <button @click="zoomIn" :disabled="zoomLevel >= maxZoom || visiblePoints.length < 2" class="zoom-btn" title="放大" aria-label="放大图表">
        <ZoomIn class="w-4 h-4" />
      </button>
      <button @click="zoomOut" :disabled="zoomLevel <= minZoom" class="zoom-btn" title="缩小" aria-label="缩小图表">
        <ZoomOut class="w-4 h-4" />
      </button>
      <button @click="resetZoom" class="zoom-btn" title="重置" aria-label="重置图表缩放">
        <Maximize2 class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { TrendingUp, BarChart3, Activity, ZoomIn, ZoomOut, Maximize2 } from 'lucide-vue-next';
import ChartToolbar from './ChartToolbar.vue';
import ChartTooltip from './ChartTooltip.vue';
import { useChartExport } from './useChartExport.js';

const props = defineProps({
  data: { type: Array, default: () => [] }, // [{ timestamp, value }]
  color: { type: String, default: '#38BDF8' },
  unit: { type: String, default: '' },
  anomalies: { type: Array, default: () => [] }, // [{ start, end }] timestamps
  width: { type: Number, default: 800 },
  height: { type: Number, default: 300 },
  // Phase 2: 新增多指标支持
  datasets: { type: Array, default: () => [] }, // [{ label, data: [{timestamp, value}], color, unit }]
  compareMode: { type: Boolean, default: false },
  // Phase 2: 可访问性
  ariaLabel: { type: String, default: '交互式图表' },
  ariaDescription: { type: String, default: '' },
});

const chartTypes = [
  { key: 'line', label: '折线图', icon: TrendingUp },
  { key: 'area', label: '面积图', icon: Activity },
  { key: 'bar', label: '柱状图', icon: BarChart3 },
];

const chartType = ref('area');
const padding = { top: 20, right: 20, bottom: 30, left: 50 };
const gridLines = 5;
const gradientId = `chart-grad-${Math.random().toString(36).slice(2, 8)}`;
const descriptionId = `${gradientId}-description`;
const anomalyPatternId = `anomaly-pattern-${gradientId}`;

// Zoom and pan state
const zoomLevel = ref(1);
const panOffset = ref(0);
const maxZoom = 20;
const minZoom = 1;

// Interaction state
const hoverIndex = ref(null);
const isDragging = ref(false);
const dragStart = ref(null);
const dragEnd = ref(null);
const wrapperRef = ref(null);
const canvasWrapper = ref(null);
const renderedSize = ref({ width: props.width, height: props.height });
const tooltipSize = ref({ width: 120, height: 64 });
let resizeObserver;

// Phase 2: Keyboard navigation
const focusedPointIndex = ref(null);
const keyboardEnabled = ref(false);

const plotWidth = computed(() => props.width - padding.left - padding.right);
const plotHeight = computed(() => props.height - padding.top - padding.bottom);

// Phase 2: 多指标模式下的数据集
const activeDatasets = computed(() => {
  if (props.compareMode && props.datasets.length > 0) {
    return props.datasets;
  }
  // 单指标模式：包装为数据集格式
  return [{
    label: '指标',
    data: props.data,
    color: props.color,
    unit: props.unit,
  }];
});

const sourcePoints = computed(() => props.compareMode ? activeDatasets.value[0]?.data || [] : props.data);

// Visible data range based on zoom and pan
const visiblePoints = computed(() => {
  if (sourcePoints.value.length === 0) return [];
  const totalPoints = sourcePoints.value.length;
  const visibleCount = Math.ceil(totalPoints / zoomLevel.value);
  const startIdx = Math.max(0, Math.min(totalPoints - visibleCount, Math.floor(panOffset.value)));
  const endIdx = Math.min(totalPoints, startIdx + visibleCount);
  return sourcePoints.value.slice(startIdx, endIdx);
});

const verticalGridCount = computed(() => Math.min(visiblePoints.value.length, 10));

// Phase 2: 多数据集的可见范围
const visibleDatasets = computed(() => {
  return activeDatasets.value.map(dataset => {
    if (dataset.data.length === 0) return { ...dataset, visibleData: [] };
    const totalPoints = dataset.data.length;
    const visibleCount = Math.ceil(totalPoints / zoomLevel.value);
    const startIdx = Math.max(0, Math.min(totalPoints - visibleCount, Math.floor(panOffset.value)));
    const endIdx = Math.min(totalPoints, startIdx + visibleCount);
    return {
      ...dataset,
      visibleData: dataset.data.slice(startIdx, endIdx),
    };
  });
});

// 多指标模式下 hoverIndex 处有点的 datasets(消除模板 v-for+v-if 混用)
const hoveredDatasets = computed(() => {
  if (hoverIndex.value === null) return [];
  return visibleDatasets.value.filter((d) => d.visibleData?.[hoverIndex.value]);
});

// Statistics
const stats = computed(() => {
  if (visiblePoints.value.length === 0) {
    return { min: '-', avg: '-', max: '-', current: '-' };
  }
  const values = visiblePoints.value.map(p => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const current = values[values.length - 1];
  
  return {
    min: formatValue(min),
    avg: formatValue(avg),
    max: formatValue(max),
    current: formatValue(current),
  };
});

// Y-axis scale
const yScale = computed(() => {
  if (visiblePoints.value.length === 0) return { min: 0, max: 100 };
  const values = visiblePoints.value.map(p => p.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const range = max - min;
  return {
    min: min - range * 0.1,
    max: max + range * 0.1,
  };
});

// Phase 2: 双Y轴支持（多指标比较模式）
const yScales = computed(() => {
  if (!props.compareMode || visibleDatasets.value.length === 0) {
    return [yScale.value];
  }
  
  return visibleDatasets.value.map(dataset => {
    if (dataset.visibleData.length === 0) return { min: 0, max: 100 };
    const values = dataset.visibleData.map(p => p.value);
    const min = Math.min(...values, 0);
    const max = Math.max(...values, 1);
    const range = max - min;
    return {
      min: min - range * 0.1,
      max: max + range * 0.1,
    };
  });
});

// Chart paths (单指标)
const linePath = computed(() => {
  if (visiblePoints.value.length < 2) return '';
  return visiblePoints.value.map((point, i) => {
    const x = getX(i);
    const y = getY(point.value);
    return `${i === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ');
});

const areaPath = computed(() => {
  if (!linePath.value) return '';
  const lastX = getX(visiblePoints.value.length - 1);
  const bottomY = props.height - padding.bottom;
  return `${linePath.value} L${lastX},${bottomY} L${padding.left},${bottomY} Z`;
});

const barWidth = computed(() => {
  if (visiblePoints.value.length === 0) return 0;
  return Math.max(2, Math.min(20, plotWidth.value / visiblePoints.value.length * 0.8));
});

// Phase 2: 多指标路径
const multiLinePaths = computed(() => {
  if (!props.compareMode) return [];
  return visibleDatasets.value.map((dataset, dsIdx) => {
    if (dataset.visibleData.length < 2) return null;
    const scale = yScales.value[dsIdx];
    const path = dataset.visibleData.map((point, i) => {
      const x = getXForDataset(i, dataset.visibleData.length);
      const y = getYForScale(point.value, scale);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    }).join(' ');
    return { path, color: dataset.color };
  }).filter(Boolean);
});

const multiAreaPaths = computed(() => {
  if (!props.compareMode) return [];
  return visibleDatasets.value.map((dataset, dsIdx) => {
    if (dataset.visibleData.length < 2) return null;
    const scale = yScales.value[dsIdx];
    const linePath = dataset.visibleData.map((point, i) => {
      const x = getXForDataset(i, dataset.visibleData.length);
      const y = getYForScale(point.value, scale);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    }).join(' ');
    const lastX = getXForDataset(dataset.visibleData.length - 1, dataset.visibleData.length);
    const bottomY = props.height - padding.bottom;
    const path = `${linePath} L${lastX},${bottomY} L${padding.left},${bottomY} Z`;
    return { path, gradientId: `grad-${dsIdx}-${gradientId}` };
  }).filter(Boolean);
});

// Visible anomalies
const visibleAnomalies = computed(() => {
  if (props.anomalies.length === 0 || visiblePoints.value.length === 0) return [];
  const startTime = visiblePoints.value[0].timestamp;
  const endTime = visiblePoints.value[visiblePoints.value.length - 1].timestamp;
  
  return props.anomalies
    .filter(a => a.end >= startTime && a.start <= endTime)
    .map(a => {
      const startIdx = visiblePoints.value.findIndex(p => p.timestamp >= a.start);
      const endIdx = visiblePoints.value.findIndex(p => p.timestamp >= a.end);
      if (startIdx === -1) return null;
      const start = startIdx === -1 ? 0 : startIdx;
      const end = endIdx === -1 ? visiblePoints.value.length - 1 : endIdx;
      return {
        x: getX(start),
        width: getX(end) - getX(start),
      };
    })
    .filter(Boolean);
});

// Coordinate helpers
function getX(index) {
  if (visiblePoints.value.length <= 1) return padding.left;
  return padding.left + (plotWidth.value * index) / (visiblePoints.value.length - 1);
}

function getY(value) {
  const { min, max } = yScale.value;
  const range = max - min;
  if (range === 0) return props.height - padding.bottom;
  return padding.top + plotHeight.value * (1 - (value - min) / range);
}

// Phase 2: 多指标坐标辅助函数
function getXForDataset(index, dataLength) {
  if (dataLength <= 1) return padding.left;
  return padding.left + (plotWidth.value * index) / (dataLength - 1);
}

function getYForScale(value, scale) {
  const { min, max } = scale;
  const range = max - min;
  if (range === 0) return props.height - padding.bottom;
  return padding.top + plotHeight.value * (1 - (value - min) / range);
}

// Tooltip uses CSS pixels, while drawing and hit testing use SVG coordinates.
const tooltipX = computed(() => {
  if (hoverIndex.value === null) return 0;
  const availableWidth = renderedSize.value.width;
  const tooltipWidth = Math.min(tooltipSize.value.width, availableWidth);
  const x = getX(hoverIndex.value) * availableWidth / props.width;
  return Math.max(0, Math.min(x - tooltipWidth / 2, availableWidth - tooltipWidth));
});
const tooltipY = computed(() => {
  const point = visiblePoints.value[hoverIndex.value];
  if (!point) return 0;
  const availableHeight = renderedSize.value.height;
  const y = getY(point.value) * availableHeight / props.height;
  const tooltipHeight = tooltipSize.value.height;
  return Math.max(0, Math.min(y > availableHeight / 2 ? y - tooltipHeight - 8 : y + 12, availableHeight - tooltipHeight));
});
function pointTime(point) {
  return new Date(point.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Formatting
function formatValue(value) {
  if (typeof value !== 'number' || isNaN(value)) return '-';
  return `${value.toFixed(1)}${props.unit}`;
}

// Convert the responsive SVG's on-screen coordinates back into its viewBox.
function chartPoint(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const width = rect.width || props.width;
  const height = rect.height || props.height;
  renderedSize.value = { width, height };
  return { x: (event.clientX - rect.left) * props.width / width,
    y: (event.clientY - rect.top) * props.height / height };
}
let touchStart = null;
let touchInteraction = false;
function onPointerDown(event) {
  touchInteraction = event.pointerType === 'touch';
  touchStart = touchInteraction ? { x: event.clientX, y: event.clientY } : null;
  if (touchInteraction) hoverIndex.value = null;
}
function onPointerMove(event) {
  if (event.pointerType !== 'touch') touchInteraction = false;
}
function onPointerUp(event) {
  const start = touchStart; touchStart = null;
  if (event.pointerType !== 'touch' || !start) return;
  // A tap selects a point; a swipe remains the browser's normal page scroll.
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8) selectPoint(event);
}
function selectPoint(event) {
  if (!visiblePoints.value.length) return;
  const { x, y } = chartPoint(event);
  if (isDragging.value) {
    dragEnd.value = { x: Math.max(padding.left, Math.min(props.width - padding.right, x)), y };
    return;
  }
  const relX = x - padding.left;
  if (relX < 0 || relX > plotWidth.value) { hoverIndex.value = null; return; }
  hoverIndex.value = Math.max(0, Math.min(visiblePoints.value.length - 1,
    Math.round(relX / plotWidth.value * (visiblePoints.value.length - 1))));
}
function onMouseMove(event) { if (!touchInteraction) selectPoint(event); }
function onMouseDown(event) {
  if (touchInteraction || event.button !== 0 || visiblePoints.value.length < 2) return;
  const point = chartPoint(event);
  if (point.x < padding.left || point.x > props.width - padding.right) return;
  isDragging.value = true;
  dragStart.value = point;
  dragEnd.value = point;
}
function clearDrag() {
  isDragging.value = false;
  dragStart.value = null;
  dragEnd.value = null;
}
function onMouseUp() {
  if (!isDragging.value || !dragStart.value || !dragEnd.value) { clearDrag(); return; }
  const startX = Math.min(dragStart.value.x, dragEnd.value.x);
  const endX = Math.max(dragStart.value.x, dragEnd.value.x);
  const cssSelectionWidth = (endX - startX) * renderedSize.value.width / props.width;
  if (cssSelectionWidth > 20) {
    const fraction = (endX - startX) / plotWidth.value;
    const count = visiblePoints.value.length;
    const startIndex = Math.floor(panOffset.value) + Math.floor(count * (startX - padding.left) / plotWidth.value);
    const nextZoom = Math.min(maxZoom, zoomLevel.value / fraction);
    zoomLevel.value = nextZoom;
    panOffset.value = Math.max(0, Math.min(sourcePoints.value.length - Math.ceil(sourcePoints.value.length / nextZoom), startIndex));
  }
  clearDrag();
}
function onMouseLeave() { if (!touchInteraction) hoverIndex.value = null; }
function onWheel(event) {
  // Let normal wheel input scroll the page even while the pointer is over a chart.
  if ((!event.ctrlKey && !event.metaKey) || sourcePoints.value.length < 2) return;
  event.preventDefault();
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  const newZoom = Math.max(minZoom, Math.min(maxZoom, zoomLevel.value * factor));
  if (newZoom === zoomLevel.value) return;
  const point = chartPoint(event);
  const mouseRatio = Math.max(0, Math.min(1, (point.x - padding.left) / plotWidth.value));
  const oldVisibleCount = Math.ceil(sourcePoints.value.length / zoomLevel.value);
  const newVisibleCount = Math.ceil(sourcePoints.value.length / newZoom);
  const nextOffset = panOffset.value + (oldVisibleCount - newVisibleCount) * mouseRatio;
  zoomLevel.value = newZoom;
  panOffset.value = Math.max(0, Math.min(sourcePoints.value.length - newVisibleCount, nextOffset));
}

function zoomIn() {
  zoomLevel.value = Math.min(maxZoom, zoomLevel.value * 1.5);
}

function zoomOut() {
  zoomLevel.value = Math.max(minZoom, zoomLevel.value / 1.5);
  if (zoomLevel.value === minZoom) panOffset.value = 0;
}

function resetZoom() {
  zoomLevel.value = minZoom;
  panOffset.value = 0;
}

// Phase 2: Keyboard navigation
function handleKeyDown(event) {
  if (!keyboardEnabled.value || event.target !== canvasWrapper.value?.querySelector('svg.chart-canvas')) return;
  
  const visibleLength = visiblePoints.value.length;
  
  if (visibleLength === 0) return;
  
  switch (event.key) {
    case 'ArrowLeft':
      event.preventDefault();
      if (focusedPointIndex.value === null) {
        focusedPointIndex.value = Math.floor(visibleLength / 2);
      } else {
        focusedPointIndex.value = Math.max(0, focusedPointIndex.value - 1);
      }
      hoverIndex.value = focusedPointIndex.value;
      break;
      
    case 'ArrowRight':
      event.preventDefault();
      if (focusedPointIndex.value === null) {
        focusedPointIndex.value = Math.floor(visibleLength / 2);
      } else {
        focusedPointIndex.value = Math.min(visibleLength - 1, focusedPointIndex.value + 1);
      }
      hoverIndex.value = focusedPointIndex.value;
      break;
      
    case '+':
    case '=':
      event.preventDefault();
      zoomIn();
      break;
      
    case '-':
    case '_':
      event.preventDefault();
      zoomOut();
      break;
      
    case 'r':
    case 'R':
      event.preventDefault();
      resetZoom();
      focusedPointIndex.value = null;
      hoverIndex.value = null;
      break;
      
    case 'Escape':
      event.preventDefault();
      keyboardEnabled.value = false;
      focusedPointIndex.value = null;
      hoverIndex.value = null;
      break;
  }
}

function enableKeyboardNav() {
  keyboardEnabled.value = true;
}
function disableKeyboardNav() {
  keyboardEnabled.value = false;
  focusedPointIndex.value = null;
  hoverIndex.value = null;
}

// ChartToolbar 的 @export 转发到 CSV/PNG 导出(依赖 visible* computed,故置于其定义之后)。
const { exportToCSV, exportToPNG } = useChartExport();
const exporting = ref(false);
const exportError = ref('');
const exportFeedback = ref('');
const lastExportFormat = ref('csv');
let disposed = false;
async function handleExport(format) {
  if (exporting.value) return;
  lastExportFormat.value = format;
  exportError.value = '';
  exportFeedback.value = '';
  exporting.value = true;
  try {
    if (format === 'png') await exportToPNG({ canvasWrapper, width: props.width, height: props.height });
    else exportToCSV({ compareMode: props.compareMode, visibleDatasets: visibleDatasets.value, visiblePoints: visiblePoints.value });
    if (!disposed) exportFeedback.value = `${format.toUpperCase()} 已生成，浏览器将开始下载。`;
  } catch (error) {
    if (!disposed) exportError.value = error?.message || '导出失败，请重试';
  } finally {
    if (!disposed) exporting.value = false;
  }
}

function measureChart() {
  const rect = canvasWrapper.value?.querySelector('svg.chart-canvas')?.getBoundingClientRect();
  if (rect?.width && rect?.height) renderedSize.value = { width: rect.width, height: rect.height };
}
onMounted(() => {
  measureChart();
  if (typeof ResizeObserver !== 'undefined' && canvasWrapper.value) {
    resizeObserver = new ResizeObserver(measureChart);
    resizeObserver.observe(canvasWrapper.value);
  }
  document.addEventListener('mouseup', onMouseUp);
});
onBeforeUnmount(() => {
  disposed = true;
  resizeObserver?.disconnect();
  document.removeEventListener('mouseup', onMouseUp);
});
// Data and zoom changes can shrink the visible range before the next render.
watch([visiblePoints, visibleDatasets], () => {
  hoverIndex.value = null;
  focusedPointIndex.value = null;
}, { flush: 'sync' });
watch(sourcePoints, () => {
  zoomLevel.value = minZoom;
  panOffset.value = 0;
  clearDrag();
});
</script>

<style scoped>
.interactive-chart-wrapper {
  position: relative;
  width: 100%;
  background: var(--color-surface-950, #1a1e25);
  border-radius: 0.5rem;
  border: 1px solid #27272a;
  padding: 1rem;
}

.chart-canvas-wrapper {
  position: relative;
  width: 100%;
  cursor: crosshair;
  user-select: none;
}

.chart-canvas {
  width: 100%;
  height: auto;
  display: block;
}

.grid-line {
  stroke: #27272a;
  stroke-width: 1;
}

.chart-area {
  pointer-events: none;
}

.chart-line {
  pointer-events: none;
  filter: drop-shadow(0 0 4px currentColor);
}

.chart-bar {
  transition: opacity 0.2s;
}

.chart-bar:hover {
  opacity: 1 !important;
}

.crosshair-line {
  stroke: var(--color-surface-500, #6f7a8a);
  stroke-width: 1;
  stroke-dasharray: 4 2;
}

.crosshair-dot {
  stroke: #fff;
  stroke-width: 2;
  filter: drop-shadow(0 0 4px currentColor);
}

.zoom-controls {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  flex-wrap: wrap;
  gap: .35rem;
  margin-top: .75rem;
}

.chart-range-labels { display: flex; justify-content: space-between; gap: .5rem; margin-top: .35rem; font-size: .65rem; font-variant-numeric: tabular-nums; color: var(--color-surface-500); }
.chart-zoom-summary { margin-right: auto; font-size: .7rem; color: var(--color-surface-400); }
.zoom-btn:disabled { opacity: .4; cursor: default; }

.zoom-btn {
  padding: 0.5rem;
  background: var(--color-surface-900);
  border: 1px solid var(--color-surface-800);
  border-radius: 0.375rem;
  color: var(--color-surface-300, #b6bdc9);
  cursor: pointer;
  transition: background .2s, border-color .2s;
}

.zoom-btn:hover:not(:disabled) {
  background: var(--color-surface-800, #363c48);
  color: var(--color-surface-100, #eceef2);
  border-color: #38BDF8;
}

.zoom-btn:focus-visible {
  outline: 2px solid var(--color-accent, #2563eb);
  outline-offset: 2px;
}

.keyboard-focus-ring {
  animation: focus-pulse 1.5s ease-in-out infinite;
}

@keyframes focus-pulse {
  0%, 100% {
    opacity: 0.8;
  }
  50% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) { .keyboard-focus-ring { animation: none; } .chart-bar, .zoom-btn { transition: none; } }
</style>
