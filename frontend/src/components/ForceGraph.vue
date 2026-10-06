<template>
  <div class="force-graph-wrap" :style="{ height: height + 'px' }">
    <svg
      ref="svgEl"
      class="force-graph"
      :aria-label="ariaLabel"
      role="img"
      @pointerdown="onPointerDown"
      @wheel.prevent="onWheel"
    >
      <defs>
        <pattern id="fg-dots" width="26" height="26" patternUnits="userSpaceOnUse">
          <circle cx="1.4" cy="1.4" r="1.4" fill="rgba(148, 163, 184, 0.09)" />
        </pattern>
        <template v-for="(palette, key) in PALETTES" :key="key">
          <radialGradient :id="`fg-fill-${key}`" cx="42%" cy="36%" r="72%">
            <stop offset="0%" stop-color="#0B0E13" stop-opacity="0.72" />
            <stop offset="58%" :stop-color="palette.main" stop-opacity="0.14" />
            <stop offset="100%" :stop-color="palette.main" stop-opacity="0.34" />
          </radialGradient>
          <radialGradient :id="`fg-halo-${key}`">
            <stop offset="0%" :stop-color="palette.main" stop-opacity="0.34" />
            <stop offset="70%" :stop-color="palette.main" stop-opacity="0.1" />
            <stop offset="100%" :stop-color="palette.main" stop-opacity="0" />
          </radialGradient>
        </template>
        <marker id="fg-arrow" markerWidth="7" markerHeight="6" refX="6" refY="3" orient="auto">
          <polygon points="0 0, 7 3, 0 6" fill="#34D399" opacity="0.8" />
        </marker>
      </defs>

      <g :transform="`translate(${tx} ${ty}) scale(${scale})`">
        <rect
          class="fg-canvas-hit"
          :x="-4000" :y="-4000" width="9200" height="9200"
          fill="url(#fg-dots)"
          @pointerdown="onPointerDown"
        />
        <!-- 连线:底层弧线 + 上层流向虚线 -->
        <g class="fg-edges">
          <template v-for="edge in renderedEdges" :key="edge.key">
            <path
              class="fg-edge-line"
              :class="{ 'fg-dim': isDimmedEdge(edge) }"
              :d="edge.path"
              fill="none"
              :stroke="edgeColor(edge)"
              stroke-width="1.5"
            />
            <path
              class="fg-edge-flow"
              :class="{ 'fg-dim': isDimmedEdge(edge) }"
              :d="edge.path"
              fill="none"
              :stroke="edgeFlowColor(edge)"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-dasharray="0.5 9"
              marker-end="url(#fg-arrow)"
            />
          </template>
        </g>
        <!-- 气泡节点 -->
        <g class="fg-nodes">
          <g
            v-for="node in nodesView"
            :key="node.key"
            class="fg-node"
            :class="{ 'fg-dim': isDimmedNode(node), 'fg-grabbing': dragKey === node.key }"
            :transform="`translate(${node.x} ${node.y})`"
            :data-key="node.key"
            @pointerdown="onNodePointerDown(node, $event)"
            @pointerenter="hoverKey = node.key"
            @pointerleave="hoverKey = hoverKey === node.key ? '' : hoverKey"
          >
            <circle :r="node.r * 1.5" :fill="`url(#fg-halo-${node.pal})`" class="fg-halo" />
            <circle
              class="fg-bubble"
              :r="node.r"
              :fill="`url(#fg-fill-${node.pal})`"
              :stroke="node.selected ? '#F8FAFC' : paletteOf(node).main"
              :stroke-width="node.selected ? 2 : 1.5"
              :stroke-opacity="node.selected ? 0.9 : 0.66"
            />
            <ellipse
              class="fg-spec"
              :cx="-node.r * 0.3" :cy="-node.r * 0.42" :rx="node.r * 0.46" :ry="node.r * 0.26"
              fill="rgba(255, 255, 255, 0.13)"
            />
            <!-- 知识图谱式标签:挂在气泡下方,不挤占气泡内部 -->
            <text class="fg-label" text-anchor="middle" :y="node.r + 17">{{ node.label }}</text>
            <text
              v-if="node.sub"
              class="fg-sub" text-anchor="middle" :y="node.r + 32"
              :fill="paletteOf(node).soft"
            >{{ node.sub }}</text>
            <title>{{ node.fullLabel || node.label }}{{ node.sub ? ` · ${node.sub}` : '' }}</title>
          </g>
        </g>
      </g>
    </svg>

    <!-- 视图控制 -->
    <div class="fg-controls">
      <button class="icon-btn fg-ctrl" title="放大" aria-label="放大" @click="zoomBy(1.25)"><ZoomIn class="h-4 w-4" /></button>
      <button class="icon-btn fg-ctrl" title="缩小" aria-label="缩小" @click="zoomBy(0.8)"><ZoomOut class="h-4 w-4" /></button>
      <button class="icon-btn fg-ctrl" title="重置视图" aria-label="重置视图" @click="fitView()"><Maximize class="h-4 w-4" /></button>
      <button class="icon-btn fg-ctrl" title="重新布局" aria-label="重新布局" @click="reseed()"><Shuffle class="h-4 w-4" /></button>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Maximize, Shuffle, ZoomIn, ZoomOut } from 'lucide-vue-next';
