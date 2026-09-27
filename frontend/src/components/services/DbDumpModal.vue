<template>
  <BaseModal :show="true" :title="`备份数据库 · ${project.projectName}`" size-class="max-w-[calc(100vw-2rem)] sm:max-w-lg flex max-h-[88vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-3" @close="close">
    <template #header-actions>
      <Database class="w-4 h-4 text-emerald-300" />
    </template>
    <p v-if="error" class="alert-error">{{ error }}</p>
    <p v-if="!containers.length && !loading && !error" class="text-muted text-sm">该项目没有运行中的数据库容器(Postgres / MySQL / MariaDB / Redis / MongoDB)。</p>
    <div v-if="containers.length" class="space-y-3">
      <label>目标容器<select v-model="containerId" class="input"><option value="">选择数据库容器</option><option v-for="c in containers" :key="c.containerId" :value="c.containerId">{{ c.containerName }} ({{ c.type }})</option></select></label>
      <label v-if="selectedType && selectedType !== 'redis'">库名(留空自动从 .env 识别)<input v-model="dbName" class="input font-mono" :placeholder="autoDbHint || '例如 mydb'" /></label>
      <p class="text-xs text-surface-400">导出方式:{{ selectedType === 'redis' ? 'redis-cli bgsave → RDB 归档' : `${selectedTypeCmd} 全量导出` }};自动 gzip 压缩,浏览器直接下载,服务器同时留存一份历史备份。</p>
    </div>
    <template #footer>
      <button class="btn-secondary" :disabled="dumping" @click="close">取消</button>
      <button class="btn-primary" :disabled="!containerId || dumping" @click="dump"><Database class="w-4 h-4" :class="{ 'animate-pulse': dumping }" />{{ dumping ? '导出中...' : '开始导出并下载' }}</button>
    </template>
  </BaseModal>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';
import { Database } from 'lucide-vue-next';
import BaseModal from '../common/BaseModal.vue';

const props = defineProps({ project: { type: Object, required: true } });
const emit = defineEmits(['close']);
const toast = useToastStore();
const containers = ref([]);
const loading = ref(true);
const dumping = ref(false);
const containerId = ref('');
const dbName = ref('');
const error = ref('');

const selectedType = computed(() => containers.value.find((c) => c.containerId === containerId.value)?.type || '');
const autoDbHint = computed(() => '自动识别');
const selectedTypeCmd = computed(() => ({ postgres: 'pg_dump', mysql: 'mysqldump', mariadb: 'mysqldump', mongo: 'mongodump --archive', redis: '' })[selectedType.value] || '');

async function load() {
  try {
    const data = await api.listDbDumpTargets(props.project.id);
    containers.value = data?.containers || [];
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
async function dump() {
  if (!containerId.value || dumping.value) return;
  dumping.value = true;
  error.value = '';
  try {
    const res = await api.streamDbDump(props.project.id, containerId.value, dbName.value.trim());
    if (!res.ok) {
      let msg = `导出失败 (HTTP ${res.status})`;
      try { const body = await res.json(); msg = body.message || msg; } catch {
        // 非 JSON 错误响应沿用 HTTP 状态文本。
      }
      throw new Error(msg);
    }
    const disposition = res.headers.get('content-disposition') || '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const filename = match ? match[1] : `dump-${Date.now()}.gz`;
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success(`数据库备份已下载 (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    close();
  } catch (e) {
    error.value = e.message;
    toast.error(e.message);
  } finally {
    dumping.value = false;
  }
}
function close() { if (!dumping.value) emit('close'); }
onMounted(load);
</script>
