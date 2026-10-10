<template>
  <div class="service-editor">
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
          <button class="btn-ghost text-xs" @click="addPort"><Plus class="w-3 h-3" />添加</button>
        </div>
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
          <button class="btn-ghost text-xs" @click="addVolume"><Plus class="w-3 h-3" />添加</button>
        </div>
        <div v-for="(vol, idx) in service.volumes" :key="idx" class="flex flex-col gap-2 mb-2 sm:flex-row sm:items-center">
          <label class="flex w-full min-w-0 flex-col gap-1 sm:flex-1">
            <span class="text-xs text-surface-500 sm:hidden">宿主机路径或命名卷</span>
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
            <span class="text-xs text-surface-500 sm:hidden">容器路径</span>
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
            <span class="text-xs text-surface-500 sm:hidden">变量名</span>
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
            <span class="text-xs text-surface-500 sm:hidden">变量值</span>
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
          <option value="">不重启</option>
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
import { ref, watch } from 'vue';
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

const service = ref({
  name: '',
  image: '',
  container_name: '',
  ports: [],
  volumes: [],
  environment: [],
  restart: 'unless-stopped',
  depends_on: [],
  networks: [],
});

const dependsOnInput = ref('');
const networksInput = ref('');

// 从父组件接收的服务数据初始化
watch(() => props.modelValue, (val) => {
  if (val) {
    service.value = {
      name: val.name || '',
      image: val.image || '',
      container_name: val.container_name || '',
      ports: parsePortsToArray(val.ports || []),
      volumes: parseVolumesToArray(val.volumes || []),
      environment: parseEnvToArray(val.environment || []),
      restart: val.restart || 'unless-stopped',
      depends_on: val.depends_on || [],
      networks: val.networks || [],
    };
    dependsOnInput.value = Array.isArray(val.depends_on) ? val.depends_on.join(', ') : '';
    networksInput.value = Array.isArray(val.networks) ? val.networks.join(', ') : '';
  }
}, { immediate: true });

function parsePortsToArray(ports) {
  return ports.map((p) => {
    if (typeof p === 'string') {
      const [host, container] = p.split(':');
      return { host, container: container || host };
    }
    return { host: String(p), container: String(p) };
  });
}

function parseVolumesToArray(volumes) {
  return volumes.map((v) => {
    if (typeof v === 'string') {
      const [host, container] = v.split(':');
      return { host, container: container || host };
    }
    return v;
  });
}

function parseEnvToArray(environment) {
  if (Array.isArray(environment)) {
    return environment.map((e) => {
      if (typeof e === 'string') {
        const [key, ...valueParts] = e.split('=');
        return { key, value: valueParts.join('=') };
      }
      return e;
    });
  }
  // 如果是对象形式
  return Object.entries(environment).map(([key, value]) => ({ key, value: String(value) }));
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
  // 转换为 compose 格式
  const composeService = {
    image: service.value.image,
  };

  if (service.value.container_name) {
    composeService.container_name = service.value.container_name;
  }

  // 端口
  const ports = service.value.ports
    .filter((p) => p.host && p.container)
    .map((p) => `${p.host}:${p.container}`);
  if (ports.length) {
    composeService.ports = ports;
  }

  // 卷
  const volumes = service.value.volumes
    .filter((v) => v.host && v.container)
    .map((v) => `${v.host}:${v.container}`);
  if (volumes.length) {
    composeService.volumes = volumes;
  }

  // 环境变量
  const environment = service.value.environment
    .filter((e) => e.key)
    .map((e) => `${e.key}=${e.value || ''}`);
  if (environment.length) {
    composeService.environment = environment;
  }

  // 重启策略
  if (service.value.restart) {
    composeService.restart = service.value.restart;
  }

  // 依赖
  if (dependsOnInput.value.trim()) {
    composeService.depends_on = dependsOnInput.value.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // 网络
  if (networksInput.value.trim()) {
    composeService.networks = networksInput.value.split(',').map((s) => s.trim()).filter(Boolean);
  }

  emit('save', {
    name: service.value.name,
    service: composeService,
  });
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
         focus:outline-hidden focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500
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
  @apply px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white
         hover:bg-emerald-500 transition-colors inline-flex items-center gap-2;
}

.text-muted {
  @apply text-xs text-surface-500;
}
</style>
