<template>
  <section class="standalone-panel card">
    <header class="standalone-panel__header">
      <div><h2>独立 Docker 容器</h2><p>不属于任何 Compose 项目的容器 · 当前节点：{{ hostName || hostId || '加载中' }}</p></div>
      <button class="btn-secondary btn-sm" :disabled="loading" @click="load"><RefreshCw :size="14" :class="{ 'animate-spin': loading }" />刷新</button>
    </header>
    <p v-if="error" class="alert-error mx-4 mb-3" role="alert">{{ error }}</p>
    <div v-if="loading && !containers.length" class="p-5 text-sm text-muted" role="status">正在扫描独立容器…</div>
    <div v-else-if="!containers.length" class="standalone-empty">当前节点没有发现独立容器。通过 Docker CLI 创建且未带 Compose 项目标记的容器会显示在这里。</div>
    <div v-else class="standalone-list">
      <article v-for="item in containers" :key="item.id" class="standalone-row">
        <div class="standalone-identity"><Box :size="17" /><div class="min-w-0"><strong>{{ item.name }}</strong><span :title="item.image">{{ item.image }}</span><small>{{ item.ports.length ? item.ports.map(p => `${p.public}→${p.private}`).join(' · ') : '未发布端口' }}</small></div></div>
        <div class="standalone-state"><StatusBadge :status="item.state" /><span>{{ item.statusText }}</span></div>
        <div class="standalone-actions" role="group" :aria-label="`${item.name} 容器操作`">
          <button class="btn-ghost btn-sm" :disabled="busyId === item.id || item.state === 'running'" @click="run(item, 'start')"><Play :size="13" />启动</button>
          <button class="btn-ghost btn-sm" :disabled="busyId === item.id || item.state !== 'running'" @click="requestAction(item, 'restart')"><RotateCw :size="13" />重启</button>
          <button class="btn-ghost btn-sm text-status-error" :disabled="busyId === item.id || item.state !== 'running'" @click="requestAction(item, 'stop')"><Square :size="13" />停止</button>
        </div>
      </article>
    </div>
    <ConfirmDialog :show="!!pending" :title="pending?.action === 'stop' ? '停止独立容器' : '重启独立容器'" :message="pending ? `确认${pending.action === 'stop' ? '停止' : '重启'}「${pending.name}」？容器不会被删除，数据卷保持不变。` : ''" tone="warning" :confirm-text="pending?.action === 'stop' ? '停止容器' : '重启容器'" @confirm="confirmAction" @cancel="pending = null" />
  </section>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { Box, Play, RefreshCw, RotateCw, Square } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import { useToastStore } from '../../stores/toast.js';
import StatusBadge from '../common/StatusBadge.vue';
import ConfirmDialog from '../common/ConfirmDialog.vue';

const props = defineProps({ hostId: { type: String, default: 'local' } });
const emit = defineEmits(['refresh']);
const containers = ref([]);
const hostName = ref('');
const hostId = ref(props.hostId);
const loading = ref(false);
const error = ref('');
const busyId = ref('');
const pending = ref(null);
const toast = useToastStore();

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await api.getStandaloneContainers();
    hostId.value = result.hostId;
    hostName.value = result.hostName;
    containers.value = result.containers || [];
  } catch (cause) {
    error.value = `独立容器扫描失败：${cause.message}`;
  } finally { loading.value = false; }
}
function requestAction(item, action) { pending.value = { id: item.id, name: item.name, action }; }
async function confirmAction() {
  const item = pending.value;
  pending.value = null;
  if (item) await run(containers.value.find(row => row.id === item.id), item.action);
}
async function run(item, action) {
  if (!item || busyId.value) return;
  busyId.value = item.id;
  try {
    await api.runStandaloneContainerAction(item.id, action, hostId.value);
    toast.success(`容器 ${item.name} 已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}`);
    await load();
    emit('refresh');
  } catch (cause) {
    toast.error(`容器操作失败：${cause.message}`);
  } finally { busyId.value = ''; }
}
watch(() => props.hostId, async (next, previous) => {
  if (next !== previous) { containers.value = []; await load(); }
});
onMounted(load);
</script>

<style scoped>
.standalone-panel { overflow: hidden; }
.standalone-panel__header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px 18px; border-bottom:1px solid var(--line-subtle); }
.standalone-panel__header h2 { font-size:14px; font-weight:600; }
.standalone-panel__header p { margin-top:4px; color:var(--color-surface-500); font-size:11px; }
.standalone-panel__header button { display:inline-flex; align-items:center; gap:6px; }
.standalone-empty { padding:22px 18px; color:var(--color-surface-400); font-size:12px; }
.standalone-list { padding-inline:18px; }
.standalone-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(120px,.35fr) auto; align-items:center; gap:16px; padding:14px 0; border-bottom:1px solid var(--line-subtle); }
.standalone-row:last-child { border-bottom:0; }
.standalone-identity { display:flex; align-items:center; gap:10px; min-width:0; color:var(--color-surface-400); }
.standalone-identity strong,.standalone-identity span,.standalone-identity small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.standalone-identity strong { color:var(--color-surface-100); font-family:var(--font-mono); font-size:12px; font-weight:500; }
.standalone-identity span,.standalone-identity small,.standalone-state span { margin-top:4px; color:var(--color-surface-500); font-size:10px; }
.standalone-state { display:flex; flex-direction:column; align-items:flex-start; gap:3px; }
.standalone-actions { display:flex; flex-wrap:wrap; gap:4px; }
.standalone-actions button { display:inline-flex; align-items:center; gap:4px; min-height:34px; }
@media(max-width:700px) { .standalone-panel__header { padding:13px; } .standalone-list { padding-inline:13px; } .standalone-row { grid-template-columns:minmax(0,1fr) auto; gap:10px; } .standalone-state { align-items:flex-end; } .standalone-actions { grid-column:1/-1; } .standalone-actions button { flex:1; justify-content:center; min-height:40px; background:var(--panel-raised); } }
</style>
