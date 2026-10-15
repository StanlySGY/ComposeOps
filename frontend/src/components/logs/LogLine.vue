<template>
  <div class="aggregate-line group" :class="{ 'line-error': isError }">
    <span v-if="containerName" class="container-badge" :class="badgeClass">{{ containerName }}</span>
    <span v-if="ts" class="line-ts">{{ shortTs }}</span>
    <template v-if="jsonState !== null">
      <pre class="json-block" :class="{ open: jsonOpen }">{{ jsonText }}</pre>
      <button class="json-toggle" :aria-expanded="jsonOpen" :aria-label="`${jsonOpen ? '折叠' : '展开'} JSON 日志：${text.slice(0, 80)}`" @click="jsonOpen = !jsonOpen">{{ jsonOpen ? '折叠' : '展开' }}</button>
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
import { hashColor } from '../../lib/log-colors.js';

// 单容器日志流的帧里没有 containerName,由调用方补一个 fallbackName,徽章颜色仍按名字哈希取色。
const props = defineProps({
  line: { type: Object, required: true },
  fallbackName: { type: String, default: '' },
});
const jsonOpen = ref(false);

const containerName = computed(() => props.line.containerName || props.fallbackName || '');
const badgeClass = computed(() => hashColor(containerName.value));

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
