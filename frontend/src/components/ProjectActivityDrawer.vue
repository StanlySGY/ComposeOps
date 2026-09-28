<template>
  <div v-if="project" class="drawer-backdrop z-55" @click.self="$emit('close')">
    <aside class="activity-drawer z-51">
      <header class="flex items-start gap-3 border-b border-surface-800 px-4 py-4">
        <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"><History class="h-5 w-5" /></div>
        <div class="min-w-0 flex-1"><h2 class="truncate font-mono text-base font-semibold text-surface-100">{{ project.projectName }}</h2><p class="mt-0.5 text-muted">活动记录与配置版本</p></div>
        <button class="icon-btn" title="关闭" aria-label="关闭项目活动" @click="$emit('close')"><X class="h-4 w-4" /></button>
      </header>
      <div class="tabs px-4 pt-2">
        <button :class="{ active: tab === 'activity' }" @click="tab = 'activity'"><Activity class="h-4 w-4" />活动 <span class="count-badge">{{ operations.length }}</span></button>
        <button :class="{ active: tab === 'versions' }" @click="tab = 'versions'"><FileClock class="h-4 w-4" />配置版本 <span class="count-badge">{{ backups.length }}</span></button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <div v-if="loading" class="flex min-h-32 flex-col items-center justify-center gap-3 text-surface-500">
        <span class="loading-mark"></span><span class="text-sm">正在加载项目活动...</span>
      </div>
        <div v-else-if="error" class="alert-error">{{ error }}</div>
        <div v-else-if="tab === 'activity'" class="activity-list">
          <button v-for="item in operations" :key="item.id" class="activity-item" @click="selectedOperation = item">
            <span class="timeline-dot" :class="item.status === 'success' ? 'success' : 'failed'"></span>
            <span class="min-w-0 flex-1"><span class="flex items-center justify-between gap-3"><strong>{{ actionLabel(item.action) }}</strong><time>{{ formatRelative(item.createdAt) }}</time></span><small>{{ operationSummary(item) }}</small></span>
            <ChevronRight class="h-4 w-4 shrink-0 text-surface-600" />
          </button>
          <EmptyState icon="History" compact title="该项目暂无操作记录" description="对项目执行启动、停止等操作后会显示在这里" />
        </div>
        <div v-else class="space-y-3">
          <article v-for="backup in backups" :key="backup.id" class="version-card">
            <div class="flex items-start gap-3"><span class="version-icon"><FileCode2 class="h-4 w-4" /></span><div class="min-w-0 flex-1"><strong>{{ reasonLabel(backup.reason) }}</strong><p class="mt-1 truncate font-mono text-muted" :title="backup.filePath">{{ backup.filePath }}</p><p class="mt-1 text-xs text-surface-600">{{ formatTime(backup.createdAt) }} · {{ backup.size }} 字符</p></div></div>
            <div class="mt-3 flex justify-end gap-2"><router-link class="btn-ghost" :to="`/compose?projectId=${project.id}`" @click="$emit('close')"><Eye class="h-4 w-4" />打开编辑器</router-link><button class="btn-secondary" :disabled="restoring || !project.editable" :title="project.editable ? '恢复到该版本' : '项目未启用 Compose 编辑能力'" @click="restore(backup)"><Undo2 class="h-4 w-4" />恢复</button></div>
          </article>
          <EmptyState icon="FileClock" compact title="暂无配置备份" description="保存配置后会自动生成版本历史" />
        </div>
      </div>
      <footer class="flex items-center justify-between border-t border-surface-800 px-4 py-3 text-muted"><span>保留最近 20 个配置版本</span><button class="btn-ghost" :disabled="loading" @click="load"><RefreshCw class="h-4 w-4" />刷新</button></footer>
    </aside>
  </div>

  <BaseModal
    :show="!!selectedOperation"
    :title="selectedOperation ? `${actionLabel(selectedOperation.action)} · ${formatTime(selectedOperation.createdAt)}` : ''"
    body-class="p-0"
    @close="selectedOperation = null"
  >
    <pre class="terminal-output max-h-[65vh] min-h-48">{{ selectedOperation?.detail || '该操作没有附加输出。' }}</pre>
  </BaseModal>
  <ConfirmDialog :show="!!restoreTarget" title="恢复配置版本" :message="`恢复 ${restoreTarget ? formatTime(restoreTarget.createdAt) : ''} 的配置版本?当前配置会先自动备份。`" tone="warning" confirm-text="确认恢复" @confirm="confirmRestore" @cancel="restoreTarget = null" />
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useEscapeKey } from '../composables/useEscapeKey.js';
import { Activity, ChevronRight, Eye, FileClock, FileCode2, History, RefreshCw, Undo2, X } from 'lucide-vue-next';
import { api } from '../api/client.js';
import EmptyState from './common/EmptyState.vue';
import ConfirmDialog from './common/ConfirmDialog.vue';
import BaseModal from './common/BaseModal.vue';

const props = defineProps({ project: Object });
const emit = defineEmits(['close', 'restored']);
const tab = ref('activity'); const loading = ref(false); const restoring = ref(false); const error = ref(''); const operations = ref([]); const backups = ref([]); const selectedOperation = ref(null);
const restoreTarget = ref(null);

useEscapeKey({ active: computed(() => !!props.project), onClose: () => emit('close'), layer: 'drawer', lockBody: true });

async function load() {
  if (!props.project) return;
  loading.value = true; error.value = '';
  try { const data = await api.getProjectActivity(props.project.id); operations.value = data.operations || []; backups.value = data.backups || []; }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
async function restore(backup) {
  restoreTarget.value = backup;
}
async function confirmRestore() {
  const backup = restoreTarget.value;
  restoreTarget.value = null;
  if (!backup) return;
  restoring.value = true; error.value = '';
  try { await api.restoreBackup(props.project.id, backup.id); emit('restored'); await load(); }
  catch (e) { error.value = e.message; }
  finally { restoring.value = false; }
}
function actionLabel(action = '') { const clean = action.split('.').pop(); return ({ up: '启动项目', restart: '重启项目', stop: '停止项目', pull: '拉取镜像', ps: '检查状态', save: '保存配置', restore: '恢复配置' })[clean] || action; }
function operationSummary(item) { if (item.status !== 'success') return item.detail?.trim().split('\n').filter(Boolean).slice(-1)[0] || '执行失败'; return item.detail ? '执行完成，点击查看输出' : '执行成功'; }
function reasonLabel(reason) { return reason === 'restore' ? '恢复前自动备份' : '保存前自动备份'; }
function formatTime(value) { return value ? new Date(`${value}Z`).toLocaleString() : ''; }
function formatRelative(value) { const diff = Date.now() - new Date(`${value}Z`).getTime(); const min = Math.floor(diff / 60000); if (min < 1) return '刚刚'; if (min < 60) return `${min} 分钟前`; const hour = Math.floor(min / 60); if (hour < 24) return `${hour} 小时前`; const day = Math.floor(hour / 24); return day < 7 ? `${day} 天前` : formatTime(value); }

watch(() => props.project?.id, load);
onMounted(load);
</script>
