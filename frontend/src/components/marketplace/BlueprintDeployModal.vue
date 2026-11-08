<template>
  <BaseModal :show="true" :title="`部署应用：${template.name}`" :close-disabled="busy" size-class="max-w-3xl max-h-[90dvh] flex flex-col" body-class="deploy-body min-h-0 overflow-y-auto" @close="close(!hasResult)">
    <div class="deploy-summary">
      <span class="deploy-emblem"><Rocket :size="23" aria-hidden="true" /></span>
      <div><p class="deploy-kicker">新的服务，从这里开始</p><h3>{{ template.name }}</h3><p v-if="!hasResult">{{ template.description || '确认配置后，在选定节点创建独立项目。' }}</p></div>
    </div>
    <ol class="deploy-steps" aria-label="部署进度">
      <li v-for="(step, index) in steps" :key="step" :class="{ current: stepIndex === index, complete: stepIndex > index }" :aria-current="stepIndex === index ? 'step' : undefined">
        <span><Check v-if="stepIndex > index" :size="12" /><LoaderCircle v-else-if="busy && stepIndex === index" :size="12" class="animate-spin" /><template v-else>{{ index + 1 }}</template></span>{{ step }}
      </li>
    </ol>

    <div class="deploy-target"><Server :size="15" aria-hidden="true" /><div><span>目标节点</span><strong>{{ context.hostName }}</strong></div><code>{{ canEdit && !busy ? `/projects/${projectName || '项目名称'}` : context.workingDir }}</code></div>
    <p v-if="hostMismatch" class="deploy-notice" role="alert">当前节点已切换。本次操作仍属于 {{ context.hostName }}，请切回该节点后查看结果。<button v-if="canEdit" class="text-link" @click="retarget">改用当前节点</button></p>
    <p v-else-if="hosts.active?.type === 'tcp'" class="deploy-notice" role="alert">TCP 节点不能创建应用配置，请切换到本地或 SSH 节点。</p>
    <p v-if="hosts.error" class="deploy-notice" role="alert">节点信息读取失败：{{ hosts.error }}<button class="text-link" :disabled="hosts.loading" @click="hosts.load(true)">重试读取节点</button></p>

    <form v-if="!hasResult || canEdit" ref="form" class="deploy-form" @submit.prevent="start">
      <div class="deploy-field"><label for="market-deploy-project-name">项目名称</label><input id="market-deploy-project-name" v-model="projectName" class="input" :disabled="busy || hostMismatch" :aria-invalid="!!fieldErrors.projectName" aria-describedby="deploy-name-hint" autocomplete="off" maxlength="40" @input="fieldErrors.projectName = ''" /><p id="deploy-name-hint">小写字母、数字、_ 或 -。已有项目目录不会被覆盖。</p><span v-if="fieldErrors.projectName" class="field-error">{{ fieldErrors.projectName }}</span></div>
      <div v-if="variables.length" class="deploy-fields">
        <div v-for="field in variables" :key="field.key" class="deploy-field" :class="{ 'secret-field': isSecret(field) }">
          <label :for="`market-deploy-variable-${field.key}`">{{ field.label || field.key }}<span v-if="isSecret(field)" class="secret-tag"><KeyRound :size="11" />私密</span></label>
          <div class="deploy-input-row"><input :id="`market-deploy-variable-${field.key}`" v-model="values[field.key]" :type="isSecret(field) && !visibleSecrets[field.key] ? 'password' : 'text'" :inputmode="field.type === 'port' ? 'numeric' : undefined" :autocomplete="isSecret(field) ? 'new-password' : 'off'" :spellcheck="false" class="input" :disabled="busy || hostMismatch" :aria-invalid="!!fieldErrors[field.key]" @input="generated.delete(field.key); fieldErrors[field.key] = ''" />
            <button v-if="isSecret(field)" type="button" class="secret-toggle" :aria-label="`${visibleSecrets[field.key] ? '隐藏' : '显示'}${field.label || field.key}`" :aria-pressed="!!visibleSecrets[field.key]" @click="visibleSecrets[field.key] = !visibleSecrets[field.key]"><EyeOff v-if="visibleSecrets[field.key]" :size="16" /><Eye v-else :size="16" /></button>
          </div>
          <div v-if="isSecret(field)" class="secret-tools"><span>{{ generated.has(field.key) ? '已生成随机密码' : '仅在本次窗口中保留' }}</span><button type="button" :disabled="busy || hostMismatch" @click="generateSecret(field)"><RefreshCw :size="12" />重新生成</button><button type="button" @click="copySecret(field)"><Copy :size="12" />复制</button></div>
          <span v-if="fieldErrors[field.key]" class="field-error">{{ fieldErrors[field.key] }}</span>
        </div>
      </div>
      <p class="deploy-note"><ShieldCheck :size="15" />配置将写入目标节点。秘密不会保存在浏览器存储中。</p>
    </form>

    <section v-if="status !== 'setup'" class="deployment-result" :data-status="status" aria-live="polite">
      <span class="result-icon"><LoaderCircle v-if="busy" :size="22" class="animate-spin" /><CircleCheck v-else-if="status === 'success'" :size="22" /><TriangleAlert v-else :size="22" /></span>
      <div><h3>{{ statusTitle }}</h3><p>{{ statusDescription }}</p><p v-if="result?.code != null" class="exit-note">Compose 退出码 {{ result.code }}</p></div>
    </section>
    <p v-if="error" class="deploy-error" role="alert">{{ error }}</p>
    <p v-if="feedback" class="deploy-feedback" role="status">{{ feedback }}</p>


    <section v-if="status !== 'setup'" class="deployment-console" aria-label="部署输出">
      <header><span><Terminal :size="14" />部署输出</span><div><button v-if="!following" @click="followOutput">跟随最新</button><button :disabled="!output" @click="copyOutput"><Copy :size="13" />复制输出</button></div></header>
      <p v-if="outputTruncated" class="output-limit">仅保留最近 64K 字符，较早输出已省略。</p>
      <pre ref="outputElement" tabindex="0" aria-label="部署输出内容" @scroll="trackScroll">{{ output || (busy ? '等待部署输出…' : '没有收到命令输出。') }}</pre>
    </section>

    <section v-if="hasResult && context.projectId" class="deploy-inspection">
      <div class="inspection-heading"><h4>运行状态核对</h4><button class="text-link" :disabled="inspecting || hostMismatch" @click="inspectProject"><RefreshCw :size="13" :class="{ 'animate-spin': inspecting }" />{{ inspecting ? '核对中…' : '重新核对' }}</button></div>
      <p>{{ inspectionText }}</p>
      <div v-if="project?.containers?.length" class="deployment-containers"><span v-for="container in project.containers" :key="container.id" :data-running="container.state === 'running'"><i />{{ container.service || container.name }}<small>{{ container.health === 'healthy' ? '健康检查通过' : container.health === 'unhealthy' ? '健康检查未通过' : container.state === 'running' ? '运行中' : '未运行' }}</small></span></div>
      <div class="deployment-links"><button class="btn-secondary" :disabled="hostMismatch" @click="navigate('services')"><Box :size="15" />查看服务</button><button class="btn-secondary" :disabled="hostMismatch || !project" @click="navigate('logs')"><ScrollText :size="15" />查看日志</button><button class="btn-secondary" :disabled="hostMismatch || !project?.editable" @click="navigate('compose')"><FileCode2 :size="15" />查看配置</button></div>
    </section>
    <details v-if="!record && hasResult && !canEdit && secretFields.length" class="deployment-credentials"><summary><KeyRound :size="14" />保存本次应用凭据</summary><p>关闭窗口后将不再显示这些值，请按需保存。</p><div v-for="field in secretFields" :key="field.key"><label :for="`deployed-secret-${field.key}`">{{ field.label || field.key }}</label><input :id="`deployed-secret-${field.key}`" class="input" type="password" readonly :value="values[field.key]" autocomplete="off" /><button class="text-link" :aria-label="`复制${field.label || field.key}`" @click="copySecret(field)"><Copy :size="14" />复制</button></div></details>
    <p v-if="record" class="deploy-feedback">上次部署记录 · 仅在本次页面会话内保留，不含密码字段。运行状态请重新核对。</p>
    <template #footer>
      <div class="deployment-footer"><button v-if="!busy" class="btn-secondary btn-cancel" @click="close(!hasResult)">{{ hasResult ? '返回市场' : returnLabel }}</button><button v-else class="btn-secondary" @click="stopWaiting">停止等待</button><span v-if="busy">已执行的操作不会自动回滚</span><button v-if="canEdit" class="btn-primary btn-save" :disabled="busy || hostMismatch || hosts.loading || hosts.active?.type === 'tcp'" @click="start"><Rocket :size="15" />{{ busy ? '部署中…' : status === 'failed' ? '重新检查并部署' : '部署' }}</button></div>
    </template>
  </BaseModal>
