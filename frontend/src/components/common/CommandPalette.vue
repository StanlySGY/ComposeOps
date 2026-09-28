<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="show" class="modal-backdrop z-60" @click.self="close">
        <Transition name="modal-pop" appear>
          <div class="command-palette">
            <div class="command-input-wrapper">
              <Search class="h-4 w-4 text-surface-500" />
              <input
                ref="inputRef"
                v-model="query"
                type="text"
                placeholder="搜索命令..."
                class="command-input"
                @keydown.down.prevent="selectNext"
                @keydown.up.prevent="selectPrev"
                @keydown.enter.prevent="executeSelected"
                @keydown.esc="close"
              />
            </div>
            <div v-if="filtered.length" class="command-list">
              <div
                v-for="(item, idx) in filtered"
                :key="item.id"
                class="command-item"
                :class="{ selected: idx === selected }"
                @click="execute(item)"
                @mouseenter="selected = idx"
              >
                <component :is="item.icon" class="h-4 w-4 shrink-0" :class="item.iconClass || 'text-cyan-400'" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-surface-200">{{ item.label }}</p>
                  <p v-if="item.description" class="truncate text-xs text-surface-500">{{ item.description }}</p>
                </div>
                <kbd v-if="item.shortcut" class="shortcut-key text-[10px]">{{ item.shortcut }}</kbd>
              </div>
            </div>
            <div v-else class="px-4 py-8 text-center text-sm text-surface-500">
              未找到匹配的命令
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Search } from 'lucide-vue-next';
import { useEscapeKey } from '../../composables/useEscapeKey.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  commands: { type: Array, default: () => [] },
});

const emit = defineEmits(['close', 'execute']);

const query = ref('');
const selected = ref(0);
const inputRef = ref(null);

const filtered = computed(() => {
  const q = query.value.toLowerCase().trim();
  if (!q) return props.commands;
  return props.commands.filter((cmd) => {
    const label = cmd.label?.toLowerCase() || '';
    const desc = cmd.description?.toLowerCase() || '';
    const category = cmd.category?.toLowerCase() || '';
    return label.includes(q) || desc.includes(q) || category.includes(q);
  });
});

watch(() => props.show, async (show) => {
  if (show) {
    query.value = '';
    selected.value = 0;
    await nextTick();
    inputRef.value?.focus();
  }
});

watch(filtered, () => {
  if (selected.value >= filtered.value.length) {
    selected.value = Math.max(0, filtered.value.length - 1);
  }
});

function selectNext() {
  if (filtered.value.length === 0) return;
  selected.value = (selected.value + 1) % filtered.value.length;
}

function selectPrev() {
  if (filtered.value.length === 0) return;
  selected.value = selected.value === 0 ? filtered.value.length - 1 : selected.value - 1;
}

function executeSelected() {
  if (filtered.value.length === 0) return;
  execute(filtered.value[selected.value]);
}

function execute(item) {
  emit('execute', item);
  close();
}

function close() {
  emit('close');
}

function onGlobalKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
    event.preventDefault();
    if (props.show) {
      close();
    } else {
      emit('close'); // 触发父组件打开
    }
  }
}

useEscapeKey({
  active: computed(() => props.show),
  onClose: close,
  layer: 'command',
  lockBody: true,
});

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown, { capture: true });
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown, { capture: true });
});
</script>

<style scoped>
@reference '../../style.css';
.command-palette {
  @apply relative mx-4 w-full max-w-xl overflow-hidden rounded-xl border border-surface-800 bg-surface-950 shadow-2xl;
}

.command-input-wrapper {
  @apply flex items-center gap-3 border-b border-surface-800 px-4 py-3;
}

.command-input {
  @apply w-full bg-transparent text-sm text-surface-100 placeholder-surface-500 outline-none;
}

.command-list {
  @apply max-h-[60vh] overflow-y-auto;
}

.command-item {
  @apply flex cursor-pointer items-center gap-3 border-b border-surface-900/50 px-4 py-3 transition-colors last:border-0;
}

.command-item:hover,
.command-item.selected {
  @apply bg-surface-900/60;
}
</style>
