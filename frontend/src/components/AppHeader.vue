<template>
  <header class="app-header h-16 flex items-center justify-between gap-2 px-3 sm:px-6 shrink-0">
    <div class="flex min-w-0 items-center gap-2 sm:gap-3">
      <div class="brand-mark shrink-0"><Boxes class="w-5 h-5" /></div>
      <div class="brand-text min-w-0">
        <span class="brand-title block max-w-36 truncate text-sm sm:text-base font-semibold tracking-tight">ComposeOps</span>
        <p class="text-muted truncate">{{ currentPage }}</p>
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-1.5 sm:gap-3 text-sm">
      <button class="command-trigger hidden sm:inline-flex" title="快速跳转" aria-label="打开快速跳转" @click="commandOpen = true">
        <Search class="h-4 w-4" />
        <span class="hidden md:inline">快速跳转</span>
      </button>
      <button class="icon-btn sm:hidden" title="快速跳转" aria-label="打开快速跳转" @click="commandOpen = true">
        <Search class="h-4 w-4" />
      </button>
      <span v-if="backendOnline" class="status-pill text-emerald-300 hidden md:inline-flex">
        <span class="status-ping bg-emerald-400"></span><span class="hidden sm:inline">服务正常</span>
      </span>
      <span v-else class="status-pill text-rose-300 md:inline-flex hidden">
        <span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span><span class="hidden sm:inline">服务离线</span>
      </span>
      <div class="relative">
        <button class="btn-secondary min-h-8! px-2.5! py-1! text-xs" title="快速切换项目" aria-label="快速切换项目" @click="toggleProjectSwitcher">
          <Layers class="w-3.5 h-3.5" /><span class="hidden min-[380px]:inline">项目</span>
          <ChevronDown class="w-3 h-3" />
        </button>
        <div v-if="projectSwitcherOpen" class="command-backdrop" @click.self="projectSwitcherOpen = false"></div>
        <div v-if="projectSwitcherOpen" class="absolute right-0 top-full mt-2 w-64 overflow-hidden rounded-xl border border-surface-800 bg-surface-950 shadow-2xl z-60">
          <div class="border-b border-surface-800 px-3 py-2 text-xs font-semibold text-surface-300">快速切换项目</div>
          <label class="search-field mx-2 my-2 flex-none" aria-label="搜索项目">
            <Search class="h-3.5 w-3.5 shrink-0" />
            <input v-model="projectQuery" type="search" placeholder="搜索项目、归属或路径" />
          </label>
          <div class="max-h-80 overflow-y-auto p-1.5">
            <button v-for="p in quickProjects" :key="p.id" class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-surface-800/60" @click="goProject(p)">
              <span class="status-dot shrink-0" :class="projectStatusDotClass(p.status)"></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-mono text-surface-200">{{ p.projectName }}</span>
                <span class="block truncate text-[10px] text-surface-500">{{ p.owner }} · {{ p.containers.length }} 容器</span>
              </span>
              <span v-if="p.managed" class="count-badge shrink-0 text-[9px] text-emerald-300">纳管</span>
            </button>
            <p v-if="!quickProjects.length" class="px-2 py-4 text-center text-xs text-surface-600">{{ projectQuery ? '没有匹配的项目' : '暂无项目' }}</p>
          </div>
        </div>
      </div>
      <HostSwitcher />
      <EventCenter />
      <button class="icon-btn" title="打开页面 Agent" aria-label="打开页面 Agent" @click="emitAgentOpen"><Bot class="w-4 h-4 text-accent" /></button>
      <button class="icon-btn hidden sm:inline-flex header-density" :title="density === 'compact' ? '切换为舒适视图' : '切换为紧凑视图'" aria-label="视图密度" @click="toggleDensity"><Rows3 class="w-4 h-4" /></button>
      <span class="hidden lg:inline text-muted">{{ currentTime }}</span>
      <span class="hidden sm:inline h-5 w-px bg-surface-800"></span>
      <button class="icon-btn" title="退出登录" aria-label="退出登录" @click="$emit('logout')"><LogOut class="w-4 h-4" /></button>
    </div>
  </header>

  <CommandPalette :show="commandOpen" :commands="commands" @close="commandOpen = false" @execute="runCommand" />
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
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Activity, Bot, Boxes, ChartNoAxesCombined, ChevronDown, FileCode2, FileSearch, BellRing, History, KeyRound, Layers, LogOut, Play, RotateCw, Rows3, ScrollText, Search, Settings, ShieldCheck, Square, Store, TerminalSquare } from 'lucide-vue-next';
import EventCenter from './EventCenter.vue';
import HostSwitcher from './HostSwitcher.vue';
import CommandPalette from './common/CommandPalette.vue';
import ConfirmDialog from './common/ConfirmDialog.vue';
import { api, bumpHostEpoch } from '../api/client.js';
import { useHostsStore } from '../stores/hosts.js';
import { useToastStore } from '../stores/toast.js';

