<template>
  <section v-if="rows.length || error" class="agent-operations" aria-label="本会话持久任务">
    <div class="flex items-center justify-between gap-2"><strong class="text-xs">本会话持久任务</strong><button class="text-link text-xs" :disabled="loading" @click="reload">{{ loading ? '读取中…' : '刷新状态' }}</button></div>
    <p v-if="error" class="mt-2 text-xs text-status-warn" role="alert">{{ error }}</p>
    <ul v-if="rows.length" class="mt-2 space-y-2">
      <li v-for="row in rows" :key="row.operation.kind + row.operation.id" class="rounded-lg border border-surface-700 p-2 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2"><strong>{{ kindLabel(row.operation.kind) }}</strong><span :class="row.operation.businessVerified ? 'text-status-ok' : 'text-status-warn'">{{ statusLabel(row.operation) }}</span></div>
        <p class="mt-1 break-all text-surface-400">{{ row.operation.hostId }} · {{ row.operation.projectId }}</p>
        <p class="mt-1 leading-5">{{ row.verification.reason }}</p>
        <router-link class="text-link mt-1 inline-block" :to="destination(row.operation)">查看执行证据</router-link>
      </li>
    </ul>
  </section>
</template>
<script setup>
import { ref, watch } from 'vue';
import { api } from '../../api/client.js';
import { useAgentTaskPanel } from '../../composables/useAgentTaskPanel.js';
const props = defineProps({ sessionId: { type: [String, Number], default: null }, running: Boolean });
const rows = ref([]);
const kindLabel = kind => ({ change: '应用发布', 'business-backup': '业务备份', 'business-run': '业务恢复演练', onboarding: '应用接入' })[kind] || '运维任务';
const statusLabel = op => op.businessVerified ? '业务验收通过' : op.needsReconciliation ? '需要核对' : ({ queued: '已排队', running: '执行中', checking: '检查中', executing: '执行中', verifying: '验收中', rolling_back: '回退中', verifying_rollback: '回退验收中', verified: '备份已校验', rolled_back: '已回退', failed: '未通过', blocked: '已阻止', cancelled: '已取消', applying: '正在接入', partial: '部分接入', complete: '接入完成', closed: '已关闭' })[op.status] || '尚未验收';
const destination = op => ({ path: '/reliability', query: { tab: ['business', 'onboarding', 'changes', 'releases'].includes(op.view) ? op.view : op.kind.startsWith('business-') ? 'business' : op.kind === 'onboarding' ? 'onboarding' : 'releases', operationId: op.id, hostId: op.hostId, projectId: op.projectId } });
const { error, loading, reload } = useAgentTaskPanel({
  scope: () => props.sessionId,
  read: signal => api.getAgentSessionOperations(props.sessionId, signal),
  apply: result => { rows.value = result.operations || []; },
  interval: () => props.running || rows.value.some(row => row.operation.running) ? 5000 : 0,
  reset: () => { rows.value = []; },
});
watch(() => props.running, reload);
</script>
<style scoped>
.agent-operations { margin: .5rem 1rem; padding: .75rem; border: 1px solid var(--color-surface-700, #303641); border-radius: .75rem; max-height: min(16rem, 24dvh); overflow: auto; flex-shrink: 0; }
</style>
