<template>
  <section class="space-y-4" aria-labelledby="full-backup-title" :aria-busy="loading">
    <div>
      <h2 id="full-backup-title" class="section-title">完整备份范围预检</h2>
      <p class="mt-1 text-muted">先核对配置、宿主挂载目录、Docker 卷和镜像。此处为只读清单；需要执行时，在完整备份页选择应用并完成执行预检。</p>
    </div>
    <div class="flex flex-wrap items-end gap-2">
      <label class="form-grid-label"><span>项目</span>
        <select v-model="projectId" class="input w-full sm:w-64" aria-label="选择完整备份预检项目" :disabled="loadingProjects" @change="clearPlan">
          <option value="">选择项目</option>
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option>
        </select>
      </label>
      <button class="btn-secondary" :disabled="!projectId || loading" @click="preview"><ClipboardList class="h-4 w-4" :class="{ 'animate-pulse': loading }" />{{ loading ? '正在核对…' : '生成预检清单' }}</button>
      <button class="btn-secondary" :disabled="loadingProjects" @click="loadProjects"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loadingProjects }" />刷新项目</button>
    </div>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
    <p v-if="loading" class="text-muted" role="status" aria-live="polite">正在读取当前节点的容器与配置…</p>
    <template v-if="plan">
      <p class="alert-info" role="status" aria-live="polite">{{ plan.project.name }} · {{ plan.host.name }}：已生成 {{ plan.resources.length }} 项清单，尚未生成备份。</p>
      <div v-if="plan.blockers.length" class="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3">
        <h3 class="text-sm font-medium text-rose-300">需要先处理（{{ plan.blockers.length }}）</h3>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-surface-300"><li v-for="(item, index) in plan.blockers" :key="index">{{ item.message }}</li></ul>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>类型</th><th>来源</th><th>关联容器</th><th>核对状态</th></tr></thead>
          <tbody>
            <tr v-for="item in plan.resources" :key="`${item.kind}:${item.source}`">
              <td class="whitespace-nowrap">{{ kindLabel(item.kind) }}</td>
              <td class="max-w-96 break-all font-mono text-xs">{{ item.source }}<span v-if="item.reference" class="block text-muted">{{ item.reference }}</span></td>
              <td class="text-xs">{{ item.containers.join('、') || '—' }}</td>
              <td class="whitespace-nowrap text-xs text-amber-300">{{ statusLabel(item.verification) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <details class="rounded-xl border border-surface-800 p-3">
        <summary class="cursor-pointer text-sm text-surface-300">一致性与恢复检查（{{ plan.warnings.length }}）</summary>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-surface-400"><li v-for="(item, index) in plan.warnings" :key="index">{{ item.message }}</li></ul>
      </details>
      <p class="break-all text-xs text-surface-500">核对时间：{{ new Date(plan.generatedAt).toLocaleString('zh-CN') }} · 清单指纹 {{ plan.fingerprint.slice(0, 16) }}</p>
    </template>
  </section>
</template>

<script setup>
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { ClipboardList, RefreshCw } from 'lucide-vue-next';
import { api } from '../../api/client.js';

const projects = ref([]);
const projectId = ref('');
const plan = ref(null);
const loading = ref(false);
const loadingProjects = ref(false);
const error = ref('');
let planRequest = 0;
let projectsRequest = 0;
let active = false;

function clearPlan() {
  planRequest++;
  plan.value = null;
  loading.value = false;
  error.value = '';
}
async function loadProjects() {
  const request = ++projectsRequest;
  clearPlan();
  loadingProjects.value = true;
  try {
    const result = await api.getProjects(true);
    if (request !== projectsRequest) return;
    projects.value = (result.projects || []);
    if (!projects.value.some(project => project.id === projectId.value)) projectId.value = '';
  } catch (failure) {
    if (request === projectsRequest) { projects.value = []; projectId.value = ''; error.value = failure.message || '项目读取失败'; }
  } finally { if (request === projectsRequest) loadingProjects.value = false; }
}
async function preview() {
  clearPlan();
  const request = planRequest;
  const requestedProject = projectId.value;
  loading.value = true;
  try {
    const result = await api.getFullBackupPlan(requestedProject);
    if (request === planRequest && requestedProject === projectId.value) plan.value = result;
  } catch (failure) {
    if (request === planRequest) error.value = failure.message || '预检失败';
  } finally { if (request === planRequest) loading.value = false; }
}
function hostChanged() {
  projectId.value = '';
  projects.value = [];
  loadProjects();
}
function activate() {
  if (active) return;
  active = true;
  window.addEventListener('composeops:host-changed', hostChanged);
  loadProjects();
}
function deactivate() {
  active = false;
  planRequest++;
  projectsRequest++;
  window.removeEventListener('composeops:host-changed', hostChanged);
}
function kindLabel(kind) {
  return { project_directory: '项目目录', compose_file: 'Compose 文件', env_file: '环境文件', configuration_file: '配置 / 密钥文件', bind: '宿主挂载', volume: 'Docker 卷', volume_declaration: '卷声明', image: '镜像', writable_layer: '容器可写层', runtime_dependency: '运行依赖' }[kind] || kind;
}
function statusLabel(status) {
  return { readable: '配置已读取', unavailable: '未读取', 'recreate-required': '恢复时重建', 'pending-export': '待导出', 'pending-diff-check': '待检查改动', 'pending-model-resolution': '待解析实际卷名' }[status] || '待核实';
}
onMounted(activate);
onActivated(activate);
onDeactivated(deactivate);
onBeforeUnmount(deactivate);
</script>
