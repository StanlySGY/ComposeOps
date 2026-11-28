<template>
  <section class="settings-section space-y-4" aria-labelledby="data-lifecycle-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="data-lifecycle-title" class="section-title">数据库容量与事件归档</h2>
      <button class="btn-secondary" :disabled="busy" @click="load">{{ busy ? '处理中…' : '刷新容量' }}</button>
    </div>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
    <p v-if="!data && !error" class="text-sm text-muted" role="status">正在读取容量…</p>
    <template v-if="data">
      <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div v-for="item in stats" :key="item.label" class="rounded-lg border border-surface-800 p-3">
          <dt class="text-xs text-muted">{{ item.label }}</dt>
          <dd class="mt-1 text-lg font-semibold tabular-nums">{{ formatBytes(item.value) }}</dd>
        </div>
      </dl>
      <p v-for="warning in data.warnings" :key="warning" class="alert-warning">{{ warning }}</p>
      <p class="text-sm leading-6 text-muted">{{ data.note }}</p>
      <p class="text-xs text-muted">容量增长与磁盘阈值告警可在「应用可靠性 → 平台健康」查看。</p>
      <div class="space-y-3 rounded-lg border border-surface-800 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-medium">加密事件归档</h3>
          <span class="text-xs" :class="data.archiveStorage?.ready ? 'text-emerald-400' : 'text-amber-400'">{{ archiveState }}</span>
        </div>
        <p v-if="data.archiveStorage?.error" class="alert-warning">{{ data.archiveStorage.error }}</p>
        <p v-if="data.archiveError" class="alert-warning">最近归档提示：{{ data.archiveError }}</p>
        <dl v-if="data.archiveStorage?.ready" class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div><dt class="text-xs text-muted">{{ data.archiveStorage.partial ? '已扫描文件（部分）' : '归档文件' }}</dt><dd class="mt-1">{{ data.archiveStorage.files }} 份 · {{ formatBytes(data.archiveStorage.bytes) }}</dd></div>
          <div><dt class="text-xs text-muted">归档磁盘可用</dt><dd class="mt-1">{{ formatBytes(data.archiveStorage.freeBytes) }}</dd></div>
          <div><dt class="text-xs text-muted">容量采样时间</dt><dd class="mt-1">{{ date(data.archiveStorage.sampledAt) }}</dd></div>
        </dl>
        <p v-if="data.archiveStorage?.partial" class="text-xs text-amber-400">单次最多检查 {{ data.archiveStorage.limit }} 项，以上为已扫描部分，不是目录总量。</p>
        <p class="text-xs leading-5 text-muted">每 6 小时处理 90 天前已完成任务的事件，每批最多 100 条、约 8 MiB。归档文件不会自动删除，请纳入备份和容量管理。</p>
        <div class="flex flex-wrap gap-2">
          <button class="btn-secondary" :disabled="busy || (!data.archiveEnabled && !data.archiveStorage?.ready)" @click="toggle">{{ data.archiveEnabled ? '暂停自动归档' : '启用每 6 小时加密归档' }}</button>
          <button class="btn-secondary" :disabled="busy || !data.archiveEnabled || !data.archiveStorage?.ready" @click="archive">归档一批已过期事件</button>
        </div>
        <p v-if="!data.archiveConfigured" class="text-xs text-muted">部署时配置独立归档目录和外置数据库密钥后可启用。未完成任务的证据始终保留。</p>
        <p v-if="data.lastArchive" class="text-xs text-muted">最近归档 {{ data.lastArchive.archived }} 条，已解密核对 · {{ date(data.lastArchive.at) }}</p>
        <p v-if="message" class="text-sm text-emerald-400" role="status">{{ message }}</p>
      </div>
    </template>
  </section>
</template>
<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api/client.js';
import { formatBytes } from '../../lib/metrics.js';
const data = ref(null), busy = ref(false), error = ref(''), message = ref('');
const date = value => value ? new Date(value).toLocaleString() : '尚无记录';
const stats = computed(() => [{ label: '数据库文件', value: data.value.databaseBytes }, { label: 'WAL', value: data.value.walBytes }, { label: '可复用空页', value: data.value.reusableBytes }, { label: '磁盘可用', value: data.value.freeBytes }]);
const archiveState = computed(() => !data.value?.archiveConfigured ? '尚未配置' : !data.value.archiveStorage?.ready ? '配置需要处理' : data.value.archiveEnabled ? '自动归档已启用' : '已就绪，自动归档暂停');
async function work(fn) {
  if (busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try { data.value = await fn(); } catch (e) { error.value = e.message; } finally { busy.value = false; }
}
const load = () => work(() => api.getDataLifecycle());
const toggle = () => work(async () => { const result = await api.saveDataLifecycle(!data.value.archiveEnabled); message.value = result.archiveEnabled ? '自动归档已启用。' : '自动归档已暂停，已有文件保留。'; return result; });
const archive = () => work(async () => {
  const result = await api.archiveRunEvents();
  message.value = result.result?.archived ? `已归档 ${result.result.archived} 条事件并完成解密核对。` : '本批没有符合条件的事件，源记录保持不变。';
  return result;
});
onMounted(load);
</script>
