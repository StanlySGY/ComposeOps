<template>
  <section class="panel space-y-3 p-4" aria-label="项目 AI 助手">
    <div><h2 class="section-title">项目 AI 助手</h2><p class="text-sm text-muted">仅访问所选项目。{{ canWrite ? '可查询日志、诊断问题，并审批启动、停止、重启已有容器。' : '可查询状态、日志并诊断问题。当前账号没有容器操作权限。' }}</p></div>
    <form class="space-y-2" @submit.prevent="startTask"><label class="block text-sm">操作项目<select v-model="selected" class="input mt-1 w-full" required><option value="" disabled>选择授权项目</option><option v-for="p in projects" :key="p.hostId + p.id" :value="p.hostId + ':' + p.id">{{ p.hostName }} / {{ p.projectName }}</option></select></label><textarea v-model="message" class="input w-full" aria-label="项目任务" rows="3" maxlength="6000" required placeholder="例如：查看 api 的日志并分析异常原因" /><button class="btn-primary" :disabled="busy || !selected || activeRun">提交任务</button></form>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
    <article v-for="run in runs" :key="run.id" class="space-y-2 rounded-lg border border-surface-700 p-3 text-sm">
      <div class="flex flex-wrap justify-between gap-2"><strong class="break-all">{{ run.goal }}</strong><span class="text-muted">{{ labels[run.status] || run.status }}</span></div>
      <p v-if="run.checkpoint?.budget" class="text-xs text-muted">任务用量 {{ run.checkpoint.budget.used.toLocaleString() }} / {{ run.checkpoint.budget.limits.total.toLocaleString() }}{{ run.checkpoint.budget.estimated ? '（含保守估算）' : '' }}</p>
      <p class="text-muted">{{ run.error || run.checkpoint?.content }}</p><p v-if="run.result?.finalContent" class="whitespace-pre-wrap break-words">{{ run.result.finalContent }}</p>
      <div class="flex flex-wrap gap-2"><button v-if="active(run)" class="btn-secondary" :disabled="busy" @click="act(run, 'stop')">停止任务</button><button v-if="['failed','interrupted'].includes(run.status)" class="btn-secondary" :disabled="busy" @click="act(run, 'resume', { revision: run.revision })">核对并继续</button><button class="btn-secondary" :disabled="busy" @click="inspect(run)">执行证据</button></div>
      <div v-if="run.approval" class="rounded border border-status-warn/40 p-3"><p>{{ run.approval.description }}</p><pre class="my-2 overflow-auto whitespace-pre-wrap break-all text-xs">{{ JSON.stringify(run.approval.params, null, 2) }}</pre><div class="flex gap-2"><button class="btn-primary" :disabled="busy" @click="approve(run, true)">批准此步骤</button><button class="btn-secondary" :disabled="busy" @click="approve(run, false)">拒绝</button></div></div>
    </article>
    <BaseModal :show="!!detail" title="任务执行证据" @close="closeDetail"><div v-if="detail" class="max-h-[70vh] space-y-3 overflow-auto p-4"><p class="text-sm text-muted">结果未知时请先核对实际容器；记录证据不会执行重试。</p><article v-for="effect in detail.effects" :key="effect.id" class="border-b border-surface-700 pb-3"><strong>{{ effect.tool }} · {{ effect.status }}</strong><pre class="my-2 overflow-auto whitespace-pre-wrap break-all text-xs">{{ JSON.stringify(effect, null, 2) }}</pre><form v-if="canWrite && ['unknown','started'].includes(effect.status) && !active(detail.run)" class="space-y-2" @submit.prevent="reconcile(effect)"><select v-model="outcomes[effect.id]" class="input w-full" aria-label="核对结论" required><option value="applied">确认已生效</option><option value="not_applied">确认未生效</option><option value="failed">确认失败，不再重试</option></select><textarea v-model="evidence[effect.id]" class="input w-full" aria-label="核对证据" minlength="10" maxlength="4000" required placeholder="检查时间、节点、容器及实际结果" /><button class="btn-secondary" :disabled="busy">保存证据</button></form></article><p v-if="!detail.effects.length" class="text-muted">尚无写操作</p></div></BaseModal>
  </section>
</template>
<script setup>
import { ref, computed } from 'vue';
import { useAgentTaskPanel } from '../../composables/useAgentTaskPanel.js';
import { api } from '../../api/client.js';
import BaseModal from '../common/BaseModal.vue';
const props = defineProps({ projects: { type: Array, default: () => [] }, canWrite: Boolean });
const selected = ref(''), message = ref(''), runs = ref([]), detail = ref(null), outcomes = ref({}), evidence = ref({});
const labels = { running: '执行中', waiting_approval: '等待审批', stopping: '正在停止', completed: '本轮完成', failed: '失败', interrupted: '可继续', needs_reconciliation: '需要核对', awaiting_results: '等待结果' };
const active = run => ['running','waiting_approval','stopping'].includes(run.status);
const activeRun = computed(() => runs.value.some(active));
let detailGeneration = 0;
const { busy, error, action: work, cancelActionRead } = useAgentTaskPanel({
  scope: () => JSON.stringify([selected.value, props.canWrite, props.projects.map(p => [p.hostId, p.id]).sort()]),
  read: signal => api.getMemberRuns(signal),
  apply: result => { runs.value = result.runs || []; },
  interval: () => runs.value.some(run => active(run) || run.status === 'awaiting_results') ? 3000 : 30000,
  reset: () => { runs.value = []; closeDetail(); },
});
function closeDetail() {
  detailGeneration++;
  cancelActionRead();
  detail.value = null;
  outcomes.value = {};
  evidence.value = {};
}
const startTask = () => work(async ({ isCurrent }) => {
  const project = props.projects.find(p => p.hostId + ':' + p.id === selected.value);
  if (!project) throw new Error('请选择当前授权项目');
  if (activeRun.value) return;
  const submitted = message.value, selection = selected.value;
  await api.createMemberRun({ hostId: project.hostId, projectId: project.id, message: submitted });
  if (isCurrent() && selection === selected.value && submitted === message.value) message.value = '';
});
const act = (run, action, body = {}) => work(() => api.memberRunAction(run.id, action, body));
const approve = (run, approved) => act(run, 'approve', { executionId: run.approval.executionId, toolCallId: run.approval.toolCallId, approved });
const inspect = run => work(async ({ signal, isCurrent }) => {
  const current = ++detailGeneration;
  const result = await api.getMemberRun(run.id, signal);
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
  return work(async ({ signal, isCurrent }) => {
    await api.memberRunAction(runId, 'reconcile/' + encodeURIComponent(effect.id), payload);
    if (!isCurrent() || current !== detailGeneration) return;
    const result = await api.getMemberRun(runId, signal);
    if (isCurrent() && current === detailGeneration) {
      detail.value = result;
      delete outcomes.value[effect.id];
      delete evidence.value[effect.id];
    }
  });
}
</script>