const route = useRoute();
const router = useRouter();
const hostsStore = useHostsStore();
const toast = useToastStore();
const backendOnline = ref(false);
const currentTime = ref('');
const commandOpen = ref(false);
const projectSwitcherOpen = ref(false);
const projectQuery = ref('');
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
const pageNames = { dashboard: '运维总览', services: '服务总览', compose: 'Compose 配置', logs: '实时日志', shell: '容器终端', agent: 'AI 智能运维 Agent', 'agent-history': 'Agent 执行历史', inspection: 'AI 巡检中心', monitor: '实时监控', review: '变更与回滚', events: '事件中心', resources: '存储清理', cron: '定时任务', gitops: 'GitOps', cost: '成本分析', topology: '服务拓扑', 'ops-center': '运维任务', 'node-groups': '节点组管理', cmdb: '资产中心', workflows: '工作流', marketplace: '应用市场', settings: '系统设置' };
const currentPage = computed(() => pageNames[route.name] || '运维控制台');
const envProjects = ref([]);
const appBlueprints = ref([]);
const baseCommands = [
  { to: '/dashboard', label: '运维总览', description: '项目健康、环境指标与最近事件', icon: Boxes, category: 'dashboard home 首页 概览' },
  { to: '/services', label: '服务总览', description: '查看项目健康状态并执行生命周期操作', icon: Boxes, category: 'dashboard stack container 项目 容器' },
  { to: '/compose', label: 'Compose 配置', description: '编辑、校验和恢复 Compose 文件', icon: FileCode2, category: 'yaml editor backup 配置 备份' },
  { to: '/logs', label: '实时日志', description: '连接容器输出并搜索、暂停或导出', icon: ScrollText, category: 'stdout stderr search 日志' },
  { to: '/shell', label: '容器终端', description: '打开受限的交互式 Shell', icon: TerminalSquare, category: 'terminal bash sh 终端' },
  { to: '/agent', label: 'AI 智能运维 Agent', description: '挂载日志、检索资料并执行 Compose 运维操作', icon: Bot, category: 'agent ai chat workflow 编排 执行 工具 运维 诊断 诊断 chat' },
  { to: '/inspection', label: 'AI 巡检中心', description: '只读巡检容器、磁盘、内存与备份时效,输出结论与建议', icon: ShieldCheck, category: 'inspection scan health check 巡检 体检 检查 报告' },
  { to: '/monitor', label: '实时监控', description: '检查容器 CPU、内存用量的实时概览', icon: ChartNoAxesCombined, category: 'metrics cpu memory 监控 realtime 实时' },
  { to: '/monitor?tab=history', label: '历史指标', description: '回看容器资源指标的历史曲线与异常', icon: Activity, category: 'history chart metrics 指标 曲线 历史' },
  { to: '/events?tab=operations', label: '操作与任务', description: '审计 Compose、配置和维护操作,跟踪后台任务', icon: History, category: 'history audit 记录 审计 任务 job' },
  { to: '/events', label: '事件中心', description: '统一查看告警事件、运维时间线与操作任务', icon: BellRing, category: 'alert event timeline 事件 告警 时间线' },
  { to: '/review', label: '变更与回滚', description: '部署前 AI 评审变更,出问题后一键回滚', icon: FileSearch, category: 'review rollback change 变更 评审 回滚' },
  { to: '/topology', label: '服务拓扑', description: '查看服务依赖、端口和数据卷关系', icon: Layers, category: 'topology dependencies graph 拓扑 依赖' },
  { to: '/agent/history', label: 'Agent 执行历史', description: '查看工具调用、执行结果与 token 用量', icon: History, category: 'agent history usage 历史 用量' },
  { to: '/ops-center', label: '运维任务', description: '编排项目升级与自动巡检任务', icon: Play, category: 'operations jobs 运维 任务' },
  { to: '/workflows', label: '工作流', description: '创建可复用流程并处理待审批任务', icon: Layers, category: 'workflow automation 自动化 审批' },
  { to: '/cron', label: '定时任务', description: '自动备份、清理与镜像检查', icon: History, category: 'cron schedule 定时 计划 备份' },
  { to: '/gitops', label: 'GitOps', description: '同步仓库并检查配置漂移', icon: FileCode2, category: 'git repository sync 仓库 同步 漂移' },
  { to: '/cmdb', label: '资产中心', description: '查看主机、项目与容器资产', icon: Boxes, category: 'cmdb inventory 资产' },
  { to: '/node-groups', label: '节点组', description: '按组管理 Docker 节点', icon: Layers, category: 'host group fleet 节点 主机 分组' },
  { to: '/marketplace', label: '应用市场', description: '发现、收藏和部署应用模板', icon: Store, category: 'marketplace app store 模板 应用 市场' },
  { to: '/resources', label: '存储清理', description: '管理镜像、卷、网络与数据卷备份', icon: Boxes, category: 'storage volume image network 存储 清理 备份' },
  { to: '/cost', label: '成本分析', description: '分析项目与镜像的资源占用', icon: ChartNoAxesCombined, category: 'cost resource 成本 分析' },
  { to: '/settings', label: '系统设置', description: '配置通知、更新、AI 与项目纳管', icon: Settings, category: 'notification maintenance mounts 设置' },
  { to: '/settings?tab=mounts', label: '项目纳管', description: '选择允许控制和编辑 Compose 的项目', icon: Boxes, category: 'permission mount compose 权限 目录' },
  { to: '/settings?tab=notifications', label: '异常通知', description: '设置容器、内存和存储告警渠道', icon: Settings, category: 'alert webhook telegram email 告警' },
  { to: '/settings?tab=maintenance', label: 'Docker 维护', description: '检查镜像更新并清理可回收空间', icon: Settings, category: 'prune image update cleanup 清理 镜像' },
];
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
      to: `/services?env=${project.id}`,
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
      { id: `logs-${project.id}`, to: `/logs?projectId=${project.id}`, label: `日志: ${project.projectName}`, description: '查看项目实时日志', icon: ScrollText, category: `logs 日志 ${project.projectName}` },
    ]));
  return [...baseCommands, ...actionCommands, ...nodeCommands, ...envCommands, ...blueprintCommands].map((item) =>
    item.id ? item : { ...item, id: item.to },
  );
});

