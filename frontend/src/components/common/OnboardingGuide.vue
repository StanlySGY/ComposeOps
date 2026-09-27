<template>
  <BaseModal :show="show" title="欢迎使用 ComposeOps" size-class="sm:max-w-lg" body-class="p-4 space-y-3" @close="dismiss">
    <p class="text-sm text-muted">全新环境,三步完成初始化,让运维台真正运转起来:</p>
    <ol class="space-y-2">
      <li v-for="step in steps" :key="step.n" class="flex items-start gap-3 rounded-xl border border-surface-800 bg-surface-950/40 p-3">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-emerald-900/40 bg-emerald-950/30 text-sm font-semibold text-emerald-300">{{ step.n }}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2"><component :is="step.icon" class="h-4 w-4 shrink-0 text-surface-300" /><h3 class="text-sm font-semibold text-surface-100">{{ step.title }}</h3></div>
          <p class="mt-1 text-xs leading-5 text-surface-400">{{ step.desc }}</p>
        </div>
        <router-link :to="step.to" class="btn-secondary shrink-0 !px-2.5 !py-1 text-xs" @click="dismiss">前往</router-link>
      </li>
    </ol>
    <template #footer>
      <button class="btn-primary" @click="dismiss">开始使用</button>
    </template>
  </BaseModal>
</template>

<script setup>
// 首次运行引导:仅在"从未看过引导且一个项目都没有"的全新环境弹一次,看过或有项目即永久静默
import { onMounted, ref } from 'vue';
import { Bot, FileCode2, ShieldCheck } from 'lucide-vue-next';
import BaseModal from './BaseModal.vue';
import { api } from '../../api/client.js';

const STORAGE_KEY = 'composeops:onboarding-dismissed';
const show = ref(false);

const steps = [
  { n: 1, icon: FileCode2, title: '纳管 Compose 项目', desc: '在设置中选择要管理的项目与挂载目录,服务列表、拓扑与配置编辑会随之出现', to: '/settings?tab=mounts' },
  { n: 2, icon: Bot, title: '配置 AI 助手', desc: '填入 OpenAI 兼容接口与模型,启用 AI 诊断、巡检与 Agent 自动执行', to: '/settings?tab=ai' },
  { n: 3, icon: ShieldCheck, title: '跑一次 AI 巡检', desc: '一键体检容器、磁盘、内存与备份时效,拿到结论与修复建议', to: '/inspection' },
];

function dismiss() {
  show.value = false;
  try { localStorage.setItem(STORAGE_KEY, '1'); } catch {
    // 无法写入本地存储时本次仍关闭引导,下次打开会再次显示。
  }
}

onMounted(async () => {
  try {
    if (localStorage.getItem(STORAGE_KEY)) return;
    const data = await api.getProjects();
    const projects = Array.isArray(data) ? data : data.projects || [];
    if (projects.length === 0) show.value = true;
    else localStorage.setItem(STORAGE_KEY, '1');
  } catch { /* 首次探测失败不打扰用户 */ }
});
</script>
