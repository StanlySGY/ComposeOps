<template>
  <div class="service-editor">
    <p v-if="formError" class="alert-error mb-3" role="alert">{{ formError }}</p>
    <div class="space-y-4">
      <!-- 基础信息 -->
      <div class="form-group">
        <label class="form-label" for="compose-service-name">服务名称</label>
        <input
          v-model="service.name"
          id="compose-service-name"
          type="text"
          class="input"
          placeholder="例如: nginx, postgres, redis"
          :disabled="!isNew"
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="compose-service-image">镜像</label>
        <input
          v-model="service.image"
          id="compose-service-image"
          type="text"
          class="input"
          placeholder="例如: nginx:latest, postgres:15-alpine"
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="compose-service-container-name">容器名称 (可选)</label>
        <input
          v-model="service.container_name"
          id="compose-service-container-name"
          type="text"
          class="input"
          placeholder="留空使用默认命名"
        />
      </div>

      <!-- 端口映射 -->
      <div class="form-section">
        <div class="flex items-center justify-between mb-2">
          <label class="form-label mb-0">端口映射</label>
          <button v-if="!complexPorts" class="btn-ghost text-xs" @click="addPort"><Plus class="w-3 h-3" />添加</button>
        </div>
        <p v-if="complexPorts" class="text-muted text-xs leading-5">包含高级端口配置，请在代码视图中编辑。本次保存会完整保留这些配置。</p>
        <div v-for="(port, idx) in service.ports" :key="idx" class="flex items-center gap-2 mb-2">
          <input
            v-model="port.host"
            :aria-label="`第 ${idx + 1} 行端口映射 · 宿主机端口`"
            type="text"
            class="input flex-1"
            placeholder="宿主机端口"
          />
          <span class="text-muted">:</span>
          <input
            v-model="port.container"
            :aria-label="`第 ${idx + 1} 行端口映射 · 容器端口`"
            type="text"
            class="input flex-1"
            placeholder="容器端口"
          />
          <button class="icon-btn" :aria-label="`删除第 ${idx + 1} 行端口映射`" :title="`删除第 ${idx + 1} 行端口映射`" @click="removePort(idx)"><Trash2 class="w-4 h-4" /></button>
        </div>
      </div>

      <!-- 卷挂载 -->
      <div class="form-section">
        <div class="flex items-center justify-between mb-2">
          <label class="form-label mb-0">卷挂载</label>
          <button v-if="!complexVolumes" class="btn-ghost text-xs" @click="addVolume"><Plus class="w-3 h-3" />添加</button>
        </div>
        <p v-if="complexVolumes" class="text-muted text-xs leading-5">包含高级卷配置，请在代码视图中编辑。本次保存会完整保留这些配置。</p>
        <div v-for="(vol, idx) in service.volumes" :key="idx" class="flex flex-col gap-2 mb-2 sm:flex-row sm:items-center">
          <label class="flex w-full min-w-0 flex-col gap-1 sm:flex-1">
            <span class="text-xs text-surface-400 sm:hidden">宿主机路径或命名卷</span>
            <input
              v-model="vol.host"
              :aria-label="`第 ${idx + 1} 行卷挂载 · 宿主机路径或命名卷`"
              type="text"
              class="input w-full sm:w-auto sm:flex-1"
              placeholder="宿主机路径或命名卷"
            />
          </label>
          <span class="text-muted hidden sm:inline">:</span>
          <label class="flex w-full min-w-0 flex-col gap-1 sm:flex-1">
            <span class="text-xs text-surface-400 sm:hidden">容器路径</span>
            <input
              v-model="vol.container"
              :aria-label="`第 ${idx + 1} 行卷挂载 · 容器路径`"
              type="text"
              class="input w-full sm:w-auto sm:flex-1"
              placeholder="容器路径"
            />
          </label>
          <button class="icon-btn self-end sm:self-auto" :aria-label="`删除第 ${idx + 1} 行卷挂载`" :title="`删除第 ${idx + 1} 行卷挂载`" @click="removeVolume(idx)"><Trash2 class="w-4 h-4" /></button>
        </div>
      </div>

      <!-- 环境变量 -->
      <div class="form-section">
        <div class="flex items-center justify-between mb-2">
          <label class="form-label mb-0">环境变量</label>
          <button class="btn-ghost text-xs" @click="addEnv"><Plus class="w-3 h-3" />添加</button>
        </div>
        <div v-for="(env, idx) in service.environment" :key="idx" class="flex flex-col gap-2 mb-2 sm:flex-row sm:items-center">
          <label class="flex w-full min-w-0 flex-col gap-1 sm:flex-1">
            <span class="text-xs text-surface-400 sm:hidden">变量名</span>
            <input
              v-model="env.key"
              :aria-label="`第 ${idx + 1} 行环境变量名称`"
              type="text"
              class="input w-full sm:w-auto sm:flex-1"
              placeholder="变量名"
            />
          </label>
          <span class="text-muted hidden sm:inline">=</span>
          <label class="flex w-full min-w-0 flex-col gap-1 sm:flex-1">
            <span class="text-xs text-surface-400 sm:hidden">变量值</span>
            <input
              v-model="env.value"
              :aria-label="`第 ${idx + 1} 行环境变量值`"
              type="text"
              class="input w-full sm:w-auto sm:flex-1"
              placeholder="值"
            />
          </label>
          <button class="icon-btn self-end sm:self-auto" :aria-label="`删除第 ${idx + 1} 行环境变量`" :title="`删除第 ${idx + 1} 行环境变量`" @click="removeEnv(idx)"><Trash2 class="w-4 h-4" /></button>
        </div>
      </div>

      <!-- 依赖关系 -->
      <div class="form-group">
        <label class="form-label" for="compose-service-depends-on">依赖服务 (可选)</label>
        <input
          v-model="dependsOnInput"
          id="compose-service-depends-on"
          type="text"
          class="input"
          placeholder="逗号分隔,例如: db, redis"
        />
        <p class="text-muted text-xs mt-1">此服务启动前需要等待的其他服务</p>
      </div>

      <!-- 重启策略 -->
      <div class="form-group">
        <label class="form-label" for="compose-service-restart">重启策略</label>
        <select id="compose-service-restart" v-model="service.restart" class="input">
          <option value="">未设置（使用默认行为）</option>
          <option value="no">no</option>
          <option value="always">always</option>
          <option value="on-failure">on-failure</option>
          <option value="unless-stopped">unless-stopped</option>
        </select>
      </div>

      <!-- 网络 -->
      <div class="form-group">
        <label class="form-label" for="compose-service-networks">网络 (可选)</label>
        <input
          v-model="networksInput"
          id="compose-service-networks"
          type="text"
          class="input"
          placeholder="逗号分隔,例如: frontend, backend"
        />
      </div>
    </div>

    <div class="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-surface-800">
      <button class="btn-ghost" @click="$emit('close')">取消</button>
      <button class="btn-primary" @click="save">{{ isNew ? '创建' : '保存' }}</button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { Plus, Trash2 } from 'lucide-vue-next';

