<template>
  <header class="app-header">
    <router-link class="app-brand" to="/dashboard" aria-label="ComposeOps，返回运维总览">
      <BrandMark class="brand-mark" />
      <span class="brand-title">ComposeOps</span>
    </router-link>
    <div class="header-actions">
      <button class="header-control command-trigger" title="快速跳转（Ctrl / ⌘ K）" aria-label="打开快速跳转" @click="commandOpen = true">
        <Search class="h-4 w-4" />
        <span class="command-label">快速跳转</span>
        <kbd class="command-key" aria-hidden="true">{{ commandShortcut }}</kbd>
      </button>
      <span class="header-connection" role="status" :data-state="backendOnline === null ? 'pending' : backendOnline ? 'online' : 'offline'" title="控制台连接状态，项目健康请查看总览">
        <span class="header-status-dot" aria-hidden="true"></span><span>{{ backendOnline === null ? '连接中' : backendOnline ? '控制台已连接' : '控制台离线' }}</span>
      </span>
      <div class="relative header-project-switcher">
        <button ref="projectSwitcherTriggerRef" class="header-control header-project" title="快速切换项目" aria-label="快速切换项目" :aria-expanded="projectSwitcherOpen" :aria-controls="projectSwitcherOpen ? 'project-switcher-panel' : undefined" @click="toggleProjectSwitcher">
          <Layers class="w-4 h-4" /><span class="hidden min-[380px]:inline">项目</span>
          <ChevronDown class="header-chevron w-3 h-3" />
        </button>
        <div v-if="projectSwitcherOpen" class="header-popover-backdrop" aria-hidden="true" @click.self="projectSwitcherOpen = false"></div>
        <div v-if="projectSwitcherOpen" id="project-switcher-panel" ref="projectSwitcherPanelRef" class="absolute right-0 top-full mt-2 w-64 overflow-hidden rounded-xl border border-surface-800 bg-surface-950 shadow-2xl z-[46]" role="dialog" aria-modal="true" aria-labelledby="project-switcher-title" tabindex="-1" @keydown="trapProjectSwitcherTab">
          <div id="project-switcher-title" class="border-b border-surface-800 px-3 py-2 text-xs font-semibold text-surface-300">快速切换项目</div>
          <label class="search-field mx-2 my-2 flex-none">
            <Search class="h-3.5 w-3.5 shrink-0" />
            <input ref="projectSwitcherSearchRef" v-model="projectQuery" type="search" aria-label="搜索项目" placeholder="搜索项目、归属或路径" />
          </label>
          <div class="max-h-80 overflow-y-auto p-1.5">
            <button v-for="p in quickProjects" :key="p.id" class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-surface-800/60" @click="goProject(p)">
              <span class="status-dot shrink-0" :class="projectStatusDotClass(p.status)"></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-mono text-surface-200">{{ p.projectName }}</span>
                <span class="block truncate text-[10px] text-surface-400">{{ p.owner }} · {{ p.containers.length }} 容器</span>
              </span>
              <span v-if="p.managed" class="count-badge shrink-0 text-[9px] text-status-ok">纳管</span>
            </button>
            <p v-if="!quickProjects.length" class="px-2 py-4 text-center text-xs text-surface-400">{{ projectQuery ? '没有匹配的项目' : '暂无项目' }}</p>
          </div>
        </div>
      </div>
      <HostSwitcher />
      <EventCenter />
      <button class="icon-btn" title="打开页面 Agent" aria-label="打开页面 Agent" @click="emitAgentOpen"><Bot class="w-4 h-4 text-status-info" /></button>
      <button class="icon-btn hidden sm:inline-flex header-density" :title="density === 'compact' ? '切换为舒适视图' : '切换为紧凑视图'" aria-label="紧凑布局" :aria-pressed="density === 'compact'" @click="toggleDensity"><Rows3 class="w-4 h-4" /></button>
      <time class="header-clock" :datetime="currentDateTime" title="本地时间">{{ currentTime }}</time>
      <span class="header-divider" aria-hidden="true"></span>
      <button class="icon-btn header-logout" title="退出登录" aria-label="退出登录" @click="$emit('logout')"><LogOut class="w-4 h-4" /></button>
    </div>
  </header>

  <CommandPalette :show="commandOpen" :commands="commands" :recent-ids="recentPageIds" @close="commandOpen = false" @execute="runCommand" @clear-recent="recentPageIds = clearRecentPages()" />
  <ConfirmDialog
    :show="!!pendingProjectAction"
    title="停止项目"
    :message="`确认停止 ${pendingProjectAction?.projectName || ''} 中正在运行的容器？容器和数据不会删除。`"
    tone="warning"
    confirm-text="停止项目"
    :busy="projectActionBusy"
    @confirm="confirmProjectAction"
    @cancel="pendingProjectAction = null"
  />
