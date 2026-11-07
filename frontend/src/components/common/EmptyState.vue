<template>
  <div
    class="empty-state flex w-full flex-col items-center justify-center gap-3 text-center"
    :class="compact ? 'min-h-32 px-4 py-6' : 'min-h-44 px-6 py-10'"
  >
    <div
      class="empty-icon grid place-items-center rounded-2xl border border-surface-700/60 bg-surface-950/40"
      :class="compact ? 'h-10 w-10' : 'h-14 w-14'"
    >
      <component :is="iconComp" class="h-6 w-6" :class="iconClass" aria-hidden="true" />
    </div>
    <div class="space-y-1">
      <p class="text-sm font-medium text-surface-300">{{ title }}</p>
      <p v-if="description" class="mx-auto max-w-sm text-xs leading-5 text-surface-400">{{ description }}</p>
    </div>
    <slot />
    <button v-if="actionLabel" class="btn-primary" type="button" :disabled="actionDisabled" @click="$emit('action')">
      <component :is="actionIconComp" class="h-4 w-4" aria-hidden="true" />{{ actionLabel }}
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { Activity, Bell, BellRing, Layers, Network, ShieldCheck, Bot, Boxes, CircleCheckBig, FileClock, FileCode2, FolderCog, History, Inbox, ListChecks, RefreshCw, Search } from 'lucide-vue-next';

const ICONS = { Activity, Bell, BellRing, Layers, Network, ShieldCheck, Bot, Boxes, CircleCheckBig, FileClock, FileCode2, FolderCog, History, Inbox, ListChecks, RefreshCw, Search };

const props = defineProps({
  icon: { type: [Object, Function, String], default: 'Inbox' },
  iconClass: { type: String, default: 'text-surface-400' },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  actionLabel: { type: String, default: '' },
  actionIcon: { type: [Object, Function, String], default: null },
  actionDisabled: Boolean,
  compact: Boolean,
});
defineEmits(['action']);

const iconComp = computed(() => {
  if (typeof props.icon === 'string') return ICONS[props.icon] || Object.entries(ICONS).find(([name]) => name.toLowerCase() === props.icon.toLowerCase())?.[1] || Inbox;
  return props.icon || Inbox;
});
const actionIconComp = computed(() => {
  if (!props.actionIcon) return null;
  if (typeof props.actionIcon === 'string') return ICONS[props.actionIcon] || null;
  return props.actionIcon;
});
</script>