const props = defineProps({
  modelValue: {
    type: Object,
    default: null,
  },
  isNew: {
    type: Boolean,
    default: true,
  },
});

const emit = defineEmits(['update:modelValue', 'close', 'save']);

const service = ref({});
const dependsOnInput = ref('');
const networksInput = ref('');
const formError = ref('');
const complexPorts = computed(() => (props.modelValue?.ports || []).some(value => typeof value === 'object' || String(value).includes('${')));
const complexVolumes = computed(() => (props.modelValue?.volumes || []).some(value => typeof value === 'object' || String(value).includes('${') || /^[a-z]:/i.test(String(value))));
const clone = value => JSON.parse(JSON.stringify(value));
let originalService = {};
let initialForm = {};
let initialDependsOn = '';
let initialNetworks = '';
const listNames = value => Array.isArray(value) ? value : Object.keys(value || {});

watch(() => props.modelValue, (value) => {
  const val = value || {};
  originalService = clone(val);
  delete originalService.name;
  formError.value = '';
  service.value = {
    name: val.name || '', image: val.image || '', container_name: val.container_name || '',
    ports: complexPorts.value ? [] : (val.ports || []).map(port => {
      const text = String(port);
      const colon = text.lastIndexOf(':');
      return colon < 0 ? { host: '', container: text } : { host: text.slice(0, colon), container: text.slice(colon + 1) };
    }),
    volumes: complexVolumes.value ? [] : (val.volumes || []).map(volume => {
      const text = String(volume);
      const colon = text.indexOf(':');
      return colon < 0 ? { host: '', container: text } : { host: text.slice(0, colon), container: text.slice(colon + 1) };
    }),
    environment: parseEnvToArray(val.environment || []),
    restart: val.restart ?? (props.isNew ? 'unless-stopped' : ''),
  };
  for (const key of ['ports', 'volumes']) {
    service.value[key] = service.value[key].map((row, index) => ({ ...row, raw: val[key][index], originalHost: row.host, originalContainer: row.container }));
  }
  dependsOnInput.value = listNames(val.depends_on).join(', ');
  networksInput.value = listNames(val.networks).join(', ');
  initialForm = clone(service.value);
  initialDependsOn = dependsOnInput.value;
  initialNetworks = networksInput.value;
}, { immediate: true });