</template>

<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Box, Check, CircleCheck, Copy, Eye, EyeOff, FileCode2, KeyRound, LoaderCircle, RefreshCw, Rocket, ScrollText, Server, ShieldCheck, Terminal, TriangleAlert } from 'lucide-vue-next';
import BaseModal from '../common/BaseModal.vue';
import { api } from '../../api/client.js';
import { useHostsStore } from '../../stores/hosts.js';
import { copyText } from '../../lib/clipboard.js';
import { deepLink } from '../../lib/deep-links.js';
import { notifyDataChanged } from '../../lib/data-changes.js';

const props = defineProps({ template: { type: Object, required: true }, returnLabel: { type: String, default: '取消' }, record: { type: Object, default: null } });
const emit = defineEmits(['close', 'deployed', 'record']);
const hosts = useHostsStore(); const router = useRouter();
const schema = computed(() => {
  const source = props.template.envSchema || props.template.variables || [];
  return Array.isArray(source) ? source : Object.entries(source).map(([key, config]) => typeof config === 'object' ? { key, ...config } : { key, default: config });
});
const variables = computed(() => schema.value.filter(field => field.key !== 'CONTAINER_NAME'));
const projectName = ref(props.template.id); const values = ref({}); const visibleSecrets = ref({});
const generated = ref(new Set()); const fieldErrors = ref({}); const form = ref(null);
const context = ref({ hostId: hosts.activeHostId, hostName: hosts.active?.name || '本地节点', projectId: '', workingDir: '' });
const status = ref('setup'); const phase = ref('queued'); const busy = ref(false); const error = ref(''); const feedback = ref('');
const result = ref(null); const output = ref(''); const outputTruncated = ref(false); const outputElement = ref(null); const following = ref(true);
const project = ref(null); const inspecting = ref(false); const inspectionError = ref('');
let active = true; let runId = 0; let inspectionId = 0; let controller; let outputObserver;
const isSecret = field => field.secret || field.type === 'password';
const secretFields = computed(() => variables.value.filter(isSecret));
const hostMismatch = computed(() => context.value.hostId !== hosts.activeHostId);
const hasResult = computed(() => ['success', 'failed', 'unknown'].includes(status.value));
const canEdit = computed(() => !props.record && (!hasResult.value || (status.value === 'failed' && !result.value?.filesCreated && !result.value?.directoryCreated)));
const steps = ['填写配置', '准备项目', '启动服务', '核对结果'];
const stepIndex = computed(() => status.value === 'success' ? 3 : status.value === 'setup' ? 0 : phase.value === 'starting' ? 2 : 1);
const statusTitle = computed(() => busy.value ? ({ queued: '正在等待项目操作', checking: '正在检查目标与端口', preparing: '正在创建项目配置', starting: '正在启动服务' }[phase.value] || '正在部署') : ({ success: '启动命令已完成', failed: '部署未完成', unknown: '结果待核对' }[status.value] || ''));
const statusDescription = computed(() => busy.value ? '可以在下方查看实时输出。' : status.value === 'success' ? '启动成功不代表应用已就绪，请继续核对容器与健康检查。' : status.value === 'unknown' ? '连接已结束，但未收到完整结果。请先检查目标项目，避免重复部署。' : result.value?.directoryCreated || result.value?.filesCreated ? '已创建的目录和配置会保留，请查看输出与项目后再处理。' : props.record ? '前置检查未完成。查看错误后，可从应用卡重新配置。' : '尚未确认创建新配置。修改下方错误后可重新检查。');
const inspectionText = computed(() => {
  if (hostMismatch.value) return '切回目标节点后可以核对运行状态。';
  if (inspecting.value) return '正在读取目标项目的容器状态…';
  if (inspectionError.value) return inspectionError.value;
  if (!project.value?.containers?.length) return '暂未发现该项目的容器。配置可能已写入，请根据输出和目标目录核对。';
  const containers = project.value.containers;
  if (containers.some(item => item.state !== 'running' || item.health === 'unhealthy')) return '部分容器未运行或健康检查未通过，请查看日志。';
  if (containers.some(item => item.health === 'starting')) return '容器已运行，健康检查仍在启动中。';
  if (containers.every(item => item.health === 'healthy')) return '当前发现的容器均运行，且健康检查通过。';
  return '当前发现的容器已运行；部分未配置健康检查，请打开应用确认。';
});

