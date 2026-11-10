<template>
  <div class="page-shell oncall-view">
    <div class="page-header">
      <div><div class="eyebrow">持续观察 · 受控处置 · 验证恢复</div><h1 class="page-title">AI 值守</h1><p class="page-subtitle">跟踪已纳管应用的故障，让每次处置都有证据和结果。</p></div>
      <div class="flex flex-wrap gap-2"><router-link to="/reliability?from=oncall" class="btn-secondary">可靠性目标</router-link><button class="btn-secondary" :disabled="loading || busy" @click="refresh"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button></div>
    </div>
    <div class="oncall-status text-xs text-surface-400" role="status">
      <span class="flex items-center gap-2"><span class="status-dot" :class="observerHealthy ? 'bg-status-ok' : 'bg-status-warn'"></span>{{ observerHealthy ? '只读值守运行中' : '值守状态待确认' }}</span>
      <span>最近观测 {{ time(observer.last?.checkedAt) }}</span><span>{{ observer.autoDiagnosis ? '自动 AI 诊断已开启' : 'AI 诊断由你发起' }}</span>
      <span v-if="observer.last?.failures" class="text-status-warn">{{ observer.last.failures }} 个目标观测失败</span>
    </div>
    <p v-if="error" class="alert-error" role="alert">{{ error }}<button class="text-link" :disabled="loading" @click="refresh">重试</button></p>
    <p v-if="notice" class="text-sm text-status-ok" role="status">{{ notice }}</p>
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div v-for="metric in metrics" :key="metric.label" class="section-panel p-4"><div class="text-xs text-surface-400">{{ metric.label }}</div><strong class="mt-2 block text-2xl tabular-nums" :class="metric.tone">{{ metric.value }}</strong></div>
    </div>
    <div class="oncall-columns">
      <section class="section-panel min-w-0" aria-label="故障列表">
        <div class="flex flex-wrap gap-2 border-b border-surface-800 p-3">
          <label class="min-w-0 flex-1"><span class="sr-only">搜索故障</span><input v-model="query" class="input w-full" placeholder="项目、节点或故障…" /></label>
          <label><span class="sr-only">故障范围</span><select v-model="filter" class="input"><option value="open">待处理</option><option value="all">全部记录</option><option value="resolved">已恢复</option></select></label>
        </div>
        <p class="px-3 pt-2 text-xs text-surface-400">列表展示最近 100 条，优先显示未恢复故障；上方统计包含全部记录。</p>
        <div v-if="loading && !loaded" class="p-8 text-sm text-surface-400">正在读取故障事件…</div>
        <EmptyState v-else-if="!visibleIncidents.length && !error" compact icon="ShieldCheck" :title="filter === 'open' ? '没有待处理故障' : '没有匹配记录'" description="异常退出、反复重启和健康检查失败会自动出现在这里。只检查已纳管应用。" />
        <button v-for="item in visibleIncidents" :key="item.id" class="incident-item" :class="{ selected: selectedId === item.id }" :aria-current="selectedId === item.id ? 'true' : undefined" :disabled="busy" @click="select(item.id)">
          <div class="flex items-center justify-between gap-2"><strong class="truncate text-sm text-surface-200">{{ item.projectName }}</strong><span class="shrink-0 text-xs" :class="incidentStatusTone(item.status)">{{ incidentStatusLabel(item.status) }}</span></div>
          <p class="mt-2 break-words text-sm text-surface-300">{{ item.title }}</p>
          <p class="mt-2 text-xs text-surface-400">{{ item.hostId }} · {{ time(item.openedAt) }}</p>
        </button>
      </section>
      <section class="min-w-0 space-y-4" aria-label="故障详情" :aria-busy="detailLoading">
        <p v-if="detailError" class="alert-error" role="alert">{{ detailError }}<button class="text-link" @click="loadDetail">重试详情</button></p>
        <div v-if="detailLoading && !incident" class="section-panel p-8 text-sm text-surface-400">正在读取证据…</div>
        <EmptyState v-else-if="!incident && !detailError" class="section-panel p-6" icon="FileSearch" title="选择一个故障" description="查看观测证据、诊断假设和恢复进展。" />
        <template v-if="incident">
          <div class="section-panel p-4 sm:p-5">
            <div class="flex flex-wrap items-start justify-between gap-3"><div class="min-w-0"><p class="text-xs text-surface-400">{{ incident.hostId }} / {{ incident.projectName }} / {{ incident.serviceName || '容器' }}</p><h2 class="mt-2 break-words text-lg font-semibold">{{ incident.title }}</h2></div><span class="status-badge" :class="incidentStatusTone(incident.status)">{{ incidentStatusLabel(incident.status) }}</span></div>
            <div class="mt-4 flex flex-wrap gap-2"><router-link class="btn-secondary btn-sm" :to="logsTarget"><ScrollText class="h-3.5 w-3.5" />查看日志</router-link><router-link class="btn-secondary btn-sm" :to="ticketTarget"><History class="h-3.5 w-3.5" />任务与审计</router-link><router-link class="btn-secondary btn-sm" :to="agentTarget"><Bot class="h-3.5 w-3.5" />继续调查</router-link><button v-if="!incident.resolvedAt && !incident.closedAt" class="btn-secondary btn-sm" :disabled="busy" @click="closeDraft = { id: incident.id, reason: '' }">人工关闭事件</button></div>
            <dl class="mt-4 grid grid-cols-2 gap-3 border-t border-surface-800 pt-4 text-xs"><div><dt class="text-surface-400">容器状态</dt><dd class="mt-1">{{ incident.latest.state }} · {{ incident.latest.health || '未配置健康检查' }}</dd></div><div><dt class="text-surface-400">最近证据</dt><dd class="mt-1">{{ time(incident.observedAt) }}</dd></div></dl>
            <p v-if="incident.closedAt" class="mt-3 text-xs text-status-warn">关闭原因：{{ incident.closureReason }}</p>
            <p v-if="incident.latest.error" class="mt-3 text-xs text-status-warn">观测失败：{{ incident.latest.error }}</p>
          </div>
          <div class="section-panel p-4 sm:p-5">
            <div class="flex flex-wrap items-center justify-between gap-2"><h3 class="font-semibold">诊断与证据</h3><button v-if="!incident.resolvedAt && !incident.closedAt" class="btn-secondary btn-sm" :disabled="busy || !observer.aiConfigured" @click="diagnose"><Bot class="h-3.5 w-3.5" />{{ incident.diagnosis ? '重新诊断' : 'AI 分析证据' }}</button></div>
            <p class="mt-2 text-xs text-surface-400">AI 结论是待验证的假设，恢复状态由实际健康观测决定。</p>
            <AgentMarkdown v-if="incident.diagnosis" class="agent-markdown mt-4 text-sm" :content="incident.diagnosis" />
            <p v-else class="mt-4 text-sm text-surface-300">{{ observer.aiConfigured ? '证据已保存，可发起 AI 分析或直接查看下方记录。' : '尚未配置 AI 服务。只读值守、证据采集和人工审批处置仍可使用。' }}<router-link v-if="!observer.aiConfigured" to="/settings" class="text-link ml-2">配置 AI</router-link></p>
            <p v-if="incident.diagnosisError" class="mt-3 text-xs text-status-warn">诊断暂未完成：{{ incident.diagnosisError }}</p>
            <details v-if="incident.diagnosisReport?.metadata" class="mt-3 text-xs text-surface-400"><summary class="cursor-pointer">诊断来源与模型记录</summary><p class="mt-2">模型 {{ incident.diagnosisReport.metadata.responseModel || incident.diagnosisReport.metadata.requestedModel }} · {{ incident.diagnosisReport.metadata.latencyMs }} ms · 费用未知</p><div v-for="source in incident.diagnosisReport.sources || []" :key="source.id" class="mt-3"><p>{{ source.id }} · {{ time(source.at) }}</p><pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">{{ JSON.stringify(source.data, null, 2) }}</pre></div></details>
          </div>
          <div class="section-panel p-4 sm:p-5">
            <div class="flex items-center gap-2"><ShieldCheck class="h-4 w-4 text-status-ok" /><h3 class="font-semibold">受控处置</h3></div>
            <p v-if="incident.resourceId.startsWith('application:')" class="mt-2 text-sm text-status-warn">应用缺少可确认的容器目标，需要人工检查部署与节点状态。</p><p v-else class="mt-2 text-sm leading-6 text-surface-300">重启当前故障容器一次，随后持续观察恢复情况。需要你的批准，可能造成短暂中断；错误配置或资源不足仍需进一步处理。</p>
            <div v-if="effect" class="mt-4 rounded-lg border border-surface-700 p-3"><strong class="text-sm">{{ incident.resolvedAt && effect.status === 'succeeded' ? '处置完成，健康验收已通过' : effectStatusLabel(effect.status) }}</strong><p v-if="effect.error" class="mt-2 break-words text-xs text-status-warn">{{ effect.error }}</p><p class="mt-2 text-xs text-surface-400">目标 {{ incident.hostId }} · {{ incident.resourceId.slice(0, 12) }} · 处置流程 v1</p></div>
            <p v-if="!worker.enabled && !incident.resolvedAt && !incident.closedAt" class="mt-3 text-xs text-status-warn">执行器尚未运行，已批准的处置会保留在队列中。</p>
            <div class="mt-4 flex flex-wrap gap-2">
              <button v-if="!effect && !incident.resolvedAt && !incident.closedAt" class="btn-primary" :disabled="busy || !incident.latest.fault || !!incident.latest.error || incident.resourceId.startsWith('application:')" @click="propose">生成重启处置</button>
              <button v-if="effect?.status === 'awaiting_approval'" class="btn-primary" :disabled="busy" @click="approval = { ticketId: incident.id, effectId: effect.id, title: incident.title, hostId: incident.hostId, resourceId: incident.resourceId }">审阅并批准</button>
              <button v-if="['awaiting_approval', 'queued'].includes(effect?.status)" class="btn-secondary" :disabled="busy" @click="cancelEffect">取消处置</button>
              <router-link v-if="['outcome_unknown', 'failed', 'rejected'].includes(effect?.status)" class="btn-secondary" :to="ticketTarget">查看原因与核对结果</router-link>
            </div>
          </div>
          <div class="section-panel p-4 sm:p-5">
            <h3 class="font-semibold">恢复验收</h3><p class="mt-2 text-sm" :class="incidentStatusTone(incident.status)">{{ incident.closedAt ? '已行政关闭，未验证恢复' : incident.resolvedAt ? '已验证恢复' : `${incident.healthyCount} / 3 次连续健康观测` }}</p>
            <p class="mt-2 text-xs leading-6 text-surface-400">至少 3 次连续健康观测，持续 30 秒。{{ incident.verification.scope === 'application_http' ? '本事件依据独立 HTTP 探针及容器状态验证；重复读取同一探针样本不计数。' : incident.verification.scope === 'container_healthcheck' ? '本事件依据 Docker HEALTHCHECK 验证。' : '未配置 HEALTHCHECK，只能验证容器进程存活，无法证明应用可用。' }}</p>
            <p v-if="incident.verification.reason" class="mt-2 text-xs text-status-warn">{{ incident.verification.reason }}</p>
          </div>
          <IncidentCorrelation :key="incident.id" :incident-id="incident.id" />
          <div class="section-panel p-4 sm:p-5"><h3 class="font-semibold">证据时间线</h3><ol class="mt-4 space-y-4"><li v-for="entry in detail.evidence" :key="entry.id" class="border-l-2 border-surface-700 pl-3"><p class="text-xs text-surface-400">#{{ entry.id }} · {{ time(entry.observedAt) }}</p><p class="mt-1 text-sm">{{ entry.summary }}</p><details class="mt-2 text-xs text-surface-400"><summary class="cursor-pointer">查看采集内容</summary><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-950 p-3">{{ JSON.stringify(entry.data, null, 2) }}</pre></details></li></ol></div>
        </template>
      </section>
    </div>
    <BaseModal :show="!!closeDraft" title="人工关闭故障事件" :close-disabled="busy" @close="closeDraft = null"><form v-if="closeDraft" class="space-y-4" @submit.prevent="closeCurrent"><p class="text-sm">用于应用退役、目标替换或已核对的旧事件。此操作保留证据，不表示应用已验证恢复；正在执行的处置须先结束。</p><label class="form-grid-label"><span>关闭原因</span><textarea v-model.trim="closeDraft.reason" class="input w-full" minlength="4" maxlength="500" required /></label><button class="btn-primary" type="submit" :disabled="busy">确认关闭事件</button></form></BaseModal>
    <ConfirmDialog :show="!!approval" title="批准单次重启处置" tone="warning" confirm-text="批准并入队" :busy="busy" :message="approval?.title || ''" @cancel="approval = null" @confirm="approve">
      <p class="break-all text-xs text-surface-300">节点 {{ approval?.hostId }} · 容器 {{ approval?.resourceId }}</p><p class="text-xs leading-6 text-surface-400">仅重启此容器一次。执行前再次核对授权和身份；执行后至少观察 30 秒。批准不会跳过拒绝策略，也不代表已恢复。</p>
    </ConfirmDialog>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onActivated, onDeactivated, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { RefreshCw, ShieldCheck, ScrollText, History, Bot } from 'lucide-vue-next';
