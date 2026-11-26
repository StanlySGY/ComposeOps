<template>
  <svg class="sparkline" :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient :id="cpuGradientId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#6366f1" stop-opacity="0.9" />
        <stop offset="100%" stop-color="#6366f1" stop-opacity="0.05" />
      </linearGradient>
      <linearGradient :id="memGradientId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--ok)" stop-opacity="0.9" />
        <stop offset="100%" stop-color="var(--ok)" stop-opacity="0.05" />
      </linearGradient>
    </defs>
    <path v-if="cpuPath" :d="areaPath(cpuPath)" :fill="`url(#${cpuGradientId})`" class="spark-area" />
    <path v-if="cpuPath" :d="linePath(cpuPath)" fill="none" :stroke="alertCpu ? 'var(--danger)' : 'var(--color-indigo-400)'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    <path v-if="memPath" :d="areaPath(memPath)" :fill="`url(#${memGradientId})`" class="spark-area" />
    <path v-if="memPath" :d="linePath(memPath)" fill="none" :stroke="alertMem ? 'var(--danger)' : 'var(--ok)'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
  </svg>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  cpu: { type: Array, default: () => [] },
  mem: { type: Array, default: () => [] },
  width: { type: Number, default: 72 },
  height: { type: Number, default: 22 },
  cpuThreshold: { type: Number, default: 85 },
  memThreshold: { type: Number, default: 90 },
});
const uid = Math.random().toString(36).slice(2, 8);
const cpuGradientId = `spark-cpu-${uid}`;
const memGradientId = `spark-mem-${uid}`;
const padX = 1;
const padY = 2;

const cpuPath = computed(() => buildPath(props.cpu));
const memPath = computed(() => buildPath(props.mem));
const alertCpu = computed(() => props.cpu.some((v) => v >= props.cpuThreshold));
const alertMem = computed(() => props.mem.some((v) => v >= props.memThreshold));

function buildPath(values) {
  if (!values || values.length < 2) return '';
  const width = props.width;
  const height = props.height;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  return values.map((value, index) => {
    const x = padX + (width - padX * 2) * (index / (values.length - 1));
    const y = height - padY - (height - padY * 2) * ((value - min) / range);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}
function areaPath(path) {
  if (!path) return '';
  const lastX = props.width - padX;
  return `${path} L${lastX},${props.height - padY} L${padX},${props.height - padY} Z`;
}
function linePath(path) { return path; }
</script>
