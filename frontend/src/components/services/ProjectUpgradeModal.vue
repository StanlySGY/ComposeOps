<template>
  <BaseModal :show="open" :title="`镜像更新 · ${project.projectName}`" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[88vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-3" @close="close">
    <template #header-actions>
      <Sparkles class="w-4 h-4 text-status-info" />
    </template>
    <div v-if="error" class="alert-error flex flex-wrap items-center gap-2" role="alert"><span class="flex-1">{{ error }}</span><button class="btn-secondary" :disabled="refreshing" @click="refresh">重新检查</button></div>
    <p v-if="refreshing && data" class="sr-only" role="status" aria-live="polite" aria-atomic="true">正在重新检查镜像更新</p>
    <div v-if="!data && !error" class="text-muted py-8 text-center" role="status" aria-live="polite" aria-atomic="true">正在检测镜像更新…</div>
    <template v-else-if="data">
      <div class="flex items-center gap-2">
        <span class="count-badge" :class="data.hasUpdate || hasUncertainStatus ? 'text-status-warn' : 'text-surface-400'">{{ overallStatusLabel }}</span>
        <span class="text-muted text-xs">{{ formatTime(data.checkedAt) }} 检测</span>
        <button class="icon-btn ml-auto" title="立即刷新" aria-label="立即刷新" :disabled="refreshing" @click="refresh"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': refreshing }" /></button>
      </div>
      <p v-if="hasUncertainStatus" class="text-xs text-status-warn" role="status">部分服务尚未完成可靠比较。已确认的结果保留，待确认服务不能选择升级，可稍后重新检查。</p>
      <div class="space-y-2">
        <div v-for="image in data.images" :key="image.service" class="card p-3">
          <div class="flex items-center gap-2">
            <input v-if="image.hasUpdate" v-model="selectedServices" :disabled="refreshing || !!error || upgrading" class="accent-status-warn" type="checkbox" :value="image.service" :aria-label="`选择升级服务 ${image.service}`" />
            <span v-else class="w-2 h-2 rounded-full" :class="image.status === 'current' ? 'bg-status-ok' : image.status === 'failed' ? 'bg-status-error' : 'bg-surface-600'"></span>
            <strong class="font-mono text-sm flex-1 min-w-0 truncate" :title="`${image.service} · ${image.image || '本地构建'}`">{{ image.service }}<span class="text-surface-400"> · </span>{{ image.image || '本地构建' }}</strong>
            <span v-if="image.hasUpdate" class="count-badge text-status-warn">可升级</span>
            <span v-else class="count-badge" :class="image.status === 'current' ? 'text-status-ok' : image.status === 'failed' ? 'text-status-error' : 'text-surface-400'">{{ imageStatusLabel(image.status) }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-2 text-[11px] font-mono text-surface-400">
            <div class="min-w-0"><span class="text-surface-400">{{ image.localImageId ? '运行镜像内容' : '本地清单' }} </span><span class="truncate block" :title="image.localImageId || image.localDigest">{{ shortDigest(image.localImageId || image.localDigest) }}</span></div>
            <div class="min-w-0"><span class="text-surface-400">{{ image.remoteImageId ? '远端镜像内容' : '远端清单' }} </span><span class="truncate block" :title="image.remoteImageId || image.remoteDigest">{{ shortDigest(image.remoteImageId || image.remoteDigest) }}</span></div>
          </div>
          <p v-if="image.error || image.reason" class="mt-1 text-[11px]" :class="image.error ? 'text-status-error' : 'text-surface-400'">{{ image.error || image.reason }}</p>
        </div>
      </div>
      <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-3 text-xs text-surface-400">
        <p>升级前会自动备份可读取的 Compose 配置文件；升级完成后 15 秒内自动健康检查。若容器异常退出，可恢复升级前配置并重建容器。注意：恢复配置不保证回退已拉取的镜像版本，浮动 tag 仍可能指向新镜像。</p>
      </div>
    </template>
    <template #footer>
      <button v-if="data?.hasUpdate && !upgrading" class="btn-primary" :disabled="!canUpgrade" @click="startUpgrade"><Zap class="w-4 h-4" />升级所选服务（{{ selectedServices.length }}）</button>
      <span v-if="upgrading" class="text-sm text-muted" role="status" aria-live="polite" aria-atomic="true">正在升级,请查看输出面板…</span>
      <button class="btn-secondary" @click="close">关闭</button>
    </template>
  </BaseModal>
  <ConfirmDialog :show="showConfirm" title="确认升级所选服务" tone="warning" confirm-text="拉取并重建" :message="`将只拉取并重建 ${project.projectName} 中的这些服务：${pendingServices.join(', ')}。这可能短暂中断服务；已停止的所选服务也会被启动，不会同时启动依赖服务。`" @confirm="upgrade" @cancel="showConfirm = false">
    <p class="text-xs text-muted">执行前会重新核对远端更新并备份 Compose 配置。镜像内部变化无法从当前配置预览，请确认发布说明；恢复配置也不能保证回退浮动标签指向的镜像。</p>
  </ConfirmDialog>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';
import { RefreshCw, Sparkles, Zap } from 'lucide-vue-next';
import BaseModal from '../common/BaseModal.vue';
import ConfirmDialog from '../common/ConfirmDialog.vue';

const props = defineProps({
  project: { type: Object, required: true },
  open: { type: Boolean, default: true },
});
const emit = defineEmits(['close', 'upgrade']);
const toast = useToastStore();
const data = ref(null);
const selectedServices = ref([]);
const error = ref('');
const refreshing = ref(false);
const upgrading = ref(false);
const showConfirm = ref(false);
const pendingServices = ref([]);
let requestId = 0, controller = null;
const active = ref(true);
const uncertainStatuses = new Set(['failed', 'unknown', 'needs_policy', 'unresolved']);
const hasUncertainStatus = computed(() => data.value?.images.some((image) => uncertainStatuses.has(image.status)) || false);
const overallStatusLabel = computed(() => {
  if (data.value?.hasUpdate) return hasUncertainStatus.value ? '有可用更新 · 部分待确认' : '有可用更新';
  if (hasUncertainStatus.value) return '部分状态待确认';
  if (data.value?.images.some((image) => ['current', 'not_downloaded'].includes(image.status))) return '未发现远端更新';
  return '没有可探测的远端镜像';
});
const canUpgrade = computed(() => active.value && props.open && props.project.managed !== false && props.project.editable !== false && !refreshing.value && !error.value && !upgrading.value && selectedServices.value.length > 0);

async function load(force = false) {
  if (!active.value || !props.open || refreshing.value) return;
  const current = ++requestId;
  controller?.abort(); controller = new AbortController();
  error.value = '';
  refreshing.value = true;
  showConfirm.value = false;
  try {
    const response = await api.getProjectUpdates(props.project.id, force, { signal: controller.signal });
    if (current !== requestId) return;
    data.value = response;
    selectedServices.value = data.value.images.filter((image) => image.hasUpdate).map((image) => image.service);
  } catch (e) {
    if (current === requestId) error.value = e.message;
  } finally {
    if (current === requestId) refreshing.value = false;
  }
}
function refresh() { void load(true); }
function startUpgrade() {
  if (!canUpgrade.value) return;
  pendingServices.value = [...selectedServices.value];
  showConfirm.value = true;
}
function upgrade() {
  if (!canUpgrade.value || !showConfirm.value || !pendingServices.value.length) return;
  const available = new Set(data.value.images.filter(image => image.hasUpdate).map(image => image.service));
  if (pendingServices.value.some(service => !available.has(service))) return;
  showConfirm.value = false;
  upgrading.value = true;
  toast.info('已开始升级镜像，请查看输出面板');
  emit('upgrade', { project: props.project, services: [...pendingServices.value] });
}
function cancel() { requestId++; controller?.abort(); controller = null; refreshing.value = false; showConfirm.value = false; pendingServices.value = []; }
function close() { cancel(); emit('close'); }
function hostChanged() { cancel(); data.value = null; selectedServices.value = []; error.value = '节点已切换，请重新打开目标项目的镜像检查。'; emit('close'); }
function formatTime(ts) { return ts ? new Date(ts).toLocaleString() : ''; }
function shortDigest(digest) { return digest ? `${String(digest).slice(7, 17)}…${String(digest).slice(-8)}` : '未知'; }
function imageStatusLabel(status) { return ({ current: '最新', failed: '检查失败', not_deployed: '尚未部署', not_downloaded: '本地未下载', local_build: '本地构建', local_only: '仅用本地镜像', needs_policy: '需明确策略', pinned: '固定 digest', unresolved: '变量未解析', unknown: '无法比较', unsupported: '不支持检查' })[status] || status; }
watch([() => props.project.id, () => props.project.hostId, () => props.project.managed, () => props.project.editable, () => props.open], () => { cancel(); data.value = null; error.value = ''; selectedServices.value = []; upgrading.value = false; void load(); }, { immediate: true });
onMounted(() => window.addEventListener('composeops:host-changed', hostChanged));
onDeactivated(() => { active.value = false; cancel(); });
onActivated(() => { if (active.value) return; active.value = true; if (!data.value && !error.value) void load(); });
onBeforeUnmount(() => { active.value = false; cancel(); window.removeEventListener('composeops:host-changed', hostChanged); });
</script>