function goProject(project) {
  projectSwitcherOpen.value = false;
  projectQuery.value = '';
  router.push(`/services?focus=${project.id}`);
}
function toggleProjectSwitcher() {
  projectSwitcherOpen.value = !projectSwitcherOpen.value;
  projectQuery.value = '';
}
// 与 StatusBadge.vue 的 STATUS 语义一致:运行=emerald、部分异常=restarting/amber、停止=surface、异常=rose。
const PROJECT_STATUS_DOT = { running: 'bg-emerald-400', restarting: 'bg-amber-400', partial: 'bg-amber-400', stopped: 'bg-surface-500' };
function projectStatusDotClass(status) {
  return PROJECT_STATUS_DOT[status] || 'bg-rose-400';
}
async function runProjectAction(project, action) {
  try {
    await api.createProjectBatchJob([project.id], action);
    window.dispatchEvent(new CustomEvent('composeops:operation-started', { detail: { projectName: project.projectName, action } }));
    return true;
  } catch (error) {
    toast.error(`操作提交失败:${error?.message || '未知错误'}`);
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

async function ping() {
  try {
    const res = await fetch('/health');
    backendOnline.value = res.ok;
  } catch {
    backendOnline.value = false;
  }
}
function closeCommand() { commandOpen.value = false; }
function runCommand(item) {
  if (item.run) { item.run(); closeCommand(); return; }
  router.push(item.to); closeCommand();
}
async function switchNode(host) {
  try {
    await hostsStore.switchHost(host.id);
    window.dispatchEvent(new CustomEvent('composeops:host-changed'));
  } catch (error) {
    toast.error(`切换到 ${host.name} 失败:${error?.message || '未知错误'}`);
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
  currentTime.value = new Date().toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  pingTimer = setInterval(ping, 5000);
  clockTimer = setInterval(() => { currentTime.value = new Date().toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }, 30000);
  window.addEventListener('keydown', onGlobalKeydown);
  window.addEventListener('composeops:host-changed', onHostChanged);
  window.addEventListener('composeops:projects-changed', onProjectsChanged);
});
onUnmounted(() => { clearInterval(pingTimer); clearInterval(clockTimer); window.removeEventListener('keydown', onGlobalKeydown); window.removeEventListener('composeops:host-changed', onHostChanged); window.removeEventListener('composeops:projects-changed', onProjectsChanged); });
</script>
