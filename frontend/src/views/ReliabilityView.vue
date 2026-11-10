<template>
  <div class="page-shell reliability-view">
    <div class="page-header"><div><div class="eyebrow">目标 · 观测 · 授权 · 效果</div><h1 class="page-title">应用可靠性</h1><p class="page-subtitle">为应用定义可用性目标，用持续证据约束自动处置。</p></div><div class="flex flex-wrap gap-2"><router-link to="/oncall?from=reliability" class="btn-secondary">故障工作台</router-link><button class="btn-primary" :disabled="busy" @click="edit()">添加应用目标</button></div></div>
    <p v-if="error" class="alert-error" role="alert">{{ error }}<button class="text-link" @click="load">刷新数据</button></p>
    <p v-if="notice" class="text-sm text-status-ok" role="status">{{ notice }}</p>
    <section class="section-panel p-4" aria-label="最近 30 天处置效果">
      <h2 class="text-sm font-semibold">最近 30 天处置效果</h2>
      <div class="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4"><div v-for="item in metrics" :key="item.label"><p class="text-xs text-surface-400">{{ item.label }}</p><strong class="mt-1 block text-xl tabular-nums">{{ item.value }}</strong></div></div>
      <p class="mt-3 text-xs leading-5 text-surface-400">{{ insights.recoverySamples ?? 0 }} 个恢复样本 · 自动派发 {{ insights.automaticDispatches ?? 0 }} 次 · 人工派发 {{ insights.manualDispatches ?? 0 }} 次 · 结果未知 {{ insights.effectOutcomes?.outcome_unknown ?? 0 }} 次。恢复率包含当前未恢复事件；命令完成不等于恢复。</p>
    </section>
    <div v-if="loading && !loaded" class="p-6 text-surface-400">正在读取可靠性目标…</div>
    <EmptyState v-else-if="loaded && !profiles.length" icon="Activity" title="添加第一个应用目标" description="选择已纳管的服务和健康检查地址，先观察，再决定是否授权自动修复。" />
    <div class="grid gap-4 xl:grid-cols-2">
      <section v-for="profile in profiles" :key="profile.id" class="section-panel min-w-0 p-4 sm:p-5" :aria-label="profile.projectName + ' / ' + profile.serviceName">
        <div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><p class="text-xs text-surface-400">{{ profile.hostId }} · 版本 {{ profile.version }}</p><h2 class="mt-1 break-words text-lg font-semibold">{{ profile.projectName }} / {{ profile.serviceName }}</h2></div><span class="status-badge" :class="probeTone(profile)">{{ probeLabel(profile) }}</span></div>
        <p class="mt-3 break-all font-mono text-xs text-surface-400">{{ profile.config.url }}</p>
        <p class="mt-2 text-xs text-surface-400">目标 {{ profile.config.targetPercent }}% · {{ profile.config.windowDays }} 天窗口 · HTTP {{ profile.config.expectedStatus }} · {{ profile.config.maxLatencyMs }} ms 内响应</p>
        <dl class="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt class="text-xs text-surface-400">已观测可用率</dt><dd class="mt-1">{{ percent(profile.statistics.observedAvailabilityPercent) }}</dd></div><div><dt class="text-xs text-surface-400">观测覆盖率</dt><dd class="mt-1">{{ percent(profile.statistics.coveragePercent) }}</dd></div><div><dt class="text-xs text-surface-400">剩余错误预算（含缺测）</dt><dd class="mt-1" :class="profile.statistics.budgetRemainingMs < 0 ? 'text-status-warn' : 'text-status-ok'">{{ duration(profile.statistics.budgetRemainingMs) }}</dd></div><div><dt class="text-xs text-surface-400">最近观测</dt><dd class="mt-1">{{ time(profile.latest?.at) }}</dd></div></dl>
        <p class="mt-3 text-xs leading-5 text-surface-400">缺测 {{ duration(profile.statistics.unknownMs) }} · {{ profile.statistics.samples }} 个样本。覆盖率不足时，已观测可用率不能代表整个窗口。</p>
        <p v-if="profile.latest?.reason" class="mt-2 text-xs text-status-warn">{{ profile.latest.reason }}</p>
        <div class="mt-4 border-t border-surface-800 pt-4"><div class="flex flex-wrap items-center justify-between gap-2"><h3 class="text-sm font-semibold">有界自动修复</h3><span class="text-xs" :class="policyActive(profile) ? 'text-status-ok' : 'text-surface-400'">{{ policyLabel(profile) }}</span></div><p class="mt-2 text-xs leading-5 text-surface-400">仅对持续探针失败的单副本服务重启一次；每个故障最多一次，结果不明时停止。多副本服务保留人工处置。</p><p v-if="profile.policy" class="mt-2 text-xs text-surface-400">每 24 小时最多 {{ profile.policy.maxDaily }} 次 · 冷却 {{ duration(profile.policy.cooldownMs) }} · 授权至 {{ time(profile.policy.expiresAt) }}</p></div>
        <div class="mt-4 flex flex-wrap gap-2"><button class="btn-secondary btn-sm" :disabled="busy" @click="edit(profile)">编辑目标</button><button class="btn-secondary btn-sm" :disabled="busy || !profile.enabled" @click="authorize(profile)">审阅自动授权</button><button v-if="profile.policy?.enabled" class="btn-secondary btn-sm" :disabled="busy" @click="disablePolicy(profile)">停止自动处置</button><button v-if="profile.enabled" class="btn-secondary btn-sm" :disabled="busy" @click="pause(profile)">暂停探针与授权</button></div>
      </section>
    </div>
    <BaseModal :show="!!draft" :title="draft?.id ? '编辑应用可靠性目标' : '添加应用可靠性目标'" :close-disabled="busy" size-class="max-w-xl" @close="draft = null">
      <form v-if="draft" class="space-y-4" @submit.prevent="save"><fieldset :disabled="busy" class="space-y-4">
        <p v-if="formError" class="alert-error" role="alert">{{ formError }}</p>
        <p v-if="draft.id" class="text-sm">{{ draft.projectName }} / {{ draft.serviceName }} · {{ draft.hostId }}<span class="mt-1 block text-xs text-status-warn">保存后开始新的观测窗口，已有自动授权会停用，需要重新审阅。</span></p>
        <template v-else><label class="form-grid-label"><span>纳管项目</span><select v-model="targetKey" class="input w-full" required @change="chooseProject"><option value="" disabled>选择项目与节点</option><option v-for="target in targets" :key="target.hostId + ':' + target.projectId" :value="target.hostId + ':' + target.projectId">{{ target.projectName }} · {{ target.hostId }}</option></select></label><label class="form-grid-label"><span>Compose 服务</span><select v-model="draft.serviceName" class="input w-full" required><option v-for="service in selectedTarget?.services || []" :key="service" :value="service">{{ service }}</option></select></label></template>
        <label class="form-grid-label"><span>HTTP 健康检查地址</span><input v-model="draft.config.url" class="input w-full" type="url" placeholder="https://app.example/health" required /><span class="text-xs text-surface-400">从 ComposeOps 所在网络访问；不跟随跳转，不支持凭据或查询参数。</span></label>
        <div class="grid grid-cols-2 gap-3"><label class="form-grid-label"><span>预期状态码</span><input v-model.number="draft.config.expectedStatus" class="input w-full" type="number" min="100" max="599" required /></label><label class="form-grid-label"><span>响应延迟目标（ms）</span><input v-model.number="draft.config.maxLatencyMs" class="input w-full" type="number" min="50" max="10000" required /></label><label class="form-grid-label"><span>请求超时（ms）</span><input v-model.number="draft.config.timeoutMs" class="input w-full" type="number" min="200" max="10000" required /></label><label class="form-grid-label"><span>连续失败触发次数</span><input v-model.number="draft.config.failureThreshold" class="input w-full" type="number" min="2" max="10" required /></label><label class="form-grid-label"><span>可用率目标（%）</span><input v-model.number="draft.config.targetPercent" class="input w-full" type="number" min="90" max="100" step="0.01" required /></label><label class="form-grid-label"><span>统计窗口（天）</span><input v-model.number="draft.config.windowDays" class="input w-full" type="number" min="1" max="30" required /></label></div>
        <label class="flex items-center gap-2 text-sm"><input v-model="draft.enabled" type="checkbox" />启用只读探针（每 30 秒）</label>
        <div class="flex justify-end gap-2"><button class="btn-secondary" type="button" @click="draft = null">取消</button><button class="btn-primary" type="submit">{{ busy ? '保存中…' : '保存目标' }}</button></div>
      </fieldset></form>
    </BaseModal>
    <BaseModal :show="!!policyDraft && !confirmPolicy" title="审阅应用自动修复授权" :close-disabled="busy" size-class="max-w-xl" @close="policyDraft = null">
      <form v-if="policyDraft" class="space-y-4" @submit.prevent="confirmPolicy = true"><fieldset class="space-y-4" :disabled="busy"><p class="text-sm font-semibold">{{ policyDraft.profile.projectName }} / {{ policyDraft.profile.serviceName }} · {{ policyDraft.profile.hostId }}</p><p class="text-xs leading-6 text-surface-400">授权 container-restart-v1 流程在持续故障时自动执行，无需逐次点击批准。重启会造成短暂中断；拒绝策略、版本和身份检查仍然生效。</p><div class="grid grid-cols-2 gap-3"><label class="form-grid-label"><span>有效天数</span><input v-model.number="policyDraft.days" class="input w-full" type="number" min="1" max="30" required /></label><label class="form-grid-label"><span>每 24 小时最多次数</span><input v-model.number="policyDraft.maxDaily" class="input w-full" type="number" min="1" max="10" required /></label><label class="form-grid-label"><span>冷却分钟数</span><input v-model.number="policyDraft.cooldownMinutes" class="input w-full" type="number" min="5" max="1440" required /></label><label class="form-grid-label"><span>维护暂停小时数</span><input v-model.number="policyDraft.maintenanceHours" class="input w-full" type="number" min="0" max="720" required /></label></div><div class="flex justify-end gap-2"><button type="button" class="btn-secondary" @click="policyDraft = null">取消</button><button type="submit" class="btn-primary">核对并继续</button></div></fieldset></form>
    </BaseModal>
    <ConfirmDialog :show="confirmPolicy" title="启用有界自动重启" confirm-text="确认授权" :busy="busy" tone="warning" :message="policyDraft ? `${policyDraft.profile.projectName} / ${policyDraft.profile.serviceName} · ${policyDraft.profile.hostId}` : ''" @cancel="confirmPolicy = false" @confirm="savePolicy"><p class="text-sm leading-6">每 24 小时最多 {{ policyDraft?.maxDaily }} 次，冷却 {{ policyDraft?.cooldownMinutes }} 分钟，有效 {{ policyDraft?.days }} 天。仅对当前应用目标版本授权，可随时停止。</p><p v-if="formError" class="alert-error" role="alert">{{ formError }}</p></ConfirmDialog>
  </div>
