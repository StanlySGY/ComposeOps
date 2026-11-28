<template>
  <section v-if="runs.length || error" class="agent-runs" aria-label="任务进度与恢复">
    <details :open="runs.some(run => run.status !== 'completed')"><summary class="cursor-pointer text-xs font-semibold">任务进度与恢复 <span class="text-muted">{{ runs.length }}<template v-if="runs[0]"> · {{ labels[runs[0].status] || runs[0].status }}</template></span></summary>
      <p v-if="error" class="mt-2 text-xs text-status-warn" role="alert">{{ error }}</p>
      <article v-for="run in runs.slice(0, showAll ? 30 : 3)" :key="run.id" class="mt-2 rounded-lg border border-surface-700 p-2 text-xs">
        <div class="flex items-start justify-between gap-2"><strong class="min-w-0 break-words">{{ run.goal.slice(0, 100) }}</strong><span class="shrink-0" :class="run.status === 'completed' ? 'text-status-ok' : 'text-status-warn'">{{ labels[run.status] || run.status }}</span></div>
        <p class="mt-1 text-muted">{{ run.error || run.checkpoint?.content || '目标与执行记录已保存' }}</p>
        <p v-if="run.checkpoint?.budget" class="mt-1 text-muted" :class="{ 'text-status-warn': run.checkpoint.budget.warning }">任务用量 {{ run.checkpoint.budget.used.toLocaleString() }} / {{ run.checkpoint.budget.limits.total.toLocaleString() }} · 请求 {{ run.checkpoint.budget.attempts }} 次{{ run.checkpoint.budget.estimated ? ' · 含保守估算' : '' }}</p>
        <p v-if="active(run)" class="mt-1 text-muted">刷新或关闭页面后任务仍保留；需要审批时会等待确认。</p>
        <div class="mt-2 flex flex-wrap gap-2"><button class="text-link" :disabled="busy" @click="inspect(run)">查看记录</button><button v-if="['failed','interrupted'].includes(run.status)" class="text-link" :disabled="busy || running" @click="resume(run)">核对并继续</button><button v-if="active(run)" class="text-status-warn" :disabled="busy" @click="stop(run)">停止任务</button></div>
        <div v-if="run.approval && !running" class="mt-2 rounded-lg border border-status-warn/30 p-2"><p class="font-medium">需要确认：{{ run.approval.description || run.approval.tool }}</p><pre class="my-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">{{ JSON.stringify(run.approval.params, null, 2) }}</pre><div class="flex gap-2"><button class="btn-primary" :disabled="busy" @click="approve(run, true)">批准此步骤</button><button class="btn-secondary" :disabled="busy" @click="approve(run, false)">拒绝</button></div></div>
      </article>
      <button v-if="runs.length > 3" class="text-link mt-2 text-xs" @click="showAll = !showAll">{{ showAll ? '收起历史任务' : '查看历史任务' }}</button>
    </details>
    <BaseModal :show="!!detail" title="持久任务执行记录" size-class="max-w-3xl" @close="closeDetail"><div v-if="detail" class="max-h-[75vh] space-y-3 overflow-auto p-4 text-sm"><p class="break-words">{{ detail.run.goal }}</p><p class="text-muted">节点：{{ detail.run.context.hostId }} · {{ labels[detail.run.status] }}</p><p v-if="detail.run.error" class="alert-warning">{{ detail.run.error }}</p><p v-if="detail.run.result?.finalContent" class="whitespace-pre-wrap break-words">{{ detail.run.result.finalContent }}</p>
      <article v-for="effect in detail.effects" :key="effect.id" class="rounded-lg border border-surface-700 p-3"><strong>{{ effect.tool }}</strong><span class="ml-2 text-xs text-muted">{{ effectLabels[effect.status] || effect.status }}</span><pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{{ JSON.stringify({ params: effect.params, result: effect.result, evidence: effect.evidence }, null, 2) }}</pre>
        <form v-if="['unknown','started'].includes(effect.status) && !active(detail.run)" class="mt-3 space-y-2" @submit.prevent="reconcile(effect)"><p class="text-status-warn">请先检查实际资源；无法确认时保持未知。此记录不会执行任何重试。</p><label class="block">核对结论<select v-model="outcomes[effect.id]" class="input mt-1 w-full" required><option value="" disabled>选择已确认的结果</option><option value="applied">已生效，后续跳过此步骤</option><option value="not_applied">确定未生效，可重新审批执行</option><option value="failed">已失败且影响已核对，不重试此步骤</option></select></label><label class="block">资源与检查证据<textarea v-model="evidence[effect.id]" class="input mt-1 w-full" required minlength="10" maxlength="4000" rows="3" placeholder="记录检查的节点、资源、时间和实际结果" /></label><button class="btn-secondary" :disabled="busy">保存核对记录</button></form>
      </article><p v-if="!detail.effects.length" class="text-muted">尚未开始写操作；恢复后仍需按审批规则确认。</p></div></BaseModal>
  </section>
