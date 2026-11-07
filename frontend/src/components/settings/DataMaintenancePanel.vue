<template>
  <section class="space-y-3 border-t border-surface-800 pt-4">
    <h2 class="section-title">指标保留与告警评估</h2>
    <p class="text-sm text-muted">原始指标保留 7 天，7–30 天压缩为 5 分钟粒度；超过 30 天的指标会删除。</p>
    <button class="btn-secondary" :disabled="busy" @click="previewRetention">预览清理影响</button>
    <p v-if="preview" class="text-sm text-surface-300">将删除 {{ preview.deleted30d }} 条过期指标，压缩 {{ preview.compactedRows }} 条历史指标。</p>
    <button v-if="preview" class="btn-secondary" :disabled="busy" @click="confirm = true">执行保留策略</button>
    <div class="flex flex-wrap items-center gap-2">
      <select v-model="containerId" class="input w-auto" aria-label="选择待评估容器"><option value="">选择容器</option><option v-for="container in containers" :key="container.id" :value="container.id">{{ container.label }}</option></select>
      <button class="btn-secondary" :disabled="!containerId || busy" @click="evaluate">只读评估告警</button>
    </div>
    <p v-if="evaluation" class="text-sm text-surface-300" role="status">{{ evaluation.count ? `发现 ${evaluation.count} 条告警建议` : '当前没有触发告警' }}</p>
    <ul v-if="evaluation?.alerts?.length" class="space-y-2 text-sm text-muted"><li v-for="(alert, index) in evaluation.alerts" :key="index">{{ alert.message }}</li></ul>
    <ConfirmDialog :show="confirm" title="执行指标保留策略" :message="`将删除约 ${preview?.deleted30d || 0} 条过期指标，并压缩历史指标。此操作无法撤销；执行时以最新数据为准。`" confirm-text="执行清理" tone="warning" @cancel="confirm = false" @confirm="apply" />
  </section>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client.js';
import { useServicesStore } from '../../stores/services.js';
import { useToastStore } from '../../stores/toast.js';
import ConfirmDialog from '../common/ConfirmDialog.vue';
const store = useServicesStore(); const toast = useToastStore();
const preview = ref(null); const evaluation = ref(null); const busy = ref(false); const confirm = ref(false); const containerId = ref('');
const containers = computed(() => store.projects.filter(p => p.managed).flatMap(p => p.containers.map(c => ({ id: c.id, label: `${p.projectName} / ${c.name}` }))));
async function run(fn) { busy.value = true; try { await fn(); } catch (e) { toast.error(e); } finally { busy.value = false; } }
function previewRetention() { return run(async () => { preview.value = (await api.previewRetentionPolicy()).preview; }); }
function evaluate() { return run(async () => { evaluation.value = await api.evaluateAlerts(containerId.value); }); }
function apply() { confirm.value = false; return run(async () => { const result = await api.applyRetentionPolicy(); toast.success(`已清理 ${result.result.deleted30d} 条过期指标`); preview.value = null; }); }
onMounted(() => { if (!store.projects.length) void store.refresh(); });
</script>
