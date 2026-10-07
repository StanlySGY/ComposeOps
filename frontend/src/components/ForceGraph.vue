<template>
  <div class="ios-graph-wrap" :style="{ height: height + 'px' }">
    <!-- 顶部/右上角状态与布局模式切换 (iOS Segmented Control) -->
    <div class="ios-top-bar">
      <div class="ios-segmented-control" role="tablist" aria-label="图谱布局模式">
        <button
          class="ios-segment-btn"
          :class="{ active: layoutMode === 'dag' }"
          role="tab"
          :aria-selected="layoutMode === 'dag'"
          title="分层架构：按依赖深度有序排列，架构流向清晰一目了然"
          @click="setLayoutMode('dag')"
        >
          <Layers class="w-3.5 h-3.5" />
          <span>分层架构</span>
        </button>
        <button
          class="ios-segment-btn"
          :class="{ active: layoutMode === 'force' }"
          role="tab"
          :aria-selected="layoutMode === 'force'"
          title="自由拓扑：弹性拖拽与力导向排布"
          @click="setLayoutMode('force')"
        >
          <Compass class="w-3.5 h-3.5" />
          <span>自由拓扑</span>
        </button>
      </div>

      <div class="flex items-center gap-2 text-xs text-surface-400">
        <span class="ios-stat-chip">
          <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
          {{ activeNodesCount }} 正常
        </span>
        <span v-if="alertNodesCount" class="ios-stat-chip text-rose-300">
          <span class="w-2 h-2 rounded-full bg-rose-400"></span>
          {{ alertNodesCount }} 告警/异常
        </span>
      </div>
    </div>

    <!-- SVG 画布 -->
    <svg
      ref="svgEl"
      class="ios-canvas"
      :class="{ 'ios-dag-mode': layoutMode === 'dag' }"
      :aria-label="ariaLabel"
      role="img"
      @pointerdown="onPointerDown"
      @wheel.prevent="onWheel"
    >
      <defs>
        <!-- iOS 暗黑极简点阵背景 -->
        <pattern id="ios-dot-grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.2" fill="rgba(255, 255, 255, 0.07)" />
        </pattern>

        <!-- 卡片背景与高光渐变 -->
        <linearGradient id="ios-card-glass" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#1A2230" stop-opacity="0.94" />
          <stop offset="100%" stop-color="#0F172A" stop-opacity="0.96" />
        </linearGradient>

        <linearGradient id="ios-card-glass-hover" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#243044" stop-opacity="0.98" />
          <stop offset="100%" stop-color="#131D31" stop-opacity="0.98" />
        </linearGradient>

        <linearGradient id="ios-card-selected" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#1E2E3E" stop-opacity="0.98" />
          <stop offset="100%" stop-color="#0D212A" stop-opacity="0.98" />
        </linearGradient>

        <!-- 卡片阴影 Filter -->
        <filter id="ios-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000000" flood-opacity="0.45" />
          <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.25" />
        </filter>

        <filter id="ios-selected-glow" x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="#10B981" flood-opacity="0.38" />
          <feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#000000" flood-opacity="0.45" />
        </filter>

        <!-- 连线箭头 -->
        <marker id="ios-arrow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
          <polygon points="0 0.5, 8 3.5, 0 6.5" fill="#64748B" />
        </marker>
        <marker id="ios-arrow-active" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
          <polygon points="0 0.5, 8 3.5, 0 6.5" fill="#34D399" />
        </marker>
      </defs>

      <g :transform="`translate(${tx} ${ty}) scale(${scale})`">
        <!-- 拾取全画布平移的底层背景 -->
        <rect
          class="ios-bg-hit"
          :x="-6000" :y="-6000" width="12000" height="12000"
          fill="url(#ios-dot-grid)"
          @pointerdown="onPointerDown"
        />

        <!-- 分层架构模式下的层级导向栏 (DAG Columns) -->
        <g v-if="layoutMode === 'dag' && dagColumns.length" class="ios-column-guides">
          <g v-for="col in dagColumns" :key="col.level" class="ios-col-group">
            <rect
              :x="col.x - CARD_W / 2 - 16"
              :y="col.minY - 48"
              :width="CARD_W + 32"
              :height="col.maxY - col.minY + 96"
              rx="20"
              fill="rgba(255, 255, 255, 0.015)"
              stroke="rgba(255, 255, 255, 0.05)"
              stroke-dasharray="4 6"
            />
            <g :transform="`translate(${col.x} ${col.minY - 26})`">
              <rect
                :x="-col.titleWidth / 2"
                y="-12"
                :width="col.titleWidth"
                height="24"
                rx="12"
                fill="rgba(30, 41, 59, 0.85)"
                stroke="rgba(255, 255, 255, 0.1)"
              />
              <text
                text-anchor="middle"
                y="4"
                class="ios-tier-label"
              >{{ col.title }}</text>
            </g>
          </g>
        </g>

        <!-- 连线层：底色优雅贝塞尔曲线 + 上层高亮流动虚线 -->
        <g class="ios-edges">
          <template v-for="edge in renderedEdges" :key="edge.key">
            <path
              class="ios-edge-base"
              :class="{ 'ios-dim': isDimmedEdge(edge), 'ios-edge-highlight': isEdgeHighlighted(edge) }"
              :d="edge.path"
              fill="none"
              :stroke="edgeColor(edge)"
              :stroke-width="isEdgeHighlighted(edge) ? 2.2 : 1.5"
              :marker-end="isEdgeHighlighted(edge) ? 'url(#ios-arrow-active)' : 'url(#ios-arrow)'"
            />
            <path
              v-if="!isDimmedEdge(edge)"
              class="ios-edge-flow"
              :class="{ 'ios-flow-fast': isEdgeHighlighted(edge) }"
              :d="edge.path"
              fill="none"
              :stroke="edgeFlowColor(edge)"
              :stroke-width="isEdgeHighlighted(edge) ? 2.4 : 1.6"
              stroke-linecap="round"
              stroke-dasharray="2 9"
            />
          </template>
        </g>

        <!-- iOS 风格实体卡片 (Squircle Cards) -->
        <g class="ios-nodes">
          <g
            v-for="node in displayNodes"
            :key="node.key"
            class="ios-card-node"
            :class="{
              'ios-dim': isDimmedNode(node),
              'ios-card-selected': selectedKey === node.key,
              'ios-card-hover': hoverKey === node.key,
              'ios-grabbing': dragKey === node.key,
            }"
            :transform="`translate(${node.x} ${node.y})`"
            :data-key="node.key"
            @pointerdown="onNodePointerDown(node, $event)"
            @pointerenter="hoverKey = node.key"
            @pointerleave="hoverKey = hoverKey === node.key ? '' : hoverKey"
          >
            <!-- 主卡片圆角矩形 -->
            <rect
              :x="-CARD_W / 2"
              :y="-CARD_H / 2"
              :width="CARD_W"
              :height="CARD_H"
              rx="16"
              ry="16"
              :fill="selectedKey === node.key ? 'url(#ios-card-selected)' : (hoverKey === node.key ? 'url(#ios-card-glass-hover)' : 'url(#ios-card-glass)')"
              :stroke="cardBorderColor(node)"
              :stroke-width="selectedKey === node.key ? 2 : 1.2"
              :filter="selectedKey === node.key ? 'url(#ios-selected-glow)' : 'url(#ios-shadow)'"
              class="ios-card-body"
            />

            <!-- 顶部高光细线 (苹果质感 Specular Top Rim) -->
            <line
              :x1="-CARD_W / 2 + 16"
              :y1="-CARD_H / 2 + 0.5"
              :x2="CARD_W / 2 - 16"
              :y2="-CARD_H / 2 + 0.5"
              stroke="rgba(255, 255, 255, 0.16)"
              stroke-width="1"
            />

            <!-- 左侧图标圆角矩形 (iOS App/Shortcut 图标式样) -->
            <rect
              :x="-CARD_W / 2 + 12"
              :y="-CARD_H / 2 + 13"
              width="42"
              height="42"
              rx="11"
              ry="11"
              :fill="paletteOf(node).bg"
              :stroke="paletteOf(node).border"
              stroke-width="1"
            />

            <!-- 图标/字母标识 -->
            <text
              :x="-CARD_W / 2 + 33"
              :y="-CARD_H / 2 + 39"
              text-anchor="middle"
              class="ios-card-glyph"
              :fill="paletteOf(node).main"
            >{{ nodeGlyph(node) }}</text>

            <!-- 标题文字 (双行设计：主标题 + 状态/角色副标题) -->
            <text
              :x="-CARD_W / 2 + 62"
              :y="-CARD_H / 2 + 29"
              class="ios-card-title"
            >{{ truncate(node.label, 14) }}</text>

            <text
              :x="-CARD_W / 2 + 62"
              :y="-CARD_H / 2 + 48"
              class="ios-card-subtitle"
              :fill="paletteOf(node).soft"
            >{{ truncate(node.sub || nodeStateText(node), 16) }}</text>

            <!-- 右上角状态呼吸小点 -->
            <circle
              :cx="CARD_W / 2 - 18"
              :cy="-CARD_H / 2 + 20"
              r="8"
              :fill="paletteOf(node).main"
              opacity="0.18"
              class="ios-status-aura"
            />
            <circle
              :cx="CARD_W / 2 - 18"
              :cy="-CARD_H / 2 + 20"
              r="4"
              :fill="paletteOf(node).main"
              class="ios-status-dot"
            />

            <!-- 右下角连接数/端口徽章 -->
            <g v-if="nodeDegree(node) > 0" :transform="`translate(${CARD_W / 2 - 18} ${CARD_H / 2 - 20})`">
              <rect
                x="-18"
                y="-9"
                width="24"
                height="16"
                rx="8"
                fill="rgba(255, 255, 255, 0.06)"
                stroke="rgba(255, 255, 255, 0.08)"
              />
              <text
                x="-6"
                y="3"
                text-anchor="middle"
                class="ios-badge-text"
              >{{ nodeDegree(node) }}</text>
            </g>

            <title>{{ node.fullLabel || node.label }}{{ node.sub ? ` · ${node.sub}` : '' }}</title>
          </g>
        </g>
      </g>
    </svg>

    <!-- iOS 风格悬浮胶囊工具栏 (Floating Island Control Pill) -->
    <div class="ios-floating-pill">
      <button class="ios-tool-btn" title="放大" aria-label="放大" @click="zoomBy(1.2)"><ZoomIn class="w-4 h-4" /></button>
      <button class="ios-tool-btn" title="缩小" aria-label="缩小" @click="zoomBy(0.8)"><ZoomOut class="w-4 h-4" /></button>
      <div class="ios-pill-divider"></div>
      <button class="ios-tool-btn" title="适应视口" aria-label="适应视口" @click="fitView()"><Maximize2 class="w-4 h-4" /></button>
      <button class="ios-tool-btn" title="重排布局" aria-label="重排布局" @click="reseed()"><RotateCw class="w-4 h-4" /></button>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Compass, Layers, Maximize2, RotateCw, ZoomIn, ZoomOut } from 'lucide-vue-next';
