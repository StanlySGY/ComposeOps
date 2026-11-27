<template>
  <BaseModal
    :show="show"
    title="新建 Compose 项目"
    size-class="max-w-[calc(100vw-2rem)] sm:max-w-3xl flex max-h-[88dvh] flex-col overflow-hidden"
    body-class="min-h-0 flex-1 overflow-y-auto space-y-4 p-4"
    :close-disabled="busy && !jobId"
    @close="close"
  >
    <div class="rounded-lg border border-surface-800 bg-surface-900/50 p-3 text-xs leading-5 text-surface-400">
      选择目标节点上的任意普通目录，在其中创建独立项目文件夹，保存 Compose 与 .env，校验配置、拉取镜像并启动。
      已存在的目录不会被覆盖。创建后的项目沿用现有服务管理、镜像更新和回滚能力。
    </div>

    <div v-if="optionsError" class="alert-error flex items-center justify-between gap-3" role="alert">
      <span>{{ optionsError }}</span>
      <button class="btn-secondary shrink-0" type="button" @click="loadOptions">重试</button>
    </div>
    <div v-else-if="!options" class="flex items-center gap-2 py-3 text-sm text-muted" role="status">
      <LoaderCircle class="h-4 w-4 animate-spin" />正在读取目标节点与目录快捷入口…
    </div>
    <template v-else>
      <p class="text-sm text-surface-200">目标节点：<strong>{{ options.hostName }}</strong></p>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="grid content-start gap-1.5 text-xs text-surface-300">
          项目名称
          <input
            v-model="projectName"
            class="input w-full font-mono"
            :disabled="busy || persisted"
            maxlength="40"
            autocomplete="off"
            placeholder="例如 my-web"
            aria-label="项目名称"
            :aria-invalid="!!fieldError" :aria-describedby="fieldError ? 'compose-name-hint compose-name-error' : 'compose-name-hint'" @blur="nameTouched = true"
          />
          <span id="compose-name-hint" class="text-[11px] text-muted">小写字母或数字开头，只能包含小写字母、数字、_ 和 -，最多 40 个字符。</span>
          <span v-if="fieldError" id="compose-name-error" class="field-error" role="alert">{{ fieldError }}</span>
          <button v-if="lowercaseSuggestion" type="button" class="text-left text-xs text-status-info" :disabled="busy || persisted" @click="projectName = lowercaseSuggestion">改为 {{ lowercaseSuggestion }}</button>
        </label>
        <div class="grid content-start gap-2">
          <HostDirectoryPicker v-if="show" v-model="rootDir" :host-id="options.hostId" :roots="options.roots" :disabled="busy || persisted || options.supported === false" />
          <span v-if="directoryError" class="field-error" role="status">{{ directoryError }}</span>
          <span class="break-all text-[11px] text-muted">最终目录：{{ finalDirectory }}</span>
        </div>
      </div>

      <label class="grid gap-1.5 text-xs text-surface-300">
        Compose YAML
        <textarea
          v-model="composeContent"
          class="input compose-editor w-full resize-y font-mono text-xs leading-5"
          rows="14"
          :disabled="busy || persisted"
          spellcheck="false"
          aria-label="Compose YAML" :aria-invalid="composeTouched && !composeContent.trim()" @blur="composeTouched = true"
          placeholder="services:&#10;  web:&#10;    image: nginx:latest&#10;    ports:&#10;      - &quot;8080:80&quot;"
        />
        <span v-if="composeTouched && !composeContent.trim()" class="field-error" role="status">请填写 Compose YAML。</span>
        <span class="text-[11px] text-muted">支持标准 Docker Compose YAML，最大 1 MiB；部署前会执行 docker compose config --quiet。</span>
      </label>

      <details class="rounded-lg border border-surface-800 p-3">
        <summary class="cursor-pointer select-none text-xs text-surface-300">环境变量（可选 .env）</summary>
        <label class="mt-3 grid gap-1.5 text-xs text-surface-300">
          .env 内容
          <textarea
            v-model="envContent"
            class="input env-editor w-full resize-y font-mono text-xs leading-5"
            rows="5"
            :disabled="busy || persisted"
            spellcheck="false"
            aria-label=".env 内容"
            placeholder="APP_ENV=production"
          />
          <span class="text-[11px] text-muted">文件权限仅所有者可读写（0600）。不要把密码或 API Key 写进 Compose YAML。</span>
        </label>
      </details>

      <div v-if="options.supported === false" class="alert-warning" role="alert">
        {{ options.reason || '当前 Docker 节点不支持在宿主机创建项目目录。' }}
      </div>
    </template>

    <p v-if="sizeError" class="alert-error" role="alert">{{ sizeError }}</p>
    <div v-if="jobId" class="flex flex-wrap items-center gap-3 text-xs text-muted" role="status">
      <span>任务已保存，关闭窗口或刷新页面后仍可查看进度。</span>
      <a class="text-status-info hover:underline" :href="'#' + deepLink('/events', { tab: 'operations', job: jobId })" @click="close">查看后台任务</a>
    </div>
    <div v-if="busy || output || result" class="overflow-hidden rounded-lg border border-surface-800">
      <div class="flex items-center justify-between gap-3 border-b border-surface-800 bg-surface-900 px-3 py-2">
        <span class="text-xs font-medium text-surface-200">{{ phaseLabel }}</span>
        <span v-if="busy" class="flex items-center gap-1.5 text-[11px] text-status-info"><LoaderCircle class="h-3.5 w-3.5 animate-spin" />执行中</span>
        <span v-else-if="result?.ok" class="text-[11px] text-status-ok">命令完成</span>
        <span v-else-if="result" class="text-[11px] text-status-warn">需要检查</span>
      </div>
      <pre class="max-h-56 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-surface-300" aria-label="部署输出">{{ output || '等待输出…' }}</pre>
      <div v-if="result" class="border-t border-surface-800 p-3 text-xs leading-5" :class="result.ok ? 'text-status-ok' : 'text-status-warn'" role="status" aria-live="polite">
        {{ result.message }}
        <div v-if="persisted && result.projectId" class="mt-2 flex gap-3">
          <a class="text-status-info hover:underline" :href="'#' + deepLink('/compose', { projectId: result.projectId, hostId: resultHostId, from: 'services' })" @click="close">打开配置</a>
          <a class="text-status-info hover:underline" :href="'#' + deepLink('/services', { focus: result.projectId, hostId: resultHostId })" @click="close">查看项目</a>
        </div>
        <p v-if="result.workingDir" class="mt-1 break-all font-mono text-[11px] text-muted">{{ result.workingDir }}</p>
      </div>
    </div>

    <template #footer>
      <div class="w-full min-w-0 space-y-2">
      <p v-if="submitReason && !busy" class="text-xs text-muted" role="status" aria-live="polite">{{ submitReason }}</p>
      <div class="flex flex-wrap justify-end gap-2">
      <button class="btn-secondary" :disabled="busy && !jobId" @click="close">{{ busy && jobId ? '后台继续' : result ? '关闭' : '取消' }}</button>
      <button v-if="result && !busy && !result.outcomeUnknown" class="btn-secondary" @click="reset">新建另一项目</button>
      <button class="btn-primary" :disabled="busy || !canSubmit" @click="submit">
        <LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />
        <Rocket v-else class="h-4 w-4" />
        {{ busy ? '创建并部署中…' : '创建并部署' }}
      </button>
      </div></div>
    </template>
  </BaseModal>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { LoaderCircle, Rocket } from 'lucide-vue-next';
