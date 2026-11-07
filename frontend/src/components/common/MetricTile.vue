<template>
  <component :is="to ? RouterLink : interactive ? 'button' : 'div'" :to="to || undefined" :type="interactive && !to ? 'button' : undefined" class="metric-tile" :class="{ 'metric-action': to || interactive, active }">
    <span v-if="icon" class="metric-icon" :class="tone"><component :is="icon" class="h-5 w-5" aria-hidden="true" /></span>
    <span class="metric-copy"><small>{{ title }}</small><strong>{{ value }}</strong><span v-if="sub" class="metric-caption">{{ sub }}</span></span>
    <SparklineChart v-if="trend.length > 1" :cpu="trend" :cpu-threshold="Infinity" :width="72" :height="30" class="ml-auto shrink-0" />
    <ArrowUpRight v-else-if="to || interactive" class="metric-arrow ml-auto hidden h-4 w-4 shrink-0 2xl:block" aria-hidden="true" />
  </component>
</template>
<script setup>
import { RouterLink } from 'vue-router';
import { ArrowUpRight } from 'lucide-vue-next';
import SparklineChart from './SparklineChart.vue';
defineProps({ title: String, value: [String, Number], sub: String, tone: { type: String, default: 'text-status-info' }, icon: [Object, Function], to: [String, Object], interactive: Boolean, active: Boolean, trend: { type: Array, default: () => [] } });
</script>
