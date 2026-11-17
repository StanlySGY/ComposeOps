<template>
  <section class="section-panel p-4" aria-label="AI 值守概况">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div><h2 class="flex items-center gap-2 text-sm font-semibold"><ShieldCheck class="h-4 w-4 text-status-ok" />AI 值守</h2><p class="mt-1 text-xs text-surface-400">{{ summary }}</p></div>
      <router-link to="/oncall?from=dashboard" class="btn-secondary btn-sm">查看故障与恢复<ArrowUpRight class="h-3.5 w-3.5" /></router-link>
    </div>
    <div v-if="attention.length" class="mt-3 grid gap-2 lg:grid-cols-3">
      <router-link v-for="item in attention" :key="item.id" :to="{ path: '/oncall', query: { incident: item.id, from: 'dashboard' } }" class="min-w-0 rounded-lg border border-surface-800 p-3 hover:bg-surface-800/40">
        <div class="flex justify-between gap-2 text-xs"><strong class="truncate">{{ item.projectName }}</strong><span class="shrink-0" :class="incidentStatusTone(item.status)">{{ incidentStatusLabel(item.status) }}</span></div><p class="mt-1 truncate text-xs text-surface-400">{{ item.title }}</p>
      </router-link>
    </div>
  </section>
</template>
<script setup>
import { ref, computed, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue';
import { ShieldCheck, ArrowUpRight } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { incidentStatusLabel, incidentStatusTone } from '../lib/incidents.js';
const stats = ref({});
const incidents = ref([]), loading = ref(true), failed = ref(false), running = ref(false);
const attention = computed(() => incidents.value.filter(item => !item.resolvedAt).slice(0, 3));
const summary = computed(() => loading.value ? '正在读取值守状态…' : failed.value ? '值守数据暂不可用，可进入工作台重试。'
  : !running.value ? '值守尚未运行，进入工作台查看状态。' : `${stats.value.open ?? incidents.value.filter(item => !item.resolvedAt).length} 个待处理故障 · ${stats.value.approvals ?? incidents.value.filter(item => item.status === 'awaiting_approval').length} 项等待审批 · ${stats.value.resolved ?? incidents.value.filter(item => item.resolvedAt).length} 项已验证恢复`);
let timer, active = false, controller, version = 0;
async function load() {
  const current = ++version; controller?.abort(); controller = new AbortController();
  try {
    const data = await api.getIncidents({ limit: 100 }, controller.signal);
    if (active && current === version) { incidents.value = data.incidents || []; stats.value = data.stats || {}; failed.value = false; running.value = !!data.observer?.running; }
  } catch { if (active && current === version) failed.value = true; }
  finally { if (active && current === version) loading.value = false; }
}
function start() { if (active) return; active = true; void load(); timer = setInterval(load, 15000); }
function stop() { active = false; version++; clearInterval(timer); controller?.abort(); }
onMounted(start); onActivated(start); onDeactivated(stop); onBeforeUnmount(stop);
</script>