import HostDirectoryPicker from './HostDirectoryPicker.vue';
import { deepLink } from '../../lib/deep-links.js';
import BaseModal from '../common/BaseModal.vue';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';

const props = defineProps({ show: { type: Boolean, default: false } });
const emit = defineEmits(['close', 'created']);
const toast = useToastStore();
const OPTIONS_TIMEOUT_MS = 15000;
const options = ref(null);
const optionsError = ref('');
const projectName = ref('');
const rootDir = ref('');
const composeContent = ref('');
const envContent = ref('');
const nameTouched = ref(false);
const composeTouched = ref(false);
const validName = computed(() => /^[a-z0-9][a-z0-9_-]{0,39}$/.test(projectName.value.trim()));
const fieldError = computed(() => !projectName.value.trim() ? (nameTouched.value ? '请填写项目名称。' : '') : validName.value ? '' : /[A-Z]/.test(projectName.value) ? '项目名称只能使用小写字母，请修改大写字符。' : '名称需以小写字母或数字开头，只能包含小写字母、数字、_ 和 -。');
const lowercaseSuggestion = computed(() => /[A-Z]/.test(projectName.value) && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(projectName.value.trim().toLowerCase()) ? projectName.value.trim().toLowerCase() : '');
const directoryError = computed(() => rootDir.value.startsWith('/') ? '' : '请选择以 / 开头的宿主机目录。');
const busy = ref(false);
const phase = ref('');
const output = ref('');
const result = ref(null);
const jobId = ref('');
const resultHostId = ref('');
const persisted = computed(() => !!(result.value?.ok || result.value?.directoryCreated || result.value?.filesCreated));
const finalDirectory = computed(() => rootDir.value ? rootDir.value.replace(/\/$/, '') + '/' + (projectName.value || '项目名称') : '未选择');
const sizeError = computed(() => new TextEncoder().encode(composeContent.value).length > 1048576 ? 'Compose YAML 超过 1 MiB（按 UTF-8 字节计算）' : new TextEncoder().encode(envContent.value).length > 524288 ? '.env 超过 512 KiB（按 UTF-8 字节计算）' : '');
let controller = null;
let optionsController = null;
let optionsRequestId = 0;
let disposed = false;
let active = true;
let activatedBefore = false;
let draftHostId = '';
let resumeTimer;

