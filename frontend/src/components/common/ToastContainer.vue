<template>
  <div class="toast-container pointer-events-none fixed bottom-6 right-6 z-70 flex w-[min(22rem,calc(100vw-3rem))] flex-col gap-2">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts.visible"
        :key="toast.id"
        class="pointer-events-auto relative flex items-center gap-2.5 rounded-lg border border-surface-700/80 bg-surface-900/95 p-3 text-xs text-surface-100 shadow-xl backdrop-blur-xs"
        role="status"
        :aria-live="toast.type === 'error' ? 'assertive' : 'polite'"
        @mouseenter="toasts.pause(toast.id)"
        @mouseleave="resumeWhenIdle($event, toast)"
        @focusin="toasts.pause(toast.id)"
        @focusout="resumeWhenIdle($event, toast)"
      >
        <span class="shrink-0" :class="toneFor(toast.type).icon">
          <component :is="iconFor(toast.type)" class="h-4 w-4" />
        </span>
        <div class="min-w-0 flex-1 leading-relaxed wrap-break-word"><p>{{ toast.message }}</p><details v-if="toast.details" class="mt-2" @toggle="toggleDetails($event, toast)"><summary class="cursor-pointer text-surface-300">查看原始详情</summary><pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-950 p-2 text-[11px]">{{ toast.details }}</pre></details></div>
        <button
          class="icon-btn shrink-0 icon-btn-sm"
          title="关闭"
          aria-label="关闭提示"
          @click="toasts.dismiss(toast.id)"
        >
          <X class="h-3.5 w-3.5" />
        </button>
        <!-- 精致进度条：离场时冻结不动 -->
        <span
          v-if="!toast.leaving"
          class="pointer-events-none absolute inset-x-0 bottom-0 h-px origin-left overflow-hidden rounded-full"
          :style="{ animation: `toast-bar ${dur(toast)}ms linear forwards` }"
        >
          <span class="block h-full w-full" :class="toneFor(toast.type).bar"></span>
        </span>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-vue-next';
import { useToastStore } from '../../stores/toast.js';

const toasts = useToastStore();
const DEFAULT = 3500;

const ICONS = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle };
function iconFor(type) { return ICONS[type] || Info; }
function resumeWhenIdle(event, toast) {
  const element = event.currentTarget;
  if (toast.detailsOpen || element.contains(event.relatedTarget) || element.contains(document.activeElement) || element.matches(':hover')) return;
  toasts.resume(toast.id, toast.duration);
}
function toggleDetails(event, toast) {
  toast.detailsOpen = event.target.open;
  if (toast.detailsOpen) toasts.pause(toast.id);
  else if (!event.target.closest('[role="status"]')?.matches(':hover, :focus-within')) toasts.resume(toast.id, toast.duration);
}
function dur(toast) { return toast.duration || DEFAULT; }

const TONES = {
  success: { icon: 'text-status-ok', bar: 'bg-status-ok shadow-glow-emerald' },
  error: { icon: 'text-status-error', bar: 'bg-status-error shadow-glow-rose' },
  info: { icon: 'text-status-info', bar: 'bg-accent shadow-glow-accent' },
  warning: { icon: 'text-status-warn', bar: 'bg-status-warn' },
};
function toneFor(type) { return TONES[type] || TONES.info; }
</script>

<style scoped>
.toast-enter-active,
.toast-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translateX(1rem); }
.toast-move { transition: transform 0.2s ease; }
</style>
