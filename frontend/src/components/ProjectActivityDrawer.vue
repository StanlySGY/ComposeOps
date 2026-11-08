<template>
  <div v-if="project" class="drawer-backdrop z-55" @click.self="close">
    <aside ref="activityDialog" class="activity-drawer z-51" role="dialog" aria-modal="true" aria-labelledby="project-activity-title" tabindex="-1" @keydown="trapActivityTab">
      <header class="flex items-start gap-3 border-b border-surface-800 px-4 py-4">
        <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-status-info"><History class="h-5 w-5" /></div>
        <div class="min-w-0 flex-1"><h2 id="project-activity-title" class="truncate font-mono text-base font-semibold text-surface-100">{{ project.projectName }}</h2><p class="mt-0.5 text-muted">活动记录与配置版本</p></div>
        <button class="icon-btn" title="关闭" aria-label="关闭项目活动" :disabled="restoring" @click="close"><X class="h-4 w-4" /></button>
      </header>
      <div class="tabs px-4 pt-2" role="tablist" aria-label="项目活动内容" @keydown="handleTabKeydown">
        <button id="project-activity-tab-activity" role="tab" data-tab="activity" aria-controls="project-activity-panel" :aria-selected="tab === 'activity'" :tabindex="tab === 'activity' ? 0 : -1" :class="{ active: tab === 'activity' }" @click="tab = 'activity'"><Activity class="h-4 w-4" />活动 <span class="count-badge">{{ hasData ? operations.length : '—' }}</span></button>
        <button id="project-activity-tab-versions" role="tab" data-tab="versions" aria-controls="project-activity-panel" :aria-selected="tab === 'versions'" :tabindex="tab === 'versions' ? 0 : -1" :class="{ active: tab === 'versions' }" @click="tab = 'versions'"><FileClock class="h-4 w-4" />配置版本 <span class="count-badge">{{ hasData ? backups.length : '—' }}</span></button>
      </div>
      <div id="project-activity-panel" class="min-h-0 flex-1 overflow-y-auto p-4 space-y-3" role="tabpanel" :aria-labelledby="`project-activity-tab-${tab}`" :aria-busy="loading">
        <section v-if="restoreResult" ref="restoreFeedback" class="activity-restore-result" tabindex="-1" role="status" aria-live="polite">
          <CircleCheck class="h-5 w-5 shrink-0 text-status-ok" /><div class="min-w-0"><h3 class="text-sm font-medium text-surface-100">配置文件已恢复，尚未应用到容器</h3><p class="mt-1 text-xs leading-5 text-surface-300">{{ shortName(restoreResult.filePath) }} · 返回项目后，选择「更多操作 → 应用配置 / 启动」并检查运行状态。</p><div class="mt-3 flex flex-wrap gap-2"><button class="btn-secondary btn-sm" @click="close">返回项目应用配置</button><router-link class="btn-ghost btn-sm" :to="editorLink" @click="close">查看恢复后的配置<ArrowRight class="h-3.5 w-3.5" /></router-link></div></div>
        </section>
        <div v-if="error" class="activity-load-error"><p class="alert-error" role="alert">{{ error }}</p><button class="btn-secondary btn-sm mt-2" :disabled="loading || restoring" @click="load">重试</button></div>
        <div v-if="loading && !hasData" class="flex min-h-32 flex-col items-center justify-center gap-3 text-surface-400">
        <span class="loading-mark" aria-hidden="true"></span><span class="text-sm" role="status" aria-live="polite" aria-atomic="true">正在加载项目活动...</span>
      </div>
        <div v-if="hasData && tab === 'activity'" class="activity-list">
          <button v-for="item in operations" :key="item.id" class="activity-item" @click="selectedOperation = item">
            <span class="timeline-dot" aria-hidden="true" :class="item.status === 'success' ? 'success' : item.status === 'failed' ? 'failed' : ''"></span>
            <span class="min-w-0 flex-1"><span class="activity-item-heading"><strong>{{ actionLabel(item.action) }}</strong><time :datetime="parseTimestamp(item.createdAt)?.toISOString()" :title="formatTime(item.createdAt)">{{ formatRelative(item.createdAt) }}</time></span><span class="activity-status" :class="item.status === 'success' ? 'text-status-ok' : item.status === 'failed' ? 'text-status-error' : 'text-surface-300'">{{ statusLabel(item.status) }}</span><small>{{ operationSummary(item) }}</small></span>
            <ChevronRight class="h-4 w-4 shrink-0 text-surface-400" />
          </button>
          <EmptyState v-if="!operations.length" icon="History" compact title="该项目暂无操作记录" description="对项目执行启动、停止等操作后会显示在这里" />
        </div>
        <div v-else-if="hasData && tab === 'versions'" class="space-y-3">
          <p class="activity-version-guide"><FileClock class="h-4 w-4 shrink-0 text-status-info" /><span>配置版本保留文件快照。恢复后还需应用配置，运行中的容器才会更新。</span></p>
          <article v-for="backup in backups" :key="backup.id" class="version-card">
            <div class="flex items-start gap-3"><span class="version-icon"><FileCode2 class="h-4 w-4" /></span><div class="min-w-0 flex-1"><strong class="break-all">{{ shortName(backup.filePath) }}</strong><p class="mt-1 text-xs text-surface-400">{{ reasonLabel(backup.reason) }} · {{ backup.size }} 字符</p><p class="mt-1 text-xs tabular-nums text-surface-300">{{ formatTime(backup.createdAt) }}</p></div></div>
            <details class="activity-version-path"><summary>文件位置<ChevronRight class="h-3.5 w-3.5" /></summary><p>{{ backup.filePath }}</p></details>
            <div class="activity-version-actions"><router-link class="btn-ghost" :to="editorLink" @click="close"><Eye class="h-4 w-4" />打开编辑器</router-link><button class="btn-secondary" :disabled="restoring || !project.editable" :title="project.editable ? '恢复到该版本' : '项目未启用 Compose 编辑能力'" @click="restore(backup)"><Undo2 class="h-4 w-4" />恢复</button></div>
          </article>
          <EmptyState v-if="!backups.length" icon="FileClock" compact title="暂无配置备份" description="保存配置后会自动生成版本历史" />
        </div>
      </div>
      <footer class="flex items-center justify-between gap-2 border-t border-surface-800 px-4 py-3 text-muted"><span>保留最近 20 个配置版本</span><button class="btn-ghost" :disabled="loading || restoring" @click="load"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button></footer>
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
  <ConfirmDialog :show="!!restoreTarget" title="恢复配置版本" :message="restoreMessage" tone="warning" confirm-text="确认恢复" :busy="restoring" @confirm="confirmRestore" @cancel="restoreTarget = null"><p v-if="restoreError" class="alert-error" role="alert">{{ restoreError }}</p></ConfirmDialog>
