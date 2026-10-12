<template>
  <div class="log-pane" :class="{ 'log-pane-single': !heading }" :data-container-id="containerId || undefined">
    <!-- 分栏模式下每栏自带标题:容器徽章 + 本栏计数,避免多栏共用一条统计行。 -->
    <div v-if="heading" class="log-pane-head">
      <span class="container-badge" :class="badgeClass">{{ heading }}</span>
      <span class="text-[11px] text-muted tabular-nums">{{ lines.length }} 条</span>
      <span v-if="paneErrorCount" class="text-[11px] text-rose-400">ERROR {{ paneErrorCount }}</span>
    </div>
    <div ref="boxEl" class="terminal-output card log-pane-body" @scroll="onScroll" @wheel="onWheel">
      <template v-if="lines.length">
        <div :style="{ height: scrollPadTop + 'px' }" aria-hidden="true"></div>
        <!-- 单容器与聚合共用 LogLine:单容器流的帧里没有 containerName,由 fallback-name 补上徽章。 -->
        <LogLine v-for="line in visibleLines" :key="line.id" :line="line" :fallback-name="fallbackName" />
        <div :style="{ height: scrollPadBottom + 'px' }" aria-hidden="true"></div>
      </template>
      <p v-else class="text-muted px-2 py-1">{{ emptyText }}</p>
    </div>
    <button v-if="connected && autoScrollPaused && !paused" class="scroll-resume-chip" @click="resume">已暂停自动滚动(向上) · 点击回到底部</button>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { hashColor } from '../../lib/log-colors.js';
import LogLine from './LogLine.vue';

const props = defineProps({
  lines: { type: Array, required: true },
  // 单容器流的帧里没有 containerName,由调用方补徽章。
  fallbackName: { type: String, default: '' },
  // 分栏标题;空串表示单栏模式,不渲染栏头。
  heading: { type: String, default: '' },
  containerId: { type: String, default: '' },
  emptyText: { type: String, default: '等待日志…' },
  autoScroll: { type: Boolean, default: true },
  connected: { type: Boolean, default: false },
  paused: { type: Boolean, default: false },
  // 调用方每追加/清空一行就 +1:行数封顶后长度不变,只能靠它驱动跟随。
  revision: { type: Number, default: 0 },
  // End 快捷键广播:调用方 +1,所有栏一起回到底部。
  resumeSignal: { type: Number, default: 0 },
});

const LINE_H = 24;
const OVERSCAN = 30;
const boxEl = ref(null);
const viewStart = ref(0);
const viewEnd = ref(0);
const autoScrollPaused = ref(false);
let followFrame = 0;
let resizeObserver;

const badgeClass = computed(() => hashColor(props.heading || props.fallbackName || ''));
const scrollPadTop = computed(() => viewStart.value * LINE_H);
const scrollPadBottom = computed(() => Math.max(0, (props.lines.length - viewEnd.value) * LINE_H));
const visibleLines = computed(() => viewEnd.value > viewStart.value ? props.lines.slice(viewStart.value, viewEnd.value) : []);
const paneErrorCount = computed(() => props.lines.reduce((sum, line) => sum + (line.level === 'error' ? 1 : 0), 0));
const followActive = computed(() => props.autoScroll && !props.paused && !autoScrollPaused.value);

function syncViewport() {
  if (!boxEl.value) return;
  const height = boxEl.value.clientHeight || 420;
  const scrollTop = boxEl.value.scrollTop;
  viewStart.value = Math.max(0, Math.floor(scrollTop / LINE_H) - OVERSCAN);
  viewEnd.value = Math.min(props.lines.length, Math.ceil((scrollTop + height) / LINE_H) + OVERSCAN);
}
/** rAF 合并的滚底调度:高频日志每帧只滚一次,避免反复强制 reflow 卡死主线程。 */
function scheduleFollow() {
  if (!followActive.value || followFrame) return;
  followFrame = requestAnimationFrame(() => {
    followFrame = 0;
    if (!boxEl.value) return;
    boxEl.value.scrollTop = boxEl.value.scrollHeight;
    syncViewport();
  });
}
function onScroll() { syncViewport(); }
function onWheel(event) {
  if (!props.connected || !props.autoScroll) return;
  if (event.deltaY < 0) { autoScrollPaused.value = true; return; }
  autoScrollPaused.value = false;
  scheduleFollow();
}
function resume() { autoScrollPaused.value = false; scheduleFollow(); }

// 行数或调用方修订号变化:能跟随就跟随,否则只重算可视区间(过滤变窄时不能强行滚底)。
watch([() => props.revision, () => props.lines.length], () => {
  if (followActive.value) scheduleFollow();
  else syncViewport();
});
watch(() => props.resumeSignal, () => { autoScrollPaused.value = false; scheduleFollow(); });

onMounted(() => {
  nextTick(syncViewport);
  if (boxEl.value && typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(syncViewport);
    resizeObserver.observe(boxEl.value);
  }
});
onBeforeUnmount(() => {
  if (followFrame) cancelAnimationFrame(followFrame);
  resizeObserver?.disconnect();
});
</script>
