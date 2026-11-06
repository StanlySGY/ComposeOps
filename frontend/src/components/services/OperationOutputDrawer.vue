<template>
  <div ref="drawerRef" class="drawer max-w-[calc(100vw-2rem)] sm:max-w-[720px] z-51" role="dialog" aria-labelledby="operation-output-title" tabindex="-1">
    <div class="modal-header"><h2 id="operation-output-title" class="min-w-0 truncate">{{ label }} · {{ name }} 操作输出</h2><button class="icon-btn" title="关闭输出面板" aria-label="关闭输出面板" @click="$emit('close')"><X class="w-4 h-4" /></button></div>
    <div v-if="batchTasks.length" class="border-b border-surface-800 p-3">
      <div class="mb-2 flex items-center justify-between text-muted"><span>任务进度</span><span role="status" aria-live="polite" aria-atomic="true">{{ completedCount }} / {{ batchTasks.length }} 项任务已完成</span></div>
      <div class="progress mb-3" role="progressbar" aria-label="批量任务总体进度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.max(0, Math.min(100, batchProgress))" :aria-valuetext="`${completedCount} / ${batchTasks.length} 项任务已完成`"><span aria-hidden="true" :style="{ width: `${batchProgress}%` }"></span></div>
      <div class="grid gap-2 sm:grid-cols-2">
        <div v-for="task in batchTasks" :key="task.id" class="batch-task">
          <LoaderCircle v-if="task.status === 'running'" class="h-4 w-4 animate-spin text-accent" />
          <CircleCheck v-else-if="task.status === 'success'" class="h-4 w-4 text-emerald-400" />
          <CircleX v-else-if="task.status === 'failed'" class="h-4 w-4 text-rose-400" />
          <span v-else class="h-2 w-2 rounded-full bg-surface-600"></span>
          <span class="min-w-0 flex-1 truncate text-xs">{{ task.name }}</span>
          <span class="text-[10px] text-surface-500">{{ statusLabel(task.status) }}</span>
        </div>
      </div>
    </div>
    <div v-if="!batchTasks.length" class="operation-result" role="status" aria-live="polite" :data-state="running ? 'running' : failed ? 'failed' : exitCode === 0 ? 'success' : 'unknown'">
      <LoaderCircle v-if="running" class="h-5 w-5 animate-spin" /><CircleX v-else-if="failed" class="h-5 w-5" /><CircleCheck v-else-if="exitCode === 0" class="h-5 w-5" /><CircleHelp v-else class="h-5 w-5" />
      <div><strong>{{ running ? '正在执行' : failed ? '执行失败' : exitCode === 0 ? '命令执行成功' : '尚未确认执行结果' }}</strong><p>{{ running ? '输出会实时更新，关闭面板不会发送停止命令。' : failed ? (failureReason || '查看下方输出定位原因，也可以交给 AI 分析。') : exitCode === 0 ? '命令退出码为 0；请继续确认容器状态与业务是否正常。' : '没有收到退出码。请检查项目状态，避免重复提交操作。' }}</p></div>
    </div>
    <pre class="terminal-output flex-1" role="region" aria-label="操作执行输出" aria-live="off" tabindex="0">{{ text }}</pre>
    <div v-if="!running && projectId" class="ai-diagnose-bar">
      <template v-if="failed">
        <button class="btn-primary" @click="$emit('diagnose')"><Sparkles class="w-4 h-4" />一键 AI 诊断</button>
        <span class="text-xs text-muted">检测到执行失败，可交给 AI 分析根因与修复建议</span>
      </template>
      <template v-else>
        <span class="text-xs text-muted">{{ exitCode === 0 ? '下一步：确认容器运行状态' : '下一步：核实当前项目状态' }}</span>
        <button class="btn-secondary text-xs!" @click="$emit('inspect')">查看项目状态</button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { CircleCheck, CircleHelp, CircleX, LoaderCircle, Sparkles, X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useEscapeKey } from '../../composables/useEscapeKey.js';

const props = defineProps({
  label: { type: String, default: '' },
  name: { type: String, default: '' },
  text: { type: String, default: '' },
  projectId: { type: String, default: '' },
  exitCode: { type: Number, default: null },
  running: { type: Boolean, default: false },
  failureReason: { type: String, default: '' },
  batchTasks: { type: Array, default: () => [] },
  batchProgress: { type: Number, default: 0 },
  completedCount: { type: Number, default: 0 },
});
const emit = defineEmits(['close', 'diagnose', 'inspect']);
const drawerRef = ref(null);
const activeElementBeforeOpen = document.activeElement;
let previousFocus = activeElementBeforeOpen instanceof HTMLElement && activeElementBeforeOpen !== document.body
  ? activeElementBeforeOpen
  : null;

onMounted(async () => {
  await nextTick();
  drawerRef.value?.focus({ preventScroll: true });
});

onBeforeUnmount(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  previousFocus = null;
});

const failed = computed(() => {
  if (props.failureReason) return true;
  if (props.exitCode != null) return props.exitCode !== 0;
  return false;
});
useEscapeKey({ active: computed(() => true), onClose: () => emit('close'), layer: 'drawer', lockBody: true });
function statusLabel(status) { return ({ pending: '等待', running: '执行中', success: '成功', failed: '失败' })[status] || status; }
</script>

<style scoped>
.operation-result { display: flex; align-items: flex-start; gap: 10px; padding: 16px; border-bottom: 1px solid var(--line-subtle); color: var(--color-surface-300); }
.operation-result strong { font-size: 13px; font-weight: 600; }
.operation-result p { margin-top: 5px; font-size: 11px; color: var(--color-surface-400); }
.operation-result[data-state="success"] > svg { color: #6ee7b7; }
.operation-result[data-state="failed"] > svg { color: #fda4af; }
.operation-result[data-state="unknown"] > svg { color: #fcd34d; }
</style>
