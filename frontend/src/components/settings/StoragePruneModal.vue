<template>
  <BaseModal :show="open" title="Docker 磁盘空间与清理" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[88vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-4" @close="close">
    <p v-if="error" class="alert-error">{{ error }}</p>
    <template v-if="df">
      <div>
        <div class="mb-2 flex items-center justify-between text-sm"><span class="text-surface-200">磁盘占用</span><span class="text-muted">{{ formatBytes(df.total) }}</span></div>
        <div class="storage-bar">
          <span v-if="df.images?.total" class="storage-seg bg-blue-500" :style="{ width: segPercent(df.images.total) }" title="镜像"></span>
          <span v-if="df.volumes?.total" class="storage-seg bg-violet-500" :style="{ width: segPercent(df.volumes.total) }" title="卷"></span>
          <span v-if="df.containers?.total" class="storage-seg bg-amber-500" :style="{ width: segPercent(df.containers.total) }" title="容器"></span>
          <span v-if="df.buildCache?.total" class="storage-seg bg-emerald-500" :style="{ width: segPercent(df.buildCache.total) }" title="构建缓存"></span>
        </div>
        <div class="mt-2 flex flex-wrap gap-3 text-[11px] text-surface-400">
          <span><span class="inline-block h-2 w-2 rounded-xs bg-blue-500"></span> 镜像 {{ formatBytes(df.images?.total) }}</span>
          <span><span class="inline-block h-2 w-2 rounded-xs bg-violet-500"></span> 卷 {{ formatBytes(df.volumes?.total) }}</span>
          <span><span class="inline-block h-2 w-2 rounded-xs bg-amber-500"></span> 容器 {{ formatBytes(df.containers?.total) }}</span>
          <span><span class="inline-block h-2 w-2 rounded-xs bg-emerald-500"></span> 缓存 {{ formatBytes(df.buildCache?.total) }}</span>
        </div>
        <p class="mt-3 text-sm text-emerald-300">可安全释放 {{ formatBytes(df.reclaimable) }}<span v-if="df.volumes?.orphans">(含 {{ df.volumes.orphans }} 个孤儿卷 {{ formatBytes(df.volumes.reclaimable) }})</span></p>
        <p v-if="df.disk" class="text-muted text-xs">磁盘剩余 {{ formatBytes(df.disk.free) }} / {{ formatBytes(df.disk.total) }}</p>
      </div>

      <div class="rounded-xl border border-surface-800 p-3 space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2"><Zap class="h-4 w-4 text-amber-300" /><div><strong class="text-sm text-surface-200">一键极速安全清理</strong><p class="text-muted text-xs mt-0.5">清理悬空镜像、退出容器与未使用构建缓存</p></div></div>
          <button class="btn-primary" :disabled="pruning" @click="runPrune('safe')">{{ pruning ? '清理中…' : '立即清理' }}</button>
        </div>
        <div class="border-t border-surface-800 pt-3">
          <strong class="text-sm text-surface-200">深度清理设置</strong>
          <label class="toggle-label mt-2"><input v-model="options.volumes" type="checkbox" />清理孤儿持久卷(不可恢复)</label>
          <label class="toggle-label mt-2"><input v-model="options.builder" type="checkbox" />清理全部构建缓存</label>
          <p v-if="options.volumes || options.builder" class="alert-warning mt-2">深度清理会删除未引用的持久数据,请确认已备份重要卷。</p>
          <button class="btn-danger mt-2" :disabled="pruning" @click="runDeep"><Trash2 class="w-4 h-4" />执行深度清理</button>
        </div>
      </div>
    </template>
    <div v-else class="text-muted py-8 text-center">正在读取磁盘占用…</div>
    <template #footer>
      <span v-if="lastReclaimed" class="mr-auto text-sm text-emerald-400">已释放 {{ formatBytes(lastReclaimed) }}</span>
      <button class="btn-secondary" @click="close">关闭</button>
    </template>
  </BaseModal>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';
import { Trash2, Zap } from 'lucide-vue-next';
import BaseModal from '../common/BaseModal.vue';

defineProps({ open: { type: Boolean, default: true } });
const emit = defineEmits(['close', 'reclaimed']);
const toast = useToastStore();
const df = ref(null);
const error = ref('');
const pruning = ref(false);
const lastReclaimed = ref(0);
const options = ref({ volumes: false, builder: false });

const totalMax = computed(() => Math.max(df.value?.total || 1, 1));

async function load() {
  error.value = '';
  try { df.value = await api.getStorageDf(); } catch (e) { error.value = e.message; }
}
function segPercent(size) { return `${Math.max(1, Math.min(100, (Number(size) || 0) / totalMax.value * 100))}%`; }
async function runPrune(mode) {
  pruning.value = true;
  error.value = '';
  try {
    const result = await api.pruneStorage(mode, mode === 'safe' ? undefined : 'PRUNE');
    const reclaimed = result.reclaimedMB * 1024 * 1024;
    lastReclaimed.value = reclaimed;
    toast.success(`已释放 ${formatBytes(reclaimed)} 磁盘空间`);
    emit('reclaimed', reclaimed);
    await load();
  } catch (e) {
    if (e.status === 400 && /PRUNE/.test(e.message)) toast.error('深度清理需先输入 PRUNE 确认');
    else error.value = e.message;
  } finally { pruning.value = false; }
}
async function runDeep() {
  if (!options.value.volumes && !options.value.builder) { toast.info('请至少勾选一项深度清理'); return; }
  const confirmText = window.prompt('深度清理不可撤销,请输入 PRUNE 确认:');
  if (confirmText !== 'PRUNE') return;
  const mode = options.value.volumes && options.value.builder ? 'all' : options.value.volumes ? 'volumes' : 'builder';
  await runPrune(mode);
}
function formatBytes(value = 0) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(value) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function close() { emit('close'); }
onMounted(load);
</script>