const phaseLabels = {
  checking: '检查项目与目标节点',
  preparing: '创建项目目录并写入配置',
  validating: '验证 Compose 配置',
  pulling: '拉取镜像',
  starting: '构建并启动服务',
};
const phaseLabel = computed(() => phaseLabels[phase.value] || (busy.value ? '准备部署' : '部署输出'));
const submitReason = computed(() => {
  if (persisted.value) return '项目文件已创建，可查看项目或新建另一项目。';
  if (result.value?.outcomeUnknown) return '结果尚未确认，请先核对后台任务，避免重复部署。';
  if (optionsError.value) return optionsError.value;
  if (!options.value) return '正在读取创建配置…';
  if (options.value.supported === false) return options.value.reason || '当前节点不支持创建项目。';
  if (!projectName.value.trim()) return '请填写项目名称。';
  if (!validName.value) return fieldError.value;
  if (directoryError.value) return directoryError.value;
  if (!composeContent.value.trim()) return '请填写 Compose YAML。';
  return sizeError.value;
});
const canSubmit = computed(() => !submitReason.value);

function reset() {
  jobId.value = '';
  projectName.value = '';
  composeContent.value = '';
  envContent.value = '';
  nameTouched.value = false;
  composeTouched.value = false;
  output.value = '';
  result.value = null;
  phase.value = '';
  optionsError.value = '';
}

async function loadOptions() {
  optionsController?.abort();
  const requestId = ++optionsRequestId;
  const requestController = new AbortController();
  optionsController = requestController;
  options.value = null;
  optionsError.value = '';
  const timeoutId = window.setTimeout(() => requestController.abort(), OPTIONS_TIMEOUT_MS);
  try {
    const loadedOptions = await api.getComposeProjectCreateOptions(requestController.signal);
    if (requestId !== optionsRequestId || !props.show) return;
    options.value = loadedOptions;
    if (!rootDir.value || (draftHostId && draftHostId !== loadedOptions.hostId)) rootDir.value = loadedOptions.roots?.[0] || '/';
    draftHostId = loadedOptions.hostId;
  } catch (error) {
    if (requestId !== optionsRequestId || !props.show) return;
    if (requestController.signal.aborted) {
      optionsError.value = '读取创建配置超时（15 秒未收到服务器响应）。请重试，或检查服务器后端与当前 Docker 节点。';
    } else {
      optionsError.value = '读取创建配置失败：' + error.message;
    }
  } finally {
    window.clearTimeout(timeoutId);
    if (optionsController === requestController) optionsController = null;
  }
}

watch(() => props.show, (visible) => {
  if (!visible) {
    optionsRequestId += 1;
    optionsController?.abort();
    optionsController = null;
    return;
  }
  void loadOptions();
  if (jobId.value && !busy.value && result.value?.outcomeUnknown) void resumeJob();
});