</template>

<script setup>
import { pageCommands } from '../lib/page-navigation.js';
import { deepLink } from '../lib/deep-links.js';
import { computed, nextTick, ref, watch, onMounted, onUnmounted } from 'vue';
import BrandMark from './common/BrandMark.vue';
import { useRoute, useRouter } from 'vue-router';
import { Bot, ChevronDown, KeyRound, Layers, LogOut, Play, RotateCw, Rows3, ScrollText, Search, Square, Store } from 'lucide-vue-next';
import EventCenter from './EventCenter.vue';
import HostSwitcher from './HostSwitcher.vue';
import CommandPalette from './common/CommandPalette.vue';
import ConfirmDialog from './common/ConfirmDialog.vue';
import { api, bumpHostEpoch } from '../api/client.js';
import { useHostsStore } from '../stores/hosts.js';
import { useToastStore } from '../stores/toast.js';
import { useEscapeKey } from '../composables/useEscapeKey.js';
import { clearRecentPages, readRecentPages, rememberPage } from '../lib/command-history.js';

const route = useRoute();
const router = useRouter();
const hostsStore = useHostsStore();
const toast = useToastStore();
const backendOnline = ref(null);
const currentTime = ref('');
const currentDateTime = ref('');
const commandShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
function updateClock() {
  const now = new Date();
  currentDateTime.value = now.toISOString();
  currentTime.value = now.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
const commandOpen = ref(false);
const projectSwitcherOpen = ref(false);
const projectQuery = ref('');
const projectSwitcherTriggerRef = ref(null);
const projectSwitcherSearchRef = ref(null);
const projectSwitcherPanelRef = ref(null);
let previousProjectSwitcherFocus = null;
watch(projectSwitcherOpen, async (isOpen) => {
  if (isOpen) {
    previousProjectSwitcherFocus = projectSwitcherTriggerRef.value || document.activeElement;
    await nextTick();
    if (projectSwitcherOpen.value) projectSwitcherSearchRef.value?.focus({ preventScroll: true });
    return;
  }
  if (previousProjectSwitcherFocus?.isConnected) previousProjectSwitcherFocus.focus({ preventScroll: true });
  previousProjectSwitcherFocus = null;
});
function trapProjectSwitcherTab(event) {
  if (event.key !== 'Tab') return;
  const panel = projectSwitcherPanelRef.value;
  if (!panel) return;
  const focusable = [...panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter((element) => {
    if (element.closest('[hidden]') || element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
  if (!focusable.length) {
    event.preventDefault();
    panel.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

useEscapeKey({ active: projectSwitcherOpen, onClose: () => { projectSwitcherOpen.value = false; }, layer: 'event' });
const pendingProjectAction = ref(null);
const projectActionBusy = ref(false);
const density = ref(localStorage.getItem('composeops:density') || 'comfortable');
function toggleDensity() { density.value = density.value === 'compact' ? 'comfortable' : 'compact'; document.body.dataset.density = density.value; localStorage.setItem('composeops:density', density.value); }
/** 归一化 API 返回值,避免非数组形态触发 `.slice`/`.filter` 报错。 */
function asArray(value) { return Array.isArray(value) ? value : []; }
const allProjects = ref([]);
const quickProjects = computed(() => {
  const query = projectQuery.value.trim().toLocaleLowerCase();
  return asArray(allProjects.value)
    .filter((project) => !query || [project.projectName, project.owner, project.workingDir].some((value) => String(value || '').toLocaleLowerCase().includes(query)))
    .slice(0, 20);
});
const envProjects = ref([]);
const appBlueprints = ref([]);
const baseCommands = pageCommands;
const recentAllowedIds = baseCommands.map(item => item.to);
const recentPageIds = ref(readRecentPages(recentAllowedIds));
const commands = computed(() => {
  const nodeCommands = hostsStore.hosts
    .filter((host) => host.id !== hostsStore.activeHostId)
    .map((host) => ({
      id: `node-${host.id}`,
      run: () => void switchNode(host),
      label: `切换节点:${host.name}`,
      description: host.type === 'local' ? '切换到本机 Docker' : `切换到 ${host.type.toUpperCase()} ${host.host}:${host.port}`,
      icon: Layers,
      category: `switch node host docker 节点 切换 ${host.name}`,
    }));
  const envCommands = asArray(envProjects.value)
    .filter((project) => project.editable)
    .map((project) => ({
      id: `env-${project.id}`,
      to: deepLink('/services', { env: project.id, from: route.name }),
      label: `Env: ${project.projectName}`,
      description: `编辑 ${project.projectName} 的环境变量 (.env)`,
      icon: KeyRound,
      category: `env environment variable 环境变量 ${project.projectName}`,
    }));
  const blueprintCommands = asArray(appBlueprints.value)
    .slice(0, 12)
    .map((blueprint) => ({
      id: `blueprint-${blueprint.name}`,
      to: '/marketplace',
      label: `应用市场: ${blueprint.name}`,
      description: `一键部署 ${blueprint.name} (${blueprint.category})`,
      icon: Store,
      category: `app store blueprint deploy marketplace 部署 应用市场 模板市场 ${blueprint.name}`,
    }));
  const actionCommands = asArray(allProjects.value)
    .filter((project) => project.managed)
    .flatMap((project) => ([
      { id: `run-${project.id}-up`, run: () => void runProjectAction(project, 'up'), label: `启动: ${project.projectName}`, description: '通过 Compose 启动项目', icon: Play, category: `start up 启动 运行 ${project.projectName}` },
      { id: `run-${project.id}-restart`, run: () => void runProjectAction(project, 'restart'), label: `重启: ${project.projectName}`, description: '重启项目所有容器', icon: RotateCw, category: `restart reboot 重启 ${project.projectName}` },
      { id: `run-${project.id}-stop`, run: () => requestProjectAction(project, 'stop'), label: `停止: ${project.projectName}`, description: '停止项目所有容器', icon: Square, category: `stop halt 停止 ${project.projectName}` },
      { id: `logs-${project.id}`, to: deepLink('/logs', { projectId: project.id, from: route.name }), label: `日志: ${project.projectName}`, description: '查看项目实时日志', icon: ScrollText, category: `logs 日志 ${project.projectName}` },
    ]));
  return [...baseCommands, ...actionCommands, ...nodeCommands, ...envCommands, ...blueprintCommands].map((item) =>
    item.id ? item : { ...item, id: item.to },
  );
});

function goProject(project) {
  projectSwitcherOpen.value = false;
  projectQuery.value = '';
  router.push(deepLink('/services', { focus: project.id, from: route.name }));
}
function toggleProjectSwitcher() {
  projectSwitcherOpen.value = !projectSwitcherOpen.value;
  projectQuery.value = '';
}
// 与 StatusBadge.vue 的 STATUS 语义一致:运行=emerald、部分异常=restarting/amber、停止=surface、异常=rose。
const PROJECT_STATUS_DOT = { running: 'bg-status-ok', restarting: 'bg-status-warn', partial: 'bg-status-warn', stopped: 'bg-surface-500' };
function projectStatusDotClass(status) {
  return PROJECT_STATUS_DOT[status] || 'bg-status-error';
}
async function runProjectAction(project, action) {
  try {
    await api.createProjectBatchJob([project.id], action);
    window.dispatchEvent(new CustomEvent('composeops:operation-started', { detail: { projectName: project.projectName, action } }));
    return true;
  } catch (error) {
    toast.error(`操作提交失败：${error?.message || '未知错误'}`);
    return false;
  }
}
function requestProjectAction(project, action) {
  if (action === 'stop') {
    pendingProjectAction.value = project;
    return;
  }
  void runProjectAction(project, action);
}
async function confirmProjectAction() {
  const project = pendingProjectAction.value;
  if (!project || projectActionBusy.value) return;
  projectActionBusy.value = true;
  try {
    if (await runProjectAction(project, 'stop')) pendingProjectAction.value = null;
  } finally {
    projectActionBusy.value = false;
  }
}
const emit = defineEmits(['logout', 'open-agent']);
function emitAgentOpen() {
  emit('open-agent');
}
let pingTimer; let clockTimer;

let pingInitialized = false;
/**
 * 窄屏隐藏连接文字,状态翻转时通过 toast 提供反馈。
 * 这里只在状态真的翻转时补一条 toast(首次探测不算翻转,避免进页面就弹提示)。
 */
async function ping() {
  let online;
  try {
    const res = await fetch('/health');
    online = res.ok;
  } catch {
    online = false;
  }
  if (pingInitialized && online !== backendOnline.value) {
    if (online) toast.success('后端服务已恢复连接');
    else toast.error('后端服务连接中断,数据可能不是最新');
  }
  pingInitialized = true;
  backendOnline.value = online;
}
function closeCommand() { commandOpen.value = false; }
async function runCommand(item) {
  if (item.run) { item.run(); closeCommand(); return; }
  closeCommand();
  try {
    const failure = await router.push(item.to);
    if (!failure && recentAllowedIds.includes(item.id)) recentPageIds.value = rememberPage(recentPageIds.value, item.id, recentAllowedIds);
  } catch (error) {
    toast.error(`页面打开失败：${error?.message || '请重试'}`);
  }
}
async function switchNode(host) {
  try {
    await hostsStore.switchHost(host.id);
    if (route.path === '/dashboard') await router.replace({ query: { ...route.query, hostId: host.id, resource: 'host' } });
  } catch (error) {
    toast.error(`切换到 ${host.name} 失败：${error?.message || '未知错误'}`);
  }
}
async function reloadHostProjects() {
  const currentRequest = ++projectRequestId;
  try {
    const data = await api.getProjects(true);
    if (currentRequest !== projectRequestId) return;
    const list = asArray(data?.projects);
    envProjects.value = list.filter((project) => project.editable);
    allProjects.value = list;
  } catch {
    if (currentRequest !== projectRequestId) return;
    envProjects.value = [];
    allProjects.value = [];
  }
}
let projectRequestId = 0;
function onHostChanged() {
  bumpHostEpoch();
  projectSwitcherOpen.value = false;
  envProjects.value = [];
  allProjects.value = [];
  void reloadHostProjects();
  void api.getBlueprints(true).then((data) => { appBlueprints.value = asArray(data?.blueprints); }).catch(() => {});
}
function onProjectsChanged() {
  projectSwitcherOpen.value = false;
  void reloadHostProjects();
}
function onGlobalKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); commandOpen.value = !commandOpen.value; }
}
onMounted(() => {
  if (!hostsStore.hosts.length) void hostsStore.load();
  void reloadHostProjects();
  void api.getBlueprints().then((data) => { appBlueprints.value = asArray(data?.blueprints); }).catch(() => {});
  ping();
  updateClock();
  pingTimer = setInterval(ping, 5000);
  clockTimer = setInterval(updateClock, 30000);
  window.addEventListener('keydown', onGlobalKeydown);
  window.addEventListener('composeops:host-changed', onHostChanged);
  window.addEventListener('composeops:projects-changed', onProjectsChanged);
});
onUnmounted(() => { clearInterval(pingTimer); clearInterval(clockTimer); window.removeEventListener('keydown', onGlobalKeydown); window.removeEventListener('composeops:host-changed', onHostChanged); window.removeEventListener('composeops:projects-changed', onProjectsChanged); });
</script>
