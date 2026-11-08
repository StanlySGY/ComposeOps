<template>
  <section v-if="items.length" class="pending-queue" :class="{ paused }" aria-label="待发送消息">
    <div class="pending-queue-head">
      <button type="button" class="pending-queue-toggle" :aria-expanded="expanded" @click="expanded = !expanded">
        <Pause v-if="paused" class="h-3.5 w-3.5" /><ListOrdered v-else class="h-3.5 w-3.5" />
        <span>{{ paused ? '队列已暂停' : '接下来发送' }}<b>{{ items.length }}</b></span>
        <ChevronDown class="h-3.5 w-3.5 pending-chevron" :class="{ expanded }" />
      </button>
      <button v-if="paused" type="button" class="pending-resume" :disabled="busy" @click="$emit('resume')"><Play class="h-3 w-3" />恢复队列</button>
    </div>
    <p class="pending-queue-hint" role="status">{{ paused ? '内容已保留，恢复后按顺序发送。' : '当前回复结束后按顺序发送，可提前移除。' }}</p>
    <ol v-if="expanded" class="pending-queue-list">
      <li v-for="(item, index) in items" :key="item.id">
        <span class="pending-number">{{ index + 1 }}</span><p>{{ item.text }}</p>
        <button type="button" :aria-label="`移除第 ${index + 1} 条待发送消息`" title="移除待发送消息" @click="$emit('remove', item.id)"><X class="h-3.5 w-3.5" /></button>
      </li>
    </ol>
  </section>
</template>
<script setup>
import { ref, watch } from 'vue';
import { ChevronDown, ListOrdered, Pause, Play, X } from 'lucide-vue-next';
const props = defineProps({ items: { type: Array, default: () => [] }, paused: Boolean, busy: Boolean });
defineEmits(['resume', 'remove']);
const expanded = ref(props.paused);
watch(() => props.paused, paused => { if (paused) expanded.value = true; });
</script>
<style scoped>
.pending-queue { margin-bottom: 10px; padding: 9px 10px; border: 1px solid rgb(74 104 97 / .5); border-radius: 10px; background: linear-gradient(115deg, rgb(32 65 54 / .26), rgb(16 22 30 / .5)); }
.pending-queue.paused { border-color: rgb(161 126 53 / .45); background: linear-gradient(115deg, rgb(92 65 21 / .2), rgb(16 22 30 / .5)); }
.pending-queue-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; }
.pending-queue-toggle { display: inline-flex; align-items: center; gap: 7px; color: #b7e4d0; text-align: left; font-size: 12px; }
.paused .pending-queue-toggle { color: #e9c986; }.pending-queue-toggle span { display: inline-flex; align-items: center; gap: 7px; }.pending-queue-toggle b { display: grid; min-width: 19px; height: 19px; place-items: center; border-radius: 5px; background: rgb(255 255 255 / .06); font-size: 10px; font-variant-numeric: tabular-nums; }
.pending-chevron { transition: transform .16s ease; }.pending-chevron.expanded { transform: rotate(180deg); }.pending-queue-hint { margin: 4px 0 0; color: #a6adb7; font-size: 11px; line-height: 1.6; }
.pending-resume { display: inline-flex; align-items: center; gap: 5px; min-height: 30px; padding: 3px 7px; border-radius: 6px; color: #e9c986; font-size: 11px; }.pending-resume:hover:not(:disabled) { background: rgb(233 201 134 / .1); }.pending-resume:disabled { opacity: .45; }
.pending-queue-list { max-height: 146px; overflow-y: auto; margin-top: 8px; border-top: 1px solid rgb(255 255 255 / .07); }.pending-queue-list li { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0; }.pending-queue-list li + li { border-top: 1px solid rgb(255 255 255 / .05); }.pending-number { flex: 0 0 16px; padding-top: 5px; color: #7f968c; font-size: 10px; font-variant-numeric: tabular-nums; }.pending-queue-list p { min-width: 0; flex: 1; padding-top: 3px; white-space: pre-wrap; overflow-wrap: anywhere; color: #d4dae2; font-size: 12px; line-height: 1.65; }.pending-queue-list li button { display: grid; flex: 0 0 30px; height: 30px; place-items: center; border-radius: 6px; color: #a3acb9; }.pending-queue-list li button:hover { color: #fda4af; background: rgb(244 63 94 / .08); }button:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 2px; }
@media (pointer: coarse) { .pending-queue-list li button, .pending-resume, .pending-queue-toggle { min-height: 38px; }.pending-queue-list li button { flex-basis: 38px; } }
@media (prefers-reduced-motion: reduce) { .pending-chevron { transition: none; } }
</style>