function close() {
  if (busy.value && !jobId.value) return;
  controller?.abort();
  emit('close');
}

async function submit() {
  if (busy.value || !canSubmit.value) return;
  busy.value = true;
  output.value = '';
  result.value = null;
  phase.value = 'checking';
  jobId.value = ''; resultHostId.value = options.value.hostId;
  controller = new AbortController();
  try {
    await api.streamCustomComposeProjectDeploy({
      projectName: projectName.value.trim(),
      rootDir: rootDir.value,
      composeContent: composeContent.value,
      envContent: envContent.value,
      expectedHostId: options.value.hostId,
    }, (frame) => {
      if (frame.type === 'job') jobId.value = frame.data?.jobId || '';
      else if (frame.type === 'output') output.value = String(frame.data || '');
      else if (frame.type === 'phase') phase.value = frame.data?.phase || phase.value;
      else if (frame.type === 'stdout' || frame.type === 'stderr') output.value = (output.value + String(frame.data || '')).slice(-20000);
      else if (frame.type === 'result') result.value = frame.data || null;
      else if (frame.type === 'exit' && frame.data?.code !== 0 && result.value) result.value = { ...result.value, ok: false };
    }, controller.signal);
    if (!result.value) result.value = { ok: false, outcomeUnknown: true, message: '连接已结束，结果尚未确认，请查看后台任务和项目状态。' };
    if (persisted.value) emit('created', result.value);
    if (result.value?.ok) toast.success('Compose 项目 ' + projectName.value.trim() + ' 已创建并完成启动命令');
    else toast.warning(result.value?.message || '项目文件已保留，请检查部署输出');
  } catch (error) {
    if (result.value && !result.value.outcomeUnknown) {
      // 明确终态已收到，随后关闭观察连接不改变执行结果。
    } else if (jobId.value) {
      result.value = { ok: false, outcomeUnknown: true, message: '任务在后台继续，请查看后台任务获取结果。' };
      if (!controller.signal.aborted) resumeTimer = window.setTimeout(() => { if (!disposed && active && props.show) void resumeJob(); }, 0);
    } else {
      const safeToRetry = error.status >= 400 && error.status < 500;
      result.value = { ok: false, directoryCreated: false, outcomeUnknown: !safeToRetry, message: safeToRetry ? error.message : '未收到明确结果，请先在后台任务和服务列表核对，避免重复部署。' };
      if (error.name !== 'AbortError') toast.error('创建项目失败：' + error.message);
    }
  } finally {
    busy.value = false;
    controller = null;
  }
}
async function resumeJob() {
  if (busy.value || !jobId.value) return;
  busy.value = true;
  const current = new AbortController(); controller = current;
  try {
    const job = await api.followDeploymentJob(jobId.value, frame => {
      if (frame.type === 'output') output.value = String(frame.data || '');
      else if (frame.type === 'phase') phase.value = frame.data?.phase || phase.value;
      else if (frame.type === 'result') result.value = frame.data;
    }, current.signal);
    if (job?.result?.directoryCreated) emit('created', job.result);
  } catch (error) { if (error.name !== 'AbortError') toast.error(error.message); }
  finally { if (controller === current) { controller = null; busy.value = false; } }
}
function hostChanged() { if (active && props.show && !busy.value) void loadOptions(); }
window.addEventListener('composeops:host-changed', hostChanged);
onDeactivated(() => { active = false; optionsRequestId++; optionsController?.abort(); controller?.abort(); clearTimeout(resumeTimer); });
onActivated(() => {
  if (!activatedBefore) { activatedBefore = true; return; }
  active = true;
  if (props.show) { void loadOptions(); if (jobId.value && result.value?.outcomeUnknown) void resumeJob(); }
});
onBeforeUnmount(() => { disposed = true; clearTimeout(resumeTimer); optionsRequestId++; optionsController?.abort(); controller?.abort(); window.removeEventListener('composeops:host-changed', hostChanged); });
</script>

<style scoped>
textarea.compose-editor { min-height: 17.5rem; height: 17.5rem; }
textarea.env-editor { min-height: 7rem; }
</style>