import { createGraphModel, tickModel, applySeedPositions } from '../lib/force-graph.js';
import { assignLevels } from '../lib/topology-layout.js';

const CARD_W = 196;
const CARD_H = 68;

const props = defineProps({
  /** [{key, label, sub?, state?, fullLabel?}] state ∈ running/stopped/unhealthy/none/host/project/volume/alert */
  nodes: { type: Array, default: () => [] },
  /** [{source, target}] key 引用 */
  edges: { type: Array, default: () => [] },
  height: { type: Number, default: 560 },
  selectedKey: { type: String, default: '' },
  /** 可选:key → {x,y} 的初始坐标 */
  seedPositions: { type: Object, default: null },
  ariaLabel: { type: String, default: '服务拓扑与关系图' },
  defaultLayout: { type: String, default: 'dag' }, // 'dag' | 'force'
});
const emit = defineEmits(['node-click']);

// 布局模式：'dag' (分层架构) 或 'force' (自由力导向)
const layoutMode = ref(props.defaultLayout);
function setLayoutMode(mode) {
  layoutMode.value = mode;
  if (mode === 'dag') {
    applyDagLayout();
  } else {
    reseed();
  }
}

// 统一 iOS 色彩系统 (HIG System Colors)
const PALETTES = {
  running: { main: '#10B981', soft: '#6EE7B7', bg: 'rgba(16, 185, 129, 0.14)', border: 'rgba(16, 185, 129, 0.3)' },
  stopped: { main: '#F43F5E', soft: '#FDA4AF', bg: 'rgba(244, 63, 94, 0.14)', border: 'rgba(244, 63, 94, 0.3)' },
  unhealthy: { main: '#F59E0B', soft: '#FCD34D', bg: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.3)' },
  none: { main: '#94A3B8', soft: '#CBD5E1', bg: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.25)' },
  neutral: { main: '#38BDF8', soft: '#7DD3FC', bg: 'rgba(56, 189, 248, 0.14)', border: 'rgba(56, 189, 248, 0.3)' },
  host: { main: '#38BDF8', soft: '#7DD3FC', bg: 'rgba(56, 189, 248, 0.14)', border: 'rgba(56, 189, 248, 0.3)' },
  project: { main: '#34D399', soft: '#6EE7B7', bg: 'rgba(52, 211, 153, 0.14)', border: 'rgba(52, 211, 153, 0.3)' },
  volume: { main: '#A78BFA', soft: '#C4B5FD', bg: 'rgba(167, 139, 250, 0.14)', border: 'rgba(167, 139, 250, 0.3)' },
  alert: { main: '#F43F5E', soft: '#FDA4AF', bg: 'rgba(244, 63, 94, 0.14)', border: 'rgba(244, 63, 94, 0.3)' },
};
function paletteOf(node) {
  return PALETTES[node.pal] || PALETTES.neutral;
}

