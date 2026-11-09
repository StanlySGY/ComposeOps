<template>
  <div class="page-shell page-shell-workspace shell-page">
    <ProjectContextNav :project="selectedProject" :container-id="containerId" />
    <div class="page-header">
      <div><h1 class="page-title">容器终端</h1><p class="page-subtitle">选择运行中的容器，开启独立 Shell 会话</p></div>
      <button class="btn-secondary" aria-label="刷新终端目标" :disabled="loading" @click="loadData()"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" /><span class="shell-refresh-label">刷新目标</span></button>
    </div>
    <div class="shell-targets" :class="{ 'is-collapsed': !targetOptionsOpen }">
      <button class="shell-target-toggle md:hidden" :aria-expanded="targetOptionsOpen" aria-controls="shell-project-target" @click="targetOptionsOpen = !targetOptionsOpen"><SlidersHorizontal class="h-4 w-4 shrink-0" /><span>{{ targetOptionsOpen ? '收起目标设置' : selectedContainer?.name || '选择连接目标' }}</span><ChevronDown class="h-4 w-4 shrink-0 transition-transform" :class="{ 'rotate-180': targetOptionsOpen }" /><span class="sr-only">切换终端目标设置</span></button>
      <label id="shell-project-target" class="shell-target shell-project"><span>项目</span><select v-model="projectId" class="input" aria-label="选择终端项目" :disabled="loading" @change="containerId = ''; selectionChanged()"><option value="">选择项目</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.projectName }}</option></select></label>
      <label class="shell-target"><span>容器</span><select v-model="containerId" class="input" aria-label="选择终端容器" :disabled="loading" @change="selectionChanged"><option value="">选择容器</option><option v-for="c in containers" :key="c.id" :value="c.id" :disabled="c.state !== 'running'">{{ c.name }}{{ c.state !== 'running' ? ' · 未运行' : '' }}</option></select></label>
      <label class="shell-target shell-kind"><span>Shell</span><select v-model="cmd" class="input" aria-label="选择终端 Shell" @change="selectionChanged"><option value="sh">sh</option><option value="bash">bash</option></select></label>
      <button v-if="!connected && !connecting" class="btn-primary shell-connect" :disabled="!canConnect" :title="hasTranscript ? '开启独立 Shell 并清空上次输出' : '连接所选容器'" @click="connect"><Plug class="w-4 h-4" />{{ hasTranscript ? '新建会话' : '连接' }}</button>
      <button v-else class="btn-danger shell-connect" @click="disconnect"><Unplug class="w-4 h-4" />{{ connecting ? '取消连接' : '断开' }}</button>
    </div>
    <p v-if="!loading && loaded && !capabilities.shellEnabled" class="alert-warning" role="alert">Web Shell 当前未启用，请在部署环境设置 ENABLE_SHELL=1。</p>
    <p v-else-if="selectedContainer && selectedContainer.state !== 'running'" class="alert-warning" role="status">当前容器未运行，无法建立终端。可切换到「日志」排查，或返回项目启动容器。</p>
    <div v-if="loadError" class="alert-error flex items-center justify-between gap-3" role="alert"><span>{{ loadError }}</span><button class="btn-secondary shrink-0" :disabled="loading" @click="loadData()">重新加载</button></div>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
    <div class="card flex flex-1 min-h-[420px] flex-col overflow-hidden terminal-host" :class="{ 'is-searching': searchOpen }" @keydown.capture="onTerminalKeydown">
      <div class="terminal-session-bar" role="status" aria-live="polite">
        <span class="status-dot" :class="connected ? 'bg-status-ok' : connecting ? 'bg-status-warn animate-pulse' : 'bg-surface-600'"></span>
        <strong>{{ statusLabel }}</strong>
        <span v-if="sessionTarget || selectedContainer" class="min-w-0 truncate font-mono" :title="sessionTarget || `${selectedContainer.name} · ${cmd}`">{{ sessionTarget || `${selectedContainer.name} · ${cmd}` }}</span>
        <span class="shell-session-note">{{ notice || (connected ? '独立会话 · 离开页面即断开' : '确认连接后才可输入') }}</span>
      </div>
      <div v-if="searchOpen" class="shell-search" role="search" aria-label="查找终端输出">
        <div class="shell-search-field">
          <Search class="h-4 w-4 shrink-0" aria-hidden="true" />
          <input ref="searchInput" v-model="searchQuery" class="input" aria-label="终端查找内容" placeholder="查找终端输出…" autocomplete="off" spellcheck="false" @keydown="onSearchKeydown" />
        </div>
        <span class="shell-search-result" role="status" aria-live="polite" aria-atomic="true">{{ searchResultText }}</span>
        <div class="shell-search-actions">
          <button class="btn-ghost" :aria-pressed="searchCaseSensitive" aria-label="区分大小写" title="区分大小写" @click="searchCaseSensitive = !searchCaseSensitive">Aa</button>
          <button class="btn-ghost" :disabled="!searchQuery || !searchResult.resultCount" aria-label="上一个匹配" title="上一个匹配（Shift+Enter）" @click="findMatch(true)"><ChevronUp class="h-4 w-4" /></button>
          <button class="btn-ghost" :disabled="!searchQuery || !searchResult.resultCount" aria-label="下一个匹配" title="下一个匹配（Enter）" @click="findMatch()"><ChevronDown class="h-4 w-4" /></button>
          <button class="btn-ghost" aria-label="关闭终端查找" title="关闭查找（Esc）" @click="closeSearch()"><X class="h-4 w-4" /></button>
        </div>
      </div>
      <div class="relative flex min-h-0 flex-1 flex-col">
        <Skeleton v-if="!termReady" class="skeleton-workspace" rows="10" label="终端加载中" />
        <div ref="termEl" class="shell-terminal min-h-0 w-full flex-1" :class="{ invisible: !termReady }" aria-label="容器终端输出"></div>
        <div v-if="termReady && !hasTranscript && !connected" class="terminal-empty absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 px-6">
          <div class="shell-empty-icon"><LoaderCircle v-if="connecting || loading" class="h-7 w-7 animate-spin" /><SquareTerminal v-else class="h-7 w-7" /></div>
          <div class="space-y-2 text-center">
            <p class="text-sm font-medium text-surface-200">{{ loading ? '正在读取终端信息…' : connecting ? statusLabel : '终端未连接' }}</p>
            <p class="text-muted">{{ notice || '选好项目与容器，让每条命令都有明确的目标。' }}</p>
          </div>
          <div class="shell-entry-steps" aria-label="连接步骤"><span :class="{ complete: projectId }">1 选择项目</span><ChevronRight class="h-3 w-3" /><span :class="{ complete: containerId }">2 确认容器</span><ChevronRight class="h-3 w-3" /><span>3 建立会话</span></div>
        </div>
      </div>
      <div v-if="connected" class="shell-keyboard md:hidden" aria-label="终端辅助按键">
        <button aria-label="发送 Escape 键" @click="sendKey('\x1b')">Esc</button><button aria-label="发送 Tab 键" @click="sendKey('\t')">Tab</button><button class="text-status-error" aria-label="发送 Ctrl+C 中断当前命令" @click="sendKey('\x03')">Ctrl+C</button>
        <button aria-label="发送方向左键" @click="sendKey('\x1b[D')">←</button><button aria-label="发送方向上键" @click="sendKey('\x1b[A')">↑</button><button aria-label="发送方向下键" @click="sendKey('\x1b[B')">↓</button><button aria-label="发送方向右键" @click="sendKey('\x1b[C')">→</button>
      </div>
      <div class="shell-output-tools">
        <span class="shell-output-hint" role="status">{{ copyFeedback || (hasTranscript && !connected ? '输出已保留 · 新建会话会清空上次输出' : 'Ctrl+C 中断 · Ctrl+D 退出') }}</span>
        <button class="btn-ghost" :disabled="!hasTranscript" :aria-expanded="searchOpen" aria-label="查找终端输出" title="查找终端输出（Ctrl/Cmd+F）" @click="openSearch"><Search class="h-3.5 w-3.5" />查找</button>
        <button class="btn-ghost" :disabled="atBottom" aria-label="回到最新终端输出" @click="scrollToLatest"><ArrowDownToLine class="h-3.5 w-3.5" />最新输出</button>
        <button class="btn-ghost" :disabled="!hasSelection || copying" aria-label="复制终端选中文字" @click="copySelection"><Check v-if="copyFeedback === '已复制选中文字'" class="h-3.5 w-3.5" /><Copy v-else class="h-3.5 w-3.5" />复制选区</button>
        <button class="btn-ghost" :disabled="!hasTranscript" aria-label="清除终端滚动记录" title="仅清除本地滚动记录，保留当前行和未提交输入" @click="clearScrollback"><Eraser class="h-3.5 w-3.5" />清除记录</button>
      </div>
    </div>
  </div>
