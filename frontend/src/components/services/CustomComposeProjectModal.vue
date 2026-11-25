<template>
  <BaseModal
    :show="show"
    title="新建 Compose 项目"
    size-class="max-w-[calc(100vw-2rem)] sm:max-w-3xl"
    body-class="space-y-4 p-4"
    :close-disabled="busy"
    @close="close"
  >
    <div class="rounded-lg border border-surface-800 bg-surface-900/50 p-3 text-xs leading-5 text-surface-400">
      在管理员允许的宿主机目录下创建独立项目文件夹，保存 Compose 与 .env，校验配置、拉取镜像并启动。
      已存在的目录不会被覆盖。创建后的项目沿用现有服务管理、镜像更新和回滚能力。
    </div>

    <div v-if="optionsError" class="alert-error" role="alert">{{ optionsError }}</div>
    <div v-else-if="!options" class="flex items-center gap-2 py-3 text-sm text-muted" role="status">
      <LoaderCircle class="h-4 w-4 animate-spin" />正在读取目标节点与允许目录…
    </div>
    <template v-else>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="grid gap-1.5 text-xs text-surface-300">
          项目名称
          <input
            v-model="projectName"
            class="input w-full font-mono"
            :disabled="busy"
            maxlength="40"
            autocomplete="off"
            placeholder="例如 my-web"
            aria-label="项目名称"
            :aria-invalid="!!fieldError"
          />
          <span class="text-[11px] text-muted">小写字母或数字开头，只能包含小写字母、数字、_ 和 -，最多 40 个字符。</span>
          <span v-if="fieldError" class="field-error" role="alert">{{ fieldError }}</span>
        </label>
        <label class="grid gap-1.5 text-xs text-surface-300">
          项目根目录
          <select v-model="rootDir" class="input w-full font-mono" :disabled="busy || !options.roots?.length" aria-label="项目根目录">
            <option v-for="root in options.roots || []" :key="root" :value="root">{{ root }}</option>
          </select>
          <span class="text-[11px] text-muted">最终目录：{{ rootDir ? rootDir + '/' + (projectName || '项目名称') : '未配置' }}</span>
        </label>
      </div>

      <label class="grid gap-1.5 text-xs text-surface-300">
        Compose YAML
        <textarea
          v-model="composeContent"
          class="input min-h-64 w-full resize-y font-mono text-xs leading-5"
          :disabled="busy"
          spellcheck="false"
          aria-label="Compose YAML"
          placeholder="services:&#10;  web:&#10;    image: nginx:latest&#10;    ports:&#10;      - &quot;8080:80&quot;"
        />
        <span class="text-[11px] text-muted">支持标准 Docker Compose YAML，最大 1 MiB；部署前会执行 docker compose config --quiet。</span>
      </label>

      <details class="rounded-lg border border-surface-800 p-3">
        <summary class="cursor-pointer select-none text-xs text-surface-300">环境变量（可选 .env）</summary>
        <label class="mt-3 grid gap-1.5 text-xs text-surface-300">
          .env 内容
          <textarea
            v-model="envContent"
            class="input min-h-24 w-full resize-y font-mono text-xs leading-5"
            :disabled="busy"
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
        <p v-if="result.workingDir" class="mt-1 break-all font-mono text-[11px] text-muted">{{ result.workingDir }}</p>
      </div>
    </div>

    <template #footer>
      <button class="btn-secondary" :disabled="busy" @click="close">{{ result ? '关闭' : '取消' }}</button>
      <button class="btn-primary" :disabled="busy || !canSubmit" @click="submit">
        <LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />
        <Rocket v-else class="h-4 w-4" />
        {{ busy ? '创建并部署中…' : '创建并部署' }}
      </button>
    </template>
  </BaseModal>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { LoaderCircle, Rocket } from 'lucide-vue-next';
import BaseModal from '../common/BaseModal.vue';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';

const props = defineProps({ show: { type: Boolean, default: false } });
const emit = defineEmits(['close', 'created']);
const toast = useToastStore();
const options = ref(null);
const optionsError = ref('');
const projectName = ref('');
const rootDir = ref('');
const composeContent = ref('');
const envContent = ref('');
const fieldError = ref('');
const busy = ref(false);
const phase = ref('');
const output = ref('');
const result = ref(null);
let controller = null;

const phaseLabels = {
  checking: '检查项目与目标节点',
  preparing: '创建项目目录并写入配置',
  validating: '验证 Compose 配置',
  pulling: '拉取镜像',
  starting: '构建并启动服务',
};
const phaseLabel = computed(() => phaseLabels[phase.value] || (busy.value ? '准备部署' : '部署输出'));
const canSubmit = computed(() => options.value?.supported !== false &&
  !!rootDir.value && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(projectName.value.trim()) &&
  !!composeContent.value.trim() && composeContent.value.length <= 1048576 &&
  envContent.value.length <= 524288 && !result.value);

function reset() {
  projectName.value = '';
  composeContent.value = '';
  envContent.value = '';
  fieldError.value = '';
  output.value = '';
  result.value = null;
  phase.value = '';
  optionsError.value = '';
}

async function loadOptions() {
  options.value = null;
  optionsError.value = '';
  try {
    options.value = await api.getComposeProjectCreateOptions();
    rootDir.value = options.value.roots?.[0] || '';
  } catch (error) {
    optionsError.value = '读取创建配置失败：' + error.message;
  }
}

watch(() => props.show, (visible) => {
  if (!visible) return;
  reset();
  void loadOptions();
});

function close() {
  if (busy.value) return;
  emit('close');
}

async function submit() {
  if (busy.value || !canSubmit.value) return;
  fieldError.value = '';
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(projectName.value.trim())) {
    fieldError.value = '项目名称格式无效。';
    return;
  }
  busy.value = true;
  output.value = '';
  result.value = null;
  phase.value = 'checking';
  controller = new AbortController();
  try {
    await api.streamCustomComposeProjectDeploy({
      projectName: projectName.value.trim(),
      rootDir: rootDir.value,
      composeContent: composeContent.value,
      envContent: envContent.value,
      expectedHostId: options.value.hostId,
    }, (frame) => {
      if (frame.type === 'phase') phase.value = frame.data?.phase || phase.value;
      else if (frame.type === 'stdout' || frame.type === 'stderr') output.value = (output.value + String(frame.data || '')).slice(-20000);
      else if (frame.type === 'result') result.value = frame.data || null;
      else if (frame.type === 'exit' && frame.data?.code !== 0 && result.value) result.value = { ...result.value, ok: false };
    }, controller.signal);
    if (result.value?.projectId || result.value?.directoryCreated) emit('created', result.value);
    if (result.value?.ok) toast.success('Compose 项目 ' + projectName.value.trim() + ' 已创建并完成启动命令');
    else toast.warning(result.value?.message || '项目文件已保留，请检查部署输出');
  } catch (error) {
    if (error.name !== 'AbortError') {
      toast.error('创建项目失败：' + error.message);
      result.value = { ok: false, message: error.message };
    }
  } finally {
    busy.value = false;
    controller = null;
  }
}
</script>