const svgEl = ref(null);
const model = reactive(createGraphModel([], []));
const dagNodesMap = reactive(new Map()); // key -> { x, y, level }
const dagColumns = ref([]);
const tx = ref(0);
const ty = ref(0);
const scale = ref(1);
const hoverKey = ref('');
const dragKey = ref('');
let rafId = 0;
let viewTouched = false;
let pendingFit = false;
let resizeObserver = null;

const activeNodesCount = computed(() =>
  props.nodes.filter((n) => n.state === 'running' || !n.state || n.state === 'project' || n.state === 'host').length
);
const alertNodesCount = computed(() =>
  props.nodes.filter((n) => n.state === 'stopped' || n.state === 'unhealthy' || n.state === 'alert').length
);

const nodeMeta = reactive(new Map());
watch(
  () => props.nodes,
  (list) => {
    const next = new Map();
    for (const n of list) {
      next.set(n.key, {
        label: n.label || n.key,
        fullLabel: n.fullLabel || '',
        sub: n.sub || '',
        state: n.state || '',
      });
    }
    nodeMeta.clear();
    for (const [k, v] of next) nodeMeta.set(k, v);
  },
  { immediate: true, deep: false }
);

// 综合展示节点列表
const displayNodes = computed(() => {
  return props.nodes.map((n) => {
    const meta = nodeMeta.get(n.key) || {};
    let pos = { x: 0, y: 0 };
    if (layoutMode.value === 'dag') {
      const dag = dagNodesMap.get(n.key);
      if (dag) pos = { x: dag.x, y: dag.y };
    } else {
      const forceNode = model.nodes.find((m) => m.key === n.key);
      if (forceNode) pos = { x: forceNode.x, y: forceNode.y };
    }
    return {
      key: n.key,
      x: pos.x,
      y: pos.y,
      label: meta.label || n.key,
      fullLabel: meta.fullLabel || '',
      sub: meta.sub || '',
      pal: meta.state && PALETTES[meta.state] ? meta.state : 'neutral',
    };
  });
});

