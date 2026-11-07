<template>
  <div ref="root" class="action-disclosure" @focusout="onFocusOut">
    <button ref="trigger" class="btn-secondary" :aria-expanded="open" :aria-controls="panelId" @click="open = !open"><Ellipsis :size="16" />{{ label }}</button>
    <div v-if="open" :id="panelId" class="action-disclosure__panel" role="group" :aria-label="label" @click.capture="onAction"><slot /></div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onDeactivated, onMounted, ref, useId } from 'vue';
import { Ellipsis } from 'lucide-vue-next';
import { useEscapeKey } from '../../composables/useEscapeKey.js';
defineProps({ label: { type: String, default: '更多操作' } });
const open = ref(false);
const root = ref(null);
const trigger = ref(null);
const panelId = useId();
function close(restoreFocus = false) { open.value = false; if (restoreFocus) trigger.value?.focus(); }
function onOutside(event) { if (!root.value?.contains(event.target)) close(); }
function onFocusOut(event) { if (event.relatedTarget && !root.value?.contains(event.relatedTarget)) close(); }
function onAction(event) { if (event.target.closest('a[href], button:not(:disabled)')) close(true); }
useEscapeKey({ active: open, onClose: () => close(true), layer: 'event' });
onMounted(() => document.addEventListener('pointerdown', onOutside));
onDeactivated(() => close());
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside));
</script>

<style scoped>
.action-disclosure { position: relative; }
.action-disclosure__panel { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: 220px; max-width: calc(100vw - 48px); padding: 6px; background: var(--panel-raised); border: 1px solid var(--line-hover); border-radius: 10px; box-shadow: 0 12px 40px #0006; }
.action-disclosure__panel :deep(button), .action-disclosure__panel :deep(a) { display: flex; align-items: center; justify-content: flex-start; gap: 9px; width: 100%; min-height: 40px; padding: 9px 10px; border-radius: 6px; font-size: 12px; }
.action-disclosure__panel :deep(button:hover:not(:disabled)), .action-disclosure__panel :deep(a:hover) { background: #ffffff09; }
.action-disclosure__panel :deep(button:disabled) { opacity: .4; cursor: not-allowed; }
.action-disclosure__panel :deep(hr) { margin: 5px 3px; border-color: var(--line-subtle); }
</style>
