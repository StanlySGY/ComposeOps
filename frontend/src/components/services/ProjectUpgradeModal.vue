<template>
  <BaseModal :show="true" :title="`镜像更新 · ${project.projectName}`" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[88vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-3" @close="close">
    <template #header-actions>
      <Sparkles class="w-4 h-4 text-accent" />
    </template>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
    <div v-if="!data && !error" class="text-muted py-8 text-center" role="status" aria-live="polite" aria-atomic="true">正在检测镜像更新…</div>
    <template v-else-if="data">
      <div class="flex items-center gap-2">
        <span class="count-badge" :class="data.hasUpdate ? 'text-amber-300' : hasUncertainStatus ? 'text-rose-300' : 'text-surface-400'">{{ overallStatusLabel }}</span>
        <span class="text-muted text-xs">{{ formatTime(data.checkedAt) }} 检测</span>
        <button class="icon-btn ml-auto" title="立即刷新" aria-label="立即刷新" :disabled="refreshing" @click="refresh"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': refreshing }" /></button>
      </div>
      <div class="space-y-2">
        <div v-for="image in data.images" :key="image.service" class="card p-3">
          <div class="flex items-center gap-2">
            <input v-if="image.hasUpdate" v-model="selectedServices" class="accent-amber-400" type="checkbox" :value="image.service" :aria-label="`选择升级服务 ${image.service}`" />
            <span v-else class="w-2 h-2 rounded-full" :class="image.status === 'current' ? 'bg-emerald-400' : image.status === 'failed' ? 'bg-rose-400' : 'bg-surface-600'"></span>
            <strong class="font-mono text-sm flex-1 min-w-0 truncate">{{ image.service }}<span class="text-surface-500"> · </span>{{ image.image || '本地构建' }}</strong>
            <span v-if="image.hasUpdate" class="count-badge text-amber-300">可升级</span>
            <span v-else class="count-badge" :class="image.status === 'current' ? 'text-emerald-300' : image.status === 'failed' ? 'text-rose-300' : 'text-surface-400'">{{ imageStatusLabel(image.status) }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-2 text-[11px] font-mono text-surface-400">
            <div class="min-w-0"><span class="text-surface-600">本地 </span><span class="truncate block">{{ shortDigest(image.localDigest) }}</span></div>
            <div class="min-w-0"><span class="text-surface-600">远端 </span><span class="truncate block">{{ shortDigest(image.remoteDigest) }}</span></div>
          </div>
          <p v-if="image.error || image.reason" class="mt-1 text-[11px]" :class="image.error ? 'text-rose-400' : 'text-surface-400'">{{ image.error || image.reason }}</p>
        </div>
      </div>
      <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-3 text-xs text-surface-400">
        <p>升级前会自动备份 <code class="font-mono text-surface-300">docker-compose.yml</code> 与 <code class="font-mono text-surface-300">.env</code>;升级完成后 15 秒内自动健康检查,若容器异常退出可一键回滚。</p>
      </div>
    </template>
    <template #footer>
      <button v-if="data?.hasUpdate && !upgrading" class="btn-primary" :disabled="previewLoading || !selectedServices.length" @click="startUpgrade"><Zap class="w-4 h-4" />升级所选服务（{{ selectedServices.length }}）<span v-if="previewLoading" class="text-xs opacity-70">正在生成变更预览…</span></button>
      <p v-if="previewLoading" class="sr-only" role="status" aria-live="polite" aria-atomic="true">正在生成升级变更预览</p>
      <span v-if="upgrading" class="text-sm text-muted" role="status" aria-live="polite" aria-atomic="true">正在升级,请查看输出面板…</span>
      <button class="btn-secondary" @click="close">关闭</button>
    </template>
  </BaseModal>
  <ChangePreviewModal :show="showPreview" :preview="changePreview" title="所选服务升级 · 变更预览" confirm-text="升级所选服务" :fallback-message="`无法获取变更预览。将只拉取并重建这些服务：${selectedServices.join(', ')}。`" @confirm="upgrade" @cancel="showPreview = false" />
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';
import { RefreshCw, Sparkles, Zap } from 'lucide-vue-next';
import BaseModal from '../common/BaseModal.vue';
import ChangePreviewModal from '../common/ChangePreviewModal.vue';

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
const showPreview = ref(false);
const changePreview = ref(null);
const previewLoading = ref(false);
const uncertainStatuses = new Set(['failed', 'unknown', 'needs_policy', 'unresolved']);
const hasUncertainStatus = computed(() => data.value?.images.some((image) => uncertainStatuses.has(image.status)) || false);
const overallStatusLabel = computed(() => {
  if (data.value?.hasUpdate) return '有可用更新';
  if (hasUncertainStatus.value) return '部分状态待确认';
  if (data.value?.images.some((image) => ['current', 'not_downloaded'].includes(image.status))) return '未发现远端更新';
  return '没有可探测的远端镜像';
});

async function load(force = false) {
  error.value = '';
  if (force) refreshing.value = true;
  try {
    data.value = await api.getProjectUpdates(props.project.id, force);
    selectedServices.value = data.value.images.filter((image) => image.hasUpdate).map((image) => image.service);
  } catch (e) {
    error.value = e.message;
  } finally {
    refreshing.value = false;
  }
}
function refresh() { void load(true); }
async function startUpgrade() {
  if (upgrading.value || previewLoading.value) return;
  previewLoading.value = true;
  try {
    const compose = await api.getComposeFile(props.project.id);
    changePreview.value = await api.previewCompose(props.project.id, compose?.content ?? '');
  } catch {
    changePreview.value = null;
  } finally {
    previewLoading.value = false;
    showPreview.value = true;
  }
}
function upgrade() {
  if (upgrading.value || !selectedServices.value.length) return;
  showPreview.value = false;
  upgrading.value = true;
  toast.info('已开始平滑升级,请查看输出面板');
  emit('upgrade', { project: props.project, services: [...selectedServices.value] });
}
function close() { emit('close'); }
function formatTime(ts) { return ts ? new Date(ts).toLocaleString() : ''; }
function shortDigest(digest) { return digest ? `${String(digest).slice(7, 17)}…${String(digest).slice(-8)}` : '未知'; }
function imageStatusLabel(status) { return ({ current: '最新', failed: '检查失败', not_downloaded: '本地未下载', local_build: '本地构建', local_only: '仅用本地镜像', needs_policy: '需明确策略', pinned: '固定 digest', unresolved: '变量未解析', unknown: '无法比较', unsupported: '不支持检查' })[status] || status; }
onMounted(() => void load());
</script>