import { createGraphModel, tickModel, applySeedPositions } from '../lib/force-graph.js';

const props = defineProps({
  /** [{key, label, sub?, state?}] state ∈ running/stopped/unhealthy/none */
  nodes: { type: Array, default: () => [] },
  /** [{source, target}] key 引用 */
  edges: { type: Array, default: () => [] },
  height: { type: Number, default: 560 },
  selectedKey: { type: String, default: '' },
  /** 可选:key → {x,y} 的初始坐标(仅空模型首次构建时生效),用于继承旧布局语义 */
  seedPositions: { type: Object, default: null },
  ariaLabel: { type: String, default: '力导向关系图' },
});
const emit = defineEmits(['node-click']);

const PALETTES = {
  running: { main: '#10B981', soft: '#6EE7B7' },
  stopped: { main: '#F43F5E', soft: '#FDA4AF' },
  unhealthy: { main: '#F59E0B', soft: '#FCD34D' },
  none: { main: '#64748B', soft: '#94A3B8' },
  neutral: { main: '#38BDF8', soft: '#7DD3FC' },
  host: { main: '#38BDF8', soft: '#7DD3FC' },
  project: { main: '#10B981', soft: '#6EE7B7' },
  volume: { main: '#A78BFA', soft: '#C4B5FD' },
  alert: { main: '#F43F5E', soft: '#FDA4AF' },
};
function paletteOf(node) {
  return PALETTES[node.pal] || PALETTES.neutral;
}

const svgEl = ref(null);
const model = reactive(createGraphModel([], []));
const tx = ref(0);
const ty = ref(0);
const scale = ref(1);
const hoverKey = ref('');
const dragKey = ref('');
let rafId = 0;
let viewTouched = false;
let pendingFit = false;
let resizeObserver = null;

const nodesView = computed(() =>
  model.nodes.map((n) => {
    const meta = nodeMeta.get(n.key) || {};
    return {
      key: n.key,
      x: n.x,
      y: n.y,
      r: n.r,
      label: meta.label || n.key,
      fullLabel: meta.fullLabel || '',
      sub: meta.sub || '',
      pal: meta.state && PALETTES[meta.state] ? meta.state : 'neutral',
      selected: props.selectedKey === n.key,
    };
  })
);

const nodeMeta = reactive(new Map());
watch(
  () => props.nodes,
  (list) => {
    const next = new Map();
    for (const n of list) next.set(n.key, { label: n.label || n.key, fullLabel: n.fullLabel || '', sub: n.sub || '', state: n.state || '' });
    nodeMeta.clear();
    for (const [k, v] of next) nodeMeta.set(k, v);
  },
  { immediate: true, deep: false }
);

/**
 * 数据重建:只在图的「结构」(节点键集合 / 边集合)变化时执行。
 * 状态色、标签等表现层变化走 nodeMeta 的响应式更新,不重排物理 ——
 * 否则上游轮询产生的同名新数组会反复重加热模拟,永不稳定。
 */
const graphSignature = computed(() =>
  `${props.nodes.map((n) => n.key).join(',')}#${props.edges.map((e) => `${e.source}>${e.target}`).join(',')}`
);
watch(graphSignature, () => {
  const firstBuild = model.nodes.length === 0;
  const oldPositions = new Map(model.nodes.map((n) => [n.key, { x: n.x, y: n.y }]));
  const fresh = createGraphModel(props.nodes, props.edges);
  if (firstBuild && props.seedPositions) applySeedPositions(fresh, props.seedPositions);
  for (const node of fresh.nodes) {
    const old = oldPositions.get(node.key);
    if (old) {
      node.x = old.x;
      node.y = old.y;
    }
  }
  model.width = fresh.width;
  model.height = fresh.height;
  model.options = fresh.options;
  model.nodes.splice(0, model.nodes.length, ...fresh.nodes);
  model.links.splice(0, model.links.length, ...fresh.links);
  model.alpha = Math.max(model.alpha, 0.55);
  pendingFit = true;
  ensureLoop();
}, { immediate: true });

