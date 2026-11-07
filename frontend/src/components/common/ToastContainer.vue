<template>
  <div class="toast-container pointer-events-none fixed bottom-6 right-6 z-70 flex w-[min(22rem,calc(100vw-3rem))] flex-col gap-2">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts.visible"
        :key="toast.id"
        class="toast-card pointer-events-auto relative flex items-center gap-2.5 overflow-hidden rounded-lg border border-surface-700/80 bg-surface-900/95 p-3 text-xs text-surface-100 shadow-xl backdrop-blur-xs"
        role="status"
        :aria-live="toast.type === 'error' ? 'assertive' : 'polite'"
        aria-atomic="true"
        @mouseenter="toasts.pause(toast.id, 'hover')"
        @mouseleave="toasts.resume(toast.id, 'hover')"
        @focusin="toasts.pause(toast.id, 'focus')"
        @focusout="onFocusOut($event, toast.id)"
        @pointerdown="toasts.pause(toast.id, 'pointer')"
        @pointerup="toasts.resume(toast.id, 'pointer')"
        @pointercancel="toasts.resume(toast.id, 'pointer')"
        @pointerleave="toasts.resume(toast.id, 'pointer')"
      >
        <span class="shrink-0" :class="toneFor(toast.type).icon">
          <component :is="iconFor(toast.type)" class="h-4 w-4" />
        </span>
        <div class="min-w-0 flex-1 leading-relaxed wrap-break-word"><p>{{ toast.message }}</p><details v-if="toast.details" class="mt-2" @toggle="toggleDetails($event, toast)"><summary class="cursor-pointer text-surface-300">查看原始详情</summary><pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-950 p-2 text-[11px]">{{ toast.details }}</pre></details></div>
        <button
          class="icon-btn shrink-0 icon-btn-sm"
          title="关闭"
          aria-label="关闭提示"
          @click="dismiss($event, toast.id)"
        >
          <X class="h-3.5 w-3.5" />
        </button>
        <span
          v-if="toast.duration > 0"
          :key="toast.displayId"
          aria-hidden="true"
          class="toast-progress pointer-events-none absolute inset-x-0 bottom-0 h-px origin-left overflow-hidden rounded-full"
          :style="{ animation: `toast-bar ${toast.displayDuration}ms linear forwards`, animationPlayState: toast.paused ? 'paused' : 'running', '--toast-progress-start': toast.displayDuration / toast.duration }"
        >
          <span class="block h-full w-full" :class="toneFor(toast.type).bar"></span>
        </span>
      </div>
    </TransitionGroup>
    <span v-if="toasts.queuedCount" class="self-end rounded-full border border-surface-700/60 bg-surface-950/95 px-2 py-0.5 text-[10px] text-surface-400">还有 {{ toasts.queuedCount }} 条提示</span>
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted } from 'vue';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-vue-next';
import { useToastStore } from '../../stores/toast.js';

const toasts = useToastStore();
let previousFocus = null;
let narrowViewport;
function rememberFocus(event) {
  if (!event.target.closest?.('.toast-container')) previousFocus = event.target;
}
function onFocusOut(event, id) {
  if (!event.currentTarget.contains(event.relatedTarget)) toasts.resume(id, 'focus');
}
async function dismiss(event, id) {
  const hadFocus = event.currentTarget === document.activeElement;
  toasts.dismiss(id);
  if (hadFocus) {
    await nextTick();
    const next = document.querySelector('.toast-card:not(.toast-leave-active) button');
    if (next) next.focus({ preventScroll: true });
    else if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
}
function syncVisibility() { toasts.setHidden(document.hidden); }
function syncViewport() { toasts.setVisibleLimit(narrowViewport?.matches ? 1 : 3); }
onMounted(() => {
  previousFocus = document.activeElement;
  narrowViewport = window.matchMedia?.('(max-width: 639px)');
  syncViewport();
  narrowViewport?.addEventListener('change', syncViewport);
  syncVisibility();
  document.addEventListener('visibilitychange', syncVisibility);
  document.addEventListener('focusin', rememberFocus);
});
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', syncVisibility);
  document.removeEventListener('focusin', rememberFocus);
  narrowViewport?.removeEventListener('change', syncViewport);
  toasts.clear();
});

const ICONS = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle };
function iconFor(type) { return ICONS[type] || Info; }
function toggleDetails(event, toast) {
  toast.detailsOpen = event.target.open;
  if (toast.detailsOpen) toasts.pause(toast.id, 'details');
  else toasts.resume(toast.id, 'details');
}

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
@media (prefers-reduced-motion: reduce) {
  .toast-enter-active, .toast-leave-active, .toast-move { transition: none; }
  .toast-progress { display: none; }
}
</style>
