<template>
  <div v-if="!auth.ready" class="h-dvh grid place-items-center text-surface-400">
    <div class="flex flex-col items-center gap-3">
      <span class="loading-mark"></span>
      <span class="text-sm">正在连接 ComposeOps...</span>
    </div>
  </div>
  <LoginView v-else-if="!auth.authenticated" />
  <div v-else class="h-dvh min-h-0 flex flex-col overflow-hidden relative">
    <AppHeader @logout="auth.logout" @open-agent="openAgent" />
    <div class="flex min-h-0 flex-1 overflow-hidden pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
      <AppSidebar />
      <main class="app-main flex-1 min-w-0 overflow-auto" @scroll.passive="onMainScroll" @touchstart.passive="onPullStart" @touchmove.passive="onPullMove" @touchend.passive="onPullEnd">
        <div class="pull-indicator" :style="{ transform: 'translateY(' + pullY + 'px)', opacity: pullY > 0 ? 1 : 0 }">
          <span v-if="refreshing" class="loading-mark"></span>
          <RefreshCw v-else class="w-4 h-4" :class="{ 'rotate-180': pullY >= pullThreshold }" />
        </div>
        <div class="content-outer mx-auto h-full min-h-full w-full">
          <router-view v-slot="{ Component }">
            <transition name="page-fade" mode="out-in" @after-enter="restoreRouteScroll">
              <keep-alive :include="keepAliveViews">
                <component :is="Component" />
              </keep-alive>
            </transition>
          </router-view>
        </div>
      </main>
    </div>
    <div v-if="runtimeError" class="runtime-error-bar">
      <span class="min-w-0 flex-1 truncate">{{ runtimeError }}</span>
      <button class="shrink-0 text-xs underline" @click="dismissError">忽略并继续</button>
      <button class="shrink-0 text-xs underline" @click="reloadApp">重新加载</button>
    </div>
    <ToastContainer />
    <CheatSheetModal :open="cheatSheet" @close="cheatSheet = false" />
    <AgentDrawer />
    <OnboardingGuide />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onErrorCaptured, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppHeader from './components/AppHeader.vue';
import AppSidebar from './components/AppSidebar.vue';
import ToastContainer from './components/common/ToastContainer.vue';
import { RefreshCw } from 'lucide-vue-next';
import CheatSheetModal from './components/common/CheatSheetModal.vue';
import AgentDrawer from './components/AgentDrawer.vue';
import OnboardingGuide from './components/common/OnboardingGuide.vue';
import LoginView from './views/LoginView.vue';
import { useAuthStore } from './stores/auth.js';
import { useServicesStore } from './stores/services.js';
import { useToastStore } from './stores/toast.js';
import { useAgentConsole } from './composables/useAgentConsole.js';
import { preloadRouteChunks } from './router.js';

// keep-alive 白名单(SFC 文件名即组件名):
// 保住筛选、展开、输入与重组件状态；共享滚动容器的位置由下方按路由单独恢复。
// 服务/日志页虽然有实时流，但必须在 onDeactivated 中断开、onActivated 中恢复，不能让后台页面继续占用连接。
const keepAliveViews = [
  'ServicesView', 'LogsView', 'TopologyView',
  'ComposeView', 'AgentExecutionHistoryView',
  'SettingsView', 'MarketplaceView', 'GitOpsView', 'CostAnalysisView',
  'ResourcesView', 'CMDBView', 'WorkflowCenterView',
];

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const servicesStore = useServicesStore();
const toast = useToastStore();
const { openAgent, startPageTracking, stopPageTracking } = useAgentConsole();
const cheatSheet = ref(false);
/* ---- 下拉刷新(移动端触屏)与头部大标题收缩 ---- */
const pullY = ref(0);
const refreshing = ref(false);
const pullThreshold = 72;
let pullStartY = 0;
let pullArmed = false;

function onMainScroll(e) {
  const top = e.target.scrollTop;
  document.querySelector('.app-header')?.classList.toggle('scrolled', top > 28);
}

function onPullStart(e) {
  if (refreshing.value) return;
  const scroller = e.currentTarget;
  pullStartY = e.touches[0].clientY;
  pullArmed = scroller.scrollTop <= 0;
}

