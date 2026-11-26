<template>
  <div class="container-ports" :aria-label="`${container.name} 端口`">
    <template v-if="ports.length">
      <component :is="port.url ? 'a' : 'span'" v-for="port in ports" :key="port.key"
                 class="count-badge container-ports__item" :class="{ 'container-ports__item--link': port.url }"
                 :href="port.url || undefined" :target="port.url ? '_blank' : undefined" :rel="port.url ? 'noopener noreferrer' : undefined"
                 :title="port.host ? (port.source === 'config-file' ? '来自 NPS 配置文件，实际监听以应用为准' : port.source === 'environment' ? '来自容器明确的 Web 端口配置，实际监听以应用为准' : '镜像声明的主机网络端口，实际监听以应用配置为准') : port.url ? `打开 ${port.url}` : '宿主端口 → 容器端口'">
        <template v-if="port.host"><span>{{ port.public }}/{{ port.type }}<template v-if="port.label"> · {{ port.label }}</template></span><span class="container-ports__source">{{ ['environment', 'config-file'].includes(port.source) ? '主机网络（配置）' : '主机网络（声明）' }}</span></template>
        <template v-else><span>{{ port.public }}<span class="container-ports__arrow"> → </span>{{ port.private }}/{{ port.type }}</span></template>
      </component>
    </template>
    <span v-else class="container-ports__empty">{{ container.networkMode === 'host' ? '主机网络 · 无端口映射' : '未发布宿主端口' }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue';
const props = defineProps({ container: { type: Object, required: true }, links: { type: Array, default: () => [] } });
const ports = computed(() => {
  const result = new Map();
  const host = props.container.networkMode === 'host';
  const source = host ? (props.container.hostPorts || []).map(({ port, type, source, label, purpose }) => ({ private: port, public: port, type, source, label, purpose })) : props.container.ports || [];
  for (const port of source) {
    if (!Number(port.public)) continue;
    const type = port.type || 'tcp';
    const key = `${port.public}:${port.private}/${type}`;
    const link = type === 'tcp' && (!port.purpose || port.purpose === 'web') ? props.links.find((link) => link.port === Number(port.public)) : null;
    result.set(key, { ...port, type, key, host, url: link?.url });
  }
  return [...result.values()];
});
</script>

<style scoped>
.container-ports { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 6px; }
.container-ports__item.count-badge { display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--text-soft); font-family: var(--font-mono); font-size: 10px; font-weight: 400; line-height: 1.6; }
.container-ports__item--link.count-badge { color: var(--ui-link); }
.container-ports__item--link:hover { text-decoration: underline; text-underline-offset: 3px; }
.container-ports__arrow { color: var(--text-faint); }
.container-ports__source { padding-left: 6px; border-left: 1px solid rgba(var(--ui-line-rgb), .25); color: var(--text-faint); font-family: var(--font-sans); font-size: 9px; }
.container-ports__empty { color: var(--text-faint); font-size: 10px; }
.container-ports__item:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; border-radius: 2px; }
</style>
