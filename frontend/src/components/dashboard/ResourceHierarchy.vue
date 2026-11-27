<template>
  <div class="resource-hierarchy">
    <div class="resource-row resource-labels"><span>分组 / 项目 / 服务</span><span>整机 CPU</span><span>内存</span><span>收 / 发</span><span>读 / 写</span><span>操作</span></div>
    <section v-for="group in groups" :key="group.id" class="resource-group" :aria-label="`分组 ${group.name}`">
      <div class="resource-row resource-group-row">
        <div class="resource-name"><button class="resource-toggle" :aria-expanded="groupOpen(group)" @click="$emit('toggle-group', group.id)"><ChevronDown :size="16" :class="{ '-rotate-90': !groupOpen(group) }" /><strong>{{ group.name }}</strong></button><small>{{ group.projects.length }} 个项目<span v-if="group.pinned"> · 已置顶</span></small></div>
        <ResourceMetricCells :value="group.totals" /><button v-if="group.attention" class="text-status-warn text-xs" @click="revealAttention(group)">{{ group.attention }} 服务需关注</button><span v-else></span>
      </div>
      <template v-if="groupOpen(group)"><article v-for="project in group.projects" :key="project.id" class="cockpit-project">
        <div class="resource-row resource-project-row">
          <div class="resource-name"><button class="resource-toggle cockpit-project-summary" :aria-expanded="projectOpen(project)" @click="$emit('toggle-project', project.id)"><ChevronDown :size="16" :class="{ '-rotate-90': !projectOpen(project) }" /><strong>{{ project.name }}</strong></button><small>{{ project.id === 'standalone' ? '独立容器' : 'Compose 项目' }} · {{ project.services.length }} 个{{ project.id === 'standalone' ? '容器' : '服务' }}<span v-if="project.id !== 'standalone' && !project.managed"> · 未纳管</span></small></div>
          <ResourceMetricCells :value="project" /><span></span>
        </div>
        <template v-if="projectOpen(project)"><div v-for="service in project.services" :key="service.key" class="resource-row resource-service-row" :data-resource-key="service.key">
          <div class="resource-name"><router-link :to="focusLink(service)" class="cockpit-service-name"><span class="resource-dot" :class="{ 'resource-dot-warning': serviceAttention(service) }"></span>{{ service.name }}</router-link><small>{{ service.running }} / {{ service.total }} 运行<span v-if="service.cpuPercent != null"> · {{ (service.cpuPercent / 100).toFixed(2) }} 核</span><span v-if="serviceAttention(service)" class="text-status-warn"> · 需关注</span></small></div>
          <ResourceMetricCells :value="service" />
          <div class="resource-actions"><router-link :to="focusLink(service)" class="text-link">进入</router-link><button class="text-link" @click="$emit('trend', service)">趋势</button></div>
          <details v-if="service.containers.length" class="cockpit-replicas"><summary>{{ service.containers.length }} 个容器 · 健康与资源限制</summary>
            <div v-for="container in service.containers" :key="container.id" class="resource-container"><div><strong>{{ container.name }}</strong><small>{{ stateLabel(container.state) }} · {{ healthLabel(container) }} · {{ container.restartCount == null ? '重启次数待确认' : `累计重启 ${container.restartCount} 次` }}</small><small>{{ containerLimit(container, 'cpu') }} · {{ containerLimit(container, 'memory') }}</small><small v-if="container.detailsAt">配置采样于 {{ new Date(container.detailsAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</small><small v-if="container.oomKilled || container.stateError" class="text-status-warn">{{ container.oomKilled ? '上次退出标记 OOM' : container.stateError }}</small></div><router-link :to="focusLink(container)" class="text-link">定位容器</router-link><router-link v-if="container.projectId" :to="logLink(container)" class="text-link">日志</router-link></div>
          </details>
        </div></template>
      </article></template>
    </section>
    <p class="resource-footnote">{{ searching ? '当前为搜索命中项的小计。' : '分组与项目显示各自子项小计，不重复相加。' }}“—”表示未采集或数据不完整；容器工作集与宿主内存口径不同。</p>
  </div>
</template>
<script setup>
import { computed, nextTick } from 'vue';
import { ChevronDown } from 'lucide-vue-next';
import { groupProjects } from '../../lib/project-groups.js';
import { resourceTotals, serviceAttention, containerLimit } from '../../lib/infrastructure.js';
import ResourceMetricCells from './ResourceMetricCells.vue';
const props = defineProps({ projects: { type: Array, default: () => [] }, definitions: { type: Array, default: () => [] }, expanded: { type: Set, required: true }, collapsedGroups: { type: Set, required: true }, searching: Boolean, focusLink: { type: Function, required: true }, logLink: { type: Function, required: true } });
const emit = defineEmits(['toggle-project', 'toggle-group', 'trend']);
const groups = computed(() => groupProjects(props.projects, props.definitions).map(g => ({ ...g, totals: resourceTotals(g.projects), attention: g.projects.flatMap(p => p.services).filter(serviceAttention).length })));
const groupOpen = group => props.searching || !props.collapsedGroups.has(group.id);
const projectOpen = project => props.searching || props.expanded.has(project.id);
const stateLabel = state => ({ running: '运行中', exited: '已退出', restarting: '重启中', paused: '已暂停', created: '已创建', dead: '已失效' })[state] || state || '状态未知';
const healthLabel = container => ({ healthy: '健康检查通过', unhealthy: '健康检查失败', starting: '健康检查启动中' })[container.health] || (container.detailsReady ? '未配置健康检查' : '健康检查状态待确认');
async function revealAttention(group) {
  if (!groupOpen(group)) emit('toggle-group', group.id);
  const project = group.projects.find(p => p.services.some(serviceAttention));
  if (project && !projectOpen(project)) emit('toggle-project', project.id);
  await nextTick();
  const key = project?.services.find(serviceAttention)?.key;
  const row = [...document.querySelectorAll('[data-resource-key]')].find(el => el.dataset.resourceKey === key);
  row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
}
</script>
<style scoped>
.resource-hierarchy{--tree-step:24px;min-width:0}.resource-row{display:grid;grid-template-columns:minmax(170px,1fr) 74px 90px 105px 105px 75px;gap:10px;align-items:center;padding:12px 10px;border-bottom:1px solid var(--line-subtle);font-size:12px}.resource-labels{font-size:11px;color:var(--text-soft)}.resource-labels>span:not(:first-child),.resource-row :deep(.resource-value){text-align:right;font-variant-numeric:tabular-nums}.resource-row :deep(small){display:block;margin-top:4px;color:var(--text-soft);font-size:11px;overflow-wrap:anywhere}.resource-name{min-width:0}.resource-name>small{padding-left:24px}.resource-toggle{display:flex;align-items:center;gap:8px;text-align:left;max-width:100%;min-height:28px}.resource-toggle svg{flex-shrink:0}.resource-toggle strong{font-weight:500;overflow-wrap:anywhere}.resource-group-row{background:var(--panel-surface);border-top:1px solid var(--line-subtle)}.resource-group{margin-top:8px}.resource-project-row .resource-name{padding-left:var(--tree-step)}.resource-service-row .resource-name{padding-left:calc(var(--tree-step) * 2 + 12px);position:relative}.resource-service-row .resource-name:before{content:'';position:absolute;left:calc(var(--tree-step) + 7px);top:-12px;height:calc(50% + 12px);width:12px;border-left:1px solid var(--line-subtle);border-bottom:1px solid var(--line-subtle)}.resource-service-row .resource-name>small{padding-left:14px}.cockpit-service-name{display:flex;align-items:center;gap:8px;overflow-wrap:anywhere;color:var(--text-strong)}.cockpit-service-name:hover{color:var(--color-link)}.resource-dot{width:6px;height:6px;border-radius:50%;background:var(--color-status-ok);flex-shrink:0}.resource-dot-warning{background:var(--color-status-warn)}.resource-actions{display:flex;gap:12px;justify-content:flex-end}.cockpit-replicas{grid-column:1/-1;margin-left:calc(var(--tree-step) * 2 + 14px);min-width:0;color:var(--text-soft);font-size:12px}.cockpit-replicas summary{cursor:pointer;padding:5px 0}.resource-container{display:flex;gap:12px;flex-wrap:wrap;padding:12px 0 12px 18px;border-left:1px solid var(--line-subtle)}.resource-container>div{flex:1;min-width:140px;overflow-wrap:anywhere}.resource-footnote{font-size:11px;color:var(--text-soft);margin-top:12px}.resource-row :deep(.text-status-warn){color:var(--color-status-warn)}
@media(max-width:1100px){.resource-row{grid-template-columns:minmax(150px,1fr) 60px 76px 85px 85px 65px;gap:8px}}
@media(max-width:850px){.resource-hierarchy{--tree-step:20px}.resource-row{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.resource-name{grid-column:1/-1}.resource-labels{display:none}.resource-row :deep(.resource-value){text-align:left}.resource-row :deep(.resource-value):before{content:attr(data-label);display:block;color:var(--text-soft);font-size:11px;margin-bottom:4px}.resource-actions{grid-column:1/-1;justify-content:flex-start;padding-left:calc(var(--tree-step)*2 + 14px)}.resource-actions>*{min-height:40px;display:inline-flex;align-items:center}.resource-container>div{min-width:100%;}.resource-container>a{min-height:40px;display:inline-flex;align-items:center}.cockpit-replicas{margin-left:calc(var(--tree-step)*2 + 14px)}}
</style>