const renderedEdges = computed(() =>
  model.links.map((link, i) => {
    const a = link.source;
    const b = link.target;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const start = { x: a.x + ux * (a.r + 3), y: a.y + uy * (a.r + 3) };
    const end = { x: b.x - ux * (b.r + 8), y: b.y - uy * (b.r + 8) };
    // 垂直向弯一点,同向多条边靠下标交替方向,减少压线
    const bend = (i % 2 ? 1 : -1) * Math.min(26, d * 0.14);
    const mid = { x: (start.x + end.x) / 2 - uy * bend, y: (start.y + end.y) / 2 + ux * bend };
    return {
      key: `${a.key}->${b.key}`,
      path: `M ${start.x} ${start.y} Q ${mid.x} ${mid.y} ${end.x} ${end.y}`,
      from: a.key,
      to: b.key,
    };
  })
);

// ---- 悬停聚光:只保留邻居与相关边 ----
const neighborSet = computed(() => {
  if (!hoverKey.value) return null;
  const set = new Set([hoverKey.value]);
  for (const edge of renderedEdges.value) {
    if (edge.from === hoverKey.value) set.add(edge.to);
    if (edge.to === hoverKey.value) set.add(edge.from);
  }
  return set;
});
function isDimmedNode(node) {
  return neighborSet.value ? !neighborSet.value.has(node.key) : false;
}
function isDimmedEdge(edge) {
  return neighborSet.value ? !(neighborSet.value.has(edge.from) && neighborSet.value.has(edge.to)) : false;
}

function edgeColor(edge) {
  return hoverKey.value && !isDimmedEdge(edge) ? 'rgba(148, 163, 184, 0.45)' : 'rgba(148, 163, 184, 0.26)';
}
function edgeFlowColor(edge) {
  return hoverKey.value && !isDimmedEdge(edge) ? 'rgba(52, 211, 153, 0.8)' : 'rgba(52, 211, 153, 0.4)';
}

// ---- 物理循环 ----
function ensureLoop() {
  if (rafId) return;
  const step = () => {
    const alive = tickModel(model);
    if (alive) {
      rafId = requestAnimationFrame(step);
      return;
    }
    // 模拟冷却后再适配视口:此时节点才到达最终位置(种子位置≠收敛位置)
    rafId = 0;
    if (pendingFit) {
      pendingFit = false;
      if (!viewTouched) fitView();
    }
  };
  rafId = requestAnimationFrame(step);
}
onMounted(() => {
  // 挂载瞬间布局尺寸可能还未稳定,不按当时的 rect 取景;
  // ResizeObserver 首次回调即为可靠尺寸,后续尺寸变化(折叠/切页)也自动重取景
  resizeObserver = new ResizeObserver(() => {
    // 物理冷却前不取景(节点还没到位),交给冷却后的精调
    if (!viewTouched && !pendingFit) fitView();
  });
  if (svgEl.value) resizeObserver.observe(svgEl.value);
  ensureLoop();
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
});

// ---- 视图变换 ----
function fitView() {
  if (!svgEl.value || !model.nodes.length) {
    tx.value = 0;
    ty.value = 0;
    scale.value = 1;
    return;
  }
  const rect = svgEl.value.getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of model.nodes) {
    minX = Math.min(minX, n.x - n.r);
    minY = Math.min(minY, n.y - n.r);
    maxX = Math.max(maxX, n.x + n.r);
    // 标签挂在气泡下方,包围盒底部多留一截防止裁字
    maxY = Math.max(maxY, n.y + n.r + 34);
  }
  const pad = 48;
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  // pad 只参与缩放决策(留白),居中以内容 bbox 为准
  const s = Math.min(1.6, Math.min(rect.width / (contentW + pad * 2), rect.height / (contentH + pad * 2)));
  scale.value = s;
  tx.value = (rect.width - contentW * s) / 2 - minX * s;
  ty.value = (rect.height - contentH * s) / 2 - minY * s;
}
function zoomBy(factor) {
  if (!svgEl.value) return;
  const rect = svgEl.value.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, factor);
}
function zoomAt(px, py, factor) {
  const next = Math.min(2.6, Math.max(0.4, scale.value * factor));
  const ratio = next / scale.value;
  tx.value = px - (px - tx.value) * ratio;
  ty.value = py - (py - ty.value) * ratio;
  scale.value = next;
  viewTouched = true;
}
function onWheel(event) {
  const rect = svgEl.value.getBoundingClientRect();
  zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.1 : 0.9);
}

