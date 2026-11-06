<template>
  <section v-if="project" class="project-context" aria-label="当前项目工作区">
    <div class="project-context__identity">
      <span class="project-context__icon"><Boxes :size="18" /></span>
      <div class="min-w-0"><strong>{{ project.projectName }}</strong><span>{{ project.editable ? 'Compose 项目' : '容器项目' }}<template v-if="container"> · {{ container.name }}</template></span></div>
      <StatusBadge :status="project.status" />
    </div>
    <nav aria-label="项目内导航" class="project-context__tabs">
      <RouterLink :to="returnLocation"><Layers :size="15" />项目</RouterLink>
      <CapabilityLink v-for="item in tabs" :key="item.name" :to="location(item.name)" :disabled="item.disabled" :reason="item.reason" :aria-current="route.name === item.name ? 'page' : undefined">
        <component :is="item.icon" :size="15" />{{ item.label }}
      </CapabilityLink>
    </nav>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { Boxes, FileCode2, Layers, ScrollText, TerminalSquare } from 'lucide-vue-next';
import StatusBadge from '../common/StatusBadge.vue';
import CapabilityLink from '../common/CapabilityLink.vue';
import { projectReturnLocation, projectToolLocation } from '../../lib/project-navigation.js';
const props = defineProps({ project: { type: Object, default: null }, containerId: { type: String, default: '' }, disabled: Boolean });
const route = useRoute();
const container = computed(() => props.project?.containers?.find(item => item.id === props.containerId));
const returnLocation = computed(() => projectReturnLocation(route.query.returnTo, props.project?.id));
const tabs = computed(() => [
  { name: 'logs', label: '日志', icon: ScrollText, disabled: props.disabled || !props.project?.managed, reason: '项目纳管后可查看日志' },
  { name: 'compose', label: '配置', icon: FileCode2, disabled: props.disabled || !props.project?.editable, reason: '配置编辑需要可访问的 Compose 目录' },
  { name: 'shell', label: '终端', icon: TerminalSquare, disabled: props.disabled || !props.project?.managed, reason: '项目纳管后可使用终端' },
]);
function location(name) { return projectToolLocation(name, props.project, props.containerId, route.query); }
</script>

<style scoped>
.project-context { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; padding: 12px 16px; border: 1px solid var(--line-subtle); border-radius: 12px; background: var(--panel-surface); }
.project-context__identity { display: flex; min-width: 0; align-items: center; gap: 10px; }
.project-context__icon { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border: 1px solid var(--line-subtle); border-radius: 9px; color: var(--color-surface-300); }
.project-context__identity strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.project-context__identity div > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 3px; font-size: 11px; color: var(--color-surface-400); }
.project-context__tabs { display: flex; gap: 4px; flex-shrink: 0; }
.project-context__tabs > * { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 9px 12px; border-radius: 7px; font-size: 12px; color: var(--color-surface-400); transition: background-color 140ms, color 140ms; }
.project-context__tabs a:hover { color: var(--color-surface-100); background: var(--panel-raised); }
.project-context__tabs [aria-current="page"] { background: var(--panel-raised); color: var(--color-surface-50); box-shadow: inset 0 0 0 1px var(--line-subtle); }
@media (max-width: 767px) { .project-context { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px; } .project-context__tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--line-subtle); padding-top: 8px; } .project-context__tabs > * { min-height: 40px; padding: 8px 4px; gap: 5px; } .project-context__identity > :last-child { margin-left: auto; flex-shrink: 0; } }
</style>