function parseEnvToArray(environment) {
  if (Array.isArray(environment)) {
    return environment.map(raw => {
      const text = String(raw);
      const equals = text.indexOf('=');
      const key = equals < 0 ? text : text.slice(0, equals);
      const value = equals < 0 ? '' : text.slice(equals + 1);
      return { key, value, originalKey: key, originalValue: value, raw };
    });
  }
  return Object.entries(environment).map(([key, raw]) => {
    const value = raw == null ? '' : String(raw);
    return { key, value, originalKey: key, originalValue: value, raw };
  });
}

function addPort() {
  service.value.ports.push({ host: '', container: '' });
}

function removePort(idx) {
  service.value.ports.splice(idx, 1);
}

function addVolume() {
  service.value.volumes.push({ host: '', container: '' });
}

function removeVolume(idx) {
  service.value.volumes.splice(idx, 1);
}

function addEnv() {
  service.value.environment.push({ key: '', value: '' });
}

function removeEnv(idx) {
  service.value.environment.splice(idx, 1);
}

function save() {
  formError.value = '';
  const name = service.value.name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    formError.value = '请输入有效的服务名称（字母、数字、点、下划线或连字符）';
    return;
  }
  if (props.isNew && !service.value.image.trim()) {
    formError.value = '请填写镜像名称';
    return;
  }
  // 从完整原始配置开始，只替换表单中实际改动的字段。
  const composeService = clone(originalService);
  const changed = key => props.isNew || JSON.stringify(service.value[key]) !== JSON.stringify(initialForm[key]);
  const assign = (key, value, present) => { if (present) composeService[key] = value; else delete composeService[key]; };
  for (const key of ['image', 'container_name', 'restart']) {
    if (changed(key)) assign(key, service.value[key], !!service.value[key]);
  }
  for (const key of ['ports', 'volumes']) {
    if (!changed(key)) continue;
    if (service.value[key].some(row => row.host && !row.container)) {
      formError.value = key === 'ports' ? '请补全容器端口' : '请补全容器挂载路径';
      return;
    }
    const rows = service.value[key].filter(row => row.container).map(row => row.host === row.originalHost && row.container === row.originalContainer
      ? row.raw : row.host ? `${row.host}:${row.container}` : row.container);
    assign(key, rows, rows.length > 0);
  }
  if (changed('environment')) {
    const rows = service.value.environment.filter(row => row.key);
    const unchanged = row => row.key === row.originalKey && row.value === row.originalValue;
    const environment = originalService.environment && !Array.isArray(originalService.environment)
      ? Object.fromEntries(rows.map(row => [row.key, unchanged(row) ? row.raw : row.value]))
      : rows.map(row => unchanged(row) ? row.raw : `${row.key}=${row.value ?? ''}`);
    assign('environment', environment, rows.length > 0);
  }
  for (const [key, input, initial] of [['depends_on', dependsOnInput.value, initialDependsOn], ['networks', networksInput.value, initialNetworks]]) {
    if (!props.isNew && input === initial) continue;
    const names = [...new Set(input.split(',').map(name => name.trim()).filter(Boolean))];
    const previous = originalService[key];
    const value = previous && !Array.isArray(previous)
      ? Object.fromEntries(names.map(name => [name, Object.hasOwn(previous, name) ? previous[name] : key === 'depends_on' ? { condition: 'service_started' } : null]))
      : names;
    assign(key, value, names.length > 0);
  }
  emit('save', { name, service: composeService });
}

</script>

<style scoped>
@reference '../../style.css';
.service-editor {
  @apply p-4;
}

.form-group {
  @apply space-y-2;
}

.form-section {
  @apply space-y-2 p-3 rounded-lg bg-surface-950/30 border border-surface-800/50;
}

.form-label {
  @apply block text-xs font-medium text-surface-300;
}

.input {
  @apply w-full px-3 py-2 text-sm rounded-lg bg-surface-900 border border-surface-700
         text-surface-100 placeholder-surface-500
         focus:outline-hidden focus:ring-2 focus:ring-status-ok/50 focus:border-status-ok
         disabled:opacity-50 disabled:cursor-not-allowed;
}

.icon-btn {
  @apply p-1.5 rounded-lg text-surface-400 hover:text-surface-200 hover:bg-surface-800
         transition-colors shrink-0;
}

.btn-ghost {
  @apply px-3 py-1.5 rounded-lg text-sm font-medium text-surface-300
         hover:text-surface-100 hover:bg-surface-800 transition-colors
         inline-flex items-center gap-1.5;
}

.btn-primary {
  @apply px-4 py-2 rounded-lg text-sm font-medium bg-status-ok text-white
         hover:bg-status-ok transition-colors inline-flex items-center gap-2;
}

.text-muted {
  @apply text-xs text-surface-400;
}
</style>
