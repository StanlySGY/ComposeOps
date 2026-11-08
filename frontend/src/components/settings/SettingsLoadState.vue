<template>
  <div v-if="state.loading || !state.ready || state.error" :data-settings-load="name" class="settings-load-state" :class="{ 'has-error': state.error }" :role="state.error ? 'alert' : 'status'" aria-live="polite">
    <component :is="state.error ? CircleAlert : LoaderCircle" class="h-4 w-4 shrink-0" :class="{ 'animate-spin': state.loading }" aria-hidden="true" />
    <span class="min-w-0 flex-1">{{ state.error ? `读取${label}失败：${state.error}` : `正在读取${label}…` }}</span>
    <button v-if="state.error" type="button" class="btn-secondary btn-sm" :aria-label="`重新读取${label}`" :disabled="state.loading" @click="$emit('retry')">重试</button>
  </div>
</template>

<script setup>
import { CircleAlert, LoaderCircle } from 'lucide-vue-next';
defineProps({ state: { type: Object, required: true }, name: { type: String, required: true }, label: { type: String, required: true } });
defineEmits(['retry']);
</script>

<style scoped>
.settings-load-state { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line-subtle); border-radius: 10px; padding: 12px 14px; color: var(--color-surface-300); background: var(--panel-surface); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.settings-load-state.has-error { color: var(--color-status-warn); border-color: rgba(251,191,36,.3); }
@media (prefers-reduced-motion: reduce) { .settings-load-state svg { animation: none; } }
</style>
