<template>
  <span class="resource-value" data-label="整机 CPU">{{ metricValue(value.cpuHostPercent) }}</span>
  <span class="resource-value" data-label="内存">{{ bytes(value.memUsage) }}</span>
  <span class="resource-value" data-label="网络 收 / 发">{{ rate(value.networkRx) }}<small>{{ rate(value.networkTx) }}</small></span>
  <span class="resource-value" data-label="磁盘 读 / 写">{{ rate(value.diskRead) }}<small>{{ rate(value.diskWrite) }}</small></span>
</template>
<script setup>
import { metricValue, formatResourceBytes as bytes } from '../../lib/infrastructure.js';
defineProps({ value: { type: Object, required: true } });
const rate = value => metricValue(value, 'bytes/s');
</script>
