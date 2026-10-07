<template>
  <div class="card overflow-hidden">
    <div class="flex items-center justify-between border-b border-surface-800/80 bg-surface-950/30 px-4 py-2.5 text-xs font-medium text-surface-400">
      <span>{{ title }}</span>
      <span class="flex items-center gap-1.5"><span v-if="tone" class="h-1.5 w-1.5 rounded-full" :class="tone"></span><span v-else class="h-1.5 w-1.5 rounded-full bg-accent/80"></span></span>
    </div>
    <div class="px-4 py-3.5">
      <div class="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div class="min-w-0">
          <div class="truncate text-lg font-semibold tracking-tight font-mono tabular-nums text-surface-50 sm:text-2xl">{{ value }}</div>
          <div class="text-muted mt-1">{{ sub }}</div>
        </div>
        <SparklineChart v-if="trend && trend.length > 1" :cpu="trend" :mem="[]" :width="72" :height="28" class="shrink-0 opacity-90" />
      </div>
    </div>
  </div>
</template>

<script setup>
import SparklineChart from './common/SparklineChart.vue';
defineProps({
  title: String,
  value: String,
  sub: String,
  tone: String,
  trend: { type: Array, default: () => [] },
});
</script>
