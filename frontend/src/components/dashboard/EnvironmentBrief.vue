<template>
  <section class="environment-brief" :data-tone="tone" aria-labelledby="environment-brief-title">
    <div class="brief-copy">
      <div class="brief-eyebrow"><span class="brief-status-dot" aria-hidden="true"></span>环境简报<span>当前节点</span></div>
      <h2 id="environment-brief-title">{{ title }}</h2>
      <p>{{ description }}</p>
      <div class="brief-actions">
        <router-link :to="primaryTarget" class="btn-primary">{{ primaryLabel }}<ArrowRight :size="15" aria-hidden="true" /></router-link>
        <router-link :to="deepLink(projects.length ? '/inspection' : '/settings', { from: 'dashboard', ...(!projects.length ? { tab: 'mounts' } : {}) })" class="btn-ghost">{{ projects.length ? '查看巡检建议' : '纳管已有项目' }}<ArrowUpRight :size="14" aria-hidden="true" /></router-link>
      </div>
    </div>
    <div v-if="projects.length" class="brief-distribution" aria-label="项目状态分布">
      <div class="brief-distribution-heading"><span>{{ incomplete ? '上次项目记录' : '项目运行概况' }}</span><router-link :to="deepLink('/services', { from: 'dashboard' })">全部 {{ projects.length }} 个<ArrowUpRight :size="12" aria-hidden="true" /></router-link></div>
      <div class="brief-state-track" aria-hidden="true">
        <span v-if="healthy" :style="{ flex: healthy }" data-status="healthy"></span>
        <span v-if="attention.length" :style="{ flex: attention.length }" data-status="attention"></span>
      </div>
      <nav class="brief-projects" aria-label="快速定位项目">
        <router-link v-for="project in featuredProjects" :key="project.id" :to="deepLink('/services', { focus: project.id, from: 'dashboard' })" class="brief-project" :data-status="needsAttention(project) ? 'attention' : 'healthy'" :aria-label="`定位项目 ${project.projectName || project.id}：${incomplete ? '上次记录，' : ''}${projectAttention(project).label}`" :title="project.projectName || project.id">
          <span class="brief-project-name">{{ project.projectName || project.id }}</span>
          <span class="brief-project-state"><i aria-hidden="true"></i>{{ projectAttention(project).label }}</span>
          <ArrowUpRight class="brief-project-arrow" :size="13" aria-hidden="true" />
        </router-link>
      </nav>
      <div class="brief-counts">
        <router-link :to="deepLink('/services', { filter: 'running', from: 'dashboard' })"><span class="brief-count-value">{{ healthy }}</span><span><i class="is-healthy"></i>{{ incomplete ? '已知运行' : '运行正常' }}<ArrowUpRight :size="12" /></span></router-link>
        <router-link :to="deepLink('/services', { filter: 'attention', from: 'dashboard' })"><span class="brief-count-value" :class="{ 'text-status-warn': attention.length }">{{ attention.length }}</span><span><i class="is-attention"></i>需要关注<ArrowUpRight :size="12" /></span></router-link>
      </div>
      <p class="brief-footnote">{{ incomplete ? '部分信息未更新，请先刷新确认。' : '基于当前容器状态 · 业务可用性需单独确认' }}</p>
    </div>
    <ol v-else class="brief-onboarding" aria-label="开始使用">
      <li><span>01</span><div><strong>连接你的项目</strong><small>纳管已有服务，或从应用市场部署</small></div></li>
      <li><span>02</span><div><strong>看清运行状态</strong><small>容器、日志与配置在同一处查看</small></div></li>
      <li><span>03</span><div><strong>确认每次变更</strong><small>执行后核对状态，保留操作记录</small></div></li>
    </ol>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { ArrowRight, ArrowUpRight } from 'lucide-vue-next';
import { deepLink } from '../../lib/deep-links.js';
import { projectAttention, projectLogTarget } from '../../lib/project-health.js';