import BaseModal from '../components/common/BaseModal.vue';
import { api } from '../api/client.js';
import { deepLink } from '../lib/deep-links.js';
import { incidentStatusLabel, incidentStatusTone, effectStatusLabel } from '../lib/incidents.js';
import EmptyState from '../components/common/EmptyState.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import AgentMarkdown from '../components/common/AgentMarkdown.vue';
import IncidentCorrelation from '../components/IncidentCorrelation.vue';

const closeDraft = ref(null), observedNow = ref(Date.now());
const route = useRoute(), router = useRouter();
const stats = ref({});
const incidents = ref([]), observer = ref({}), worker = ref({}), detail = ref(null);
const query = ref(''), filter = ref('open'), selectedId = ref(String(route.query.incident || ''));
const error = ref(''), detailError = ref(''), notice = ref('');
const loading = ref(false), detailLoading = ref(false), loaded = ref(false), busy = ref(false), approval = ref(null);
const incident = computed(() => detail.value?.incident);
const effect = computed(() => detail.value?.effects?.find(item => item.id === incident.value?.effectId));
const observerHealthy = computed(() => observer.value.running && !observer.value.last?.error && observedNow.value - Date.parse(observer.value.last?.checkedAt) < 60000);
const metrics = computed(() => [
  { label: '待处理故障', value: stats.value.open ?? incidents.value.filter(item => !item.resolvedAt && !item.closedAt).length, tone: 'text-surface-100' },
  { label: '等待你审批', value: stats.value.approvals ?? incidents.value.filter(item => item.status === 'awaiting_approval').length, tone: 'text-status-warn' },
  { label: '正在验证', value: stats.value.verifying ?? incidents.value.filter(item => item.status === 'verifying').length, tone: 'text-sky-300' },
  { label: '已验证恢复', value: stats.value.resolved ?? incidents.value.filter(item => item.resolvedAt).length, tone: 'text-status-ok' },
]);
const visibleIncidents = computed(() => incidents.value.filter(item => (filter.value === 'all' || (filter.value === 'resolved' ? item.resolvedAt : !item.resolvedAt && !item.closedAt))
  && `${item.title} ${item.projectName} ${item.hostId}`.toLowerCase().includes(query.value.trim().toLowerCase())));
