<template>
  <div class="aggregate-line group" :class="{ 'line-error': isError }">
    <span class="container-badge" :class="badgeClass">{{ containerName }}</span>
    <span v-if="ts" class="line-ts">{{ shortTs }}</span>
    <template v-if="jsonState !== null">
      <pre class="json-block" :class="{ open: jsonOpen }">{{ jsonText }}</pre>
      <button class="json-toggle" @click="jsonOpen = !jsonOpen">{{ jsonOpen ? '折叠' : '展开' }}</button>
    </template>
    <template v-else>
      <span v-if="levelBadge" class="level-badge" :class="levelBadgeClass">{{ levelBadge }}</span>
      <!-- highlighted 先完整转义原始日志,仅插入固定 mark 标签后展示。 -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <span class="line-data" :class="levelClass" v-html="highlighted"></span>
    </template>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';

const props = defineProps({ line: { type: Object, required: true } });
const jsonOpen = ref(false);

const PALETTES = [
  'text-sky-300 border-sky-500/40 bg-sky-500/10',
  'text-cyan-300 border-cyan-500/40 bg-cyan-500/10',
  'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  'text-violet-300 border-violet-500/40 bg-violet-500/10',
  'text-amber-300 border-amber-500/40 bg-amber-500/10',
  'text-rose-300 border-rose-500/40 bg-rose-500/10',
];
function hashColor(name = '') {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PALETTES[Math.abs(hash) % PALETTES.length];
}
const badgeClass = computed(() => hashColor(props.line.containerName));

const text = computed(() => String(props.line.data || ''));
const level = computed(() => props.line.level || (/(error|exception|fatal|crash|panic|failed)/i.test(text.value) ? 'error' : /(warn|deprecat)/i.test(text.value) ? 'warn' : 'info'));
const isError = computed(() => level.value === 'error');
const levelClass = computed(() => {
  if (props.line.type === 'stderr' || level.value === 'error') return 'text-rose-300';
  if (level.value === 'warn') return 'text-amber-200';
  return 'text-surface-200';
});
const levelBadge = computed(() => level.value === 'error' ? 'ERROR' : level.value === 'warn' ? 'WARN' : '');
const levelBadgeClass = computed(() => level.value === 'error' ? 'bg-rose-950/60 text-rose-300 border-rose-500/40' : 'bg-amber-950/60 text-amber-300 border-amber-500/40');
const ts = computed(() => props.line.ts || null);
const shortTs = computed(() => {
  if (!ts.value) return '';
  // RFC3339 → HH:mm:ss
  return /T(\d{2}:\d{2}:\d{2})/.exec(ts.value)?.[1] || ts.value;
});

const jsonState = computed(() => {
  const trimmed = text.value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return null;
  }
});
const jsonText = computed(() => {
  if (jsonState.value === null) return '';
  return jsonOpen.value
    ? JSON.stringify(JSON.parse(jsonState.value), null, 2)
    : jsonState.value.slice(0, 240);
});
const highlighted = computed(() => {
  // 简单关键字高亮(避免 XSS:仅替换缩放模式,用 innerHTML 但关键字为固定字符串)
  const escaped = text.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/(error|exception|fatal|crash|panic|failed|warn|deprecat)/gi, '<mark class="log-mark">$1</mark>');
});
</script>