</template>
<script setup>
import { ref, watch } from 'vue';
import { useAgentTaskPanel } from '../../composables/useAgentTaskPanel.js';
import BaseModal from '../common/BaseModal.vue';
import { api } from '../../api/client.js';
const props = defineProps({ sessionId: { type: [String, Number], default: null }, running: Boolean });
const runs = ref([]), detail = ref(null), showAll = ref(false), outcomes = ref({}), evidence = ref({});
const labels = { running: '执行中', waiting_approval: '等待审批', stopping: '正在停止', awaiting_results: '等待后台结果', completed: '本轮完成', failed: '执行失败', interrupted: '可继续', needs_reconciliation: '需要核对' };
const effectLabels = { succeeded: '已记录结果', unknown: '结果未知', started: '已开始', resolved_applied: '人工确认已生效', resolved_not_applied: '人工确认未生效', resolved_failed: '人工确认失败' };
const active = run => ['running','waiting_approval','stopping'].includes(run.status);
let detailGeneration = 0;
const { busy, error, reload, action, cancelActionRead } = useAgentTaskPanel({
  scope: () => props.sessionId,
  read: signal => api.getAgentRuns(props.sessionId, signal),
  apply: result => { runs.value = result.runs || []; },
  interval: () => props.running || runs.value.some(run => active(run) || run.status === 'awaiting_results') ? 3000 : 30000,
  reset: () => { runs.value = []; showAll.value = false; closeDetail(); },
});
function closeDetail() {
  detailGeneration++;
  cancelActionRead();
  detail.value = null;
  outcomes.value = {};
  evidence.value = {};
}
const resume = run => action(() => api.resumeAgentRun(run.id, run.revision));
const stop = run => action(() => api.stopAgentRun(run.id));
const approve = (run, approved) => action(() => api.agentApprove({ executionId: run.approval.executionId, toolCallId: run.approval.toolCallId, approved }));
const inspect = run => action(async ({ signal, isCurrent }) => {
  const current = ++detailGeneration;
  const result = await api.getAgentRun(run.id, signal);
  if (isCurrent() && current === detailGeneration) {
    detail.value = result;
    outcomes.value = {};
    evidence.value = {};
  }
});
function reconcile(effect) {
  if (!detail.value) return;
  const runId = detail.value.run.id, current = detailGeneration;
  const payload = { outcome: outcomes.value[effect.id], evidence: evidence.value[effect.id] };
  return action(async ({ signal, isCurrent }) => {
    await api.reconcileAgentEffect(runId, effect.id, payload);
    if (!isCurrent() || current !== detailGeneration) return;
    const result = await api.getAgentRun(runId, signal);
    if (isCurrent() && current === detailGeneration) {
      detail.value = result;
      delete outcomes.value[effect.id];
      delete evidence.value[effect.id];
    }
  });
}
watch(() => props.running, reload);
</script>
<style scoped>
.agent-runs { margin: .5rem 1rem; padding: .6rem .75rem; border: 1px solid var(--color-surface-700, #303641); border-radius: .75rem; max-height: min(18rem, 28dvh); overflow: auto; flex-shrink: 0; }
</style>