</template>
<script setup>
import { computed, ref, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue';
import { api } from '../api/client.js';
import BaseModal from '../components/common/BaseModal.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import EmptyState from '../components/common/EmptyState.vue';
const profiles = ref([]), targets = ref([]), insights = ref({}), error = ref(''), notice = ref(''), formError = ref('');
const loading = ref(false), loaded = ref(false), busy = ref(false), draft = ref(null), policyDraft = ref(null), confirmPolicy = ref(false), targetKey = ref(''), checkedNow = ref(Date.now());
let active = false, disposed = false, version = 0, timer, controller, targetsController;
const selectedTarget = computed(() => targets.value.find(target => target.hostId + ':' + target.projectId === targetKey.value));
const percent = value => value == null ? '暂无数据' : Number(value).toFixed(2) + '%';
const duration = value => value == null ? '暂无数据' : (value < 0 ? '超支 ' : '') + (Math.abs(value) / 60000).toFixed(1) + ' 分钟';
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无数据';
const metrics = computed(() => [{ label: '故障事件', value: insights.value.incidents ?? '—' }, { label: '已验证恢复', value: insights.value.resolved ?? '—' }, { label: '恢复时间中位数', value: duration(insights.value.medianRecoveryMs) }, { label: '重复故障目标', value: insights.value.recurringTargets ?? '—' }]);
const fresh = profile => profile.latest && checkedNow.value - profile.latest.at <= 60000;
const probeLabel = profile => !profile.enabled ? '已暂停' : !fresh(profile) || profile.latest.outcome === 'unknown' ? '观测不足' : profile.latest.outcome === 'good' ? '探针达标' : '探针未达标';
const probeTone = profile => profile.enabled && fresh(profile) && profile.latest.outcome === 'good' ? 'text-status-ok' : 'text-status-warn';
const policyActive = profile => profile.enabled && profile.policy?.enabled && profile.policy.profileVersion === profile.version && profile.policy.expiresAt > checkedNow.value && profile.policy.maintenanceUntil <= checkedNow.value;
const policyLabel = profile => !profile.policy?.enabled ? '未授权自动处置' : profile.policy.maintenanceUntil > checkedNow.value ? '维护暂停中' : policyActive(profile) ? '预授权生效' : '授权已失效';
async function load() {
  if (!active || loading.value) return;
  checkedNow.value = Date.now();
  const current = ++version; controller = new AbortController(); loading.value = true;
  try {
    const result = await api.getSreProfiles(controller.signal);
    if (!active || current !== version) return;
    profiles.value = result.profiles || []; insights.value = result.insights || {}; error.value = ''; loaded.value = true;
  } catch (cause) { if (active && current === version) error.value = cause.message || '可靠性数据读取失败'; }
  finally { if (current === version) loading.value = false; }
}
function chooseProject() { if (draft.value && selectedTarget.value) Object.assign(draft.value, { hostId: selectedTarget.value.hostId, projectId: selectedTarget.value.projectId, projectName: selectedTarget.value.projectName, serviceName: selectedTarget.value.services[0] || '' }); }
async function edit(profile) {
  formError.value = ''; targetKey.value = '';
  draft.value = profile ? JSON.parse(JSON.stringify(profile)) : { enabled: true, config: { url: '', expectedStatus: 200, timeoutMs: 3000, maxLatencyMs: 1000, targetPercent: 99.9, windowDays: 7, failureThreshold: 3 } };
  if (!profile) {
    const current = draft.value;
    targetsController?.abort(); targetsController = new AbortController();
    try { const result = await api.getSreTargets(targetsController.signal); if (active && draft.value === current) targets.value = result.targets || []; }
    catch (cause) { if (!disposed && draft.value === current) formError.value = cause.message || '项目读取失败'; }
  }
}
async function mutate(action, message, done = () => {}) {
  if (busy.value) return;
  busy.value = true; formError.value = ''; notice.value = '';
  try { await action(); if (!disposed) { done(); notice.value = message; controller?.abort(); version++; loading.value = false; await load(); } }
  catch (cause) { if (!disposed) { formError.value = cause.message || '操作失败'; error.value = formError.value; } }
  finally { if (!disposed) busy.value = false; }
}
function save() { const value = JSON.parse(JSON.stringify(draft.value)); return mutate(() => api.saveSreProfile(value), '应用目标已保存，自动授权需要独立确认。', () => { draft.value = null; }); }
function pause(profile) { return mutate(() => api.pauseSreProfile(profile.id), '已暂停探针并撤销自动处置授权。'); }
function authorize(profile) { formError.value = ''; policyDraft.value = { profile: JSON.parse(JSON.stringify(profile)), days: 7, maxDaily: profile.policy?.maxDaily || 1, cooldownMinutes: (profile.policy?.cooldownMs || 3600000) / 60000, maintenanceHours: 0 }; }
function disablePolicy(profile) { return mutate(() => api.saveSreAutonomy(profile.id, { version: profile.policy.version, enabled: false }), '自动处置已停止。'); }
function savePolicy() { const value = policyDraft.value, now = Date.now(); if (!value) return;
  return mutate(() => api.saveSreAutonomy(value.profile.id, { version: value.profile.policy?.version || 0, enabled: true, confirm: 'ENABLE_AUTONOMY', expiresAt: now + value.days * 86400000,
    cooldownMs: value.cooldownMinutes * 60000, maxDaily: value.maxDaily, maintenanceUntil: value.maintenanceHours ? now + value.maintenanceHours * 3600000 : 0 }), '应用自动处置授权已保存。', () => { confirmPolicy.value = false; policyDraft.value = null; }); }
function start() { if (active || disposed) return; active = true; void load(); timer = setInterval(() => { if (!busy.value) void load(); }, 15000); }
function stop() { active = false; clearInterval(timer); controller?.abort(); targetsController?.abort(); version++; loading.value = false; }
onMounted(start); onActivated(start); onDeactivated(stop); onBeforeUnmount(() => { disposed = true; stop(); });
</script>
