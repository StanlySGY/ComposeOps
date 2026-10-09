<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="show" class="modal-backdrop" @click.self="!closeDisabled && emit('close')" @keydown="trapTab">
        <Transition name="modal-pop" appear>
          <div class="modal" :class="sizeClass" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
            <div class="modal-header">
              <span class="truncate">{{ title }}</span>
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
import { computed, nextTick, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { useEscapeKey } from '../../composables/useEscapeKey.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  title: { type: String, default: '' },
  // 覆盖 .modal 默认宽度(utilities 层级高于 components 层,可生效)
  sizeClass: { type: String, default: '' },
  bodyClass: { type: String, default: 'p-3' },
  closeDisabled: { type: Boolean, default: false },
});

const emit = defineEmits(['close']);

useEscapeKey({
  active: computed(() => props.show),
  onClose: () => { if (!props.closeDisabled) emit('close'); },
  layer: 'modal',
  lockBody: true,
});

let previousFocus = null;
function focusableIn(root) {
  return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
}
function trapTab(event) {
  if (event.key !== 'Tab') return;
  const modal = event.currentTarget.querySelector('.modal');
  if (!modal) return;
  const focusables = focusableIn(modal);
  if (!focusables.length) { event.preventDefault(); modal.focus(); return; }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
watch(() => props.show, async (visible) => {
  if (visible) {
    previousFocus = document.activeElement;
    await nextTick();
    const modal = document.querySelector('.modal-backdrop .modal');
    if (!modal) return;
    const focusables = focusableIn(modal);
    (focusables[0] || modal).focus({ preventScroll: true });
  } else if (previousFocus && document.contains(previousFocus)) {
    previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }
});
</script>
