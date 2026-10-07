<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="show" class="modal-backdrop z-60" @click.self="close">
        <Transition name="modal-pop" appear>
          <div ref="dialogRef" class="command-palette" role="dialog" aria-modal="true" aria-label="快速跳转与操作" @keydown.tab.prevent="moveFocus">
            <div class="command-input-wrapper">
              <Search class="h-4 w-4 text-surface-500" />
              <input
                ref="inputRef"
                v-model="query"
                type="text"
                placeholder="搜索页面、项目或操作,支持多个关键词…"
                class="command-input"
                role="combobox"
                aria-label="搜索命令"
                aria-autocomplete="list"
                aria-expanded="true"
                :aria-controls="listId"
                :aria-activedescendant="filtered.length ? `${listId}-${selected}` : undefined"
                autocomplete="off"
                @keydown.down.prevent="selectNext"
                @keydown.up.prevent="selectPrev"
                @keydown.enter="executeSelected"
              />
              <button v-if="query" class="text-xs text-surface-400 hover:text-surface-100 whitespace-nowrap" aria-label="清空搜索" @click="clearQuery">清空</button>
              <button class="shortcut-key text-[10px]" aria-label="关闭命令面板" @click="close">Esc</button>
            </div>
            <div :id="listId" ref="listRef" class="command-list" role="listbox" aria-label="匹配命令">
              <div
                v-for="(item, idx) in filtered"
                :key="item.id"
                :id="`${listId}-${idx}`"
                :data-command-index="idx"
                role="option"
                :aria-selected="idx === selected"
                class="command-item"
                :class="{ selected: idx === selected }"
                @click="execute(item)"
                @mousemove="selected = idx"
              >
                <component :is="item.icon" class="h-4 w-4 shrink-0" :class="item.iconClass || 'text-cyan-400'" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-surface-200">{{ item.label }}</p>
                  <p v-if="item.description" class="truncate text-xs text-surface-500">{{ item.description }}</p>
                </div>
                <kbd v-if="item.shortcut" class="shortcut-key text-[10px]">{{ item.shortcut }}</kbd>
              </div>
            </div>
            <div v-if="!filtered.length" class="px-4 py-8 text-center text-sm text-surface-500">
              未找到匹配的命令,试试项目名、日志或监控
            </div>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-surface-800 px-4 py-2 text-[11px] text-surface-400">
              <span><kbd>↑ ↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span>
              <span class="ml-auto" role="status" aria-live="polite">{{ resultSummary }}</span>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { Search } from 'lucide-vue-next';
import { useEscapeKey } from '../../composables/useEscapeKey.js';
import { searchCommands } from '../../lib/command-search.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  commands: { type: Array, default: () => [] },
});

const emit = defineEmits(['close', 'execute']);

const query = ref('');
const selected = ref(0);
const inputRef = ref(null);
const listRef = ref(null);
const dialogRef = ref(null);
const listId = `command-list-${useId()}`;
let previousFocus = null;

const allMatches = computed(() => searchCommands(props.commands, query.value));
const filtered = computed(() => query.value.trim() ? allMatches.value : allMatches.value.slice(0, 10));
const resultSummary = computed(() => query.value.trim()
  ? `${allMatches.value.length} 个结果`
  : `${filtered.value.length} 个常用入口 · 共 ${allMatches.value.length} 个命令`);

watch(() => props.show, async (show) => {
  if (show) {
    previousFocus = document.activeElement;
    query.value = '';
    selected.value = 0;
    await nextTick();
    if (props.show) inputRef.value?.focus();
  } else restoreFocus();
}, { immediate: true });

watch(filtered, () => { selected.value = 0; });
watch([selected, filtered], () => {
  listRef.value?.querySelector(`[data-command-index="${selected.value}"]`)?.scrollIntoView?.({ block: 'nearest' });
}, { flush: 'post' });

function selectNext() {
  if (filtered.value.length === 0) return;
  selected.value = (selected.value + 1) % filtered.value.length;
}

function selectPrev() {
  if (filtered.value.length === 0) return;
  selected.value = selected.value === 0 ? filtered.value.length - 1 : selected.value - 1;
}

function executeSelected(event) {
  if (event?.isComposing || event?.keyCode === 229) return;
  event?.preventDefault();
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

function clearQuery() { query.value = ''; inputRef.value?.focus(); }
function restoreFocus() {
  if (previousFocus?.isConnected) previousFocus.focus();
  previousFocus = null;
}
function moveFocus(event) {
  const elements = Array.from(dialogRef.value?.querySelectorAll('input, button') || []);
  const index = elements.indexOf(document.activeElement);
  elements[(index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length]?.focus();
}

useEscapeKey({
  active: computed(() => props.show),
  onClose: close,
  layer: 'command',
  lockBody: true,
});

onBeforeUnmount(restoreFocus);
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
  @apply min-w-0 w-full bg-transparent text-sm text-surface-100 placeholder-surface-500 outline-none;
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
