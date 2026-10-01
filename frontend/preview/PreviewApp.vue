<template>
  <div class="preview-root">
    <div class="preview-banner" role="region" aria-label="预览说明">
      <p><span class="preview-dot"></span><strong>交互预览</strong><span class="preview-mobile-note">示例数据</span><span class="preview-description">真实应用界面 · 仅示例数据，刷新即重置 · 不连接 Docker 或 AI</span></p>
      <div><button @click="reset">重置演示</button><button @click="help = true">使用说明</button><a href="https://github.com/StanlySGY/ComposeOps" target="_blank" rel="noopener noreferrer">GitHub</a><button class="preview-install" @click="install = true">安装部署</button></div>
    </div>
    <div class="preview-application"><App /></div>
    <BaseModal :show="help" title="与真实部署一致的界面" @close="help = false">
      <div class="space-y-3 p-2 text-sm leading-6 text-surface-300">
        <p>本预览直接运行 ComposeOps 正式前端，包括顶部工具栏、完整导航、页面、弹层和移动端布局。</p>
        <p>所有项目、指标、日志、密钥和 AI 回复均为虚构示例。支持的操作只修改当前页面内存，刷新后重置；未模拟的操作会明确提示，绝不会访问真实服务器。</p>
        <p>可从服务页展开 knowledge-base，查看日志与配置；在 AI 助手输入“排查 wiki-api”，体验真实审批界面的预设流程。设置 → AI 展示真实的多渠道编辑和保存交互。</p>
      </div>
    </BaseModal>
    <BaseModal :show="install" title="安装 ComposeOps" @close="install = false">
      <div class="space-y-4 p-2 text-sm text-surface-300">
        <p>在安装了 Docker 和 Compose v2 的服务器执行：</p>
        <pre class="overflow-x-auto rounded-lg bg-surface-950 p-3 text-xs leading-6">{{ command }}</pre>
        <button class="btn-primary" @click="copy">{{ copied ? '已复制' : '复制安装命令' }}</button>
        <p>访问 http://服务器地址:28765，首次访问设置管理员密码。AI 为可选能力。</p>
        <a class="text-emerald-400" href="https://github.com/StanlySGY/ComposeOps/blob/main/docs/public/BACKUP_RESTORE.md" target="_blank" rel="noopener noreferrer">备份与恢复说明 →</a>
      </div>
    </BaseModal>
  </div>
</template>
<script setup>
import { ref } from 'vue';
import App from '../src/App.vue';
import BaseModal from '../src/components/common/BaseModal.vue';
const help = ref(false), install = ref(false), copied = ref(false);
const command = 'mkdir composeops && cd composeops\ncurl -fsSL https://github.com/StanlySGY/ComposeOps/releases/latest/download/compose.yml -o compose.yml\ndocker compose pull\ndocker compose up -d';
function reset() { location.reload(); }
async function copy() { try { await navigator.clipboard.writeText(command); copied.value = true; } catch { copied.value = false; } }
</script>
