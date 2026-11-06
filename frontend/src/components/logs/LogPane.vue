<template>
  <div class="log-pane" :class="{ 'log-pane-single': !heading }" :data-container-id="containerId || undefined">
    <!-- 分栏模式下每栏自带标题:容器徽章 + 本栏计数,避免多栏共用一条统计行。 -->
    <div v-if="heading" class="log-pane-head">
      <span class="container-badge" :class="badgeClass">{{ heading }}</span>
      <span class="text-[11px] text-muted tabular-nums">{{ lines.length }} 条</span>
      <span v-if="paneErrorCount" class="text-[11px] text-rose-400">ERROR {{ paneErrorCount }}</span>
    </div>
    <div ref="boxEl" class="terminal-output card log-pane-body" role="region" :aria-label="`${heading || fallbackName || '容器'}实时日志`" tabindex="0" aria-live="off" @scroll="onScroll" @wheel.passive="onWheel" @touchstart.passive="startTouch" @touchend.passive="endTouch" @touchcancel.passive="endTouch" @keydown="onKeydown">
      <template v-if="lines.length">
        <div :style="{ height: scrollPadTop + 'px' }" aria-hidden="true"></div>
        <!-- 单容器与聚合共用 LogLine:单容器流的帧里没有 containerName,由 fallback-name 补上徽章。 -->
        <div v-for="line in visibleLines" :key="line.id" :ref="el => observeRow(line.id, el)" :data-log-id="line.id">
          <LogLine :line="line" :fallback-name="fallbackName" :expanded="(expandedIds || localExpanded).has(line.id)" @toggle-json="value => toggleJson(line.id, value)" />
        </div>
        <div :style="{ height: scrollPadBottom + 'px' }" aria-hidden="true"></div>
      </template>
      <p v-else class="text-muted px-2 py-1">{{ emptyText }}</p>
    </div>
    <p v-if="historyExpired" class="log-history-notice" role="status">正在阅读的日志已超出保留范围，已定位到最早保留的日志。<button aria-label="关闭日志保留范围提示" @click="historyExpired = false">关闭</button></p>
    <button v-if="autoScroll && autoScrollPaused && !paused" class="scroll-resume-chip" @click="resume"><ArrowDown :size="14" />{{ unreadCount ? `${unreadCount} 条新日志 · ` : '正在查看历史 · ' }}回到最新</button>
  </div>
</template>

<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue';
import { buildLogLayout, captureLogAnchor, logIndexAt, restoreLogAnchor } from '../../lib/log-layout.js';
import { hashColor } from '../../lib/log-colors.js';
import LogLine from './LogLine.vue';
import { ArrowDown } from 'lucide-vue-next';

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
  // 调用方每批追加/清空时 +1:行数封顶后仍能通知虚拟窗口。
  revision: { type: Number, default: 0 },
  // End 快捷键广播:调用方 +1,所有栏一起回到底部。
  resumeSignal: { type: Number, default: 0 },
  expandedIds: { type: Set, default: undefined },
  retainedFrom: { type: Number, default: null },
});
const emit = defineEmits(['toggle-json']);

const OVERSCAN = 12;
const heights = new Map();
const rowElements = new Map();
const elementIds = new WeakMap();
const layout = shallowRef(buildLogLayout(props.lines, heights));
const localExpanded = ref(new Set());
const historyExpired = ref(false);
const boxEl = ref(null);
const viewStart = ref(0);
const viewEnd = ref(0);
const autoScrollPaused = ref(false);
const touching = ref(false);
const seenId = ref(null);
const unreadCount = computed(() => seenId.value == null ? 0 : props.lines.filter(line => line.id > seenId.value).length);
let followFrame = 0;
let lastScrollTop = 0;
let resizeObserver;
let active = true;
let viewportWidth = 0;
let layoutChange = 0;
let adjusting = false;

