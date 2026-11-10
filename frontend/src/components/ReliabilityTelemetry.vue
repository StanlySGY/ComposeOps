<template>
  <div class="space-y-4 min-w-0">
    <p v-if="error" class="alert-error" role="alert">{{ error }}<button class="text-link ml-2" @click="load">重新读取</button></p>
    <p v-if="notice" class="text-sm text-status-ok" role="status">{{ notice }}</p>
    <section class="section-panel p-4"><div class="flex flex-wrap justify-between gap-3"><h2 class="font-semibold">应用日志与链路接入</h2><button class="btn-primary" :disabled="busy || !targets.length" @click="open">创建接入凭据</button></div><p class="mt-3 text-sm leading-6 text-surface-400">接收 OTLP HTTP JSON 格式日志和 trace，支持 gzip。每份凭据绑定一个节点、一个应用和选定服务，服务名来自 resource 的 service.name。凭据只允许写入遥测，不能读取应用数据或执行运维。</p><p class="mt-3 break-all font-mono text-xs">{{ endpoint }}/v1/logs<br />{{ endpoint }}/v1/traces</p><p class="mt-3 text-xs text-surface-400">最多 200 条 / 批、1 MiB / 请求、2000 条 / 分钟 / 凭据。保留最多 7 天，每应用 2 万条、全平台 20 万条；容量超限优先清理旧记录。</p><p class="mt-2 text-xs text-surface-400">应用需要自行启用 OpenTelemetry 日志/链路导出；创建凭据不会修改应用。只支持 JSON，不接收 protobuf、gRPC 或指标协议。</p></section>
    <p v-if="loaded && !credentials.length" class="text-sm text-surface-400">暂无接入凭据。</p>
    <section v-for="credential in credentials" :key="credential.id" class="section-panel p-4"><div class="flex flex-wrap justify-between gap-2"><h3 class="font-semibold">{{ credential.name }}</h3><span class="text-xs" :class="credential.enabled ? 'text-status-ok' : 'text-surface-400'">{{ credential.enabled ? '已启用' : '已停用' }}</span></div><p class="mt-3 break-all text-sm">{{ credential.hostId }} / {{ credential.projectId }}</p><p class="mt-2 text-xs text-surface-400">允许服务：{{ credential.services.join('、') }}</p><button v-if="credential.enabled" class="btn-secondary btn-sm mt-3" :disabled="busy" @click="revoke(credential)">停用该凭据</button></section>
    <BaseModal :show="!!draft" title="创建范围受限的遥测凭据" :close-disabled="busy" @close="draft = null"><form v-if="draft" class="space-y-4" @submit.prevent="create"><p v-if="formError" class="alert-error" role="alert">{{ formError }}</p><fieldset :disabled="busy" class="space-y-4"><label class="form-grid-label"><span>凭据名称</span><input v-model.trim="draft.name" class="input w-full" maxlength="100" required /></label><label class="form-grid-label"><span>节点与应用</span><select v-model="targetKey" class="input w-full" required @change="draft.services = []"><option value="" disabled>选择纳管应用</option><option v-for="target in targets" :key="target.hostId + ':' + target.projectId" :value="target.hostId + ':' + target.projectId">{{ target.projectName }} · {{ target.hostId }}</option></select></label><fieldset class="space-y-2"><legend class="mb-2 text-sm">允许接入的服务</legend><label v-for="service in selected?.services || []" :key="service" class="flex gap-2 text-sm"><input v-model="draft.services" type="checkbox" :value="service" />{{ service }}</label></fieldset></fieldset><button class="btn-primary" :disabled="busy || !draft.services.length">创建凭据</button></form></BaseModal>
    <BaseModal :show="!!token" title="遥测凭据（仅显示一次）" @close="token = ''"><p class="text-sm leading-6">保存到应用的安全凭据配置中。请求头使用 Authorization: Bearer 后接凭据；不要放入 URL 或公开日志。关闭后无法再次查看。</p><textarea :value="token" class="input w-full mt-3 font-mono text-xs" rows="3" readonly aria-label="遥测接入凭据" /><p class="mt-3 text-xs text-surface-400">常用导出配置：endpoint={{ endpoint }}，protocol=http/json。不同语言导出器支持情况不同，详见 docs/public/INCIDENT_CORRELATION.md。</p></BaseModal>
  </div>
</template>
<script setup>
import { ref, computed, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue';
import { api } from '../api/client.js';
import BaseModal from './common/BaseModal.vue';
const credentials = ref([]), targets = ref([]), error = ref(''), notice = ref(''), formError = ref(''), draft = ref(null), targetKey = ref(''), token = ref(''), busy = ref(false), loaded = ref(false);
const endpoint = window.location.origin + '/otlp';
const selected = computed(() => targets.value.find(row => row.hostId + ':' + row.projectId === targetKey.value));
let active = false, disposed = false, epoch = 0, controller, loading = false;
async function load() {
  if (!active || loading) return; const current = ++epoch; loading = true; controller = new AbortController();
  try { const [state, projects] = await Promise.all([api.getSreResource('telemetry/credentials', controller.signal), api.getSreTargets(controller.signal)]); if (active && current === epoch) { credentials.value = state.credentials; targets.value = projects.targets; loaded.value = true; error.value = ''; } }
  catch (cause) { if (active && current === epoch) error.value = cause.message; }
  finally { if (current === epoch) loading = false; }
}
function open() { draft.value = { name: '', services: [] }; targetKey.value = ''; formError.value = ''; }
async function act(work, complete) {
  if (!active || busy.value) return; controller?.abort(); loading = false; const current = ++epoch; busy.value = true; formError.value = ''; error.value = '';
  try { const result = await work(); if (active && current === epoch) { complete(result); await load(); } }
  catch (cause) { if (active && current === epoch) { if (draft.value) formError.value = cause.message; else error.value = cause.message; } }
  finally { busy.value = false; }
}
function create() { if (!selected.value) return; const target = selected.value; return act(() => api.sreOperation('telemetry/credentials', { ...draft.value, hostId: target.hostId, projectId: target.projectId }), result => { draft.value = null; token.value = result.token; notice.value = '接入凭据已创建。'; }); }
function revoke(credential) { return act(() => api.sreOperation('telemetry/credentials/' + encodeURIComponent(credential.id), {}, 'DELETE'), () => { notice.value = '凭据已停用，新的遥测写入将被拒绝。'; }); }
function start() { if (active || disposed) return; active = true; void load(); }
function stop() { active = false; controller?.abort(); epoch++; loading = false; token.value = ''; }
onMounted(start); onActivated(start); onDeactivated(stop); onBeforeUnmount(() => { disposed = true; stop(); });
</script>