function generateSecret(field) {
  try {
    const replacing = !!values.value[field.key];
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
    values.value[field.key] = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    fieldErrors.value[field.key] = '';
    generated.value.add(field.key);
    if (replacing) feedback.value = `${field.label || field.key}已重新生成`;
  } catch { fieldErrors.value[field.key] = '浏览器无法生成随机密码，请手动填写。'; }
}
for (const field of props.record ? [] : variables.value) {
  values.value[field.key] = String(field.default ?? '');
  if (isSecret(field) && !values.value[field.key]) generateSecret(field);
}
if (props.record) {
  context.value = { ...props.record.context };
  status.value = props.record.status;
  phase.value = props.record.phase;
  result.value = props.record.result ? { ...props.record.result } : null;
  output.value = props.record.output;
  outputTruncated.value = props.record.outputTruncated;
  error.value = props.record.error;
}
function remember() {
  if (status.value === 'setup') return;
  const secrets = secretFields.value.map(field => values.value[field.key]).filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value || ''));
  const final = result.value;
  emit('record', { context: { ...context.value }, status: status.value, phase: phase.value,
    result: final ? { ok: final.ok, code: final.code, filesCreated: final.filesCreated, directoryCreated: final.directoryCreated } : null,
    output: redact(output.value), outputTruncated: outputTruncated.value, error: redact(error.value) });
}
function close(returnToDetails = false) { remember(); emit('close', returnToDetails); }
function retarget() {
  if (!canEdit.value || busy.value) return;
  context.value = { hostId: hosts.activeHostId, hostName: hosts.active?.name || '本地节点', projectId: '', workingDir: '' };
  status.value = 'setup'; result.value = null; error.value = ''; output.value = '';
}
function validate() {
  const errors = {};
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(projectName.value)) errors.projectName = '以小写字母或数字开头，最多 40 个字符。';
  const ports = new Set();
  for (const field of variables.value) {
    const value = String(values.value[field.key] ?? '');
    if ((isSecret(field) || field.required) && !value.trim()) errors[field.key] = '请填写此项。';
    if (field.type === 'port') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) errors[field.key] = '请输入 1–65535 的端口号。';
      else if (ports.has(Number(value))) errors[field.key] = '不同端口字段不能重复。';
      ports.add(Number(value));
    }
  }
  fieldErrors.value = errors;
  if (Object.keys(errors).length) { void nextTick(() => form.value?.querySelector('[aria-invalid="true"]')?.focus()); return false; }
  return true;
}
async function start() {
  if (busy.value || !canEdit.value || hostMismatch.value || !validate()) return;
  if (hosts.active?.type === 'tcp') { error.value = 'TCP 节点不能创建应用配置，请切换到本地或 SSH 节点。'; return; }
  const id = ++runId; controller = new AbortController();
  busy.value = true; status.value = 'running'; phase.value = 'queued'; error.value = ''; feedback.value = ''; result.value = null; output.value = ''; outputTruncated.value = false; following.value = true;
  context.value = { ...context.value, projectId: '', projectName: projectName.value, workingDir: `/projects/${projectName.value}` };
  project.value = null; inspectionId++; inspecting.value = false;
  const current = () => active && id === runId;
  try {
    await api.streamBlueprintDeploy(props.template.id, { ...values.value, projectName: projectName.value }, frame => {
      if (!current() || result.value) return;
      if (frame.type === 'phase') {
        phase.value = frame.data?.phase || phase.value;
        const { projectId, workingDir, projectName: name } = frame.data || {};
        context.value = { ...context.value, ...(projectId ? { projectId } : {}), ...(workingDir ? { workingDir } : {}), ...(name ? { projectName: name } : {}) };
      } else if (frame.type === 'stdout' || frame.type === 'stderr') appendOutput(frame.data);
      else if (frame.type === 'result') {
        result.value = frame.data || {};
        context.value = { ...context.value, ...Object.fromEntries(['projectId', 'projectName', 'workingDir'].filter(key => frame.data?.[key]).map(key => [key, frame.data[key]])) };
        if (frame.data?.output) output.value = String(frame.data.output).slice(-65536);
        outputTruncated.value ||= !!frame.data?.outputTruncated;
        status.value = frame.data?.ok === true && frame.data?.code === 0 ? 'success' : 'failed';
        error.value = status.value === 'failed' ? frame.data?.message || '部署命令失败，请查看输出。' : '';
        busy.value = false;
        notifyDataChanged({ source: 'marketplace', projectId: context.value.projectId, hostId: context.value.hostId });
        if (status.value === 'success') emit('deployed', result.value);
        // result 是终帧；不等待代理关闭连接，也不接受重复或迟到帧反转结果。
        controller?.abort();
        if (following.value) void nextTick(followOutput);
        if (status.value === 'failed') void nextTick(() => outputElement.value?.scrollIntoView?.({ block: 'nearest' }));
        if (context.value.projectId && !hostMismatch.value) void inspectProject();
      }
    }, controller.signal, context.value.hostId);
    if (current() && !result.value) status.value = 'unknown';
  } catch (failure) {
    if (current() && !result.value) { status.value = 'unknown'; error.value = failure.name === 'AbortError' ? '已停止等待，请核对目标项目。' : failure.message || '部署连接中断'; }
  } finally {
    if (current()) { busy.value = false; controller = null; if (!result.value && context.value.projectId && !hostMismatch.value) void inspectProject(); }
  }
}
function appendOutput(text) {
  const next = output.value + String(text ?? ''); outputTruncated.value ||= next.length > 65536; output.value = next.slice(-65536);
  if (following.value) void nextTick(() => { if (following.value) followOutput(); });
}
let outputGeometry;
const geometry = element => [element.clientWidth, element.clientHeight, element.scrollHeight];
function trackScroll() {
  const element = outputElement.value; if (!element) return;
  const next = geometry(element);
  const reflowed = outputGeometry && next.some((value, index) => value !== outputGeometry[index]);
  outputGeometry = next;
  // WebKit can emit the layout-induced scroll before ResizeObserver. It is not a user scroll.
  if (reflowed && following.value) { followOutput(); return; }
  following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
}
function followOutput() {
  following.value = true;
  if (outputElement.value) { outputElement.value.scrollTop = outputElement.value.scrollHeight; outputGeometry = geometry(outputElement.value); }
}
watch(outputElement, element => {
  outputObserver?.disconnect();
  outputGeometry = element ? geometry(element) : undefined;
  if (!element || typeof ResizeObserver !== 'function') return;
  outputObserver = new ResizeObserver(() => { if (following.value) followOutput(); else outputGeometry = geometry(element); });
  outputObserver.observe(element);
});
function stopWaiting() {
  if (!busy.value) return;
  ++runId; controller?.abort(); controller = null; busy.value = false;
  if (!result.value) { status.value = 'unknown'; error.value = '已停止等待，已执行的操作不会自动回滚。请核对目标项目。'; }
}
async function inspectProject() {
  if (hostMismatch.value || inspecting.value || !context.value.projectId) return;
  const id = ++inspectionId; const hostId = context.value.hostId; inspecting.value = true; inspectionError.value = '';
  try {
    const data = await api.getProjects(true);
    if (!active || id !== inspectionId || hostId !== hosts.activeHostId) return;
    project.value = (data.projects || []).find(item => item.id === context.value.projectId) || null;
  } catch (failure) { if (active && id === inspectionId) inspectionError.value = `运行状态读取失败：${failure.message}。部署结果已保留，可重新核对。`; }
  finally { if (id === inspectionId) inspecting.value = false; }
}
async function copy(value, success) {
  const id = runId;
  try { await copyText(value); if (active && id === runId) feedback.value = success; }
  catch { if (active && id === runId) feedback.value = '复制失败，请选择文本后手动复制。'; }
}
const copyOutput = () => copy(output.value, '部署输出已复制');
const copySecret = field => copy(values.value[field.key], `${field.label || field.key}已复制`);
function navigate(page) {
  if (hostMismatch.value || !context.value.projectId) return;
  close(false);
  void router.push(deepLink(`/${page}`, page === 'services' ? { focus: context.value.projectId, from: 'marketplace' } : { projectId: context.value.projectId, from: 'marketplace' }));
}
watch(() => hosts.activeHostId, () => { inspectionId++; inspecting.value = false; project.value = null; if (busy.value) stopWaiting(); });
function deactivate() { if (!active) return; outputObserver?.disconnect(); stopWaiting(); remember(); controller?.abort(); controller = null; runId++; active = false; inspectionId++; inspecting.value = false; }
onDeactivated(() => { deactivate(); emit('close', false); }); onBeforeUnmount(deactivate); onActivated(() => { active = true; });
</script>