function nodeDegree(node) {
  return props.edges.filter((e) => e.source === node.key || e.target === node.key).length;
}

function truncate(str, max = 14) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function nodeStateText(node) {
  const map = {
    running: '运行中',
    stopped: '已停止',
    unhealthy: '异常',
    volume: '数据卷',
    host: '主机节点',
    project: '项目',
    alert: '告警事件',
    none: '未关联',
  };
  return map[node.pal] || '服务';
}

function nodeGlyph(node) {
  if (node.pal === 'host') return 'H';
  if (node.pal === 'volume') return 'V';
  if (node.pal === 'alert') return '!';
  if (node.pal === 'project') return 'P';
  // 提取服务首字母或标识
  const clean = String(node.label || '').replace(/[^a-zA-Z0-9]/g, '');
  return (clean[0] || 'S').toUpperCase();
}

function cardBorderColor(node) {
  if (props.selectedKey === node.key) return '#10B981';
  if (hoverKey.value === node.key) return 'rgba(255, 255, 255, 0.28)';
  return 'rgba(255, 255, 255, 0.1)';
}

// ---- 分层 DAG 计算逻辑 (Sugiyama 架构流) ----
function applyDagLayout() {
  if (!props.nodes.length) {
    dagNodesMap.clear();
    dagColumns.value = [];
    return;
  }

  // 1. 适配 assignLevels 的输入结构
  const serviceList = props.nodes.map((n) => {
    const deps = props.edges.filter((e) => e.target === n.key).map((e) => e.source);
    return { name: n.key, dependsOn: deps };
  });

  const levels = assignLevels(serviceList);
  const maxLevel = Math.max(0, ...levels.map((l) => l.level));
  const colGap = 290;
  const rowGap = 92;

  // 2. 按层分组
  const levelGroups = new Map();
  for (const item of levels) {
    if (!levelGroups.has(item.level)) levelGroups.set(item.level, []);
    levelGroups.get(item.level).push(item);
  }

  // 3. 计算各层坐标与标题
  dagNodesMap.clear();
  const columns = [];
  const startX = 220;

  for (let l = 0; l <= maxLevel; l++) {
    const group = levelGroups.get(l) || [];
    const count = group.length;
    const colX = startX + l * colGap;
    let minY = Infinity;
    let maxY = -Infinity;

    group.forEach((item, idx) => {
      const y = 360 + (idx - (count - 1) / 2) * rowGap;
      dagNodesMap.set(item.name, { x: colX, y, level: l });
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });

    // 层级标题
    let title;
    if (maxLevel === 0) {
      title = '独立服务';
    } else if (l === 0) {
      title = '依赖与存储 (Data / Base)';
    } else if (l === maxLevel) {
      title = '接入与网关 (Gateway / Web)';
    } else {
      title = `核心应用 (${l})`;
    }

    if (count > 0) {
      columns.push({
        level: l,
        x: colX,
        minY: minY - CARD_H / 2,
        maxY: maxY + CARD_H / 2,
        title,
        titleWidth: Math.max(140, title.length * 9 + 32),
      });
    }
  }

  dagColumns.value = columns;
  pendingFit = true;
  requestAnimationFrame(() => fitView());
}

