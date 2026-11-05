<template>
  <div class="page-shell page-shell-workspace">
    <div class="page-header">
      <div><h1 class="page-title">容器终端</h1><p class="page-subtitle">受限于当前 Compose 项目的交互式 Shell</p></div>
      <div class="page-actions">
        <select v-model="projectId" class="input" aria-label="选择终端项目" :disabled="loading" @change="containerId = ''; selectionChanged()"><option value="">选择项目</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.projectName }}</option></select>
        <select v-model="containerId" class="input" aria-label="选择终端容器" :disabled="loading" @change="selectionChanged"><option value="">选择容器</option><option v-for="c in containers" :key="c.id" :value="c.id">{{ c.name }}</option></select>
        <select v-model="cmd" class="input" aria-label="选择终端 Shell" @change="selectionChanged"><option value="sh">sh</option><option value="bash">bash</option></select>
        <button v-if="!connected && !connecting" class="btn-primary" :disabled="!canConnect" @click="connect"><Plug class="w-4 h-4" />连接</button>
        <button v-else class="btn-danger" @click="disconnect"><Unplug class="w-4 h-4" />断开</button>
      </div>
    </div>
    <p v-if="!loading && loaded && !capabilities.shellEnabled" class="alert-warning" role="alert">Web Shell 当前未启用，请在部署环境设置 ENABLE_SHELL=1。</p>
    <div v-if="error" class="alert-error flex items-center justify-between gap-3" role="alert"><span>{{ error }}</span><button v-if="!loaded" class="btn-secondary shrink-0" :disabled="loading" @click="loadData()">重新加载</button></div>
    <div class="card flex flex-1 min-h-[420px] flex-col overflow-hidden terminal-host">
      <div class="terminal-session-bar" role="status" aria-live="polite">
        <span class="status-dot" :class="connected ? 'bg-emerald-400' : connecting ? 'bg-amber-400' : 'bg-surface-600'"></span>
        <strong>{{ connected ? '已连接' : connecting ? '连接中…' : '未连接' }}</strong>
        <span v-if="selectedContainer" class="min-w-0 truncate font-mono">{{ selectedContainer.name }} · {{ cmd }}</span>
        <span class="ml-auto text-[11px]">{{ notice || '切换目标或离开页面会断开当前会话' }}</span>
      </div>
      <div class="relative flex min-h-0 flex-1 flex-col">
      <Skeleton v-if="!termReady" class="skeleton-workspace" rows="10" label="终端加载中" />
      <div ref="termEl" class="min-h-0 w-full flex-1" :class="{ invisible: !termReady }"></div>
      <!-- 移动端虚拟按键辅助栏 (Termius 风格快捷键) -->
      <div v-if="connected" class="flex md:hidden items-center justify-between gap-1.5 border-t border-surface-800 bg-surface-950/95 px-3 py-2 overflow-x-auto shrink-0 z-20">
        <button class="px-2.5 py-1 rounded-md bg-surface-800 text-xs font-mono font-medium text-surface-200 active:scale-95 active:bg-surface-700 shrink-0" @click="sendKey('\x1b')">ESC</button>
        <button class="px-2.5 py-1 rounded-md bg-surface-800 text-xs font-mono font-medium text-surface-200 active:scale-95 active:bg-surface-700 shrink-0" @click="sendKey('\t')">TAB</button>
        <button class="px-2.5 py-1 rounded-md bg-surface-800 text-xs font-mono font-medium text-rose-300 active:scale-95 active:bg-surface-700 shrink-0" @click="sendKey('\x03')">Ctrl+C</button>
        <button class="px-2.5 py-1 rounded-md bg-surface-800 text-xs font-mono font-medium text-surface-200 active:scale-95 active:bg-surface-700 shrink-0" @click="sendKey('\x1b[A')">▲</button>
        <button class="px-2.5 py-1 rounded-md bg-surface-800 text-xs font-mono font-medium text-surface-200 active:scale-95 active:bg-surface-700 shrink-0" @click="sendKey('\x1b[B')">▼</button>
        <button class="px-2.5 py-1 rounded-md bg-surface-800 text-xs font-mono font-medium text-emerald-300 active:scale-95 active:bg-surface-700 shrink-0" @click="sendKey('clear\n')">Clear</button>
      </div>
      <div v-if="termReady && !connected" class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-surface-1000/95 px-6">
        <div class="flex items-center gap-1.5">
          <span class="h-3 w-3 rounded-full bg-[#ff5f57]"></span>
          <span class="h-3 w-3 rounded-full bg-[#febc2e]"></span>
          <span class="h-3 w-3 rounded-full bg-[#28c840]"></span>
        </div>
        <div class="space-y-1 text-center">
          <p class="font-mono text-sm text-surface-300">{{ loading ? '正在读取终端信息…' : connecting ? '正在建立会话…' : '终端未连接' }}</p>
          <p class="text-muted">{{ notice || '请选择上方项目与容器后点击「连接」' }}</p>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-3 font-mono text-[11px] text-surface-600">
          <span><kbd class="shortcut-key">Ctrl+C</kbd> 中断</span>
          <span><kbd class="shortcut-key">Ctrl+L</kbd> 清屏</span>
          <span><kbd class="shortcut-key">Ctrl+D</kbd> 退出 Shell</span>
        </div>
      </div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { useRoute, useRouter } from 'vue-router';