</template>
<script setup>
import ProjectContextNav from '../components/services/ProjectContextNav.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useRoute, useRouter } from 'vue-router';
import { ArrowDownToLine, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Eraser, LoaderCircle, Plug, RefreshCw, Search, SlidersHorizontal, SquareTerminal, Unplug, X } from 'lucide-vue-next';
import Skeleton from '../components/common/Skeleton.vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { api, wsUrl } from '../api/client.js';
import { useWebSocket } from '../composables/useWebSocket.js';
import { copyText } from '../lib/clipboard.js';

const route = useRoute(), router = useRouter();
const projects = ref([]), projectId = ref(route.query.projectId || ''), containerId = ref(route.query.containerId || '');
const normalizeShell = value => value === 'bash' ? 'bash' : 'sh';
const cmd = ref(normalizeShell(route.query.cmd)), termReady = ref(false), error = ref(''), loadError = ref('');
const capabilities = ref({ shellEnabled: false }), termEl = ref(null), loading = ref(true), loaded = ref(false);
const targetOptionsOpen = ref(true);
const phase = ref('idle'), notice = ref(''), hasTranscript = ref(false), sessionTarget = ref('');
const hasSelection = ref(false), copying = ref(false), copyFeedback = ref('');
const searchOpen = ref(false), searchInput = ref(null), searchQuery = ref(''), searchCaseSensitive = ref(false);
const searchResult = ref({ resultIndex: -1, resultCount: 0 }), atBottom = ref(true);
const SEARCH_HIGHLIGHT_LIMIT = 1000;
const searchDecorations = { matchBackground: '#24554a', matchBorder: '#478574', matchOverviewRuler: '#478574', activeMatchBackground: '#865c16', activeMatchBorder: '#fbbf24', activeMatchColorOverviewRuler: '#fbbf24' };
const searchResultText = computed(() => {
  if (!searchQuery.value) return '输入关键词';
  const { resultIndex, resultCount } = searchResult.value;
  if (!resultCount) return '未找到匹配';
  if (resultCount >= SEARCH_HIGHLIGHT_LIMIT) return `至少 ${SEARCH_HIGHLIGHT_LIMIT} 处`;
  return resultIndex < 0 ? `${resultCount} 处匹配` : `${resultIndex + 1} / ${resultCount}`;
});
let term, fit, search, resizeObserver, readyTimer, copyTimer;
let disposed = false, requestId = 0;
const connecting = computed(() => ['connecting', 'initializing'].includes(phase.value));
const statusLabel = computed(() => ({ idle: '未连接', connecting: '正在连接…', initializing: '正在启动 Shell…', ready: '已连接', ended: '已断开', failed: '连接未完成' })[phase.value]);
function clearReadyTimer() { clearTimeout(readyTimer); readyTimer = null; }
function writeOutput(data) { hasTranscript.value = true; term?.write(data); }
function endSession(message) {
  clearReadyTimer(); phase.value = 'ended'; notice.value = message;
  if (hasTranscript.value) term?.write(`\r\n\x1b[33m—— ${message} ——\x1b[0m\r\n`);
}
// Docker exec无法续接；断开后必须由用户显式创建新会话。
const socket = useWebSocket(
  () => wsUrl(`/ws/exec?projectId=${encodeURIComponent(projectId.value)}&containerId=${encodeURIComponent(containerId.value)}&cmd=${cmd.value}`),
  {
    binaryType: 'arraybuffer', maxReconnectAttempts: 0,
    onOpen: () => {
      phase.value = 'initializing'; fit.fit();
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      readyTimer = setTimeout(() => {
        socket.close(); clearReadyTimer(); phase.value = 'failed';
        error.value = 'Shell 初始化超时，请检查容器状态后重新连接';
      }, 30000);
    },
    onMessage: (event) => {
      if (typeof event.data !== 'string') { writeOutput(new Uint8Array(event.data)); return; }
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'ready') {
          clearReadyTimer(); phase.value = 'ready'; hasTranscript.value = true;
          void nextTick(() => { if (connected.value && !disposed) { fit.fit(); term.focus(); } });
        } else if (frame.type === 'error') {
          error.value = frame.data; clearReadyTimer(); socket.close(); phase.value = 'failed';
          notice.value = '连接已结束，可检查后重新连接';
        }
      } catch { writeOutput(event.data); }
    },
    onError: () => { clearReadyTimer(); socket.close(); phase.value = 'failed'; error.value = '终端连接失败，请检查网络与容器状态后重试'; },
    onClose: () => endSession('会话已结束，可新建会话继续操作'),
  }
);
const connected = computed(() => phase.value === 'ready' && socket.connected.value);
watch(connected, value => { if (term) term.options.disableStdin = !value; if (value) targetOptionsOpen.value = false; });
const selectedProject = computed(() => projects.value.find(p => p.id === projectId.value));
const containers = computed(() => selectedProject.value?.containers || []);
const selectedContainer = computed(() => containers.value.find(container => container.id === containerId.value));
const canConnect = computed(() => termReady.value && !loading.value && !loadError.value && loaded.value && capabilities.value.shellEnabled && selectedContainer.value?.state === 'running');
usePullRefresh(() => loadData());
onMounted(async () => {
  window.addEventListener('composeops:host-changed', onHostChanged);
  term = new Terminal({ allowProposedApi: true, disableStdin: true, screenReaderMode: true, fontFamily: 'ui-monospace, Menlo, Monaco, Consolas, monospace', fontSize: 13, cursorBlink: true, theme: { background: '#0b0d10', foreground: '#e5e7eb', cursor: '#34d399', selectionBackground: '#24554a' } });
  fit = new FitAddon(); term.loadAddon(fit); term.open(termEl.value);
  resetSearchAddon();
  term.onData(data => { if (connected.value) socket.send(data); });
  term.onResize(({ cols, rows }) => socket.send(JSON.stringify({ type: 'resize', cols, rows })));
  term.onSelectionChange(() => { hasSelection.value = !!term.getSelection(); });
  term.onScroll(updateScrollPosition); term.onWriteParsed(updateScrollPosition);
  resizeObserver = new ResizeObserver(() => fit.fit()); resizeObserver.observe(termEl.value);
  await nextTick(); if (disposed) return;
  fit.fit(); termReady.value = true;
  if (await loadData()) { if (canConnect.value) connect(); }
});
async function loadData() {
  const id = ++requestId; loading.value = true; loadError.value = '';
  const [result, capability] = await Promise.allSettled([api.getProjects(true), api.getCapabilities()]);
  if (disposed || id !== requestId) return false;
  const failures = [];
  if (result.status === 'fulfilled') {
    projects.value = (result.value.projects || []).filter(project => project.managed);
    if (containerId.value && !selectedContainer.value) {
      disconnect(); containerId.value = ''; notice.value = '原容器已不可用，请重新选择'; syncQuery();
    } else if (selectedContainer.value && selectedContainer.value.state !== 'running') {
      disconnect(); notice.value = '当前容器已停止，输出已保留';
    }
  } else failures.push(`项目列表：${result.reason.message}`);
  if (capability.status === 'fulfilled') {
    capabilities.value = capability.value;
    if (!capability.value.shellEnabled) disconnect();
  } else failures.push(`功能开关：${capability.reason.message}`);
  loaded.value = !failures.length; loadError.value = failures.length ? `终端信息加载失败：${failures.join('；')}` : '';
  loading.value = false; return loaded.value;
}
function connect() {
  if (!canConnect.value || connected.value || connecting.value) return;
  disconnect(); closeSearch(false); searchQuery.value = ''; error.value = ''; notice.value = ''; copyFeedback.value = ''; term.reset(); resetSearchAddon(); hasTranscript.value = false; hasSelection.value = false; atBottom.value = true;
  sessionTarget.value = `${selectedContainer.value.name} · ${cmd.value}`;
  phase.value = 'connecting'; socket.connect();
}
function disconnect() {
  const active = connected.value || connecting.value;
  socket.close(); clearReadyTimer();
  if (active) endSession(hasTranscript.value ? '会话已断开，输出已保留' : '连接已取消');
}
function syncQuery() {
  const query = { ...route.query };
  if (projectId.value) query.projectId = projectId.value; else delete query.projectId;
  if (containerId.value) query.containerId = containerId.value; else delete query.containerId;
  if (cmd.value === 'bash') query.cmd = 'bash'; else delete query.cmd;
  void router.replace({ path: '/shell', query });
}
function selectionChanged() {
  disconnect(); error.value = ''; notice.value = hasTranscript.value ? '目标已切换，上次输出保留至新建会话' : '目标已切换，请点击「连接」建立新会话';
  if (!hasTranscript.value) sessionTarget.value = '';
  syncQuery();
}
watch(() => [route.query.projectId, route.query.containerId, route.query.cmd], ([project, container, shell]) => {
  if (route.name !== 'shell' || (projectId.value === (project || '') && containerId.value === (container || '') && cmd.value === normalizeShell(shell))) return;
  disconnect(); projectId.value = project || ''; containerId.value = container || ''; cmd.value = normalizeShell(shell);
  if (!hasTranscript.value) sessionTarget.value = '';
  notice.value = '目标已切换，请建立新会话';
});
function sendKey(char) { if (connected.value) { socket.send(char); term?.focus(); } }
function resetSearchAddon() {
  // clear/reset do not invalidate addon-search's line cache; replace it using its public lifecycle.
  search?.dispose();
  search = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT }); term.loadAddon(search);
  search.onDidChangeResults(result => { if (!disposed && searchOpen.value) searchResult.value = result; });
  searchResult.value = { resultIndex: -1, resultCount: 0 };
}
function updateScrollPosition() { const buffer = term?.buffer.active; atBottom.value = !buffer || buffer.viewportY >= buffer.baseY; }
function scrollToLatest() { closeSearch(false); term?.scrollToBottom(); updateScrollPosition(); term?.focus(); }
async function openSearch() {
  if (!termReady.value || !hasTranscript.value) return;
  const selection = term?.getSelection();
  searchOpen.value = true;
  await nextTick();
  if (disposed || !searchOpen.value) return;
  // Fit the new layout before selecting a match; delayed reflow clears xterm's selection.
  fit.fit();
  if (selection && !/[\r\n]/.test(selection) && selection !== searchQuery.value) searchQuery.value = selection;
  else findMatch(false, true);
  searchInput.value?.focus(); searchInput.value?.select();
}
function closeSearch(restoreFocus = true) {
  searchOpen.value = false; search?.clearDecorations(); term?.clearSelection();
  searchResult.value = { resultIndex: -1, resultCount: 0 };
  if (restoreFocus && !disposed) term?.focus();
}
function findMatch(previous = false, incremental = false) {
  if (!search || !searchOpen.value) return;
  if (!searchQuery.value) {
    search.clearDecorations(); term?.clearSelection(); searchResult.value = { resultIndex: -1, resultCount: 0 }; return;
  }
  const options = { caseSensitive: searchCaseSensitive.value, incremental, decorations: searchDecorations };
  if (previous) search.findPrevious(searchQuery.value, options);
  else search.findNext(searchQuery.value, options);
  updateScrollPosition();
}
watch(searchQuery, () => findMatch(false, true));
watch(searchCaseSensitive, () => {
  // addon-search 0.16 caches highlights by term; invalidate when options change too.
  search?.clearDecorations(); findMatch(false, true);
});
// Capture before xterm handles keys: search shortcuts must never become shell input.
function onTerminalKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return;
  const find = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
  const navigate = event.key === 'F3' && !event.ctrlKey && !event.metaKey && !event.altKey;
  const close = event.key === 'Escape' && searchOpen.value;
  if ((!find && !navigate && !close) || !hasTranscript.value) return;
  event.preventDefault(); event.stopPropagation();
  if (close) closeSearch();
  else if (navigate && searchOpen.value && searchQuery.value) findMatch(event.shiftKey);
  else void openSearch();
}
function onSearchKeydown(event) {
  if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return;
  event.preventDefault(); event.stopPropagation(); findMatch(event.shiftKey);
}
function clearScrollback() {
  term?.clear(); resetSearchAddon(); findMatch(false, true); updateScrollPosition(); term?.focus();
}
async function copySelection() {
  const text = term?.getSelection(); if (!text || copying.value) return;
  copying.value = true; clearTimeout(copyTimer);
  try { await copyText(text); if (!disposed) copyFeedback.value = '已复制选中文字'; }
  catch { if (!disposed) copyFeedback.value = '复制失败，请使用系统复制快捷键'; }
  finally { copying.value = false; if (!disposed) copyTimer = setTimeout(() => { copyFeedback.value = ''; }, 2400); }
}
function onHostChanged() {
  disconnect(); projects.value = []; projectId.value = ''; containerId.value = ''; loaded.value = false;
  selectionChanged(); notice.value = '节点已切换，请重新选择项目和容器'; void loadData();
}
onBeforeUnmount(() => { disposed = true; requestId += 1; disconnect(); clearTimeout(copyTimer); resizeObserver?.disconnect(); term?.dispose(); window.removeEventListener('composeops:host-changed', onHostChanged); });
</script>