// ---- 优雅 S 型 Bezier 连线计算 ----
const renderedEdges = computed(() => {
  const nodePos = new Map(displayNodes.value.map((n) => [n.key, { x: n.x, y: n.y }]));
  return props.edges.map((e) => {
    const a = nodePos.get(e.source) || { x: 0, y: 0 };
    const b = nodePos.get(e.target) || { x: 0, y: 0 };

    // 从卡片右边缘连接到目标卡片左边缘
    const startX = a.x + CARD_W / 2;
    const startY = a.y;
    const endX = b.x - CARD_W / 2;
    const endY = b.y;

    // 平滑 S 曲线
    const dx = Math.max(40, Math.abs(endX - startX) * 0.45);
    const path = `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;

    return {
      key: `${e.source}->${e.target}`,
      path,
      from: e.source,
      to: e.target,
    };
  });
});

// ---- 高亮与邻居关联 ----
const activeHighlightKey = computed(() => hoverKey.value || props.selectedKey || '');

const neighborSet = computed(() => {
  if (!activeHighlightKey.value) return null;
  const set = new Set([activeHighlightKey.value]);
  for (const edge of renderedEdges.value) {
    if (edge.from === activeHighlightKey.value) set.add(edge.to);
    if (edge.to === activeHighlightKey.value) set.add(edge.from);
  }
  return set;
});

function isDimmedNode(node) {
  return neighborSet.value ? !neighborSet.value.has(node.key) : false;
}
function isDimmedEdge(edge) {
  return neighborSet.value ? !(neighborSet.value.has(edge.from) && neighborSet.value.has(edge.to)) : false;
}
function isEdgeHighlighted(edge) {
  if (!activeHighlightKey.value) return false;
  return edge.from === activeHighlightKey.value || edge.to === activeHighlightKey.value;
}

function edgeColor(edge) {
  if (isEdgeHighlighted(edge)) return '#34D399';
  if (isDimmedEdge(edge)) return 'rgba(100, 116, 139, 0.12)';
  return 'rgba(100, 116, 139, 0.32)';
}
function edgeFlowColor(edge) {
  if (isEdgeHighlighted(edge)) return '#34D399';
  return 'rgba(148, 163, 184, 0.45)';
}

// ---- 数据变动侦听与初始化 ----
const graphSignature = computed(() =>
  `${props.nodes.map((n) => n.key).join(',')}#${props.edges.map((e) => `${e.source}>${e.target}`).join(',')}`
);

watch(graphSignature, () => {
  const fresh = createGraphModel(props.nodes, props.edges);
  if (props.seedPositions) applySeedPositions(fresh, props.seedPositions);
  // 卡片是 196x68 的矩形:给节点注册真实占位,碰撞与斥力按卡片尺寸算,
  // 否则两张卡片中心距 100 时视觉已压叠,圆形判定(r≈34)永远不触发。
  for (const node of fresh.nodes) {
    node.w = CARD_W + 24;
    node.h = CARD_H + 24;
    node.r = Math.max(node.w, node.h) / 2;
  }
  model.width = fresh.width;
  model.height = fresh.height;
  model.nodes.splice(0, model.nodes.length, ...fresh.nodes);
  model.links.splice(0, model.links.length, ...fresh.links);

  if (layoutMode.value === 'dag') {
    applyDagLayout();
  } else {
    model.alpha = 0.8;
    ensureLoop();
  }
  pendingFit = true;
}, { immediate: true });

// ---- 物理循环 (自由画布模式下使用) ----
function ensureLoop() {
  if (layoutMode.value === 'dag') return;
  if (rafId) return;
  const step = () => {
    const alive = tickModel(model);
    if (alive) {
      rafId = requestAnimationFrame(step);
      return;
    }
    rafId = 0;
    if (pendingFit) {
      pendingFit = false;
      if (!viewTouched) fitView();
    }
  };
  rafId = requestAnimationFrame(step);
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (!viewTouched && !pendingFit) fitView();
  });
  if (svgEl.value) resizeObserver.observe(svgEl.value);
  if (layoutMode.value === 'dag') applyDagLayout();
  else ensureLoop();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (rafId) cancelAnimationFrame(rafId);
});

