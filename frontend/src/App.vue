<template>
  <div v-if="!auth.ready" class="h-dvh grid place-items-center text-surface-400">
    <div class="flex flex-col items-center gap-3">
      <span class="loading-mark"></span>
      <span class="text-sm">正在连接 ComposeOps...</span>
    </div>
  </div>
  <LoginView v-else-if="!auth.authenticated" />
  <div v-else class="h-dvh min-h-0 flex flex-col overflow-hidden">
    <AppHeader @logout="auth.logout" @open-agent="openAgent" />
    <div class="flex min-h-0 flex-1 overflow-hidden pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
      <AppSidebar />
      <main class="app-main flex-1 min-w-0 overflow-auto">
        <div class="content-outer mx-auto h-full min-h-full w-full py-5 sm:py-6">
          <router-view v-slot="{ Component }">
            <transition name="page-fade" mode="out-in">
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
import { onBeforeUnmount, onErrorCaptured, onMounted, ref } from 'vue';
import AppHeader from './components/AppHeader.vue';
import AppSidebar from './components/AppSidebar.vue';
import ToastContainer from './components/common/ToastContainer.vue';
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
// 保住输入中状态、滚动位置与重组件(Monaco/终端/会话),切回页面零重建。
// 实时数据页与任务页刻意不保活,切页后及时释放 WebSocket、SSE 和轮询。
const keepAliveViews = [
  'ComposeView', 'AgentExecutionHistoryView',
  'SettingsView', 'MarketplaceView', 'GitOpsView', 'CostAnalysisView',
  'ResourcesView', 'CMDBView', 'WorkflowCenterView',
];

const auth = useAuthStore();
const servicesStore = useServicesStore();
const toast = useToastStore();
const { openAgent, startPageTracking, stopPageTracking } = useAgentConsole();
const cheatSheet = ref(false);
const runtimeError = ref('');
// density 的读写只由 AppHeader 一处负责;这里仅在挂载时按已存偏好初始化 body 标记。
function applyDensity() {
  const value = localStorage.getItem('composeops:density') || 'comfortable';
  document.body.dataset.density = value;
  localStorage.setItem('composeops:density', value);
}
const expire = () => auth.expire();
const refreshOnHostChange = () => { void servicesStore.refreshForHost(); };

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
