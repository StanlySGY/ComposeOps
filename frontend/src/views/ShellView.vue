<template>
  <div class="page-shell page-shell-workspace">
    <div class="page-header">
      <div><h1 class="page-title">容器终端</h1><p class="page-subtitle">受限于当前 Compose 项目的交互式 Shell</p></div>
      <div class="page-actions">
        <select v-model="projectId" class="input" @change="containerId = ''"><option value="">选择项目</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.projectName }}</option></select>
        <select v-model="containerId" class="input"><option value="">选择容器</option><option v-for="c in containers" :key="c.id" :value="c.id">{{ c.name }}</option></select>
        <select v-model="cmd" class="input"><option value="sh">sh</option><option value="bash">bash</option></select>
        <button v-if="!connected" class="btn-primary" :disabled="!containerId || !capabilities.shellEnabled" @click="connect"><Plug class="w-4 h-4" />连接</button>
        <button v-else class="btn-danger" @click="disconnect"><Unplug class="w-4 h-4" />断开</button>
      </div>
    </div>
    <p v-if="!capabilities.shellEnabled" class="alert-warning">Web Shell 当前未启用，请在部署环境设置 ENABLE_SHELL=1。</p><p v-if="error" class="alert-error">{{ error }}</p>
    <div class="card relative flex-1 min-h-[420px] overflow-hidden terminal-host">
      <Skeleton v-if="!termReady" class="skeleton-workspace" rows="10" label="终端加载中" />
      <div ref="termEl" class="h-full w-full" :class="{ invisible: !termReady }"></div>
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
          <p class="font-mono text-sm text-surface-300">终端未连接</p>
          <p class="text-muted">请选择上方项目与容器后点击「连接」</p>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-3 font-mono text-[11px] text-surface-600">
          <span><kbd class="shortcut-key">Ctrl+C</kbd> 中断</span>
          <span><kbd class="shortcut-key">Ctrl+L</kbd> 清屏</span>
          <span><kbd class="shortcut-key">Ctrl+D</kbd> 退出 Shell</span>
        </div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Plug, Unplug } from 'lucide-vue-next';
import Skeleton from '../components/common/Skeleton.vue';
import { Terminal } from '@xterm/xterm'; import { FitAddon } from '@xterm/addon-fit'; import '@xterm/xterm/css/xterm.css';
import { api, wsUrl } from '../api/client.js';
import { useWebSocket } from '../composables/useWebSocket.js';
const route = useRoute(); const projects = ref([]); const projectId = ref(route.query.projectId || ''); const containerId = ref(route.query.containerId || ''); const cmd = ref('sh'); const termReady = ref(false); const error = ref(''); const capabilities = ref({ shellEnabled: false }); const termEl = ref(null); let term; let fit; let resizeObserver;

/**
 * 终端不做自动重连:exec 会话无法续接,静默重连只会开出一个新 shell,
 * 用户可能以为还在原会话里继续输入。断开后写入提示,由用户显式点「连接」。
 */
const socket = useWebSocket(
  () => wsUrl(`/ws/exec?projectId=${encodeURIComponent(projectId.value)}&containerId=${encodeURIComponent(containerId.value)}&cmd=${cmd.value}`),
  {
    binaryType: 'arraybuffer',
    maxReconnectAttempts: 0,
    onOpen: () => { fit.fit(); socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); },
    onMessage: (event) => {
      if (typeof event.data !== 'string') { term.write(new Uint8Array(event.data)); return; }
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'error') error.value = frame.data;
        else term.write(event.data);
      } catch { term.write(event.data); }
    },
    onError: () => { error.value = '终端连接失败'; },
    onClose: () => { term?.write('\r\n\x1b[33m—— 会话已结束,点击「连接」开启新终端 ——\x1b[0m\r\n'); },
  }
);
const connected = socket.connected;
const containers = computed(() => projects.value.find((p) => p.id === projectId.value)?.containers || []);
onMounted(async () => {
  [projects.value, capabilities.value] = await Promise.all([api.getProjects().then((r) => r.projects.filter((project) => project.managed)), api.getCapabilities()]);
  window.addEventListener('composeops:host-changed', onHostChanged);
  term = new Terminal({ fontFamily: 'ui-monospace, Menlo, Monaco, Consolas, monospace', fontSize: 13, cursorBlink: true, theme: { background: '#0b0d10', foreground: '#e5e7eb' } }); fit = new FitAddon(); term.loadAddon(fit); term.open(termEl.value); nextTick(() => { fit.fit(); termReady.value = true; });
  term.onData((data) => socket.send(data)); term.onResize(({ cols, rows }) => socket.send(JSON.stringify({ type: 'resize', cols, rows })));
  resizeObserver = new ResizeObserver(() => fit.fit()); resizeObserver.observe(termEl.value);
  if (containerId.value && capabilities.value.shellEnabled && projects.value.some((project) => project.id === projectId.value)) connect();
});
function connect() { disconnect(); error.value = ''; term.clear(); socket.connect(); }
function disconnect() { socket.close(); }
function sendKey(char) {
  if (!connected.value) return;
  socket.send(char);
  term?.focus();
}
function onHostChanged() { disconnect(); projects.value = []; void api.getProjects().then((r) => { projects.value = r.projects.filter((project) => project.managed); }).catch(() => {}); }
onBeforeUnmount(() => { disconnect(); resizeObserver?.disconnect(); term?.dispose(); window.removeEventListener('composeops:host-changed', onHostChanged); });
</script>
