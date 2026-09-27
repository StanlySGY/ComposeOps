<template>
  <div class="interactive-chart-wrapper" ref="wrapperRef">
    <ChartToolbar v-model="chartType"
                  :chart-types="chartTypes"
                  :stats="stats"
                  @export="handleExport" />
    <!-- Main Chart Canvas -->
    <div class="chart-canvas-wrapper" ref="canvasWrapper">
      <svg :viewBox="`0 0 ${width} ${height}`" class="chart-canvas"
           role="img"
           :aria-label="ariaLabel"
           :aria-describedby="ariaDescription ? 'chart-desc' : undefined"
           tabindex="0"
           @focus="enableKeyboardNav"
           @mousedown="onMouseDown"
           @mousemove="onMouseMove"
           @mouseleave="onMouseLeave"
           @wheel.prevent="onWheel">
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
          <pattern id="anomaly-pattern" patternUnits="userSpaceOnUse" width="8" height="8">
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
          <line v-for="i in Math.min(visiblePoints.length, 10)" :key="`v-${i}`"
                :x1="padding.left + plotWidth * i / Math.min(visiblePoints.length - 1, 10)" :y1="padding.top"
                :x2="padding.left + plotWidth * i / Math.min(visiblePoints.length - 1, 10)" :y2="height - padding.bottom"
                class="grid-line" />
        </g>

        <!-- Anomaly bands (behind chart) -->
        <g v-if="anomalies.length > 0" class="anomaly-bands">
          <rect v-for="(anomaly, idx) in visibleAnomalies" :key="`anomaly-${idx}`"
                :x="anomaly.x" :y="padding.top"
                :width="anomaly.width" :height="plotHeight"
                fill="url(#anomaly-pattern)" />
        </g>

        <!-- Phase 2: 多指标模式 -->
        <template v-if="compareMode && multiLinePaths.length > 0">
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

          <!-- Multi-metric hover crosshair -->
          <g v-if="hoverIndex !== null" class="crosshair">
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

          <!-- Hover crosshair -->
          <g v-if="hoverIndex !== null" class="crosshair">
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

      <ChartTooltip :visible="hoverIndex !== null"
                    :x="tooltipX"
                    :y="tooltipY"
                    :multi="compareMode && visibleDatasets.length > 0"
                    :datasets="visibleDatasets"
                    :hover-index="hoverIndex"
                    :point="!compareMode ? visiblePoints[hoverIndex] : null"
                    :unit="unit" />
    </div>

    <!-- Zoom controls -->
    <div class="zoom-controls">
      <button @click="zoomIn" class="zoom-btn" title="放大">
        <ZoomIn class="w-4 h-4" />
      </button>
      <button @click="zoomOut" class="zoom-btn" title="缩小">
        <ZoomOut class="w-4 h-4" />
      </button>
      <button @click="resetZoom" class="zoom-btn" title="重置">
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

// Visible data range based on zoom and pan
const visiblePoints = computed(() => {
  if (props.data.length === 0) return [];
  const totalPoints = props.data.length;
  const visibleCount = Math.ceil(totalPoints / zoomLevel.value);
  const startIdx = Math.max(0, Math.min(totalPoints - visibleCount, Math.floor(panOffset.value)));
  const endIdx = Math.min(totalPoints, startIdx + visibleCount);
  return props.data.slice(startIdx, endIdx);
});

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

// Tooltip position
const tooltipX = computed(() => {
  if (hoverIndex.value === null) return 0;
  const x = getX(hoverIndex.value);
  return Math.min(Math.max(x, 60), props.width - 120);
});

const tooltipY = computed(() => {
  if (hoverIndex.value === null) return 0;
  const y = getY(visiblePoints.value[hoverIndex.value].value);
  return y > props.height / 2 ? y - 60 : y + 20;
});

// Formatting
function formatValue(value) {
  if (typeof value !== 'number' || isNaN(value)) return '-';
  return `${value.toFixed(1)}${props.unit}`;
}

// Mouse interactions
function onMouseMove(event) {
  if (visiblePoints.value.length === 0) return;
  
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  
  if (isDragging.value) {
    dragEnd.value = { x, y };
    return;
  }
  
  // Find closest point
  const relX = x - padding.left;
  if (relX < 0 || relX > plotWidth.value) {
    hoverIndex.value = null;
    return;
  }
  
  const index = Math.round((relX / plotWidth.value) * (visiblePoints.value.length - 1));
  hoverIndex.value = Math.max(0, Math.min(visiblePoints.value.length - 1, index));
}