</template>

<script setup>
import { deepLink } from '../lib/deep-links.js';
import { formatTimestamp, parseTimestamp } from '../lib/date-time.js';
import { handleTablistKeydown } from '../lib/tablist-keyboard.js';
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useEscapeKey } from '../composables/useEscapeKey.js';
import { Activity, ArrowRight, ChevronRight, CircleCheck, Eye, FileClock, FileCode2, History, RefreshCw, Undo2, X } from 'lucide-vue-next';
import { api } from '../api/client.js';
import EmptyState from './common/EmptyState.vue';
import ConfirmDialog from './common/ConfirmDialog.vue';
import BaseModal from './common/BaseModal.vue';

const props = defineProps({ project: Object });
const emit = defineEmits(['close', 'restored']);
const tab = ref('activity'); const loading = ref(false); const restoring = ref(false); const error = ref(''); const operations = ref([]); const backups = ref([]); const selectedOperation = ref(null);
const restoreTarget = ref(null);
const restoreError = ref('');
const restoreResult = ref(null);
const restoreFeedback = ref(null);
const hasData = ref(false);
const editorLink = computed(() => deepLink('/compose', { projectId: props.project?.id, from: 'services' }));
const restoreMessage = computed(() => `恢复「${shortName(restoreTarget.value?.backup.filePath)}」在 ${formatTime(restoreTarget.value?.backup.createdAt)} 的配置版本？当前文件会先自动备份。恢复只修改文件，不会自动更新容器。`);
const activityDialog = ref(null);
let activityOpener = null;
let loadRequestId = 0;
let contextVersion = 0;
let restoreRequestId = 0;
let disposed = false;
const ACTIVITY_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function captureActivityOpener() {
  const activeElement = document.activeElement;
  activityOpener = activeElement instanceof HTMLElement
    && activeElement !== document.body
    && !activityDialog.value?.contains(activeElement)
    ? activeElement
    : null;
}