const props = defineProps({ projects: { type: Array, default: () => [] }, incomplete: Boolean });
const needsAttention = project => project.status !== 'running' || (project.containers || []).some(container => container.health === 'unhealthy');
const attention = computed(() => props.projects.filter(needsAttention).sort((a, b) => Number(b.status !== 'running') - Number(a.status !== 'running') || String(a.projectName || a.id).localeCompare(String(b.projectName || b.id))));
const healthy = computed(() => props.projects.length - attention.value.length);
const featuredProjects = computed(() => [...attention.value, ...props.projects.filter(project => !needsAttention(project))].slice(0, 4));
const tone = computed(() => props.incomplete ? 'unknown' : attention.value.length ? 'attention' : props.projects.length ? 'healthy' : 'empty');
const title = computed(() => props.incomplete ? '先确认环境的最新状态' : attention.value.length ? `${attention.value.length} 个项目需要你关注` : props.projects.length ? '服务运行有序，继续你的工作' : '从第一个项目，开始清晰运维');
const description = computed(() => props.incomplete ? '部分数据暂不可用。保留已有信息，刷新后再判断下一步。' : attention.value.length ? '从异常日志开始定位问题，带着上下文处理，再核对运行结果。' : props.projects.length ? '当前未发现停止或健康检查异常的项目。可以查看巡检建议，提前处理潜在问题。' : '把状态、配置和操作结果连在一起，让每一次变更都有据可查。');
const primaryLabel = computed(() => props.incomplete ? '查看项目状态' : attention.value.length ? (attention.value[0].managed ? '查看首个异常日志' : '查看待处理项目') : props.projects.length ? '进入服务工作区' : '浏览应用市场');
const primaryTarget = computed(() => {
  if (props.incomplete) return deepLink('/services', { from: 'dashboard' });
  const first = attention.value[0];
  if (first?.managed) return projectLogTarget(first);
  return deepLink(props.projects.length ? '/services' : '/marketplace', { from: 'dashboard', ...(first ? { filter: 'attention', focus: first.id } : {}) });
});
</script>

