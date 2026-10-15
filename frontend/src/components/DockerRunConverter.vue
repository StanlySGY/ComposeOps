<template>
  <div class="converter-wrapper">
    <div class="converter-body">
      <div class="input-section">
        <label for="docker-run-command" class="input-label">Docker Run 命令</label>
        <textarea
          id="docker-run-command"
          v-model="dockerRunCommand"
          class="input-textarea"
          placeholder="docker run -d --name myapp -p 8080:80 -e NODE_ENV=production -v /data:/app/data nginx:latest"
          rows="8"
          @input="autoConvert"
        ></textarea>
        <div class="input-hint">支持多行粘贴,自动识别换行符和反斜杠续行</div>
      </div>

      <div class="converter-actions">
        <button @click="convert" class="btn-convert" :disabled="!dockerRunCommand.trim()">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M7 16V4M7 4L3 8M7 4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
          </svg>
          转换
        </button>
        <button @click="clear" class="btn-clear">清空</button>
      </div>

      <div v-if="error" class="error-message" role="alert">
        <svg class="error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
        </svg>
        {{ error }}
      </div>

      <div v-if="composeYaml" class="output-section">
        <div class="output-header">
          <span class="output-label">docker-compose.yml</span>
          <div class="output-actions">
            <button @click="copyToClipboard" class="btn-icon" title="复制" aria-label="复制 Compose 配置">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
            </button>
            <button @click="downloadYaml" class="btn-icon" title="下载" aria-label="下载 Compose 配置">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
            </button>
          </div>
        </div>
        <pre class="output-code" role="region" aria-label="转换后的 Docker Compose 配置"><code>{{ composeYaml }}</code></pre>
        <div v-if="copied" class="copy-toast" role="status" aria-live="polite">已复制到剪贴板</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const dockerRunCommand = ref('');
const composeYaml = ref('');
const error = ref('');
const copied = ref(false);

let autoConvertTimer = null;

// 监听外部命令加载事件
onMounted(() => {
  window.addEventListener('load-docker-command', handleLoadCommand);
});

onUnmounted(() => {
  window.removeEventListener('load-docker-command', handleLoadCommand);
});

function handleLoadCommand(event) {
  dockerRunCommand.value = event.detail;
  convert();
}

function autoConvert() {
  if (autoConvertTimer) clearTimeout(autoConvertTimer);
  autoConvertTimer = setTimeout(() => {
    if (dockerRunCommand.value.trim()) {
      convert();
    }
  }, 800);
}

function convert() {
  error.value = '';
  composeYaml.value = '';

  try {
    const cmd = normalizeCommand(dockerRunCommand.value);
    const parsed = parseDockerRun(cmd);
    composeYaml.value = generateCompose(parsed);
  } catch (e) {
    error.value = e.message;
  }
}

