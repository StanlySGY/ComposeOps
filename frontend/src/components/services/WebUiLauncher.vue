<template>
  <div v-if="links.length" class="app-access" aria-label="各应用访问入口">
    <div v-for="group in groups" :key="group.id" class="app-access__group">
      <span class="app-access__name" :title="group.name"><Globe class="h-3 w-3" />{{ group.name }}</span>
      <a v-for="link in group.links" :key="link.port" :href="link.url" target="_blank" rel="noopener noreferrer"
         class="app-access__port" :aria-label="`打开 ${group.name} 端口 ${link.port}`" :title="`打开 ${group.name} (${link.url})${link.source === 'host-exposed' ? ' · 主机网络，端口来自镜像声明' : ['host-environment', 'host-config-file'].includes(link.source) ? ' · 主机网络，端口来自应用配置' : ''}`">
        {{ link.port }}<ArrowUpRight class="h-3 w-3" />
      </a>
      <button class="app-access__settings" :aria-label="`配置 ${group.name} 访问入口`" title="配置访问入口" @click="$emit('configure', group.name)"><Settings2 class="h-3 w-3" /></button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { ArrowUpRight, Globe, Settings2 } from 'lucide-vue-next';
defineEmits(['configure']);
const props = defineProps({ links: { type: Array, default: () => [] } });
const groups = computed(() => {
  const result = new Map();
  for (const link of props.links) {
    const id = link.containerId || link.containerName;
    if (!result.has(id)) result.set(id, { id, name: link.serviceName || link.containerName, links: [] });
    const group = result.get(id);
    if (!group.links.some((item) => item.port === link.port)) group.links.push(link);
  }
  return [...result.values()];
});
</script>

<style scoped>
.app-access { display: flex; flex-wrap: wrap; min-width: 0; gap: 6px 8px; }
.app-access__group { display: flex; flex-wrap: wrap; min-width: 0; align-items: center; gap: 0; max-width: 100%; border: 1px solid rgba(var(--ui-line-rgb), .24); border-radius: 6px; background: rgba(var(--ui-line-rgb), .035); }
.app-access__name { display: inline-flex; min-width: 0; max-width: 200px; align-items: center; gap: 6px; padding: 5px 9px; color: var(--text-soft); font-family: var(--font-mono); font-size: 10.5px; overflow-wrap: anywhere; }
.app-access__name > svg { flex-shrink: 0; color: var(--text-faint); }
.app-access__port { display: inline-flex; flex-shrink: 0; align-items: center; gap: 5px; align-self: stretch; padding: 5px 8px; border-left: 1px solid rgba(var(--ui-line-rgb), .19); color: var(--ui-link); font-family: var(--font-mono); font-size: 11px; line-height: 1.4; font-variant-numeric: tabular-nums; transition: background-color 140ms ease; }
.app-access__settings { display: inline-flex; align-self: stretch; align-items: center; padding: 5px 7px; border-left: 1px solid rgba(var(--ui-line-rgb), .19); color: var(--text-faint); }
.app-access__settings:hover { color: var(--ui-link); background: rgba(37,99,235,.075); }
.app-access__settings:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.app-access__port > svg { opacity: .6; }
.app-access__port:hover { background: rgba(37, 99, 235, .075); }
.app-access__port:hover > svg { opacity: 1; }
.app-access__port:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; border-radius: 3px; }
@media (max-width: 639px) { .app-access__name { max-width: 160px; } }
@media (prefers-reduced-motion: reduce) { .app-access__port { transition: none; } }
</style>
