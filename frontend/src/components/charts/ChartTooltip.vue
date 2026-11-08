/**
 * ChartTooltip.vue —— 悬浮提示(单指标 / 多指标)。
 * 从 InteractiveChart.vue 拆分。
 */
<template>
  <div v-if="visible" ref="tooltipElement"
       class="chart-tooltip"
       :style="{ left: `${x}px`, top: `${y}px` }">
    <template v-if="multi && visibleRows.length > 0">
      <div class="tooltip-time">{{ formatTime(visibleRows[0].visibleData[hoverIndex]?.timestamp) }}</div>
      <div v-for="(dataset, idx) in visibleRows" :key="`tooltip-${idx}`" class="tooltip-metric">
        <span class="tooltip-metric-dot" :style="{ backgroundColor: dataset.color }" />
        <span class="tooltip-metric-label">{{ dataset.label }}:</span>
        <span class="tooltip-metric-value">{{ formatValue(dataset.visibleData[hoverIndex].value) }} {{ dataset.unit }}</span>
      </div>
    </template>
    <template v-else-if="point">
      <div class="tooltip-time">{{ formatTime(point.timestamp) }}</div>
      <div class="tooltip-value">{{ formatValue(point.value) }}{{ unit }}</div>
    </template>
  </div>
</template>

<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  multi: { type: Boolean, default: false },
  datasets: { type: Array, default: () => [] },
  hoverIndex: { type: Number, default: null },
  point: { type: Object, default: null },
  unit: { type: String, default: '' },
});
const emit = defineEmits(['resize']);
const tooltipElement = ref(null);
let observer;
let lastSize = '';
function measure() {
  const rect = tooltipElement.value?.getBoundingClientRect();
  if (!rect?.width || !rect?.height) return;
  const key = `${rect.width}:${rect.height}`;
  if (key === lastSize) return;
  lastSize = key;
  emit('resize', { width: rect.width, height: rect.height });
}
watch(tooltipElement, element => {
  observer?.disconnect();
  if (!element) return;
  measure();
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure);
    observer.observe(element);
  }
}, { flush: 'post' });
onBeforeUnmount(() => observer?.disconnect());

/** 当前可见的 tooltip 行:筛掉 hoverIndex 无数据的 dataset,消除 v-for+v-if 混用。 */
const visibleRows = computed(() =>
  (props.datasets || []).filter((d) => d.visibleData?.[props.hoverIndex]),
);

function formatValue(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return Number(value).toFixed(1);
}
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
</script>

<style scoped>
.chart-tooltip {
  position: absolute;
  background: var(--color-surface-900);
  border: 1px solid var(--color-accent);
  border-radius: 0.375rem;
  padding: 0.5rem 0.75rem;
  pointer-events: none;
  width: max-content;
  max-width: min(200px, 100%);
  overflow-wrap: anywhere;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.tooltip-time {
  font-size: 0.75rem;
  color: var(--color-surface-400);
  margin-bottom: 0.25rem;
}

.tooltip-value {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-accent);
}

.tooltip-metric {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.25rem;
  font-size: 0.875rem;
}

.tooltip-metric-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  flex-shrink: 0;
}

.tooltip-metric-label {
  color: var(--color-surface-400);
  font-weight: 500;
}

.tooltip-metric-value {
  color: var(--color-surface-100);
  font-weight: 600;
}
</style>

/**
 * ChartTooltip.vue —— 悬浮提示(单指标 / 多指标)。
 * 从 InteractiveChart.vue 拆分。
 */
