<template>
  <BaseModal :show="show" title="从这里开始使用 ComposeOps" size-class="sm:max-w-xl" body-class="p-5 space-y-4" @close="dismiss">
    <div class="guide-intro"><SceneIllustration kind="infrastructure" sizes="160px" /><div><p class="guide-eyebrow">你的运维工作区</p><p class="text-sm leading-6 text-surface-300">先查看，再按项目授权。AI 是可选能力，没有模型密钥也可以管理服务、配置和日志。</p></div></div>
    <p v-if="loading" class="text-xs text-surface-400" role="status">正在检查当前工作区…</p>
    <p v-else-if="loadError" class="text-xs text-status-warn" role="status">暂时无法检查全部配置，你仍可以通过下面的入口开始使用。</p>
    <ol class="space-y-3">
      <li v-for="step in steps" :key="step.n" class="guide-step flex items-start gap-3 rounded-xl border border-surface-800 bg-surface-950/40 p-4">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-status-ok/40 bg-status-ok/15 text-sm text-status-ok"><Check v-if="step.done" class="h-4 w-4" /><template v-else>{{ step.n }}</template></span>
        <div class="min-w-0 flex-1"><h3 class="text-sm font-semibold text-surface-100">{{ step.title }}<span v-if="step.optional" class="ml-2 text-[10px] font-normal text-surface-400">可选</span></h3><p class="mt-1 text-xs leading-5 text-surface-400">{{ step.desc }}</p><router-link :to="step.to" class="mt-2 inline-flex min-h-9 items-center gap-1 text-xs text-status-ok" @click="dismiss">{{ step.action }}<ArrowRight class="h-3.5 w-3.5" /></router-link></div>
      </li>
    </ol>
    <p class="text-xs leading-5 text-surface-400">“纳管”开放容器控制；“Compose”进一步开放配置与重建权限。可以从少量测试项目开始，确认操作范围后再扩大。</p>
    <template #footer><button class="btn-ghost" :disabled="loading" @click="openGuide">重新检查</button><button class="btn-primary" @click="dismiss">开始使用</button></template>
  </BaseModal>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ArrowRight, Check } from 'lucide-vue-next';
import SceneIllustration from './SceneIllustration.vue';
import BaseModal from './BaseModal.vue';
import { api } from '../../api/client.js';

const STORAGE_KEY = 'composeops:onboarding-dismissed';
const show = ref(false), loading = ref(false), loadError = ref(false), managedCount = ref(0), aiReady = ref(false);
let generation = 0;
const steps = computed(() => [
  { n: 1, title: '选择要管理的项目', done: managedCount.value > 0, desc: managedCount.value ? '已有 ' + managedCount.value + ' 个纳管项目，可继续调整权限。' : '自动发现不会自动授权。前往项目纳管，选择需要控制的 Compose 项目。', to: '/settings?tab=mounts', action: '设置项目权限' },
  { n: 2, title: '先查看服务与日志', desc: '确认容器状态、健康检查和日志；熟悉环境后，再进行重启、配置编辑等操作。', to: '/services', action: '打开服务列表' },
  { n: 3, title: '接入 AI 助手', done: aiReady.value, optional: true, desc: aiReady.value ? '已有可用于助手的渠道。可以先让它读取状态，了解审批流程。' : '添加模型渠道并测试工具调用，再让助手帮助排障。支持多渠道主备切换。', to: aiReady.value ? '/agent' : '/settings?tab=ai', action: aiReady.value ? '打开 AI 助手' : '配置模型渠道' },
]);
function dismiss() {
  show.value = false;
  try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* session-only dismissal */ }
}
async function openGuide() {
  const current = ++generation;
  show.value = true; loading.value = true; loadError.value = false;
  const [projects, config] = await Promise.allSettled([api.getProjects(), api.getAiConfig()]);
  if (current !== generation) return;
  if (projects.status === 'fulfilled') {
    const list = Array.isArray(projects.value) ? projects.value : projects.value.projects || [];
    managedCount.value = list.filter(project => project.managed).length;
  }
  if (config.status === 'fulfilled') aiReady.value = !!config.value.channels?.some(channel => channel.enabled && channel.supportsTools && channel.hasApiKey);
  loadError.value = projects.status === 'rejected' || config.status === 'rejected';
  loading.value = false;
}
onMounted(() => {
  window.addEventListener('composeops:show-onboarding', openGuide);
  try { if (!localStorage.getItem(STORAGE_KEY)) void openGuide(); } catch { void openGuide(); }
});
onBeforeUnmount(() => { generation++; window.removeEventListener('composeops:show-onboarding', openGuide); });
</script>

<style scoped>
.guide-intro { display: flex; align-items: center; gap: 12px; border-radius: 12px; background: linear-gradient(120deg, rgba(110,231,183,.045), transparent); }
.guide-intro .scene-illustration { width: 160px; margin: -12px -8px; }
.guide-intro > div { min-width: 0; }
.guide-eyebrow { margin-bottom: 6px; color: var(--color-status-ok); font-size: 11px; letter-spacing: .08em; }
.guide-step { transition: border-color 160ms ease; }
.guide-step:focus-within { border-color: rgba(110,231,183,.4); }
@media (max-width: 479px) { .guide-intro .scene-illustration { width: 100px; margin-left: -14px; }.guide-intro { gap: 6px; } }
@media (prefers-reduced-motion: reduce) { .guide-step { transition: none; } }
</style>