function restoreActivityFocus() {
  const opener = activityOpener;
  activityOpener = null;
  if (opener?.isConnected) void nextTick(() => opener.focus({ preventScroll: true }));
}

function trapActivityTab(event) {
  if (event.key !== 'Tab') return;
  const dialog = activityDialog.value;
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll(ACTIVITY_FOCUSABLE)].filter((element) => {
    if (element.closest('[hidden]') || element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

watch(() => !!props.project, async (isOpen) => {
  if (isOpen) {
    captureActivityOpener();
    await nextTick();
    activityDialog.value?.focus({ preventScroll: true });
    return;
  }
  restoreActivityFocus();
}, { immediate: true });

function close() { if (!restoring.value) emit('close'); }
function handleTabKeydown(event) { handleTablistKeydown(event, value => { tab.value = value; }); }
useEscapeKey({ active: computed(() => !!props.project), onClose: close, layer: 'drawer', lockBody: true });

async function load() {
  const projectId = props.project?.id;
  const requestId = ++loadRequestId;
  if (!projectId) {
    loading.value = false;
    operations.value = [];
    backups.value = [];
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const data = await api.getProjectActivity(projectId);
    // Project prop may change while the previous project's request is still in flight.
    if (disposed || requestId !== loadRequestId || projectId !== props.project?.id) return;
    operations.value = data.operations || [];
    backups.value = data.backups || [];
    hasData.value = true;
  } catch (e) {
    if (!disposed && requestId === loadRequestId && projectId === props.project?.id) error.value = e.message || '项目活动加载失败';
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}
async function restore(backup) {
  if (!props.project?.editable || restoring.value || disposed) return;
  restoreTarget.value = { backup, projectId: props.project.id, version: contextVersion };
  restoreError.value = '';
}
async function confirmRestore() {
  const target = restoreTarget.value;
  if (!target || restoring.value || !isCurrent(target) || !props.project?.editable) return;
  const request = ++restoreRequestId;
  restoring.value = true; restoreError.value = '';
  try {
    await api.restoreBackup(target.projectId, target.backup.id);
    if (!isCurrent(target)) return;
    restoring.value = false;
    restoreTarget.value = null;
    const result = { projectId: target.projectId, backupId: target.backup.id, filePath: target.backup.filePath };
    restoreResult.value = result;
    emit('restored', result);
    await nextTick();
    if (!isCurrent(target)) return;
    restoreFeedback.value?.focus({ preventScroll: true });
    restoreFeedback.value?.scrollIntoView?.({ block: 'nearest' });
    await load();
  } catch (e) {
    if (isCurrent(target)) restoreError.value = e.message || '恢复失败，请重试';
  } finally { if (request === restoreRequestId) restoring.value = false; }
}
function isCurrent(target) { return !disposed && target.version === contextVersion && target.projectId === props.project?.id; }
function invalidateContext() {
  contextVersion++; restoreRequestId++; loadRequestId++;
  restoring.value = false; loading.value = false; hasData.value = false;
  operations.value = []; backups.value = []; selectedOperation.value = null;
  restoreTarget.value = null; restoreError.value = ''; restoreResult.value = null; error.value = '';
}
function onHostChanged() { invalidateContext(); emit('close'); }
function actionLabel(action = '') { const clean = action.split('.').pop(); return ({ up: '启动项目', restart: '重启项目', stop: '停止项目', pull: '拉取镜像', ps: '检查状态', save: '保存配置', restore: '恢复配置' })[clean] || action; }
function operationSummary(item) { return item.detail?.trim().split('\n').filter(Boolean).slice(-1)[0] || '没有附加输出'; }
function statusLabel(status) { return ({ success: '执行成功', failed: '执行失败', running: '执行中', pending: '等待执行', queued: '排队中', cancelled: '已取消', interrupted: '已中断' })[status] || '结果待确认'; }
function reasonLabel(reason) { return ({ restore: '恢复前自动备份', save: '保存前自动备份' })[reason] || reason || '配置快照'; }
function shortName(path = '') { return String(path).split('/').pop() || '配置文件'; }
function formatTime(value) { return formatTimestamp(value); }
function formatRelative(value) { const date = parseTimestamp(value); if (!date) return '时间未知'; const diff = Date.now() - date.getTime(); if (diff < 0) return formatTime(value); const min = Math.floor(diff / 60000); if (min < 1) return '刚刚'; if (min < 60) return `${min} 分钟前`; const hour = Math.floor(min / 60); if (hour < 24) return `${hour} 小时前`; const day = Math.floor(hour / 24); return day < 7 ? `${day} 天前` : formatTime(value); }

watch(() => props.project?.id, (nextId, previousId) => {
  if (nextId !== previousId) {
    invalidateContext();
    tab.value = 'activity';
  }
  void load();
});
onMounted(() => { window.addEventListener('composeops:host-changed', onHostChanged); void load(); });
onDeactivated(() => { if (!disposed) { invalidateContext(); emit('close'); } });
onBeforeUnmount(() => { disposed = true; invalidateContext(); window.removeEventListener('composeops:host-changed', onHostChanged); restoreActivityFocus(); });
</script>

<style scoped>
.activity-restore-result { display: flex; align-items: flex-start; gap: 12px; padding: 14px; border: 1px solid color-mix(in srgb, var(--color-status-ok) 30%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--color-status-ok) 6%, var(--color-surface-950)); }
.activity-item-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; }
.activity-item-heading strong { min-width: 0; }
.activity-status { display: inline-block; margin-top: 5px; font-size: 11px; font-weight: 500; }
.activity-version-guide { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border-radius: 10px; background: var(--color-surface-950); font-size: 12px; line-height: 1.7; color: var(--color-surface-400); }
.activity-version-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--color-surface-800); }
.activity-version-path { margin-top: 10px; font-size: 12px; color: var(--color-surface-400); }
.activity-version-path summary { display: flex; align-items: center; gap: 5px; width: fit-content; padding: 5px 0; cursor: pointer; list-style: none; }
.activity-version-path summary::-webkit-details-marker { display: none; }
.activity-version-path summary svg { transition: transform 140ms ease; }
.activity-version-path[open] summary svg { transform: rotate(90deg); }
.activity-version-path p { padding: 8px 10px; border-radius: 6px; background: var(--color-surface-950); font-family: var(--font-mono); overflow-wrap: anywhere; }
.version-card { transition: border-color 160ms ease; }
.version-card:hover, .version-card:focus-within { border-color: var(--color-surface-600); }
@media (max-width: 639px) { .activity-version-actions > *, .tabs button { min-height: 44px; } .activity-item { padding-inline: 10px; } }
@media (prefers-reduced-motion: reduce) { .version-card, .activity-item, .activity-version-path summary svg { transition: none; } }
</style>
