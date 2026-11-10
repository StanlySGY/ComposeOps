<template>
  <div class="space-y-4 min-w-0">
    <p v-if="error" class="alert-error" role="alert">{{ error }}<button class="text-link ml-2" @click="load">重新读取</button></p>
    <p v-if="notice" class="text-sm text-status-ok" role="status">{{ notice }}</p>
    <p v-if="!data" class="text-surface-400">正在读取监测记录…</p>
    <template v-else-if="tab === 'platform'">
      <section class="section-panel p-4"><div class="flex flex-wrap justify-between gap-3"><div><h2 class="font-semibold">平台自身健康</h2><p class="mt-2 text-sm text-surface-400">面板、执行器、存储和备份的持续观测。</p></div><button class="btn-secondary" :disabled="busy" @click="editThresholds">配置阈值</button></div><p class="mt-3 text-sm" :class="data.stale ? 'text-status-warn' : 'text-surface-400'">{{ data.stale ? '观测缺失或已过期，不能确认平台健康。' : '最近观测：' + time(data.sample.at) }}</p></section>
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4"><section v-for="metric in metrics" :key="metric.title" class="section-panel p-4"><h3 class="text-xs text-surface-400">{{ metric.title }}</h3><p class="mt-3 text-lg tabular-nums">{{ metric.value }}</p></section></div>
      <section v-if="data.history.length > 1" class="section-panel p-4"><h3 class="text-sm font-semibold">最近一小时数据库与 WAL 总量</h3><svg viewBox="0 0 600 90" class="mt-3 h-24 w-full" role="img" aria-label="最近一小时数据库与 WAL 容量趋势"><polyline :points="trend" fill="none" stroke="currentColor" stroke-width="2" class="text-emerald-400" /></svg><p class="text-xs text-surface-400">{{ bytes(historyMin) }} 至 {{ bytes(historyMax) }} · 采样缺口不代表容量稳定</p></section>
      <section class="section-panel p-4"><h3 class="font-semibold">执行器与任务队列</h3><p v-if="!data.sample?.workers.length" class="mt-3 text-sm text-status-warn">暂无执行器心跳。</p><div v-for="worker in data.sample?.workers || []" :key="worker.name" class="mt-3 flex flex-wrap justify-between gap-2 text-sm"><span>{{ workerName(worker.name) }}</span><span :class="!worker.currentInstance || worker.ageMs > data.config.thresholds.heartbeatSeconds * 1000 ? 'text-status-warn' : 'text-surface-400'">{{ worker.currentInstance ? label(worker.state) : '上次进程遗留心跳' }} · {{ duration(worker.ageMs) }}前</span></div><div v-for="(queue, key) in data.sample?.queues || {}" :key="key" class="mt-3 border-t border-surface-800 pt-3 text-xs text-surface-400">{{ queueName(key) }}：等待 {{ queue.queued }} 项（最长 {{ duration(queue.oldestQueuedMs) }}），执行 {{ queue.executing }} 项（最长 {{ duration(queue.oldestExecutionMs) }}）</div></section>
      <section class="section-panel p-4"><h3 class="font-semibold">平台数据库备份</h3><p class="mt-3 text-sm">最近备份：{{ label(data.sample?.backup.state) }} · 最近成功 {{ time(data.sample?.backup.lastSuccessAt) }}</p><p class="mt-2 text-xs text-surface-400">最近耗时 {{ duration(data.sample?.backup.durationMs) }}。记录由平台数据库快照工具生成，业务数据库与数据卷备份单独验收。</p></section>
      <section class="section-panel p-4"><div class="flex flex-wrap justify-between gap-3"><h3 class="font-semibold">独立健康检查器</h3><button class="btn-secondary btn-sm" :disabled="busy" @click="tokenConfirm = true">生成或轮换检查凭据</button></div><p class="mt-3 text-sm">{{ externalLabel }} · 最近回报 {{ time(data.sample?.external.at) }}</p><p class="mt-2 text-xs leading-6 text-surface-400">检查器在独立进程运行，可发现面板停止或无响应。同宿主部署无法发现整机断电；需要整机保护时，将检查器部署到另一台主机。检查器自身保留告警和通知记录。</p><p class="mt-2 text-xs text-surface-400">部署说明：docs/public/PLATFORM_MONITORING.md</p></section>
    </template>
    <template v-else-if="data">
      <section class="section-panel p-4"><h2 class="font-semibold">多窗口错误预算告警</h2><p class="mt-2 text-sm leading-6 text-surface-400">同时检查短窗口与长窗口的错误预算消耗。覆盖不足单独告警；恢复需要连续观测，维护期暂停触发与恢复判定。</p><router-link class="mt-3 inline-block text-link text-sm" to="/settings?tab=notifications">配置通知渠道</router-link></section>
      <section v-for="profile in profiles" :key="profile.id" class="section-panel p-4"><div class="flex flex-wrap items-center justify-between gap-3"><div><h3 class="font-semibold">{{ profile.projectName }} / {{ profile.serviceName }}</h3><p class="mt-1 text-xs text-surface-400">{{ profile.hostId }} · 目标版本 {{ profile.version }}</p></div><button class="btn-secondary" :disabled="busy || ruleLoading" @click="editRule(profile)">查看与配置告警</button></div></section>
      <p v-if="!profiles.length" class="text-sm text-surface-400">先添加应用可靠性目标，再配置告警。</p>
    </template>
    <section v-if="data" class="section-panel p-4"><h2 class="font-semibold">{{ tab === 'platform' ? '平台告警记录' : '应用告警记录' }}</h2><p v-if="!alerts.length" class="mt-3 text-sm text-surface-400">暂无告警记录。监测尚未产生证据时不能据此认定健康。</p><article v-for="alert in alerts" :key="alert.key" class="mt-4 border-t border-surface-800 pt-3"><div class="flex flex-wrap justify-between gap-2"><h3 class="text-sm">{{ alert.title }}</h3><span class="text-xs" :class="alert.state === 'firing' ? 'text-status-warn' : 'text-surface-400'">{{ label(alert.state) }}{{ alert.suppressed ? ' · 维护暂停' : '' }}</span></div><p class="mt-2 text-xs text-surface-400">最近条件：{{ conditionLabel(alert.condition) }} · {{ time(alert.observedAt) }}</p><details class="mt-2 text-xs text-surface-400"><summary class="cursor-pointer">观测依据</summary><pre class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">{{ JSON.stringify(alert.detail, null, 2) }}</pre></details></article></section>
    <section v-if="data" class="section-panel p-4"><h2 class="font-semibold">通知发送记录</h2><p class="mt-2 text-xs leading-6 text-surface-400">失败后按渠道重试，最多五轮。发送中发生进程中断时标为结果未知，需要核对接收端；已发送记录不会因重启重发。</p><p v-if="!deliveries.length" class="mt-3 text-sm text-surface-400">暂无通知记录。</p><div v-for="delivery in deliveries" :key="delivery.id" class="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-surface-800 pt-3 text-xs"><span>{{ delivery.channel === 'none' ? '未配置渠道' : delivery.channel }}</span><span>{{ label(delivery.status) }}</span><span>{{ delivery.attempts }} 轮 · {{ time(delivery.updatedAt) }}</span><span v-if="delivery.error" class="text-status-warn">{{ delivery.error }}</span></div></section>
    <BaseModal :show="!!thresholdDraft" title="平台监测阈值" :close-disabled="busy" @close="thresholdDraft = null"><form v-if="thresholdDraft" class="space-y-4" @submit.prevent="saveThresholds"><p v-if="formError" class="alert-error" role="alert">{{ formError }}</p><fieldset :disabled="busy" class="grid grid-cols-2 gap-3"><label v-for="field in thresholdFields" :key="field.key" class="form-grid-label"><span>{{ field.label }}</span><input v-model.number="thresholdDraft.thresholds[field.key]" class="input w-full" type="number" :min="field.min" :max="field.max" :step="field.step || 1" required /></label><label class="form-grid-label"><span>维护暂停（小时）</span><input v-model.number="maintenanceHours" class="input w-full" type="number" min="0" max="720" step="0.1" required /></label></fieldset><button class="btn-primary" :disabled="busy">保存阈值</button></form></BaseModal>
    <BaseModal :show="!!ruleDraft" title="应用错误预算告警" :close-disabled="busy" size-class="max-w-2xl" @close="ruleDraft = null"><form v-if="ruleDraft" class="space-y-4" @submit.prevent="saveRule"><p class="text-sm">{{ ruleTarget?.projectName }} / {{ ruleTarget?.serviceName }}</p><p v-if="ruleDraft.profileVersion && ruleDraft.profileVersion !== ruleTarget?.version" class="text-sm text-status-warn">应用目标已改版；保存后告警规则才会绑定当前版本。</p><p v-if="formError" class="alert-error" role="alert">{{ formError }}</p><fieldset :disabled="busy" class="space-y-4"><label class="flex gap-2 text-sm"><input v-model="ruleDraft.config.enabled" type="checkbox" />启用该应用告警</label><div v-for="key in ['fast', 'slow']" :key="key"><h3 class="text-sm">{{ key === 'fast' ? '快速消耗' : '持续消耗' }}</h3><div class="mt-2 grid grid-cols-3 gap-2"><label class="form-grid-label"><span>短窗口（分钟）</span><input v-model.number="ruleDraft.config[key].shortMinutes" class="input w-full" type="number" min="1" max="120" required /></label><label class="form-grid-label"><span>长窗口（分钟）</span><input v-model.number="ruleDraft.config[key].longMinutes" class="input w-full" type="number" min="5" max="1440" required /></label><label class="form-grid-label"><span>消耗率（倍）</span><input v-model.number="ruleDraft.config[key].burnRate" class="input w-full" type="number" min="1" max="1000" step="0.1" required /></label></div><p v-if="ruleEvidence?.[key]" class="mt-2 text-xs text-surface-400">当前短 / 长窗口：{{ burn(ruleEvidence[key].short) }} / {{ burn(ruleEvidence[key].long) }}</p></div><div class="grid grid-cols-2 gap-3"><label class="form-grid-label"><span>最低覆盖率（0.5–1）</span><input v-model.number="ruleDraft.config.minimumCoverage" class="input w-full" type="number" min="0.5" max="1" step="0.01" required /></label><label class="form-grid-label"><span>恢复需持续（分钟）</span><input v-model.number="ruleDraft.config.recoverMinutes" class="input w-full" type="number" min="1" max="60" required /></label><label class="form-grid-label"><span>维护暂停（小时）</span><input v-model.number="maintenanceHours" class="input w-full" type="number" min="0" max="720" step="0.1" required /></label></div></fieldset><button class="btn-primary" :disabled="busy">保存应用告警</button></form></BaseModal>
    <ConfirmDialog :show="tokenConfirm" title="轮换独立检查凭据" confirm-text="生成新凭据" :busy="busy" @cancel="tokenConfirm = false" @confirm="rotateToken"><p class="text-sm leading-6">旧检查器凭据将失效，需要把新凭据保存到检查器的私有文件。凭据只允许平台健康检查，不能执行运维操作。</p><p v-if="formError" class="alert-error">{{ formError }}</p></ConfirmDialog>
    <BaseModal :show="!!monitorToken" title="检查器凭据（仅显示一次）" @close="monitorToken = ''"><p class="mb-3 text-sm">保存到权限 0600 的私有文件，在检查器配置中填写 tokenFile。关闭后无法再次查看。</p><textarea :value="monitorToken" readonly class="input w-full break-all font-mono text-xs" rows="3" aria-label="独立检查器凭据" /></BaseModal>
  </div>