<style scoped>
@reference '../../style.css';
.deploy-summary { @apply flex items-start gap-4 p-5 pb-3; }
.deploy-emblem { @apply grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300; box-shadow: inset 0 1px 0 #ffffff12; }
.deploy-summary h3 { @apply mt-0.5 text-lg font-semibold text-surface-50; }
.deploy-summary p:not(.deploy-kicker) { @apply mt-1 text-xs leading-5 text-surface-400; }
.deploy-kicker { @apply text-[10px] tracking-wider text-emerald-300/80; }
.deploy-steps { @apply mx-5 mb-4 grid grid-cols-4 rounded-xl border border-surface-800 bg-surface-950/40 p-2; }
.deploy-steps li { @apply flex items-center justify-center gap-2 text-[11px] text-surface-500; }
.deploy-steps li > span { @apply grid h-5 w-5 shrink-0 place-items-center rounded-full border border-surface-700 text-[10px]; }
.deploy-steps .current { @apply text-surface-100; }.deploy-steps .current > span { @apply border-emerald-400/50 bg-emerald-400/10 text-emerald-300; }.deploy-steps .complete { @apply text-emerald-300; }.deploy-steps .complete > span { @apply border-emerald-400/20 bg-emerald-400/10; }
.deploy-target { @apply mx-5 mb-5 flex flex-wrap items-center gap-2.5 rounded-lg border border-surface-800 px-3 py-2.5 text-surface-400; }
.deploy-target div { @apply flex items-center gap-2 text-xs; }.deploy-target strong { @apply font-medium text-surface-200; }.deploy-target code { @apply ml-auto break-all text-[11px] text-surface-400; }
.deploy-form { @apply px-5 pb-2; }.deploy-fields { @apply mt-5 grid grid-cols-2 gap-x-4 gap-y-5; }.deploy-field { @apply grid min-w-0 gap-1.5; }.deploy-field label { @apply flex items-center gap-2 text-xs font-medium text-surface-200; }.deploy-field input { @apply min-h-11 w-full; }.deploy-field > p { @apply text-[11px] leading-5 text-surface-500; }.deploy-input-row { @apply relative; }.deploy-input-row input[type=password], .secret-field .deploy-input-row input { @apply pr-11 font-mono text-xs; }.secret-field { @apply col-span-2; }
.secret-tag { @apply inline-flex items-center gap-1 rounded border border-amber-400/20 bg-amber-400/5 px-1 text-[10px] font-normal text-amber-300; }.secret-toggle { @apply absolute right-0 top-0 grid h-11 w-11 place-items-center rounded text-surface-400 hover:text-surface-100; }.secret-tools { @apply flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-surface-500; }.secret-tools button { @apply inline-flex min-h-10 items-center gap-1 px-1 text-emerald-300 hover:text-emerald-200; }.secret-tools span { @apply mr-auto; }.deploy-note { @apply my-4 flex items-start gap-2 text-[11px] leading-5 text-surface-500; }.deploy-note svg { @apply mt-0.5 shrink-0; }.field-error { @apply text-xs text-status-error; }
.deployment-result { @apply mx-5 my-4 flex items-start gap-3 rounded-xl border border-surface-700 bg-surface-900 p-4; }.result-icon { @apply mt-0.5 text-emerald-300; }.deployment-result[data-status=failed], .deployment-result[data-status=unknown] { @apply border-amber-400/20 bg-amber-400/5; }.deployment-result[data-status=failed] .result-icon, .deployment-result[data-status=unknown] .result-icon { @apply text-amber-300; }.deployment-result h3 { @apply text-sm font-semibold text-surface-100; }.deployment-result p { @apply mt-1 text-xs leading-5 text-surface-400; }.deployment-result .exit-note { @apply font-mono text-[10px]; }
.deploy-error, .deploy-notice { @apply mx-5 mb-4 break-words text-xs leading-5 text-status-error; }.deploy-notice { @apply text-amber-300; }.deploy-feedback { @apply mx-5 mb-3 text-xs text-emerald-300; }.text-link { @apply inline-flex min-h-8 items-center gap-1.5 text-xs text-emerald-300 hover:underline disabled:opacity-40; }
.deployment-console { @apply mx-5 my-4 overflow-hidden rounded-xl border border-surface-800 bg-surface-950; }.deployment-console header { @apply flex items-center justify-between gap-2 border-b border-surface-800 bg-surface-900/70 px-3 py-1.5; }.deployment-console header > span { @apply flex items-center gap-2 text-[11px] text-surface-400; }.deployment-console header > div { @apply flex flex-wrap gap-2; }.deployment-console header button { @apply inline-flex min-h-8 items-center gap-1.5 text-[11px] text-surface-300 hover:text-surface-50 disabled:opacity-40; }.deployment-console pre { @apply max-h-52 min-h-28 overflow-auto whitespace-pre-wrap break-all px-4 py-3 font-mono text-[11px] leading-5 text-surface-300; scrollbar-gutter: stable; }.output-limit { @apply px-3 pt-2 text-[10px] text-amber-300; }
.deploy-inspection { @apply mx-5 mb-5 border-t border-surface-800 pt-3; }.inspection-heading { @apply flex items-center justify-between gap-2; }.inspection-heading h4 { @apply text-xs font-medium text-surface-200; }.deploy-inspection > p { @apply my-1 text-xs leading-5 text-surface-400; }.deployment-containers { @apply my-3 grid gap-2; }.deployment-containers > span { @apply flex min-w-0 flex-wrap items-center gap-2 break-all text-xs text-surface-300; }.deployment-containers i { @apply h-1.5 w-1.5 rounded-full bg-amber-300; }.deployment-containers [data-running=true] i { @apply bg-emerald-300; }.deployment-containers small { @apply ml-auto text-[10px] text-surface-500; }.deployment-links { @apply mt-3 flex flex-wrap gap-2; }.deployment-links button { @apply min-h-10; }
.deployment-footer { @apply flex w-full flex-wrap items-center justify-end gap-2; }.deployment-footer > span { @apply mr-auto text-[10px] text-surface-500; }.deployment-footer .btn-cancel { @apply mr-auto; }.deployment-footer button { @apply min-h-11; }
.deployment-credentials { @apply mx-5 mb-4 rounded-lg border border-surface-800 p-3; }.deployment-credentials summary { @apply flex min-h-8 cursor-pointer items-center gap-2 text-xs text-amber-300; }.deployment-credentials > p { @apply my-2 text-[11px] text-surface-400; }.deployment-credentials > div { @apply mt-2 flex flex-wrap items-center gap-2; }.deployment-credentials label { @apply w-full text-xs text-surface-300; }.deployment-credentials input { @apply min-w-0 flex-1 font-mono; }
@media (max-width: 480px) { .deployment-console header button, .text-link { min-height: 40px; } .deploy-fields { grid-template-columns: 1fr; }.secret-field { grid-column: auto; }.deploy-steps li { flex-direction: column; gap: 5px; font-size: 10px; }.deploy-target code { width: 100%; margin-left: 24px; }.deploy-summary { gap: 12px; }.deployment-footer > span { order: -1; width: 100%; text-align: center; }.deployment-links button { flex: 1 1 100px; }.deploy-summary, .deploy-form { padding-left: 16px; padding-right: 16px; }.deploy-steps, .deploy-target, .deployment-result, .deployment-console, .deploy-inspection { margin-left: 16px; margin-right: 16px; } }
@media (prefers-reduced-motion: reduce) { .animate-spin { animation: none; } }
</style>
