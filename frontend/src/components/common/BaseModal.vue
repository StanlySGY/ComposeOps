<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="visible" class="modal-backdrop" @click.self="!closeDisabled && emit('close')" @keydown="trapTab">
        <Transition name="modal-pop" appear>
          <div ref="modalRef" class="modal" :class="sizeClass" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
            <div class="modal-header">
              <h2 class="m-0 truncate text-sm font-medium">{{ title }}</h2>
              <div class="flex items-center gap-1">
                <slot name="header-actions" />
                <button class="icon-btn" aria-label="关闭" :disabled="closeDisabled" @click="emit('close')"><X class="w-4 h-4" /></button>
              </div>
            </div>
            <div :class="bodyClass">
              <slot />
            </div>
            <footer v-if="$slots.footer" class="flex items-center justify-end gap-2 border-t border-surface-800 px-4 py-2.5">
              <slot name="footer" />
            </footer>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { useEscapeKey } from '../../composables/useEscapeKey.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  title: { type: String, default: '' },
  // 覆盖 .modal 默认宽度(utilities 层级高于 components 层,可生效)
  sizeClass: { type: String, default: '' },
  bodyClass: { type: String, default: 'p-3' },
  closeDisabled: { type: Boolean, default: false },
  closeOnRouteChange: { type: Boolean, default: true },
});

const emit = defineEmits(['close']);
const pageActive = ref(true);
const visible = computed(() => props.show && pageActive.value);
onActivated(() => { pageActive.value = true; });
onDeactivated(() => { pageActive.value = false; });

useEscapeKey({
  active: visible,
  closeOnRouteChange: props.closeOnRouteChange,
  onClose: () => { if (!props.closeDisabled) emit('close'); },
  layer: 'modal',
  lockBody: true,
});

const modalRef = ref(null);
let previousFocus = null;
function restoreFocus() {
  if (previousFocus && document.contains(previousFocus)) previousFocus.focus({ preventScroll: true });
  previousFocus = null;
}
onBeforeUnmount(restoreFocus);
function focusableIn(root) {
  return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.matches(':disabled') && el.offsetParent !== null);
}
function trapTab(event) {
  if (event.key !== 'Tab') return;
  const modal = event.currentTarget.querySelector('.modal');
  if (!modal) return;
  const focusables = focusableIn(modal);
  if (!focusables.length) { event.preventDefault(); modal.focus(); return; }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === modal || !modal.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
watch(visible, async (isVisible) => {
  if (isVisible) {
    previousFocus = document.activeElement;
    await nextTick();
    const modal = modalRef.value;
    if (!modal || !visible.value) return;
    const focusables = focusableIn(modal);
    (focusables[0] || modal).focus({ preventScroll: true });
  } else restoreFocus();
}, { immediate: true });
</script>
