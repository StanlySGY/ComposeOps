<template>
  <div ref="element" class="resource-trend">
    <p v-if="!points.length" class="text-muted py-8 text-center" role="status">此时间范围暂无采样；接入后会持续累积历史。</p>
    <svg v-else :viewBox="`0 0 ${width} 180`" role="img" :aria-label="`${label}，${points.length} 个采样桶；断线处保留空隙`">
      <title>{{ label }}</title>
      <path :d="`M42 16H${width - 12}M42 84H${width - 12}M42 152H${width - 12}`" class="trend-grid" />
      <text x="42" y="10">{{ axisMax }}</text><text x="16" y="155">0</text>
      <polyline v-for="(segment, index) in chart.segments" :key="index" :points="segment.map(p => `${p.x},${p.y}`).join(' ')" class="trend-line" />
      <circle v-for="(point, index) in singles" :key="index" :cx="point.x" :cy="point.y" r="3" class="trend-dot" />
      <rect x="42" y="12" :width="width - 54" height="144" fill="transparent" @mousemove="hover" @mouseleave="selected = null" @click="hover" />
      <line v-if="selected" :x1="selected.x" :x2="selected.x" y1="12" y2="152" class="trend-cursor" />
      <text x="42" y="175">{{ time(start) }}</text><text :x="width - 12" y="175" text-anchor="end">{{ time(end) }}</text>
    </svg>
    <p class="trend-summary" role="status">{{ selected ? `${time(selected.point.timestamp)} · ${metricValue(selected.point.value, unit)} · 桶内峰值 ${metricValue(selected.point.max, unit)}` : `曲线为采样均值 · ${unitLabel} · 悬停或点击查看峰值` }}</p>
  </div>
</template>
<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { metricValue, trendSegments } from '../../lib/infrastructure.js';
const props = defineProps({ points: { type: Array, default: () => [] }, interval: { type: Number, default: 10000 }, start: Number, end: Number, label: String, unit: { type: String, default: '%' } });
const element = ref(null), width = ref(640), selected = ref(null);
let observer;
const chart = computed(() => trendSegments(props.points, props.interval, props.start, props.end, width.value, 180));
const singles = computed(() => chart.value.segments.filter(segment => segment.length === 1).flat());
const axisMax = computed(() => props.unit === '%' ? `${Math.ceil(chart.value.max)}%` : metricValue(chart.value.max, props.unit));
const unitLabel = computed(() => props.unit === '%' ? '百分比' : props.unit === 'bytes/s' ? '每秒速率' : '实际用量');
function time(value) { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function hover(event) { const x = event.clientX - event.currentTarget.ownerSVGElement.getBoundingClientRect().left; selected.value = chart.value.segments.flat().reduce((best, p) => !best || Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best, null); }
onMounted(() => { if (typeof ResizeObserver === 'undefined') return; observer = new ResizeObserver(entries => { width.value = Math.max(240, entries[0].contentRect.width); }); observer.observe(element.value); });
onBeforeUnmount(() => observer?.disconnect());
</script>
<style scoped>
.resource-trend svg { width: 100%; display: block; overflow: visible; }
.resource-trend text { fill: var(--text-soft); font-size: 11px; }
.trend-grid { fill: none; stroke: var(--line-subtle); stroke-width: 1; }
.trend-line { fill: none; stroke: var(--color-link); stroke-width: 2; }
.trend-dot { fill: var(--color-link); }.trend-cursor { stroke: var(--text-soft); stroke-dasharray: 3 4; }
.trend-summary { min-height: 32px; font-size: 11px; color: var(--text-soft); margin-top: 8px; }
</style>
