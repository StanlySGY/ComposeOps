<template>
  <BaseModal :show="true" :title="`备份数据库 · ${project.projectName}`" :close-disabled="dumping" size-class="max-w-[calc(100vw-2rem)] sm:max-w-lg flex max-h-[88vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-3" @close="close">
    <template #header-actions>
      <Database class="w-4 h-4 text-status-ok" />
    </template>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
    <button v-if="error && !containers.length && !loading" class="btn-secondary" @click="load">重新读取数据库容器</button>
    <p v-if="loading" class="text-sm text-surface-400" role="status" aria-live="polite">正在读取可备份的数据库容器…</p>
    <p v-if="!containers.length && !loading && !error" class="text-muted text-sm">该项目没有运行中的数据库容器(Postgres / MySQL / MariaDB / Redis / MongoDB)。</p>
    <div v-if="containers.length" class="space-y-3">
      <label>目标容器<select v-model="containerId" aria-label="目标容器" :disabled="dumping" class="input"><option value="">选择数据库容器</option><option v-for="c in containers" :key="c.containerId" :value="c.containerId">{{ c.containerName }} ({{ c.type }})</option></select></label>
      <label v-if="selectedType && selectedType !== 'redis'">库名(留空自动从 .env 识别)<input v-model="dbName" aria-label="库名" :disabled="dumping" class="input font-mono" :placeholder="autoDbHint || '例如 mydb'" /></label>
      <p class="text-xs text-surface-400">导出方式:{{ selectedType === 'redis' ? 'redis-cli --rdb → RDB 归档' : `${selectedTypeCmd} 全量导出` }};自动 gzip 压缩,浏览器直接下载,服务器同时留存一份历史备份。</p>
    </div>
    <template #footer>
      <button class="btn-secondary" :disabled="dumping" @click="close">取消</button>
      <button class="btn-primary" :disabled="!containerId || dumping" @click="dump"><Database class="w-4 h-4" :class="{ 'animate-pulse': dumping }" />{{ dumping ? '导出中...' : '开始导出并下载' }}</button>
    </template>
  </BaseModal>
</template>

<script setup>
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';
import { Database } from 'lucide-vue-next';
import BaseModal from '../common/BaseModal.vue';
import { getAuthEpoch, onAuthEpochChange } from '../../lib/auth-context.js';

const props = defineProps({ project: { type: Object, required: true } });
const emit = defineEmits(['close']);
const toast = useToastStore();
const containers = ref([]);
const loading = ref(true);
const dumping = ref(false);
const containerId = ref('');
const dbName = ref('');
const error = ref('');
const epoch = getAuthEpoch(), controller = new AbortController();
let active = true, loadVersion = 0;
const current = () => active && !controller.signal.aborted && epoch === getAuthEpoch();

const selectedType = computed(() => containers.value.find((c) => c.containerId === containerId.value)?.type || '');
const autoDbHint = computed(() => '自动识别');
const selectedTypeCmd = computed(() => ({ postgres: 'pg_dump', mysql: 'mysqldump', mariadb: 'mysqldump', mongo: 'mongodump --archive', redis: '' })[selectedType.value] || '');

async function load() {
  if (!current()) return;
  const version = ++loadVersion;
  loading.value = true; error.value = '';
  try {
    const data = await api.listDbDumpTargets(props.project.id, controller.signal);
    if (!current() || version !== loadVersion) return;
    containers.value = data?.containers || [];
  } catch (e) {
    if (current() && version === loadVersion) error.value = e.message;
  } finally {
    if (current() && version === loadVersion) loading.value = false;
  }
}
async function dump() {
  if (!current() || !containerId.value || dumping.value) return;
  dumping.value = true;
  error.value = '';
  try {
    const res = await api.streamDbDump(props.project.id, containerId.value, dbName.value.trim(), controller.signal);
    if (!current()) { await res.body?.cancel().catch(() => {}); return; }
    if (!res.ok) {
      let msg = `导出失败 (HTTP ${res.status})`;
      try { const body = await res.json(); msg = body.message || msg; } catch {
        // 非 JSON 错误响应沿用 HTTP 状态文本。
      }
      if (!current()) return;
      if (res.status === 401) window.dispatchEvent(new Event('composeops:unauthorized'));
      throw new Error(msg);
    }
    const disposition = res.headers.get('content-disposition') || '';
    const match = /filename=(?:"([^"]+)"|([^;\s]+))/i.exec(disposition);
    const filename = (match?.[1] || match?.[2] || `dump-${Date.now()}.gz`).replace(/[\\/]/g, '_');
    const blob = await res.blob();
    if (!current()) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    try { a.click(); } finally { URL.revokeObjectURL(a.href); }
    toast.success(`数据库备份已下载 (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    dumping.value = false;
    close();
  } catch (e) {
    if (current()) { error.value = e.message; toast.error(e); }
  } finally {
    if (current()) dumping.value = false;
  }
}
function close() { if (!dumping.value) emit('close'); }
function invalidate() {
  if (!active) return;
  active = false; ++loadVersion; controller.abort();
  containers.value = []; error.value = ''; loading.value = dumping.value = false;
}
function closeContext() { if (active) { invalidate(); emit('close'); } }
const stopAuthListener = onAuthEpochChange(closeContext);
window.addEventListener('composeops:host-changed', closeContext);
onDeactivated(closeContext);
onBeforeUnmount(() => { stopAuthListener(); window.removeEventListener('composeops:host-changed', closeContext); invalidate(); });
onMounted(load);
</script>