// ---- 指针交互:拖气泡 / 拖画布 ----
let dragState = null;
function toWorld(clientX, clientY) {
  const rect = svgEl.value.getBoundingClientRect();
  return { x: (clientX - rect.left - tx.value) / scale.value, y: (clientY - rect.top - ty.value) / scale.value };
}
function onNodePointerDown(node, event) {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  event.stopPropagation();
  const world = toWorld(event.clientX, event.clientY);
  const target = model.nodes.find((n) => n.key === node.key);
  if (!target) return;
  dragKey.value = node.key;
  dragState = {
    kind: 'node',
    node: target,
    offsetX: target.x - world.x,
    offsetY: target.y - world.y,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}
function onPointerDown(event) {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  dragState = { kind: 'pan', startX: event.clientX, startY: event.clientY, tx0: tx.value, ty0: ty.value, moved: false };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}
function onPointerMove(event) {
  if (!dragState) return;
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) dragState.moved = true;
  if (dragState.kind === 'node') {
    const world = toWorld(event.clientX, event.clientY);
    dragState.node.x = world.x + dragState.offsetX;
    dragState.node.y = world.y + dragState.offsetY;
    dragState.node.vx = 0;
    dragState.node.vy = 0;
    model.alpha = Math.max(model.alpha, 0.25);
    ensureLoop();
  } else {
    tx.value = dragState.tx0 + dx;
    ty.value = dragState.ty0 + dy;
    if (dragState.moved) viewTouched = true;
  }
}
function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  const state = dragState;
  dragState = null;
  dragKey.value = '';
  if (!state) return;
  if (state.kind === 'node') {
    state.node.fixed = false;
    model.alpha = Math.max(model.alpha, 0.32);
    ensureLoop();
    if (!state.moved) emit('node-click', state.node.key);
  }
}

function reseed() {
  const fresh = createGraphModel(props.nodes, props.edges);
  for (const node of fresh.nodes) {
    const target = model.nodes.find((n) => n.key === node.key);
    if (!target) continue;
    target.x = node.x;
    target.y = node.y;
    target.vx = 0;
    target.vy = 0;
  }
  model.alpha = 1;
  viewTouched = false;
  pendingFit = true;
  ensureLoop();
}

defineExpose({ reseed, fitView });
</script>

<style scoped>
.force-graph-wrap {
  position: relative;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid rgba(148, 163, 184, 0.13);
  background:
    radial-gradient(1200px 500px at 50% -10%, rgba(16, 185, 129, 0.05), transparent 60%),
    rgba(11, 14, 19, 0.72);
  touch-action: none;
}
.force-graph {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
}
.force-graph:active {
  cursor: grabbing;
}
.fg-node {
  cursor: grab;
  transition: opacity 0.3s var(--ease-ios, ease);
}
.fg-node.fg-grabbing {
  cursor: grabbing;
}
.fg-node.fg-grabbing .fg-bubble {
  stroke-width: 2.5;
}
.fg-dim {
  opacity: 0.14;
}
.fg-edge-line,
.fg-edge-flow {
  transition: opacity 0.3s var(--ease-ios, ease), stroke 0.2s ease;
}
.fg-edge-flow {
  animation: fg-flow 1.4s linear infinite;
}
@keyframes fg-flow {
  to {
    stroke-dashoffset: -19;
  }
}
.fg-halo {
  pointer-events: none;
}
.fg-bubble {
  transition: stroke-width 0.2s ease;
}
.fg-spec {
  pointer-events: none;
}
.fg-label {
  font-size: 12.5px;
  font-weight: 600;
  fill: #E2E8F0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  pointer-events: none;
  user-select: none;
}
.fg-sub {
  font-size: 10.5px;
  pointer-events: none;
  user-select: none;
}
.fg-controls {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: rgba(23, 27, 34, 0.72);
  backdrop-filter: saturate(1.6) blur(14px);
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 14px;
  padding: 6px;
}
.fg-ctrl {
  width: 32px;
  height: 32px;
  border-radius: 9px;
}
</style>