import { Plug, Unplug } from 'lucide-vue-next';
import Skeleton from '../components/common/Skeleton.vue';
import { Terminal } from '@xterm/xterm'; import { FitAddon } from '@xterm/addon-fit'; import '@xterm/xterm/css/xterm.css';
import { api, wsUrl } from '../api/client.js';
import { useWebSocket } from '../composables/useWebSocket.js';
const route = useRoute(); const projects = ref([]); const projectId = ref(route.query.projectId || ''); const containerId = ref(route.query.containerId || ''); const cmd = ref('sh'); const termReady = ref(false); const error = ref(''); const capabilities = ref({ shellEnabled: false }); const termEl = ref(null); let term; let fit; let resizeObserver;
const router = useRouter();
const loading = ref(true);
const loaded = ref(false);
const connecting = ref(false);
const notice = ref('');
let disposed = false;
let requestId = 0;

/**
 * 终端不做自动重连:exec 会话无法续接,静默重连只会开出一个新 shell,
 * 用户可能以为还在原会话里继续输入。断开后写入提示,由用户显式点「连接」。
 */
const socket = useWebSocket(
  () => wsUrl(`/ws/exec?projectId=${encodeURIComponent(projectId.value)}&containerId=${encodeURIComponent(containerId.value)}&cmd=${cmd.value}`),
  {
    binaryType: 'arraybuffer',
    maxReconnectAttempts: 0,
    onOpen: () => { connecting.value = false; fit.fit(); term.focus(); socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); },
    onMessage: (event) => {
      if (typeof event.data !== 'string') { term.write(new Uint8Array(event.data)); return; }
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'error') error.value = frame.data;
        else term.write(event.data);
      } catch { term.write(event.data); }
    },
    onError: () => { connecting.value = false; error.value = '终端连接失败，请检查容器状态后重试'; },
    onClose: () => { connecting.value = false; notice.value = '会话已结束，点击「连接」开启新终端'; term?.write('\r\n\x1b[33m—— 会话已结束,点击「连接」开启新终端 ——\x1b[0m\r\n'); },
  }
);
const connected = socket.connected;
const containers = computed(() => projects.value.find((p) => p.id === projectId.value)?.containers || []);
const selectedContainer = computed(() => containers.value.find(container => container.id === containerId.value));
const canConnect = computed(() => termReady.value && !loading.value && loaded.value && capabilities.value.shellEnabled && !!selectedContainer.value);
// 终端刻意不自动重连(maxReconnectAttempts: 0),下拉刷新只重读项目列表,不动现有会话。
usePullRefresh(() => loadData());
onMounted(async () => {
  window.addEventListener('composeops:host-changed', onHostChanged);
  term = new Terminal({ fontFamily: 'ui-monospace, Menlo, Monaco, Consolas, monospace', fontSize: 13, cursorBlink: true, theme: { background: '#0b0d10', foreground: '#e5e7eb' } }); fit = new FitAddon(); term.loadAddon(fit); term.open(termEl.value);
  term.onData((data) => socket.send(data)); term.onResize(({ cols, rows }) => socket.send(JSON.stringify({ type: 'resize', cols, rows })));
  resizeObserver = new ResizeObserver(() => fit.fit()); resizeObserver.observe(termEl.value);
  await nextTick();
  if (disposed) return;
  fit.fit(); termReady.value = true;
  if (await loadData()) {
    if (canConnect.value) connect();
  }
});
async function loadData() {
  const id = ++requestId;
  loading.value = true;
  error.value = '';
  try {
    const [result, capability] = await Promise.all([api.getProjects(true), api.getCapabilities()]);
    if (disposed || id !== requestId) return false;
    projects.value = (result.projects || []).filter(project => project.managed);
    capabilities.value = capability;
    loaded.value = true;
    if (containerId.value && !selectedContainer.value) {
      disconnect();
      containerId.value = '';
      notice.value = '原容器已不可用，请重新选择';
    }
    return true;
  } catch (cause) {
    if (!disposed && id === requestId) { error.value = `终端信息加载失败：${cause.message}`; loaded.value = false; }
    return false;
  } finally {
    if (!disposed && id === requestId) loading.value = false;
  }
}
function connect() {
  if (!canConnect.value) return;
  disconnect(); error.value = ''; notice.value = ''; term.reset(); connecting.value = true; socket.connect();
}
function disconnect() { connecting.value = false; socket.close(); }
function selectionChanged() {
  disconnect(); term?.reset(); error.value = ''; notice.value = '目标已切换，请点击「连接」建立新会话';
  const query = { ...route.query };
  if (projectId.value) query.projectId = projectId.value; else delete query.projectId;
  if (containerId.value) query.containerId = containerId.value; else delete query.containerId;
  void router.replace({ path: '/shell', query });
}
watch(() => [route.query.projectId, route.query.containerId], ([project, container]) => {
  if (route.name !== 'shell' || (projectId.value === (project || '') && containerId.value === (container || ''))) return;
  disconnect(); term?.reset();
  projectId.value = project || ''; containerId.value = container || '';
  notice.value = '目标已切换，请点击「连接」建立新会话';
});
function sendKey(char) {
  if (!connected.value) return;
  socket.send(char);
  term?.focus();
}
function onHostChanged() {
  disconnect(); term?.reset(); projects.value = []; projectId.value = ''; containerId.value = ''; loaded.value = false;
  selectionChanged(); notice.value = '节点已切换，请重新选择项目和容器';
  void loadData();
}
onBeforeUnmount(() => { disposed = true; requestId += 1; disconnect(); resizeObserver?.disconnect(); term?.dispose(); window.removeEventListener('composeops:host-changed', onHostChanged); });
</script>
