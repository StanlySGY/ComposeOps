<template>
  <aside class="app-sidebar fixed md:static bottom-0 left-0 right-0 z-40 h-16 md:h-auto md:w-[216px] shrink-0 flex flex-col">
    <nav class="hidden md:flex md:flex-col flex-1 md:px-3 md:py-4 overflow-y-auto">
      <div class="hidden md:block px-2 pb-1 pt-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-surface-500">运行</div>
      <router-link
        v-for="item in primaryItems"
        :key="item.to"
        :to="item.to"
        class="nav-link group flex-1 min-w-16 md:flex-none md:min-w-0 flex flex-col md:flex-row items-center justify-center md:justify-start gap-1 md:gap-3 px-2 md:px-3 py-1.5 md:py-2.5 text-[11px] md:text-sm text-surface-400"
        active-class="nav-link-active"
      >
        <component :is="item.icon" class="w-[18px] h-[18px] shrink-0" />
        <span class="md:flex-1">{{ item.label }}</span>
        <span class="nav-indicator hidden md:block w-1.5 h-1.5 rounded-full bg-accent opacity-0"></span>
      </router-link>
      <section v-for="group in desktopGroups" :key="group.label" class="mt-3 first:mt-4">
        <div class="px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-surface-500">{{ group.label }}</div>
        <router-link
          v-for="item in group.items"
          :key="item.to"
          :to="item.to"
          class="nav-link group flex md:flex-row items-center justify-start gap-3 px-3 py-2 text-sm text-surface-400"
          active-class="nav-link-active"
        >
          <component :is="item.icon" class="w-[18px] h-[18px] shrink-0" />
          <span class="flex-1">{{ item.label }}</span>
        </router-link>
      </section>
    </nav>
    <nav class="flex md:hidden h-16 items-stretch justify-around px-1 pb-[env(safe-area-inset-bottom)]" aria-label="主导航">
      <router-link v-for="item in mobileItems" :key="item.to" :to="item.to" class="nav-link flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-[10px] text-surface-400" active-class="nav-link-active">
        <component :is="item.icon" class="h-[18px] w-[18px] shrink-0" />
        <span class="max-w-full truncate">{{ item.label }}</span>
      </router-link>
      <button class="nav-link flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-[10px] text-surface-400" :class="{ 'nav-link-active': moreOpen }" aria-label="更多功能" @click="moreOpen = true">
        <Menu class="h-[18px] w-[18px]" />
        <span>更多</span>
      </button>
    </nav>
    <div class="hidden md:block mx-4 mb-4 rounded-xl border border-surface-800/80 bg-surface-950/50 p-3">
      <div class="flex items-center gap-2 text-xs text-surface-300"><span class="status-dot bg-emerald-400"></span>本地控制台</div>
      <p class="mt-1.5 text-[11px] leading-4 text-surface-600">集中管理 Compose 服务与运行状态</p>
    </div>
  </aside>
  <teleport to="body">
    <div v-if="moreOpen" class="fixed inset-0 z-51 bg-black/55 md:hidden" @click.self="moreOpen = false">
      <section class="absolute inset-x-0 bottom-0 max-h-[78dvh] overflow-y-auto rounded-t-2xl border-t border-surface-700 bg-surface-950 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl" role="dialog" aria-modal="true" aria-label="更多功能">
        <div class="mb-3 flex items-center justify-between"><div><h2 class="text-base font-semibold text-surface-100">更多功能</h2><p class="mt-0.5 text-xs text-muted">配置、排障与系统工具</p></div><button class="icon-btn" title="关闭" @click="moreOpen = false">×</button></div>
        <div v-for="group in mobileGroups" :key="group.label" class="mb-4 last:mb-0">
          <h3 class="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-surface-600">{{ group.label }}</h3>
          <div class="grid grid-cols-2 gap-2">
            <router-link v-for="item in group.items" :key="item.to" :to="item.to" class="flex min-h-14 items-center gap-3 rounded-xl border border-surface-800 bg-surface-900/60 px-3 py-2.5 text-sm text-surface-300 transition hover:border-surface-600 hover:bg-surface-800" @click="moreOpen = false">
              <component :is="item.icon" class="h-4 w-4 shrink-0 text-accent" /><span>{{ item.label }}</span>
            </router-link>
          </div>
        </div>
      </section>
    </div>
  </teleport>
</template>

<script setup>
import { ref } from 'vue';
import { useEscapeKey } from '../composables/useEscapeKey.js';
import { Boxes, Clock3, FileCode2, ScrollText, TerminalSquare, Bot, ChartNoAxesCombined, HardDrive, Settings, Store, Activity, GitBranch, DollarSign, Menu, ShieldCheck, Network, FileSearch, Workflow, ServerCog, Database, BellRing, History } from 'lucide-vue-next';
const primaryItems = [
  { to: '/dashboard', icon: Activity, label: '总览' },
  { to: '/services', icon: Boxes, label: '服务' },
  { to: '/compose', icon: FileCode2, label: '配置' },
  { to: '/logs', icon: ScrollText, label: '日志' },
  { to: '/agent', icon: Bot, label: 'AI 助手' },
];
const navGroups = [
  {
    label: '观测',
    items: [
      { to: '/topology', icon: Network, label: '拓扑' },
      { to: '/monitor', icon: ChartNoAxesCombined, label: '实时监控' },
      { to: '/events', icon: BellRing, label: '事件中心' },
      { to: '/inspection', icon: ShieldCheck, label: 'AI 巡检' },
      { to: '/agent/history', icon: History, label: 'Agent 执行历史' },
    ],
  },
  {
    label: '自动化',
    items: [
      { to: '/ops-center', icon: Workflow, label: '运维任务' },
      { to: '/workflows', icon: Workflow, label: '工作流' },
      { to: '/cron', icon: Clock3, label: '定时任务' },
      { to: '/gitops', icon: GitBranch, label: 'GitOps' },
      { to: '/review', icon: FileSearch, label: '变更与回滚' },
    ],
  },
  {
    label: '资源',
    items: [
      { to: '/cmdb', icon: Database, label: '资产中心' },
      { to: '/node-groups', icon: ServerCog, label: '节点组' },
      { to: '/marketplace', icon: Store, label: '应用市场' },
      { to: '/resources', icon: HardDrive, label: '存储清理' },
      { to: '/cost', icon: DollarSign, label: '成本分析' },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/shell', icon: TerminalSquare, label: '终端' },
      { to: '/settings', icon: Settings, label: '设置' },
    ],
  },
];
const desktopGroups = navGroups;
const moreOpen = ref(false);
const mobileItems = [primaryItems[0], primaryItems[1], primaryItems[3], primaryItems[4]];
const mobileGroups = navGroups;
useEscapeKey({ active: moreOpen, layer: 'drawer', onClose: () => { moreOpen.value = false; }, lockBody: true });
</script>