// ---- 视口缩放与自适应 (iOS Pan & Zoom) ----
function fitView() {
  if (!svgEl.value || !displayNodes.value.length) {
    tx.value = 0;
    ty.value = 0;
    scale.value = 1;
    return;
  }
  const rect = svgEl.value.getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const n of displayNodes.value) {
    minX = Math.min(minX, n.x - CARD_W / 2);
    minY = Math.min(minY, n.y - CARD_H / 2);
    maxX = Math.max(maxX, n.x + CARD_W / 2);
    maxY = Math.max(maxY, n.y + CARD_H / 2);
  }

  const pad = 64;
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const s = Math.min(1.4, Math.max(0.4, Math.min(rect.width / (contentW + pad * 2), rect.height / (contentH + pad * 2))));

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
  const next = Math.min(2.4, Math.max(0.35, scale.value * factor));
  const ratio = next / scale.value;
  tx.value = px - (px - tx.value) * ratio;
  ty.value = py - (py - ty.value) * ratio;
  scale.value = next;
  viewTouched = true;
}

function onWheel(event) {
  const rect = svgEl.value.getBoundingClientRect();
  zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.08 : 0.92);
}

// ---- 指针交互：平移画布与拖拽卡片 ----
let dragState = null;
function toWorld(clientX, clientY) {
  const rect = svgEl.value.getBoundingClientRect();
  return { x: (clientX - rect.left - tx.value) / scale.value, y: (clientY - rect.top - ty.value) / scale.value };
}

