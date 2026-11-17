<template>
  <section class="section-panel p-4 sm:p-5 min-w-0">
    <div class="flex flex-wrap justify-between gap-3"><h3 class="font-semibold">关联故障分析</h3><button class="btn-secondary btn-sm" :disabled="loading" @click="load">{{ loading ? '正在关联…' : data ? '刷新关联证据' : '关联日志、指标与依赖' }}</button></div>
    <p class="mt-2 text-xs leading-6 text-surface-400">在同节点、同应用范围内关联探针、日志、指标、变更与调用链。依赖原因是待验证假设，时间相关不等于因果。</p>
    <p v-if="error" class="alert-error mt-3" role="alert">{{ error }}</p>
    <template v-if="data">
      <p class="mt-3 text-xs text-surface-400">{{ data.scope.hostId }} / {{ data.scope.projectId }} · {{ time(data.start) }} 至 {{ time(data.end) }} · 采集 {{ time(data.collectedAt) }}</p>
      <ul v-if="data.gaps.length" class="mt-3 space-y-1 text-xs text-status-warn"><li v-for="gap in data.gaps" :key="gap">{{ gap }}</li></ul>
      <div class="mt-4"><h4 class="text-sm font-semibold">当前依赖</h4><p v-if="!data.dependencies.length" class="mt-2 text-xs text-surface-400">未取得声明式依赖，不表示应用没有外部依赖。</p><p v-for="edge in data.dependencies" :key="edge.source + ':' + edge.target" class="mt-2 text-xs">{{ edge.source }} → {{ edge.target }}</p></div>
      <article v-for="(hypothesis, i) in data.hypotheses" :key="i" class="mt-4 border-l-2 border-amber-500/60 pl-3"><p class="text-sm">待验证假设：{{ hypothesis.claim }}</p><p class="mt-2 text-xs text-surface-400">{{ hypothesis.qualification }}</p><div class="mt-2 flex flex-wrap gap-2"><button v-for="id in hypothesis.evidenceIds" :key="id" class="text-link text-xs break-all text-left" @click="source = data.timeline.find(row => row.id === id)">查看来源 {{ shortId(id) }}</button></div></article>
      <details v-if="data.traces.length" class="mt-4"><summary class="text-sm cursor-pointer">关联请求（{{ data.traces.length }} 条 trace）</summary><div v-for="trace in data.traces" :key="trace.traceId" class="mt-3 text-xs"><p class="font-mono break-all">{{ trace.traceId }}</p><p class="mt-1 text-surface-400">{{ trace.services.join(' → ') }} · {{ trace.evidenceIds.length }} 条记录；服务列表不表示调用顺序</p></div></details>
      <div class="mt-4 flex flex-wrap items-center justify-between gap-3"><h4 class="text-sm font-semibold">关联时间线</h4><label class="text-xs">来源 <select v-model="kind" class="input ml-2"><option value="">全部</option><option v-for="item in kinds" :key="item" :value="item">{{ kindLabel(item) }}</option></select></label></div>
      <ol class="mt-3 max-h-[32rem] space-y-4 overflow-auto"><li v-for="entry in timeline" :key="entry.id" class="border-l border-surface-700 pl-3"><p class="text-xs text-surface-400">{{ time(entry.at) }} · {{ entry.serviceName || '应用' }} · {{ kindLabel(entry.kind) }}</p><p class="mt-1 text-sm break-words">{{ entry.summary }}</p><button class="mt-1 text-link text-xs" @click="source = entry">查看来源 {{ shortId(entry.id) }}</button></li></ol><p class="mt-3 text-xs leading-6 text-surface-400">{{ data.limitations }}</p>
    </template>
    <BaseModal :show="!!source" title="关联来源证据" @close="source = null"><template v-if="source"><p class="text-xs break-all">{{ source.id }} · {{ time(source.at) }}</p><pre class="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-all text-xs">{{ JSON.stringify(source.data, null, 2) }}</pre></template></BaseModal>
  </section>
</template>
<script setup>
import { ref, computed, onMounted, onActivated, onDeactivated, onBeforeUnmount, watch } from 'vue';
import { api } from '../api/client.js';
import BaseModal from './common/BaseModal.vue';
const props = defineProps({ incidentId: { type: String, required: true } });
const data = ref(null), source = ref(null), error = ref(''), loading = ref(false), kind = ref('');
let active = false, epoch = 0, controller;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
const shortId = id => id.length > 30 ? id.slice(0, 26) + '…' : id;
const kindLabel = value => ({ trace: '调用链', log: '遥测日志', logs: '故障日志', logs_snapshot: '当前日志快照', dependency: '依赖关系', metric: '资源指标', probe: '独立探针', change: '发布变更', incident: '关联故障', container: '容器状态', observation: '状态观测' })[value] || '其他证据';
const kinds = computed(() => [...new Set((data.value?.timeline || []).map(row => row.kind))]);
const timeline = computed(() => (data.value?.timeline || []).filter(row => !kind.value || row.kind === kind.value));
async function load() {
  if (!active || loading.value) return; const current = ++epoch, id = props.incidentId; controller = new AbortController(); loading.value = true;
  try { const value = await api.getIncidentCorrelation(id, controller.signal); if (active && current === epoch && id === props.incidentId) { data.value = value; error.value = ''; } }
  catch (cause) { if (active && current === epoch) error.value = cause.message; }
  finally { if (current === epoch) loading.value = false; }
}
function stop() { active = false; controller?.abort(); epoch++; loading.value = false; source.value = null; }
watch(() => props.incidentId, () => { controller?.abort(); epoch++; data.value = null; source.value = null; error.value = ''; kind.value = ''; loading.value = false; });
onMounted(() => { active = true; }); onActivated(() => { active = true; }); onDeactivated(stop); onBeforeUnmount(stop);
</script>