<style scoped>
.environment-brief { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(290px, 1fr); align-items: center; gap: 36px; padding: 28px 30px; overflow: hidden; border: 1px solid var(--line-subtle); border-radius: 16px; background: radial-gradient(ellipse at 95% 0, rgba(72, 140, 134, .09), transparent 60%), linear-gradient(115deg, #1a232b, #151c24); box-shadow: inset 0 1px 0 rgba(255,255,255,.035); }
.brief-eyebrow { display: flex; align-items: center; gap: 8px; color: var(--color-surface-200); font-size: 12px; }
.brief-eyebrow > span:last-child { padding-left: 12px; margin-left: 4px; border-left: 1px solid var(--line-subtle); color: var(--color-surface-400); font-size: 11px; }
.brief-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-status-ok); box-shadow: 0 0 0 4px rgba(110,231,183,.08); }
[data-tone="attention"] .brief-status-dot, [data-tone="unknown"] .brief-status-dot { background: var(--color-status-warn); box-shadow: 0 0 0 4px rgba(252,211,77,.08); }
[data-tone="empty"] .brief-status-dot { background: var(--color-status-info); }
.brief-copy h2 { margin-top: 15px; font-size: clamp(20px, 2vw, 29px); font-weight: 600; letter-spacing: -.035em; line-height: 1.45; }
.brief-copy > p { margin-top: 10px; max-width: 40em; color: var(--color-surface-400); font-size: 13px; line-height: 1.9; }
.brief-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.brief-actions .btn-primary { gap: 14px; }
.brief-actions a svg { transition: transform 160ms; }
.brief-actions a:hover svg { transform: translateX(2px); }
.brief-distribution { align-self: center; padding-left: 30px; border-left: 1px solid var(--line-subtle); min-width: 0; }
.brief-distribution-heading { display: flex; justify-content: space-between; gap: 12px; color: var(--color-surface-400); font-size: 11px; }
.brief-distribution-heading a { display: inline-flex; align-items: center; gap: 4px; color: var(--color-link); border-radius: 4px; }
.brief-state-track { display: flex; gap: 3px; height: 4px; margin: 14px 0 10px; overflow: hidden; border-radius: 3px; }
.brief-state-track span { min-width: 3px; background: var(--color-status-ok); opacity: .7; }
.brief-state-track [data-status="attention"] { background: var(--color-status-warn); }
.brief-counts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.brief-counts a { border-radius: 8px; padding: 4px 6px; margin-left: -6px; transition: background 160ms; }
.brief-counts a:hover { background: rgba(148,163,184,.07); }
.brief-count-value { display: block; font-size: 24px; line-height: 1.3; font-variant-numeric: tabular-nums; font-weight: 550; }
.brief-counts a > span:last-child { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--color-surface-400); font-size: 11px; }
.brief-counts i { width: 5px; height: 5px; border-radius: 50%; }
.is-healthy { background: var(--color-status-ok); }.is-attention { background: var(--color-status-warn); }
.brief-projects { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-top: 12px; }
.brief-project { position: relative; min-width: 0; padding: 9px 24px 9px 10px; border: 1px solid var(--line-subtle); border-radius: 8px; background: rgba(15,20,26,.24); transition: background 160ms, border-color 160ms; }
.brief-project-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-surface-200); font-size: 11px; }
.brief-project-state { display: flex; align-items: center; gap: 5px; margin-top: 4px; font-size: 10px; color: var(--color-surface-400); }
.brief-project-state i { width: 4px; height: 4px; border-radius: 50%; background: var(--color-status-ok); }
.brief-project[data-status="attention"] .brief-project-state i { background: var(--color-status-warn); }
.brief-project-arrow { position: absolute; top: 11px; right: 8px; color: var(--color-surface-400); transition: transform 160ms, color 160ms; }
.brief-project:focus-visible { outline: 2px solid var(--color-link); outline-offset: 2px; }
@media (hover: hover) { .brief-project:hover { background: var(--panel-raised); border-color: var(--color-surface-500); }.brief-project:hover .brief-project-arrow { color: var(--color-link); transform: translate(1px, -1px); } }
.brief-footnote { margin-top: 12px; color: var(--color-surface-400); font-size: 10px; line-height: 1.7; }
.brief-onboarding { display: grid; gap: 16px; align-self: center; }.brief-onboarding li { display: flex; align-items: center; gap: 14px; }.brief-onboarding li > span { font-size: 11px; font-family: var(--font-mono); color: var(--color-link); border: 1px solid var(--line-subtle); padding: 7px; border-radius: 8px; }.brief-onboarding strong { display: block; font-size: 12px; font-weight: 500; }.brief-onboarding small { display: block; font-size: 11px; margin-top: 4px; color: var(--color-surface-400); }
@media (max-width: 900px) { .environment-brief { grid-template-columns: 1fr; gap: 22px; }.brief-distribution { border-left: 0; border-top: 1px solid var(--line-subtle); padding: 18px 0 0; }.brief-counts { grid-template-columns: 1fr 1fr; }.brief-footnote { margin-top: 10px; } }
@media (max-width: 639px) { .environment-brief { padding: 18px; border-radius: 13px; gap: 16px; }.brief-copy h2 { font-size: 21px; }.brief-copy > p { font-size: 12px; }.brief-actions { gap: 6px; }.brief-actions a { min-height: 40px; font-size: 12px; }.brief-distribution { padding-top: 14px; }.brief-counts a { display: flex; align-items: baseline; gap: 7px; }.brief-count-value { font-size: 22px; }.brief-counts a > span:last-child { flex-wrap: wrap; }.brief-counts i { display: none; }.brief-projects { margin-top: 8px; }.brief-onboarding { gap: 12px; } }
@media (prefers-reduced-motion: reduce) { .brief-actions a svg, .brief-counts a, .brief-project, .brief-project-arrow { transition: none; } }
</style>