const logsTarget = computed(() => deepLink('/logs', { hostId: incident.value?.hostId, projectId: incident.value?.projectId, containerId: incident.value?.resourceId?.startsWith('application:') ? undefined : incident.value?.resourceId, from: 'oncall' }));
const ticketTarget = computed(() => deepLink('/tickets', { ticket: incident.value?.id, from: 'oncall' }));
const agentTarget = computed(() => deepLink('/agent', { hostId: incident.value?.hostId, projectId: incident.value?.projectId, containerId: incident.value?.resourceId?.startsWith('application:') ? undefined : incident.value?.resourceId, diagnose: '1', from: 'oncall' }));
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未观测';
let active = false, disposed = false, timer, listVersion = 0, detailVersion = 0, listController, detailController;
async function loadList() {
  if (!active || loading.value) return;
  const version = ++listVersion;
  listController = new AbortController(); loading.value = true;
  try {
    const result = await api.getIncidents({ limit: 100 }, listController.signal);
    if (!active || version !== listVersion) return;
    incidents.value = result.incidents || []; stats.value = result.stats || {}; observer.value = result.observer || {}; worker.value = result.worker || {}; loaded.value = true; error.value = '';
  } catch (cause) { if (active && version === listVersion) error.value = cause.message || '故障列表加载失败'; }
  finally { if (version === listVersion) loading.value = false; }
}
async function loadDetail() {
  if (!active || !selectedId.value) return;
  const id = selectedId.value, version = ++detailVersion;
  detailController?.abort(); detailController = new AbortController(); detailLoading.value = true;
  try {
    const result = await api.getIncident(id, detailController.signal);
    if (active && version === detailVersion && id === selectedId.value) { detail.value = result; detailError.value = ''; }
  } catch (cause) { if (active && version === detailVersion) detailError.value = cause.message || '故障详情加载失败'; }
  finally { if (version === detailVersion) detailLoading.value = false; }
}
async function refresh() { observedNow.value = Date.now(); await Promise.all([loadList(), loadDetail()]); }
function select(id) {
  if (busy.value) return;
  selectedId.value = id; detail.value = null; detailError.value = ''; notice.value = ''; approval.value = null;
  void router.replace({ path: '/oncall', query: { incident: id } }); void loadDetail();
}
watch(() => route.query.incident, id => { if (typeof id === 'string' && id !== selectedId.value) select(id); });
async function mutate(action, message) {
  if (busy.value) return;
  busy.value = true; notice.value = ''; error.value = '';
  try { await action(); if (!disposed) { notice.value = message; approval.value = null; closeDraft.value = null; await refresh(); } }
  catch (cause) { if (!disposed) error.value = cause.message || '操作失败，请重试'; }
  finally { if (!disposed) busy.value = false; }
}
function closeCurrent() { const value = { ...closeDraft.value }; return mutate(() => api.closeIncident(value.id, value.reason), '事件已人工关闭，未计入已验证恢复。'); }
function diagnose() { const id = selectedId.value; return mutate(() => api.diagnoseIncident(id), '诊断已更新，请结合证据核对。'); }
function propose() { const id = selectedId.value; return mutate(() => api.proposeIncidentRestart(id), '处置已生成，等待你审批。'); }
function approve() { const target = approval.value; if (target) return mutate(() => api.approveOpsEffect(target.ticketId, target.effectId), '已批准入队，等待执行和独立验收。'); }
function cancelEffect() { const id = selectedId.value, effectId = effect.value?.id; if (effectId) return mutate(() => api.cancelOpsEffect(id, effectId, '管理员在 AI 值守中取消'), '处置已取消。'); }
function activate() { if (active || disposed) return; active = true; void refresh(); timer = setInterval(() => { observedNow.value = Date.now(); if (!busy.value) void refresh(); }, 15000); }
function deactivate() { active = false; clearInterval(timer); listController?.abort(); detailController?.abort(); listVersion++; detailVersion++; loading.value = detailLoading.value = false; }
onMounted(activate); onActivated(activate); onDeactivated(deactivate); onBeforeUnmount(() => { disposed = true; deactivate(); });
</script>

<style scoped>
.eyebrow { margin-bottom: .5rem; font-size: 10px; letter-spacing: .12em; color: var(--color-status-ok); }
.oncall-status { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; }
.oncall-columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; align-items: start; }
.incident-item { display: block; width: 100%; padding: 1rem; text-align: left; border-bottom: 1px solid var(--color-surface-800); transition: background .15s; }
.incident-item:hover { background: rgb(255 255 255 / .025); }
.incident-item.selected { background: rgb(16 185 129 / .065); box-shadow: inset 3px 0 var(--color-status-ok); }
@media (min-width: 1100px) { .oncall-columns { grid-template-columns: minmax(280px, .7fr) minmax(0, 1.3fr); } }
</style>
