<template>
  <BaseModal :show="open" title="Docker 磁盘空间与清理" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[88vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-4" :close-disabled="pruning" @close="close">
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
    <template v-if="df">
      <p class="break-all text-sm text-surface-200">目标节点：<strong>{{ df.hostName || df.hostId }}</strong></p>
      <div>
        <div class="mb-2 flex items-center justify-between text-sm"><span class="text-surface-200">Docker 资源统计</span><span class="text-muted">{{ formatBytes(df.total) }}</span></div>
        <div class="storage-bar" role="img" :aria-label="`Docker 磁盘占用分布：镜像 ${formatBytes(df.images?.total)}，卷 ${formatBytes(df.volumes?.total)}，容器 ${formatBytes(df.containers?.total)}，构建缓存 ${formatBytes(df.buildCache?.total)}`">
          <span v-if="df.images?.total" class="storage-seg bg-blue-500" :style="{ width: segPercent(df.images.total) }" title="镜像"></span>
          <span v-if="df.volumes?.total" class="storage-seg bg-violet-500" :style="{ width: segPercent(df.volumes.total) }" title="卷"></span>
          <span v-if="df.containers?.total" class="storage-seg bg-status-warn" :style="{ width: segPercent(df.containers.total) }" title="容器"></span>
          <span v-if="df.buildCache?.total" class="storage-seg bg-status-ok" :style="{ width: segPercent(df.buildCache.total) }" title="构建缓存"></span>
        </div>
        <div class="mt-2 flex flex-wrap gap-3 text-[11px] text-surface-400">
          <span><span class="inline-block h-2 w-2 rounded-xs bg-blue-500"></span> 镜像 {{ formatBytes(df.images?.total) }}</span>
          <span><span class="inline-block h-2 w-2 rounded-xs bg-violet-500"></span> 卷 {{ formatBytes(df.volumes?.total) }}</span>
          <span><span class="inline-block h-2 w-2 rounded-xs bg-status-warn"></span> 容器 {{ formatBytes(df.containers?.total) }}</span>
          <span><span class="inline-block h-2 w-2 rounded-xs bg-status-ok"></span> 缓存 {{ formatBytes(df.buildCache?.total) }}</span>
        </div>
        <p class="mt-3 text-sm text-status-ok">潜在可回收 {{ formatBytes(df.reclaimable) }}<span v-if="df.volumes?.orphans">(含 {{ df.volumes.orphans }} 个未引用卷 {{ formatBytes(df.volumes.reclaimable) }})</span></p>
        <p class="text-xs text-muted">各类资源可能共享底层数据，合计不等同于文件系统实际占用；可回收量是估算，实际释放以执行结果为准。</p>
        <p v-if="df.volumes?.unknown" class="text-xs text-status-warn">{{ df.volumes.unknown }} 个卷的引用或大小未知，请在资源页核对。</p>
        <p v-if="df.disk" class="text-muted text-xs">磁盘剩余 {{ formatBytes(df.disk.free) }} / {{ formatBytes(df.disk.total) }}</p>
      </div>

      <div class="rounded-xl border border-surface-800 p-3 space-y-3">
        <div class="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div class="flex items-center gap-2"><Zap class="h-4 w-4 text-status-warn" /><div><strong class="text-sm text-surface-200">清理悬空镜像与缓存</strong><p class="text-muted text-xs mt-0.5">删除悬空镜像与默认可清理缓存，保留容器和数据卷</p></div></div>
          <button class="btn-primary shrink-0" :disabled="pruning" @click="requestPrune('safe')">{{ pruning ? '清理中…' : '选择清理' }}</button>
        </div>
        <div class="border-t border-surface-800 pt-3">
          <h3 class="text-sm font-semibold text-surface-200">选择深度清理范围</h3>
          <div class="mt-2 grid gap-2">
            <label class="flex cursor-pointer items-start gap-3 rounded-lg border border-surface-800 p-3">
              <input v-model="options.volumes" :disabled="pruning" type="checkbox" class="mt-0.5 shrink-0" />
              <span class="min-w-0"><span class="block text-sm text-surface-200">清理未引用的匿名卷</span><span class="mt-1 block text-xs text-muted">卷内数据会删除；命名卷保留，需逐项核对。</span></span>
            </label>
            <label class="flex cursor-pointer items-start gap-3 rounded-lg border border-surface-800 p-3">
              <input v-model="options.builder" :disabled="pruning" type="checkbox" class="mt-0.5 shrink-0" />
              <span class="min-w-0"><span class="block text-sm text-surface-200">清理全部未使用的构建缓存</span><span class="mt-1 block text-xs text-muted">包括默认清理之外的缓存，下次构建可能变慢。</span></span>
            </label>
          </div>
          <p v-if="options.volumes" class="alert-warning mt-2">匿名卷也可能保存重要数据，删除前请确认已有可用备份。命名卷请在资源页逐项查看。</p>
          <p v-else-if="options.builder" class="text-muted text-xs mt-2">构建缓存删除后，下次构建可能需要重新下载和编译。</p>
          <button class="btn-danger mt-2" :disabled="pruning" @click="runDeep"><Trash2 class="w-4 h-4" />确认所选范围</button>
        </div>
      </div>
    </template>
    <div v-else-if="loadingDf" class="text-muted py-8 text-center" role="status" aria-live="polite">正在读取磁盘占用…</div>
    <div v-else class="text-muted py-8 text-center">磁盘占用暂不可用，请检查 Docker 连接后重试。</div>
    <template #footer>
      <span v-if="lastReclaimed" class="mr-auto text-sm text-status-ok" role="status" aria-live="polite" aria-atomic="true">已释放 {{ formatBytes(lastReclaimed) }}</span>
      <button class="btn-secondary" :disabled="pruning || loadingDf" @click="load">重新读取</button>
      <button class="btn-secondary" :disabled="pruning" @click="close">关闭</button>
    </template>
  </BaseModal>
  <ConfirmDialog :show="!!pending" title="确认 Docker 清理范围" :message="confirmationMessage" tone="danger" confirm-text="确认清理" @confirm="runPrune" @cancel="pending = null" />
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';
import { Trash2, Zap } from 'lucide-vue-next';
import BaseModal from '../common/BaseModal.vue';
import ConfirmDialog from '../common/ConfirmDialog.vue';

const props = defineProps({ open: { type: Boolean, default: true } });
const emit = defineEmits(['close', 'reclaimed']);
const toast = useToastStore();
const df = ref(null);
const error = ref('');
const loadingDf = ref(true);
const pruning = ref(false);
const lastReclaimed = ref(0);
const options = ref({ volumes: false, builder: false });
const pending = ref(null);
let version = 0, active = true, mounted = false;
const descriptions = { safe: '删除悬空镜像与默认可清理的构建缓存；保留容器和数据卷', builder: '删除全部未使用的构建缓存，下次构建可能需要重新下载', volumes: '删除未被容器引用的匿名卷及其中的数据；命名卷请在资源页逐项确认', all: '删除全部未使用的构建缓存和未被容器引用的匿名卷，匿名卷中的数据不可恢复' };
const confirmationMessage = computed(() => pending.value ? `节点「${pending.value.hostName || pending.value.expectedHostId}」：${descriptions[pending.value.mode]}。资源范围覆盖该节点，包含未纳管项目。此操作不能撤销。` : '');

const totalMax = computed(() => Math.max(df.value?.total || 1, 1));

async function load() {
  if (!active || !props.open || pruning.value) return;
  const request = ++version;
  pending.value = null; error.value = ''; df.value = null; loadingDf.value = true;
  try {
    const data = await api.getStorageDf();
    if (request !== version) return;
    if (!data.hostId || !data.hostRevision) throw new Error('节点范围信息不完整，请重新读取后操作');
    df.value = data;
  } catch (e) { if (request === version) error.value = e.message || '空间统计读取失败'; }
  finally { if (request === version) loadingDf.value = false; }
}
function segPercent(size) { return `${Math.max(1, Math.min(100, (Number(size) || 0) / totalMax.value * 100))}%`; }
function requestPrune(mode) {
  if (!active || !props.open || pruning.value || loadingDf.value || !df.value) return;
  pending.value = { mode, expectedHostId: df.value.hostId, hostRevision: df.value.hostRevision, hostName: df.value.hostName };
}
async function runPrune() {
  if (!pending.value || pruning.value || !active || !props.open) return;
  const target = pending.value, request = version;
  pending.value = null; pruning.value = true; error.value = '';
  try {
    const result = await api.pruneStorage(target.mode, 'PRUNE', target.expectedHostId, target.hostRevision);
    if (request !== version) return;
    if (!result?.ok || !Number.isFinite(result.reclaimedMB) || result.reclaimedMB < 0) throw new Error('清理结果不完整');
    const reclaimed = result.reclaimedMB * 1024 * 1024;
    lastReclaimed.value = reclaimed;
    toast.success(`节点「${target.hostName || target.expectedHostId}」已释放 ${formatBytes(reclaimed)}`);
    emit('reclaimed', reclaimed);
  } catch (e) { if (request === version) {
    df.value = null; lastReclaimed.value = 0;
    error.value = `${e.message || '清理未完成'}；请核对是否已有部分资源被清理，重新读取后再操作。`;
  } }
  finally {
    pruning.value = false;
    if (request === version && !error.value) await load();
  }
}
function runDeep() {
  if (!options.value.volumes && !options.value.builder) { toast.info('请至少勾选一项深度清理'); return; }
  requestPrune(options.value.volumes && options.value.builder ? 'all' : options.value.volumes ? 'volumes' : 'builder');
}
function formatBytes(value = 0) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(value) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function close() { if (!pruning.value) { pending.value = null; emit('close'); } }
function invalidate() { version++; pending.value = null; df.value = null; loadingDf.value = false; lastReclaimed.value = 0; }
function hostChanged() { invalidate(); error.value = '节点已变化，请重新读取空间统计后确认。'; }
watch(() => props.open, open => { invalidate(); if (open && mounted) void load(); });
onDeactivated(() => { active = false; invalidate(); });
onActivated(() => { active = true; if (mounted && !df.value && !loadingDf.value) void load(); });
onBeforeUnmount(() => { active = false; invalidate(); window.removeEventListener('composeops:host-changed', hostChanged); });
onMounted(() => { mounted = true; window.addEventListener('composeops:host-changed', hostChanged); void load(); });
</script>
