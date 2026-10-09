<template>
  <BaseModal :show="show" :title="title" :size-class="sizeClass" body-class="p-4 space-y-3" :close-disabled="busy" @close="$emit('cancel')">
    <div class="flex items-start gap-3">
      <div
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
        :class="tone.box"
      >
        <component :is="tone.icon" class="h-5 w-5" :class="tone.text" />
      </div>
      <div class="min-w-0 flex-1 space-y-1.5">
        <p class="text-sm leading-relaxed text-surface-200">{{ message }}</p>
        <slot />
      </div>
    </div>
    <template #footer>
      <button class="btn-ghost" :disabled="busy" @click="emit('cancel')">{{ cancelText }}</button>
      <button class="btn" :class="tone.btn" :disabled="busy" @click="$emit('confirm')">
        <Loader2 v-if="busy" class="h-4 w-4 animate-spin" />
        <component v-else :is="tone.icon" class="h-4 w-4" />
        {{ confirmText }}
      </button>
    </template>
  </BaseModal>
</template>

<script setup>
import { computed } from 'vue';
import { AlertTriangle, Info, Loader2, ShieldAlert } from 'lucide-vue-next';
import BaseModal from './BaseModal.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  title: { type: String, default: '确认操作' },
  message: { type: String, default: '' },
  // danger: 红色警示(不可逆/删除类); warning: 琥珀警示; info: 中性提示
  tone: { type: String, default: 'info', validator: (v) => ['info', 'warning', 'danger'].includes(v) },
  confirmText: { type: String, default: '确认' },
  cancelText: { type: String, default: '取消' },
  sizeClass: { type: String, default: 'sm:max-w-md' },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(['confirm', 'cancel']);

const TONES = {
  info: { icon: Info, text: 'text-sky-300', box: 'border-sky-900/50 bg-sky-950/40', btn: 'btn-primary' },
  warning: { icon: AlertTriangle, text: 'text-amber-300', box: 'border-amber-900/50 bg-amber-950/40', btn: 'btn-primary' },
  danger: { icon: ShieldAlert, text: 'text-rose-300', box: 'border-rose-900/50 bg-rose-950/40', btn: 'btn-danger' },
};

const tone = computed(() => TONES[props.tone] || TONES.info);
</script>
