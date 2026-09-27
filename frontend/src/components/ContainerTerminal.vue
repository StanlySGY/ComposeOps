<template>
  <div class="terminal-wrapper">
    <div class="terminal-header">
      <div class="header-left">
        <span class="terminal-icon">▶</span>
        <span class="terminal-title">{{ containerName }}</span>
        <span class="shell-indicator">{{ shell }}</span>
      </div>
      <div class="header-actions">
        <button v-if="!connected" @click="connect" class="btn-connect" :disabled="connecting">
          {{ connecting ? '连接中...' : '连接终端' }}
        </button>
        <button v-else @click="disconnect" class="btn-disconnect">断开</button>
      </div>
    </div>
    <div ref="terminalContainer" class="terminal-container"></div>
    <div v-if="error" class="terminal-error">{{ error }}</div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const props = defineProps({
  projectId: { type: String, required: true },
  containerId: { type: String, required: true },
  containerName: { type: String, default: 'Container' },
  shell: { type: String, default: 'sh' },
  autoConnect: { type: Boolean, default: false },
});

const terminalContainer = ref(null);
const connected = ref(false);
const connecting = ref(false);
const error = ref('');

let terminal = null;
let fitAddon = null;
let ws = null;

onMounted(() => {
  initTerminal();
  if (props.autoConnect) {
    connect();
  }
});

onUnmounted(() => {
  cleanup();
});

watch(() => props.containerId, () => {
  if (connected.value) {
    disconnect();
  }
});

function initTerminal() {
  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, monospace',
    theme: {
      background: '#0A0D12',
      foreground: '#E5E7EB',
      cursor: '#38BDF8',
      black: '#0F131C',
      red: '#EF4444',
      green: '#6EE7B7',
      yellow: '#E9A568',
      blue: '#38BDF8',
      magenta: '#A78BFA',
      cyan: '#22D3EE',
      white: '#F3F4F6',
      brightBlack: '#4B5563',
      brightRed: '#F87171',
      brightGreen: '#86EFAC',
      brightYellow: '#FCD34D',
      brightBlue: '#60A5FA',
      brightMagenta: '#C4B5FD',
      brightCyan: '#67E8F9',
      brightWhite: '#FFFFFF',
    },
    scrollback: 10000,
    convertEol: true,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  terminal.open(terminalContainer.value);
  fitAddon.fit();

  window.addEventListener('resize', handleResize);
}

function handleResize() {
  if (fitAddon && terminal) {
    fitAddon.fit();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'resize',
        cols: terminal.cols,
        rows: terminal.rows,
      }));
    }
  }
}

function connect() {
  if (connecting.value || connected.value) return;

  connecting.value = true;
  error.value = '';

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const url = `${protocol}//${host}/api/v1/ws/exec?projectId=${props.projectId}&containerId=${props.containerId}&cmd=${props.shell}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    connecting.value = false;
    connected.value = true;
    terminal.clear();
    terminal.write('\r\n\x1b[32m✓ 已连接到容器终端\x1b[0m\r\n\r\n');

    // 发送初始尺寸
    ws.send(JSON.stringify({
      type: 'resize',
      cols: terminal.cols,
      rows: terminal.rows,
    }));

    // 监听终端输入
    terminal.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'error') {
          error.value = msg.data;
          terminal.write(`\r\n\x1b[31m错误: ${msg.data}\x1b[0m\r\n`);
        }
      } catch {
        terminal.write(event.data);
      }
    } else {
      // 二进制数据直接写入
      const reader = new FileReader();
      reader.onload = () => {
        terminal.write(new Uint8Array(reader.result));
      };
      reader.readAsArrayBuffer(event.data);
    }
  };

  ws.onerror = () => {
    connecting.value = false;
    error.value = '连接失败';
    terminal.write('\r\n\x1b[31m✗ 连接失败\x1b[0m\r\n');
  };

  ws.onclose = () => {
    connecting.value = false;
    connected.value = false;
    terminal.write('\r\n\x1b[33m✗ 连接已断开\x1b[0m\r\n');
  };
}

function disconnect() {
  if (ws) {
    ws.close();
    ws = null;
  }
  connected.value = false;
}

function cleanup() {
  disconnect();
  if (terminal) {
    terminal.dispose();
    terminal = null;
  }
  window.removeEventListener('resize', handleResize);
}
</script>

<style scoped>
.terminal-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0A0D12;
  border-radius: 8px;
  overflow: hidden;
}

.terminal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: #0F131C;
  border-bottom: 1px solid #1E2636;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.terminal-icon {
  color: #6EE7B7;
  font-size: 14px;
}

.terminal-title {
  color: #F3F4F6;
  font-size: 14px;
  font-weight: 500;
}

.shell-indicator {
  padding: 2px 8px;
  background: #1E2636;
  color: #9CA3AF;
  font-size: 12px;
  border-radius: 4px;
  font-family: monospace;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.btn-connect,
.btn-disconnect {
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-connect {
  background: #38BDF8;
  color: #0A0D12;
}

.btn-connect:hover:not(:disabled) {
  background: #0EA5E9;
}

.btn-connect:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-disconnect {
  background: #EF4444;
  color: white;
}

.btn-disconnect:hover {
  background: #DC2626;
}

.terminal-container {
  flex: 1;
  padding: 12px;
  overflow: hidden;
}

.terminal-error {
  padding: 12px 16px;
  background: rgba(239, 68, 68, 0.1);
  border-top: 1px solid rgba(239, 68, 68, 0.2);
  color: #EF4444;
  font-size: 13px;
}
</style>
