<template>
  <div class="drawer max-w-[calc(100vw-2rem)] sm:max-w-[720px] z-51">
    <div class="modal-header"><span>{{ label }} · {{ name }}</span><button class="icon-btn" title="关闭输出面板" @click="$emit('close')"><X class="w-4 h-4" /></button></div>
    <div v-if="batchTasks.length" class="border-b border-surface-800 p-3">
      <div class="mb-2 flex items-center justify-between text-muted"><span>任务进度</span><span>{{ completedCount }} / {{ batchTasks.length }}</span></div>
      <div class="progress mb-3"><span :style="{ width: `${batchProgress}%` }"></span></div>
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
    <pre class="terminal-output flex-1">{{ text }}</pre>
    <div v-if="failed && !running && projectId" class="ai-diagnose-bar">
      <button class="btn-primary" @click="$emit('diagnose')"><Sparkles class="w-4 h-4" />一键 AI 诊断</button>
      <span class="text-xs text-muted">检测到执行失败,可交给 AI 分析根因与修复建议</span>
    </div>
  </div>
</template>

<script setup>
import { CircleCheck, CircleX, LoaderCircle, Sparkles, X } from 'lucide-vue-next';
import { computed } from 'vue';
import { useEscapeKey } from '../../composables/useEscapeKey.js';

const props = defineProps({
  label: { type: String, default: '' },
  name: { type: String, default: '' },
  text: { type: String, default: '' },
  projectId: { type: String, default: '' },
  exitCode: { type: Number, default: null },
  running: { type: Boolean, default: false },
  batchTasks: { type: Array, default: () => [] },
  batchProgress: { type: Number, default: 0 },
  completedCount: { type: Number, default: 0 },
});
const emit = defineEmits(['close', 'diagnose']);
const failed = computed(() => {
  if (props.exitCode != null && props.exitCode !== 0) return true;
  return /(fatal|error|crash|exception|failed|failed to|error:|exited with code)/i.test(props.text);
});
useEscapeKey({ active: computed(() => true), onClose: () => emit('close'), layer: 'drawer', lockBody: true });
function statusLabel(status) { return ({ pending: '等待', running: '执行中', success: '成功', failed: '失败' })[status] || status; }
</script>