function normalizeCommand(cmd) {
  // 移除多余空白,处理续行符
  return cmd
    .replace(/\\\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDockerRun(cmd) {
  const tokens = tokenize(cmd);
  const result = {
    image: '',
    name: '',
    ports: [],
    volumes: [],
    environment: [],
    command: [],
    network: null,
    restart: null,
    detached: false,
    privileged: false,
    labels: [],
    networks: [],
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token === 'docker' || token === 'run') {
      i++;
      continue;
    }

    if (token === '-d' || token === '--detach') {
      result.detached = true;
      i++;
    } else if (token === '--name') {
      result.name = tokens[++i];
      i++;
    } else if (token === '-p' || token === '--publish') {
      result.ports.push(tokens[++i]);
      i++;
    } else if (token === '-v' || token === '--volume') {
      result.volumes.push(tokens[++i]);
      i++;
    } else if (token === '-e' || token === '--env') {
      result.environment.push(tokens[++i]);
      i++;
    } else if (token === '--network') {
      result.network = tokens[++i];
      i++;
    } else if (token === '--restart') {
      result.restart = tokens[++i];
      i++;
    } else if (token === '--privileged') {
      result.privileged = true;
      i++;
    } else if (token === '-l' || token === '--label') {
      result.labels.push(tokens[++i]);
      i++;
    } else if (token.startsWith('-')) {
      // 跳过未处理的选项
      i++;
      if (i < tokens.length && !tokens[i].startsWith('-')) {
        i++;
      }
    } else {
      // 第一个非选项 token 是镜像
      if (!result.image) {
        result.image = token;
        i++;
        // 剩余的都是命令
        while (i < tokens.length) {
          result.command.push(tokens[i++]);
        }
      } else {
        i++;
      }
    }
  }

  if (!result.image) {
    throw new Error('未找到镜像名称');
  }

  return result;
}

function tokenize(cmd) {
  const tokens = [];
  let current = '';
  let inQuote = null;

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === ' ') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

function generateCompose(parsed) {
  const serviceName = parsed.name || 'app';
  const lines = ['services:', `  ${serviceName}:`];

  lines.push(`    image: ${parsed.image}`);

  if (parsed.name) {
    lines.push(`    container_name: ${parsed.name}`);
  }

  if (parsed.ports.length > 0) {
    lines.push('    ports:');
    parsed.ports.forEach(p => {
      lines.push(`      - "${p}"`);
    });
  }

  if (parsed.volumes.length > 0) {
    lines.push('    volumes:');
    parsed.volumes.forEach(v => {
      lines.push(`      - ${v}`);
    });
  }

  if (parsed.environment.length > 0) {
    lines.push('    environment:');
    parsed.environment.forEach(e => {
      if (e.includes('=')) {
        const [key, ...rest] = e.split('=');
        const value = rest.join('=');
        lines.push(`      ${key}: ${value.includes(' ') ? `"${value}"` : value}`);
      } else {
        lines.push(`      ${e}: ""`);
      }
    });
  }

  if (parsed.command.length > 0) {
    lines.push(`    command: ${JSON.stringify(parsed.command)}`);
  }

  if (parsed.network) {
    lines.push('    networks:');
    lines.push(`      - ${parsed.network}`);
  }

  if (parsed.restart) {
    lines.push(`    restart: ${parsed.restart}`);
  }

  if (parsed.privileged) {
    lines.push('    privileged: true');
  }

  if (parsed.labels.length > 0) {
    lines.push('    labels:');
    parsed.labels.forEach(l => {
      if (l.includes('=')) {
        const [key, ...rest] = l.split('=');
        const value = rest.join('=');
        lines.push(`      ${key}: "${value}"`);
      }
    });
  }

  if (parsed.network) {
    lines.push('');
    lines.push('networks:');
    lines.push(`  ${parsed.network}:`);
    lines.push('    external: true');
  }

  return lines.join('\n');
}

function clear() {
  dockerRunCommand.value = '';
  composeYaml.value = '';
  error.value = '';
}

function copyToClipboard() {
  navigator.clipboard.writeText(composeYaml.value).then(() => {
    copied.value = true;
    setTimeout(() => copied.value = false, 2000);
  });
}

function downloadYaml() {
  const blob = new Blob([composeYaml.value], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'docker-compose.yml';
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
.converter-wrapper {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.converter-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.input-section,
.output-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.input-label,
.output-label {
  color: #F3F4F6;
  font-size: 14px;
  font-weight: 500;
}

.input-textarea {
  padding: 14px;
  background: #0F131C;
  border: 1px solid #1E2636;
  border-radius: 8px;
  color: #E5E7EB;
  font-family: 'Cascadia Code', 'JetBrains Mono', monospace;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  transition: border-color 0.15s;
}

.input-textarea:focus {
  outline: none;
  border-color: #38BDF8;
}

.input-textarea::placeholder {
  color: #4B5563;
}

.input-hint {
  color: #6B7280;
  font-size: 12px;
}

.converter-actions {
  display: flex;
  gap: 12px;
}

.btn-convert,
.btn-clear {
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-convert {
  background: #38BDF8;
  color: #0A0D12;
}

.btn-convert:hover:not(:disabled) {
  background: #0EA5E9;
}

.btn-convert:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-clear {
  background: #1E2636;
  color: #9CA3AF;
}

.btn-clear:hover {
  background: #2A3447;
  color: #E5E7EB;
}

.icon {
  width: 16px;
  height: 16px;
}

.error-message {
  padding: 12px 16px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  color: #EF4444;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.error-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.output-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.output-actions {
  display: flex;
  gap: 8px;
}

.btn-icon {
  padding: 6px;
  background: #1E2636;
  border: none;
  border-radius: 6px;
  color: #9CA3AF;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
}

.btn-icon:hover {
  background: #2A3447;
  color: #E5E7EB;
}

.output-code {
  margin: 0;
  padding: 16px;
  background: #0F131C;
  border: 1px solid #1E2636;
  border-radius: 8px;
  overflow-x: auto;
}

.output-code code {
  color: #E5E7EB;
  font-family: 'Cascadia Code', 'JetBrains Mono', monospace;
  font-size: 13px;
  line-height: 1.6;
}

.copy-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 12px 20px;
  background: #6EE7B7;
  color: #0A0D12;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  animation: slideIn 0.2s ease-out;
}

@keyframes slideIn {
  from {
    transform: translateY(100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
</style>