function onPullMove(e) {
  if (!pullArmed || refreshing.value || e.touches.length !== 1) return;
  const delta = e.touches[0].clientY - pullStartY;
  pullY.value = delta > 0 ? Math.min(delta * 0.4, 96) : 0;
}

function onPullEnd() {
  if (!pullArmed || refreshing.value) { pullY.value = 0; return; }
  if (pullY.value >= pullThreshold) {
    refreshing.value = true;
    pullY.value = 48;
    window.dispatchEvent(new CustomEvent('composeops:refresh'));
    setTimeout(() => {
      refreshing.value = false;
      pullY.value = 0;
    }, 900);
  } else {
    pullY.value = 0;
  }
}

const runtimeError = ref('');
// density 的读写只由 AppHeader 一处负责;这里仅在挂载时按已存偏好初始化 body 标记。
function applyDensity() {
  const value = localStorage.getItem('composeops:density') || 'comfortable';
  document.body.dataset.density = value;
  localStorage.setItem('composeops:density', value);
}
const expire = () => auth.expire();
const refreshOnHostChange = () => { void servicesStore.refreshForHost(); };

// Keep the shared app scroller position per route while pages are cached.
const routeScrollPositions = new Map();
let pendingScrollRestoreRoute = null;
watch(() => route.fullPath, (currentPath, previousPath) => {
  const scroller = document.querySelector('.app-main');
  const previousName = router.resolve(previousPath).name;
  if (previousName && scroller) routeScrollPositions.set(previousName, scroller.scrollTop);
  pendingScrollRestoreRoute = router.resolve(currentPath).name;
});
function restoreRouteScroll() {
  const routeName = pendingScrollRestoreRoute || route.name;
  pendingScrollRestoreRoute = null;
  const scroller = document.querySelector('.app-main');
  if (!scroller) return;
  scroller.scrollTop = routeScrollPositions.get(routeName) || 0;
  document.querySelector('.app-header')?.classList.toggle('scrolled', scroller.scrollTop > 28);
}

function onGlobalKeydown(event) {
  if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target?.tagName && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
  if (target?.isContentEditable) return;
  event.preventDefault();
  cheatSheet.value = true;
}
function openCheatSheet() { cheatSheet.value = true; }
function dismissError() { runtimeError.value = ''; }
function onRuntimeError(event) { runtimeError.value = event?.detail?.message || '发生未知运行时错误'; }
function onOperationStarted(event) { const detail = event?.detail || {}; toast.success(`已提交${detail.projectName || ''} ${ACTION_LABELS[detail.action] || detail.action} 操作,可在操作中心查看进度`); }
const ACTION_LABELS = { up: '启动', stop: '停止', restart: '重启', pull: '拉取' };
function reloadApp() { window.location.reload(); }
onErrorCaptured((error) => {
  console.error('[ComposeOps] captured component error:', error?.stack || error?.message || error);
  runtimeError.value = `页面组件异常:${error?.message || error}`;
  return false; // 不阻止向上传播,但避免整页白屏
});
onMounted(() => {
  applyDensity();
  startPageTracking();
  // 空闲时预取路由 chunk,首访页面不再因下载+解析顿一下
  if ('requestIdleCallback' in window) requestIdleCallback(() => preloadRouteChunks(), { timeout: 4000 });
  else setTimeout(() => preloadRouteChunks(), 1500);
  window.addEventListener('composeops:runtime-error', onRuntimeError);
  window.addEventListener('composeops:operation-started', onOperationStarted);
  window.addEventListener('composeops:unauthorized', expire);
  window.addEventListener('composeops:host-changed', refreshOnHostChange);
  window.addEventListener('keydown', onGlobalKeydown, { capture: true });
  window.addEventListener('composeops:open-cheatsheet', openCheatSheet);
  auth.check();
});
onBeforeUnmount(() => {
  stopPageTracking();
  window.removeEventListener('composeops:runtime-error', onRuntimeError);
  window.removeEventListener('composeops:operation-started', onOperationStarted);
  window.removeEventListener('composeops:unauthorized', expire);
  window.removeEventListener('composeops:host-changed', refreshOnHostChange);
  window.removeEventListener('keydown', onGlobalKeydown, { capture: true });
  window.removeEventListener('composeops:open-cheatsheet', openCheatSheet);
});
</script>
