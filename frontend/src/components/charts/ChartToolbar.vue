<template>
  <div class="chart-toolbar" @keydown="onToolbarKeydown">
    <div class="chart-controls" role="group" aria-label="图表类型与导出">
      <button v-for="type in chartTypes" :key="type.key"
              @click="$emit('update:modelValue', type.key)"
              :class="['chart-type-btn', modelValue === type.key && 'active']"
              :aria-pressed="modelValue === type.key"
              :title="type.label" :aria-label="type.label">
        <component :is="type.icon" class="w-4 h-4" />
      </button>

      <!-- Export button with dropdown -->
      <div class="export-dropdown" ref="exportDropdownRef" @focusout="onFocusOut">
        <button ref="exportButton" @click="toggleExportMenu" @keydown.down.prevent="openExportMenu"
                :aria-expanded="showExportMenu" :aria-controls="exportMenuId"
                :disabled="exporting" :aria-busy="exporting"
                class="chart-type-btn export-btn"
                title="导出数据" aria-label="导出数据">
          <Loader2 v-if="exporting" class="w-4 h-4 animate-spin" /><Download v-else class="w-4 h-4" />
        </button>
        <div v-if="showExportMenu" :id="exportMenuId" ref="exportMenu" class="export-menu" role="group" aria-label="图表导出格式">
          <button @click="emitExport('csv')" class="export-menu-item">
            <FileText class="w-4 h-4" />
            <span>导出 CSV</span>
          </button>
          <button @click="emitExport('png')" class="export-menu-item">
            <Image class="w-4 h-4" />
            <span>导出 PNG</span>
          </button>
        </div>
      </div>
    </div>
    <div class="chart-stats">
      <span class="stat-item">最小: <strong>{{ stats.min }}</strong></span>
      <span class="stat-item">平均: <strong>{{ stats.avg }}</strong></span>
      <span class="stat-item">最大: <strong>{{ stats.max }}</strong></span>
      <span class="stat-item current">当前: <strong>{{ stats.current }}</strong></span>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { Download, FileText, Image, Loader2 } from 'lucide-vue-next';

defineProps({
  modelValue: { type: String, default: 'area' },
  chartTypes: { type: Array, required: true },
  stats: { type: Object, required: true },
  exporting: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'export']);

const showExportMenu = ref(false);
const exportDropdownRef = ref(null);
const exportButton = ref(null);
const exportMenu = ref(null);
const exportMenuId = `chart-export-${Math.random().toString(36).slice(2, 8)}`;

function toggleExportMenu() {
  if (showExportMenu.value) closeExportMenu();
  else void openExportMenu();
}
async function openExportMenu() {
  showExportMenu.value = true;
  await nextTick();
  exportMenu.value?.querySelector('button')?.focus({ preventScroll: true });
}
function closeExportMenu(restoreFocus = false) {
  if (!showExportMenu.value) return;
  showExportMenu.value = false;
  if (restoreFocus) exportButton.value?.focus({ preventScroll: true });
}
function onFocusOut(event) {
  if (event.relatedTarget && !exportDropdownRef.value?.contains(event.relatedTarget)) closeExportMenu();
}
function onToolbarKeydown(event) {
  if (event.key !== 'Escape' || !showExportMenu.value) return;
  event.preventDefault();
  event.stopPropagation();
  closeExportMenu(true);
}
function emitExport(format) {
  closeExportMenu(true);
  emit('export', format);
}

function handleClickOutside(event) {
  if (exportDropdownRef.value && !exportDropdownRef.value.contains(event.target)) {
    closeExportMenu();
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside);
});
</script>

<style scoped>
.chart-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: .85rem;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--color-surface-800);
}

.chart-controls {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.chart-type-btn {
  padding: 0.5rem;
  border-radius: 0.375rem;
  background: var(--color-surface-900);
  border: 1px solid var(--color-surface-800);
  color: var(--color-surface-400);
  cursor: pointer;
  transition: background .2s, color .2s, border-color .2s;
}

.chart-type-btn:hover {
  background: var(--color-surface-800);
  color: var(--color-surface-100);
}

.chart-type-btn.active {
  background: rgb(16 185 129 / 12%);
  border-color: rgb(52 211 153 / 45%);
  color: var(--color-accent);
}
.chart-type-btn:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

.chart-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  flex: 1 1 16rem;
  gap: .75rem;
  min-width: 0;
  font-size: 0.75rem;
}

.stat-item {
  color: var(--color-surface-400);
  min-width: 0;
  overflow-wrap: anywhere;
}

.stat-item strong {
  display: block;
  margin-top: .25rem;
  font-variant-numeric: tabular-nums;
  color: var(--color-surface-100);
}

.stat-item.current strong {
  color: var(--color-accent);
}

.export-dropdown {
  position: relative;
}

.export-btn {
  display: flex;
  align-items: center;
  justify-content: center;
}

.export-menu {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  min-width: 10rem;
  background: var(--color-surface-900);
  border: 1px solid var(--color-surface-700);
  border-radius: 0.375rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 20;
  overflow: hidden;
}

.export-menu-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.75rem 1rem;
  background: transparent;
  border: none;
  color: var(--color-surface-100);
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
  transition: background 0.2s;
}

.export-menu-item:hover {
  background: var(--color-surface-800);
}

.export-icon {
  font-size: 1rem;
  line-height: 1;
}
@media (prefers-reduced-motion: reduce) { .chart-type-btn, .export-menu-item { transition: none; } }
</style>