const badgeClass = computed(() => hashColor(props.heading || props.fallbackName || ''));
const scrollPadTop = computed(() => layout.value.offsets[viewStart.value] || 0);
const scrollPadBottom = computed(() => Math.max(0, layout.value.total - (layout.value.offsets[viewEnd.value] || 0)));
const visibleLines = computed(() => viewEnd.value > viewStart.value ? props.lines.slice(viewStart.value, viewEnd.value) : []);
const paneErrorCount = computed(() => props.lines.reduce((sum, line) => sum + (line.level === 'error' ? 1 : 0), 0));
const followActive = computed(() => props.autoScroll && !props.paused && !autoScrollPaused.value && !touching.value);

function syncViewport() {
  if (!boxEl.value) return;
  const height = boxEl.value.clientHeight || 420;
  const scrollTop = boxEl.value.scrollTop;
  viewStart.value = Math.max(0, logIndexAt(layout.value, scrollTop) - OVERSCAN);
  viewEnd.value = Math.min(props.lines.length, logIndexAt(layout.value, scrollTop + height) + 1 + OVERSCAN);
}
function observeRow(id, element) {
  const previous = rowElements.get(id);
  if (previous === element) return;
  if (previous) resizeObserver?.unobserve?.(previous);
  if (!element) { rowElements.delete(id); return; }
  rowElements.set(id, element);
  elementIds.set(element, id);
  if (active) resizeObserver?.observe(element);
}
function toggleJson(id, value) {
  // Expanding a row is a reading action: incoming lines must not pull it away.
  pauseFollow();
  if (value) localExpanded.value.add(id); else localExpanded.value.delete(id);
  emit('toggle-json', id, value);
}
async function rebuildLayout() {
  const anchor = captureLogAnchor(layout.value, boxEl.value?.scrollTop || 0);
  const next = buildLogLayout(props.lines, heights);
  if (anchor && !followActive.value && props.retainedFrom != null && props.retainedFrom > anchor.id) historyExpired.value = true;
  layout.value = next;
  const target = restoreLogAnchor(next, anchor);
  const change = ++layoutChange;
  adjusting = true;
  // Compute the new window before rendering, including when front trimming moves it.
  viewStart.value = Math.max(0, logIndexAt(next, target) - OVERSCAN);
  viewEnd.value = Math.min(props.lines.length, logIndexAt(next, target + (boxEl.value?.clientHeight || 420)) + 1 + OVERSCAN);
  await nextTick();
  if (change !== layoutChange || !active) return;
  if (boxEl.value && !followActive.value) {
    boxEl.value.scrollTop = target;
    lastScrollTop = boxEl.value.scrollTop;
  }
  adjusting = false;
  syncViewport();
  scheduleFollow();
}
function measureRows(entries) {
  if (!active) return;
  let changed = false;
  const boxEntry = entries.find(entry => entry.target === boxEl.value);
  if (boxEntry && boxEntry.contentRect.width > 0 && boxEntry.contentRect.width !== viewportWidth) {
    viewportWidth = boxEntry.contentRect.width;
    heights.clear();
    changed = true;
  }
  for (const entry of entries) {
    const id = elementIds.get(entry.target);
    const height = entry.borderBoxSize?.[0]?.blockSize || entry.target.getBoundingClientRect().height;
    if (id == null || height <= 0 || !layout.value.indices.has(id)) continue;
    if (Math.abs((heights.get(id) || 0) - height) > 0.25) { heights.set(id, height); changed = true; }
  }
  if (changed) void rebuildLayout();
  else { syncViewport(); scheduleFollow(); }
}
/** rAF 合并的滚底调度:高频日志每帧只滚一次,避免反复强制 reflow 卡死主线程。 */
function scheduleFollow() {
  if (!active || !followActive.value || followFrame) return;
  followFrame = requestAnimationFrame(async () => {
    followFrame = 0;
    if (!active || !boxEl.value || !followActive.value) return;
    boxEl.value.scrollTop = boxEl.value.scrollHeight;
    lastScrollTop = boxEl.value.scrollTop;
    seenId.value = props.lines.at(-1)?.id ?? null;
    syncViewport();
    // 切换虚拟窗口后，徽章/JSON 的实际行高可能改变 scrollHeight。
    // 等渲染完成再对齐一次；用户若已开始阅读历史，绝不覆盖其位置。
    await nextTick();
    if (!active || !boxEl.value || !followActive.value) return;
    boxEl.value.scrollTop = boxEl.value.scrollHeight;
    lastScrollTop = boxEl.value.scrollTop;
    syncViewport();
  });
}
function cancelFollow() {
  if (followFrame) cancelAnimationFrame(followFrame);
  followFrame = 0;
}
function pauseFollow() {
  if (!autoScrollPaused.value) seenId.value = props.lines.at(-1)?.id ?? null;
  autoScrollPaused.value = true;
  cancelFollow();
}
function onScroll() {
  syncViewport();
  const box = boxEl.value;
  if (!box || !props.autoScroll || adjusting) return;
  const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
  const movedUp = box.scrollTop < lastScrollTop - 1;
  lastScrollTop = box.scrollTop;
  if (distance > 32 && (movedUp || touching.value)) pauseFollow();
  else if (distance <= 32) { autoScrollPaused.value = false; seenId.value = props.lines.at(-1)?.id ?? null; }
  // 内容增长/虚拟窗口重排产生的 scroll 事件不代表用户向上滚动。
  if (distance > 1 && followActive.value) scheduleFollow();
}
function onWheel(event) {
  if (props.autoScroll && event.deltaY < 0) pauseFollow();
  // Downward scrolling resumes following only after the reader reaches the end.
}
function startTouch() { touching.value = true; cancelFollow(); }
function endTouch() { touching.value = false; onScroll(); scheduleFollow(); }
function onKeydown(event) {
  if (event.target !== boxEl.value) return;
  if (props.autoScroll && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pauseFollow();
  if (event.key === 'Home') {
    // 原生 Home 动画按滚动前的虚拟高度计算终点，窗口重排后可能停在第一行之外。
    event.preventDefault();
    boxEl.value.scrollTop = 0;
    syncViewport();
  }
}
function resume() {
  historyExpired.value = false;
  autoScrollPaused.value = false;
  seenId.value = props.lines.at(-1)?.id ?? null;
  scheduleFollow();
}

// 行数或调用方修订号变化:能跟随就跟随,否则只重算可视区间(过滤变窄时不能强行滚底)。
watch([() => props.revision, () => props.lines, () => props.lines.length], () => {
  const retained = new Set(props.lines.map(line => line.id));
  for (const id of heights.keys()) if (!retained.has(id)) heights.delete(id);
  for (const id of localExpanded.value) if (!retained.has(id)) localExpanded.value.delete(id);
  if (!props.lines.length) historyExpired.value = false;
  void rebuildLayout();
});
watch(() => props.resumeSignal, resume);
watch(() => props.autoScroll, value => { if (value) resume(); else cancelFollow(); });

function activate() {
  active = true;
  adjusting = false;
  nextTick(() => { syncViewport(); scheduleFollow(); });
  if (!resizeObserver && boxEl.value && typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(measureRows);
    resizeObserver.observe(boxEl.value);
    for (const element of rowElements.values()) resizeObserver.observe(element);
  }
}
function deactivate() {
  active = false;
  layoutChange += 1;
  cancelFollow();
  resizeObserver?.disconnect();
  resizeObserver = null;
}
onMounted(activate);
onActivated(activate);
onDeactivated(deactivate);
onBeforeUnmount(deactivate);
</script>

<style scoped>
.log-pane { position: relative; }
.scroll-resume-chip { position: absolute; bottom: 12px; right: 12px; left: auto; z-index: 10; display: inline-flex; align-items: center; gap: 6px; max-width: calc(100% - 24px); min-height: 36px; background: var(--panel-raised); }
.log-pane-body { overscroll-behavior: contain; overflow-anchor: none; }
.log-history-notice { position: absolute; top: 8px; left: 12px; right: 12px; z-index: 10; padding: 8px 12px; border: 1px solid var(--color-surface-700); border-radius: 8px; background: var(--panel-raised); color: var(--color-amber-300); font-size: 12px; }
.log-history-notice button { margin-left: 8px; text-decoration: underline; }
</style>
