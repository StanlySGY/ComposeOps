<template>
  <nav class="workspace-navigation" aria-label="页面导航" :aria-busy="loading">
    <div class="navigation-controls" role="group" aria-label="浏览历史">
      <button class="navigation-back" :disabled="!backTarget || loading" :aria-label="backLabel" :title="backLabel" @click="goBack">
        <ArrowLeft class="h-4 w-4" /><span>返回</span><span v-if="backTarget" class="navigation-back-name">{{ pageDetails(backTarget).label }}</span>
      </button>
      <button class="navigation-forward" :disabled="!forwardTarget || loading" :aria-label="forwardLabel" :title="forwardLabel" @click="router.forward()"><ArrowRight class="h-4 w-4" /></button>
    </div>
    <span class="navigation-divider" aria-hidden="true"></span>
    <ol class="navigation-breadcrumbs">
      <li class="navigation-home"><router-link to="/dashboard" aria-label="返回运维总览" title="运维总览"><House class="h-3.5 w-3.5" /></router-link><ChevronRight class="h-3 w-3" aria-hidden="true" /></li>
      <li v-if="parent && route.name !== 'dashboard'" class="navigation-parent"><router-link :to="parent.fullPath">{{ pageDetails(parent).label }}</router-link><ChevronRight class="h-3 w-3" aria-hidden="true" /></li>
      <li v-else-if="route.name !== 'dashboard'" class="navigation-parent"><span>{{ page.group }}</span><ChevronRight class="h-3 w-3" aria-hidden="true" /></li>
      <li class="navigation-current" aria-current="page" :title="page.label">{{ page.label }}</li>
    </ol>
    <span class="sr-only" role="status" aria-live="polite">{{ loading ? '正在打开页面' : page.label }}</span>
    <span v-if="loading" class="navigation-progress" aria-hidden="true"></span>
  </nav>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, ArrowRight, ChevronRight, House } from 'lucide-vue-next';
import { fallbackTarget, historyTarget, pageDetails } from '../lib/navigation.js';

const route = useRoute();
const router = useRouter();
const state = shallowRef({ ...router.options.history.state });
const loading = ref(false);
let loadingTimer;
const page = computed(() => pageDetails(route));
const parent = computed(() => page.value.parent ? router.resolve({ name: page.value.parent }) : null);
const previous = computed(() => historyTarget(router, state.value.back, route));
const backTarget = computed(() => previous.value || fallbackTarget(router, route));
const forwardTarget = computed(() => historyTarget(router, state.value.forward, route));
const backLabel = computed(() => backTarget.value ? `返回${pageDetails(backTarget.value).label}` : '已在起始页');
const forwardLabel = computed(() => forwardTarget.value ? `前进到${pageDetails(forwardTarget.value).label}` : '没有可前进的页面');

function goBack() {
  if (previous.value) router.back();
  else if (backTarget.value) void router.replace(backTarget.value.fullPath);
}
function finishNavigation() {
  clearTimeout(loadingTimer);
  loading.value = false;
  state.value = { ...router.options.history.state };
}
const removeBefore = router.beforeEach(() => {
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => { loading.value = true; }, 180);
});
const removeAfter = router.afterEach(finishNavigation);
const removeError = router.onError(finishNavigation);
watch(() => route.fullPath, () => {
  document.title = `${page.value.label} · ComposeOps`;
}, { immediate: true });
onBeforeUnmount(() => {
  clearTimeout(loadingTimer);
  removeBefore(); removeAfter(); removeError();
});
</script>

<style scoped>
.workspace-navigation { position: relative; display: flex; min-height: 46px; flex-shrink: 0; align-items: center; gap: 14px; padding: 4px clamp(16px, 1.35vw, 28px); border-bottom: 1px solid rgba(148,163,184,.1); background: #141920; font-size: 12px; color: #8f9bab; }
.navigation-controls { display: flex; flex-shrink: 0; align-items: center; gap: 2px; }
.navigation-back, .navigation-forward { display: flex; min-height: 34px; align-items: center; justify-content: center; gap: 7px; padding: 5px 8px; border-radius: 7px; transition: background-color 140ms, color 140ms; }
.navigation-back:not(:disabled):hover, .navigation-forward:not(:disabled):hover { background: #242d39; color: #f1f5f9; }
.navigation-back:not(:disabled):hover svg { transform: translateX(-2px); }
.navigation-back svg { transition: transform 140ms; }
button:disabled { opacity: .35; cursor: default; }
.navigation-back-name { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #bec8d5; }
.navigation-divider { height: 18px; width: 1px; flex-shrink: 0; background: #303845; }
.navigation-breadcrumbs { display: flex; min-width: 0; align-items: center; gap: 9px; }
.navigation-breadcrumbs li { display: flex; min-width: 0; align-items: center; gap: 9px; }
.navigation-breadcrumbs a { border-radius: 4px; white-space: nowrap; transition: color 140ms; }
.navigation-breadcrumbs a:hover { color: #93c5fd; }
.navigation-current { display: block !important; color: #d9e2ed; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.navigation-progress { position: absolute; left: 0; bottom: -1px; height: 2px; width: 35%; background: #60a5fa; animation: navigation-loading 1.4s ease-in-out infinite; }
@keyframes navigation-loading { from { left: 0; width: 10%; } to { left: 65%; width: 35%; } }
@media (max-width: 767px) { .workspace-navigation { gap: 10px; padding-inline: 12px; min-height: 46px; } .navigation-back-name, .navigation-parent, .navigation-home { display: none !important; } .navigation-back, .navigation-forward { min-height: 38px; } .navigation-controls { gap: 0; } }
@media (prefers-reduced-motion: reduce) { *, .navigation-back svg { transition: none; animation: none; } .navigation-progress { width: 100%; opacity: .7; } }
</style>