function onMouseDown(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  
  isDragging.value = true;
  dragStart.value = { x, y };
  dragEnd.value = { x, y };
}

function onMouseUp() {
  if (!isDragging.value || !dragStart.value || !dragEnd.value) {
    isDragging.value = false;
    dragStart.value = null;
    dragEnd.value = null;
    return;
  }
  
  const startX = Math.min(dragStart.value.x, dragEnd.value.x);
  const endX = Math.max(dragStart.value.x, dragEnd.value.x);
  const selectionWidth = endX - startX;
  
  // Only zoom if selection is meaningful
  if (selectionWidth > 20) {
    const startRatio = (startX - padding.left) / plotWidth.value;
    const endRatio = (endX - padding.left) / plotWidth.value;
    const newZoom = 1 / (endRatio - startRatio);
    
    if (newZoom >= minZoom && newZoom <= maxZoom) {
      zoomLevel.value = newZoom;
      panOffset.value = Math.floor(props.data.length * startRatio);
    }
  }
  
  isDragging.value = false;
  dragStart.value = null;
  dragEnd.value = null;
}

function onMouseLeave() {
  hoverIndex.value = null;
}

function onWheel(event) {
  const delta = event.deltaY;
  const factor = delta > 0 ? 0.9 : 1.1;
  const newZoom = Math.max(minZoom, Math.min(maxZoom, zoomLevel.value * factor));
  
  if (newZoom !== zoomLevel.value) {
    // Adjust pan to zoom towards mouse position
    const rect = event.currentTarget.getBoundingClientRect();
    const mouseX = event.clientX - rect.left - padding.left;
    const mouseRatio = mouseX / plotWidth.value;
    
    const oldVisibleCount = Math.ceil(props.data.length / zoomLevel.value);
    const newVisibleCount = Math.ceil(props.data.length / newZoom);
    const panAdjust = (oldVisibleCount - newVisibleCount) * mouseRatio;
    
    zoomLevel.value = newZoom;
    panOffset.value = Math.max(0, panOffset.value + panAdjust);
  }
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
  if (!keyboardEnabled.value) return;
  
  const visibleLength = props.compareMode && visibleDatasets.value.length > 0
    ? visibleDatasets.value[0].visibleData.length
    : visiblePoints.value.length;
  
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

// ChartToolbar 的 @export 转发到 CSV/PNG 导出(依赖 visible* computed,故置于其定义之后)。
const { exportToCSV, exportToPNG } = useChartExport();
function handleExport(format) {
  if (format === 'png') {
    exportToPNG({ canvasWrapper, width: props.width, height: props.height });
  } else {
    exportToCSV({
      compareMode: props.compareMode,
      visibleDatasets: visibleDatasets.value,
      visiblePoints: visiblePoints.value,
    });
  }
}

// Mount/unmount
onMounted(() => {
  if (wrapperRef.value) {
    wrapperRef.value.addEventListener('mouseup', onMouseUp);
  }
  document.addEventListener('keydown', handleKeyDown);
});

onBeforeUnmount(() => {
  if (wrapperRef.value) {
    wrapperRef.value.removeEventListener('mouseup', onMouseUp);
  }
  document.removeEventListener('keydown', handleKeyDown);
});

// Watch for data changes and reset zoom if needed
watch(() => props.data.length, () => {
  if (zoomLevel.value > minZoom) {
    const maxOffset = props.data.length - Math.ceil(props.data.length / zoomLevel.value);
    if (panOffset.value > maxOffset) {
      panOffset.value = Math.max(0, maxOffset);
    }
  }
});
</script>

<style scoped>
.interactive-chart-wrapper {
  position: relative;
  width: 100%;
  background: #0F131C;
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
  stroke: #52525b;
  stroke-width: 1;
  stroke-dasharray: 4 2;
}

.crosshair-dot {
  stroke: #fff;
  stroke-width: 2;
  filter: drop-shadow(0 0 4px currentColor);
}

.zoom-controls {
  position: absolute;
  top: 4.5rem;
  right: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.zoom-btn {
  padding: 0.5rem;
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 0.375rem;
  color: #a1a1aa;
  cursor: pointer;
  transition: all 0.2s;
}

.zoom-btn:hover {
  background: #27272a;
  color: #e4e4e7;
  border-color: #38BDF8;
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
</style>
