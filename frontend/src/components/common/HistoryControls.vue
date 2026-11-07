<template>
  <nav class="flex flex-wrap items-center justify-between gap-3 py-3" :aria-label="`${label}分页与排序`">
    <div class="flex flex-wrap items-center gap-2">
      <select :value="sortKey" class="input input-sm" :aria-label="`${label}排序字段`" @change="$emit('update:sortKey', $event.target.value)"><option v-for="option in options" :key="option.key" :value="option.key">{{ option.label }}</option></select>
      <button class="btn-ghost btn-sm" :aria-label="`${label}：${descending ? '降序，点击升序' : '升序，点击降序'}`" @click="$emit('update:descending', !descending)"><ArrowDownWideNarrow v-if="descending" class="h-4 w-4" /><ArrowUpWideNarrow v-else class="h-4 w-4" />{{ descending ? '降序' : '升序' }}</button>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-muted tabular-nums" role="status">{{ total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}` : '0' }} / {{ total }} 条</span>
      <button class="icon-btn icon-btn-sm" :disabled="page <= 1" :aria-label="`${label}上一页`" @click="$emit('update:page', page - 1)"><ChevronLeft class="h-4 w-4" /></button>
      <span class="text-xs tabular-nums text-surface-300">{{ page }} / {{ Math.max(1, Math.ceil(total / pageSize)) }}</span>
      <button class="icon-btn icon-btn-sm" :disabled="page * pageSize >= total" :aria-label="`${label}下一页`" @click="$emit('update:page', page + 1)"><ChevronRight class="h-4 w-4" /></button>
    </div>
  </nav>
</template>
<script setup>
import { ArrowDownWideNarrow, ArrowUpWideNarrow, ChevronLeft, ChevronRight } from 'lucide-vue-next';
defineProps({ page: { type: Number, default: 1 }, pageSize: { type: Number, default: 20 }, total: { type: Number, default: 0 }, sortKey: String, descending: Boolean, options: { type: Array, default: () => [] }, label: { type: String, default: '历史记录' } });
defineEmits(['update:page', 'update:sortKey', 'update:descending']);
</script>