</template>
<script setup>
import { computed, ref, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue';
import { api } from '../api/client.js';
import BaseModal from './common/BaseModal.vue';
import ConfirmDialog from './common/ConfirmDialog.vue';
const props = defineProps({ tab: { type: String, default: 'platform' }, profiles: { type: Array, default: () => [] } });
const data = ref(null), error = ref(''), notice = ref(''), formError = ref(''), busy = ref(false), thresholdDraft = ref(null), maintenanceHours = ref(0);
const ruleDraft = ref(null), ruleTarget = ref(null), ruleEvidence = ref(null), ruleLoading = ref(false), tokenConfirm = ref(false), monitorToken = ref('');
let active = false, disposed = false, epoch = 0, ruleEpoch = 0, timer, controller, ruleController, loading = false;
const thresholdFields = [
  { key: 'heartbeatSeconds', label: '心跳失联（秒）', min: 30, max: 600 }, { key: 'queueMinutes', label: '排队最长（分钟）', min: 1, max: 1440 },
  { key: 'executionMinutes', label: '执行最长（分钟）', min: 1, max: 1440 }, { key: 'databaseGiB', label: '数据库容量（GiB）', min: 0.1, max: 10000, step: 0.1 },
  { key: 'walMiB', label: 'WAL 容量（MiB）', min: 1, max: 100000 }, { key: 'growthMiBPerHour', label: '增长率（MiB/小时）', min: 1, max: 100000 },
  { key: 'diskFreePercent', label: '最少磁盘余量（%）', min: 1, max: 90 }, { key: 'backupHours', label: '备份最大年龄（小时）', min: 1, max: 8760 },
  { key: 'backupMinutes', label: '备份最长耗时（分钟）', min: 1, max: 1440 }, { key: 'externalSeconds', label: '外部心跳（秒）', min: 30, max: 3600 },
];
const bytes = value => value == null ? '未知' : value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GiB' : (value / 1024 ** 2).toFixed(1) + ' MiB';
const duration = value => value == null ? '未知' : (value / 60000).toFixed(1) + ' 分钟';
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无记录';
const label = value => ({ normal: '尚未触发', firing: '告警中', resolved: '已验证恢复', closed: '已行政关闭', idle: '空闲', working: '执行中', running: '进行中', stopped: '已停止', error: '执行异常', succeeded: '成功', failed: '失败', unknown: '未知', pending: '等待发送', sending: '发送中', sent: '已发送', retry: '等待重试', outcome_unknown: '发送结果未知', unconfigured: '未配置渠道', superseded: '已被后续状态替代' })[value] || '未知';
const conditionLabel = value => ({ good: '达标', bad: '未达标', unknown: '证据不足' })[value] || '证据不足';
const workerName = name => ({ 'sre-runtime': '可靠变更与恢复演练', 'incident-observer': 'AI 值守观测', 'effect-worker': '受控执行器', 'platform-monitor': '平台健康监测' })[name] || name;
const queueName = name => ({ effects: '受控操作', changes: '可靠变更', recovery: '恢复演练' })[name] || name;
const burn = value => `${value.zeroBudget ? '零错误预算' : value.burnRate == null ? '暂无消耗率' : value.burnRate.toFixed(1) + ' 倍'}，覆盖 ${(value.coverage * 100).toFixed(1)}%`;
const metrics = computed(() => { const s = data.value?.sample; return [{ title: '数据库', value: bytes(s?.databaseBytes) }, { title: 'WAL', value: bytes(s?.walBytes) }, { title: '增长 / 小时', value: bytes(s?.growthBytesPerHour) }, { title: '磁盘可用', value: s?.diskFreePercent == null ? '未知' : s.diskFreePercent.toFixed(1) + '%' }]; });
const alerts = computed(() => (data.value?.alerts || []).filter(row => props.tab === 'platform' ? row.scope === 'platform' : row.scope.startsWith('profile:')));
const deliveries = computed(() => (data.value?.deliveries || []).filter(row => props.tab === 'platform' ? row.alertKey.startsWith('platform:') : row.alertKey.startsWith('profile:')));
const externalLabel = computed(() => { const x = data.value?.sample?.external; return !x?.configured ? '尚未配置' : !x.at ? '等待首次回报' : x.location === 'separate-host' ? '异宿主检查器（部署方声明）' : '同宿主独立进程'; });
const historyValues = computed(() => (data.value?.history || []).filter(s => s.databaseBytes != null && s.walBytes != null).map(s => s.databaseBytes + s.walBytes));
const historyMin = computed(() => Math.min(...historyValues.value)), historyMax = computed(() => Math.max(...historyValues.value));
const trend = computed(() => historyValues.value.map((value, i, values) => `${i * 600 / Math.max(1, values.length - 1)},${80 - (value - historyMin.value) * 70 / Math.max(1, historyMax.value - historyMin.value)}`).join(' '));
async function load() {
  if (!active || loading) return;
  const current = ++epoch; controller = new AbortController(); loading = true;
  try { const result = await api.getSreResource('platform', controller.signal); if (active && current === epoch) { data.value = result; error.value = ''; } }
  catch (cause) { if (active && current === epoch) error.value = cause.message; }
  finally { if (current === epoch) loading = false; }
}
async function mutate(work, success, close) {
  if (busy.value || !active) return;
  controller?.abort(); loading = false; const current = ++epoch; busy.value = true; formError.value = '';
  try { const result = await work(); if (active && current === epoch) { close?.(result); notice.value = success; await load(); } }
  catch (cause) { if (active && current === epoch) formError.value = cause.message; }
  finally { busy.value = false; }
}
function editThresholds() { thresholdDraft.value = JSON.parse(JSON.stringify(data.value.config)); maintenanceHours.value = Math.max(0, (thresholdDraft.value.thresholds.maintenanceUntil - Date.now()) / 3600000); formError.value = ''; }
function until() { return maintenanceHours.value ? Math.round(Date.now() + maintenanceHours.value * 3600000) : 0; }
function saveThresholds() { return mutate(() => api.sreOperation('platform/config', { ...thresholdDraft.value, thresholds: { ...thresholdDraft.value.thresholds, maintenanceUntil: until() } }, 'PUT'), '平台阈值已保存。', () => { thresholdDraft.value = null; }); }
async function editRule(profile) {
  ruleController?.abort(); ruleController = new AbortController(); const current = ++ruleEpoch; ruleLoading.value = true; formError.value = '';
  try { const result = await api.getSreResource(`profiles/${encodeURIComponent(profile.id)}/alerts`, ruleController.signal); if (active && current === ruleEpoch) { ruleTarget.value = profile; ruleDraft.value = result.rule; ruleEvidence.value = result.evidence; maintenanceHours.value = Math.max(0, (result.rule.config.maintenanceUntil - Date.now()) / 3600000); } }
  catch (cause) { if (active && current === ruleEpoch) error.value = cause.message; }
  finally { if (current === ruleEpoch) ruleLoading.value = false; }
}
function saveRule() { return mutate(() => api.sreOperation(`profiles/${encodeURIComponent(ruleTarget.value.id)}/alerts`, { version: ruleDraft.value.version, config: { ...ruleDraft.value.config, maintenanceUntil: until() } }, 'PUT'), '应用告警规则已保存。', () => { ruleDraft.value = null; }); }
function rotateToken() { return mutate(() => api.sreOperation('platform/monitor-token'), '独立检查凭据已轮换。', result => { tokenConfirm.value = false; monitorToken.value = result.token; }); }
function start() { if (active || disposed) return; active = true; void load(); timer = setInterval(() => { if (!busy.value) void load(); }, 15000); }
function stop() { active = false; clearInterval(timer); controller?.abort(); ruleController?.abort(); epoch++; ruleEpoch++; loading = false; ruleLoading.value = false; monitorToken.value = ''; }
onMounted(start); onActivated(start); onDeactivated(stop); onBeforeUnmount(() => { disposed = true; stop(); });
</script>