function onNodePointerDown(node, event) {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  event.stopPropagation();
  const world = toWorld(event.clientX, event.clientY);
  dragKey.value = node.key;

  dragState = {
    kind: 'node',
    key: node.key,
    offsetX: node.x - world.x,
    offsetY: node.y - world.y,
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
    const nextX = world.x + dragState.offsetX;
    const nextY = world.y + dragState.offsetY;

    if (layoutMode.value === 'dag') {
      // 分层架构是编排好的语义视图:卡片不可拖出所属分组框(仅点击高亮/画布平移缩放)。
      // 拖拽整理布局请切到自由拓扑。
      return;
    }
    const target = model.nodes.find((n) => n.key === dragState.key);
    if (target) {
      target.x = nextX;
      target.y = nextY;
      target.vx = 0;
      target.vy = 0;
      model.alpha = Math.max(model.alpha, 0.3);
      ensureLoop();
    }
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

  if (state.kind === 'node' && !state.moved) {
    emit('node-click', state.key);
  }
}

function reseed() {
  if (layoutMode.value === 'dag') {
    applyDagLayout();
  } else {
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
}

defineExpose({ reseed, fitView, setLayoutMode });
</script>

<style scoped>
.ios-graph-wrap {
  position: relative;
  overflow: hidden;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background:
    radial-gradient(1200px 500px at 50% -10%, rgba(16, 185, 129, 0.06), transparent 60%),
    linear-gradient(180deg, #0B0F17 0%, #080B10 100%);
  box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.08);
  touch-action: none;
}

.ios-canvas {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
}
.ios-canvas:active {
  cursor: grabbing;
}

/* 顶部模式切换与指示器 */
.ios-top-bar {
  position: absolute;
  top: 14px;
  left: 14px;
  right: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  pointer-events: none;
  z-index: 10;
}
.ios-segmented-control {
  pointer-events: auto;
  display: inline-flex;
  padding: 3px;
  border-radius: 14px;
  background: rgba(15, 23, 42, 0.78);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.ios-segment-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: #94A3B8;
  border-radius: 10px;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.ios-segment-btn:hover {
  color: #F8FAFC;
}
.ios-segment-btn.active {
  color: #FFFFFF;
  background: rgba(255, 255, 255, 0.12);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}
.ios-stat-chip {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 20px;
  background: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

/* 悬浮控制胶囊 */
.ios-floating-pill {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 24px;
  background: rgba(15, 23, 42, 0.82);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 10;
}
.ios-tool-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: #94A3B8;
  transition: all 0.18s ease;
}
.ios-tool-btn:hover {
  color: #FFFFFF;
  background: rgba(255, 255, 255, 0.1);
}
.ios-pill-divider {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.12);
  margin: 0 2px;
}

/* DAG 架构列文字 */
.ios-tier-label {
  font-size: 11px;
  font-weight: 600;
  fill: #94A3B8;
  letter-spacing: 0.02em;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

/* 节点卡片样式 */
.ios-card-node {
  cursor: grab;
  transition: opacity 0.28s ease, filter 0.28s ease;
}
/* 分层架构是编排好的视图,卡片不可拖拽,光标提示可点击 */
.ios-canvas.ios-dag-mode .ios-card-node {
  cursor: pointer;
}
.ios-card-node.ios-grabbing {
  cursor: grabbing;
}
.ios-card-body {
  transition: fill 0.2s ease, stroke 0.2s ease, stroke-width 0.2s ease;
}
.ios-card-node:hover .ios-card-body {
  stroke: rgba(255, 255, 255, 0.28);
}
.ios-card-glyph {
  font-size: 16px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.ios-card-title {
  font-size: 13px;
  font-weight: 600;
  fill: #F8FAFC;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  user-select: none;
}
.ios-card-subtitle {
  font-size: 11px;
  font-weight: 400;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  user-select: none;
}
.ios-badge-text {
  font-size: 9.5px;
  font-weight: 600;
  fill: #94A3B8;
  font-family: ui-monospace, SFMono-Regular, monospace;
}

/* 连线与流动动画 */
.ios-edge-base {
  transition: stroke 0.24s ease, stroke-width 0.24s ease, opacity 0.24s ease;
}
.ios-edge-flow {
  animation: ios-flow 1.8s linear infinite;
  pointer-events: none;
}
.ios-flow-fast {
  animation: ios-flow 1s linear infinite;
}
@keyframes ios-flow {
  to {
    stroke-dashoffset: -22;
  }
}
.ios-status-aura {
  animation: ios-pulse 2.4s ease-in-out infinite;
}
@keyframes ios-pulse {
  0%, 100% {
    opacity: 0.15;
    transform: scale(1);
  }
  50% {
    opacity: 0.35;
    transform: scale(1.35);
  }
}

.ios-dim {
  opacity: 0.12 !important;
}
</style>
