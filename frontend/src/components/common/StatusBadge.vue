<template>
  <span
    class="status-badge inline-flex items-center rounded-full border font-medium"
    :class="[data.cls, sizeCls]"
    :data-pulse="data.pulse"
    :title="data.tip || undefined"
    :aria-label="data.tip || data.label"
  >
    <span class="relative inline-flex shrink-0" :class="dotSize">
      <span v-if="data.pulse" class="status-badge-pulse absolute inset-0 rounded-full" :class="data.dot"></span>
      <span class="relative inline-flex rounded-full" :class="[data.dot, dotSize]"></span>
    </span>
    <svg v-if="showIcon && iconPath" class="h-3.5 w-3.5 shrink-0" :class="{ 'animate-spin': isSpinning }" fill="currentColor" viewBox="0 0 20 20">
      <path :d="iconPath" clip-rule="evenodd" fill-rule="evenodd" />
    </svg>
    <span v-if="showLabel" class="truncate">{{ data.label }}</span>
  </span>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  status: { type: String, default: '' },
  health: { type: String, default: '' },
  size: { type: String, default: 'sm', validator: (v) => ['sm', 'md', 'lg'].includes(v) },
  showLabel: { type: Boolean, default: true },
  showIcon: { type: Boolean, default: false },
});

const STATUS = {
  running: { label: '运行中', dot: 'bg-emerald-400', pulse: true, cls: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10 shadow-[0_0_10px_rgba(16,185,129,0.2)]', tip: '服务运行正常' },
  restarting: { label: '重启中', dot: 'bg-amber-400', pulse: true, cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10 shadow-[0_0_10px_rgba(245,158,11,0.2)]', tip: '服务正在重启' },
  paused: { label: '已暂停', dot: 'bg-sky-400', pulse: false, cls: 'text-sky-300 border-sky-500/30 bg-sky-500/10', tip: '服务已暂停' },
  stopped: { label: '已停止', dot: 'bg-surface-500', pulse: false, cls: 'text-surface-400 border-surface-700/50 bg-surface-900/60', tip: '服务已停止' },
  partial: { label: '部分异常', dot: 'bg-amber-400', pulse: false, cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10 shadow-[0_0_10px_rgba(245,158,11,0.2)]', tip: '部分容器未正常运行' },
  degraded: { label: '运行降级', dot: 'bg-rose-400', pulse: false, cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10 shadow-[0_0_10px_rgba(244,63,94,0.22)]', tip: '服务质量已降级,请检查' },
  error: { label: '异常', dot: 'bg-rose-400', pulse: false, cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10 shadow-[0_0_10px_rgba(244,63,94,0.25)]', tip: '运行异常,请检查日志' },
  queued: { label: '排队中', dot: 'bg-accent', pulse: true, cls: 'text-blue-300 border-blue-500/30 bg-blue-500/10', tip: '任务已创建,等待执行' },
  task: { label: '执行中', dot: 'bg-accent', pulse: true, cls: 'text-blue-300 border-blue-500/30 bg-blue-500/10 shadow-[0_0_10px_rgba(37,99,235,0.2)]', tip: '任务正在执行' },
  pending: { label: '等待', dot: 'bg-surface-500', pulse: false, cls: 'text-surface-400 border-surface-600/40 bg-surface-800/40', tip: '等待执行' },
  success: { label: '成功', dot: 'bg-emerald-400', pulse: false, cls: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10 shadow-[0_0_10px_rgba(16,185,129,0.2)]', tip: '执行成功' },
  failed: { label: '失败', dot: 'bg-rose-400', pulse: false, cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10 shadow-[0_0_10px_rgba(244,63,94,0.25)]', tip: '执行失败,请查看详情' },
  interrupted: { label: '已中断', dot: 'bg-amber-400', pulse: false, cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10', tip: '任务被中断' },
};

const effectiveStatus = computed(() => {
  if (props.health === 'healthy') return 'healthy';
  if (props.health === 'unhealthy') return 'unhealthy';
  return props.status;
});

const data = computed(() => {
  const st = effectiveStatus.value;
  if (st === 'healthy') {
    return { label: '健康', dot: 'bg-emerald-400', pulse: true, cls: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10 shadow-[0_0_10px_rgba(16,185,129,0.2)]', tip: '服务健康' };
  }
  if (st === 'unhealthy') {
    return { label: '不健康', dot: 'bg-rose-400', pulse: false, cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10 shadow-[0_0_10px_rgba(244,63,94,0.25)]', tip: '服务不健康,请检查' };
  }
  return STATUS[st] || { label: st || '未知', dot: 'bg-surface-600', pulse: false, cls: 'text-surface-400 border-surface-600/40 bg-surface-800/40', tip: '未知状态' };
});
const sizeCls = computed(() => {
  if (props.size === 'md') return 'px-2.5 py-1 text-xs';
  if (props.size === 'lg') return 'px-3 py-1 text-sm';
  return 'px-2 py-0.5 text-[11px]';
});
const dotSize = computed(() => {
  if (props.size === 'md') return 'h-2.5 w-2.5';
  if (props.size === 'lg') return 'h-3 w-3';
  return 'h-2 w-2';
});

const ICON_PATHS = {
  running: 'M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z',
  healthy: 'M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z',
  unhealthy: 'M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z',
  exited: 'M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z',
  dead: 'M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z',
  error: 'M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z',
  restarting: 'M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z',
  paused: 'M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z',
};
const iconPath = computed(() => ICON_PATHS[effectiveStatus.value] || '');
const isSpinning = computed(() => ['restarting', 'starting'].includes(effectiveStatus.value));
</script>
