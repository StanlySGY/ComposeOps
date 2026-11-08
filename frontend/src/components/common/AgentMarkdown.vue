<template>
  <div>
    <div ref="rootEl"></div>
    <span class="sr-only" role="status" aria-live="polite">{{ copyStatus }}</span>
  </div>
</template>

<script setup>
import { watch, onMounted, onBeforeUnmount, ref } from 'vue';
import { renderAgentMarkdown } from '../../lib/agent-markdown.js';
import { copyText } from '../../lib/clipboard.js';

const props = defineProps({ content: String });
const rootEl = ref(null), copyStatus = ref('');
let revision = 0, disposed = false;
const timers = new Set();
const copyIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16V4h12"/></svg>';
function renderContent() {
  if (!rootEl.value) return;
  const current = ++revision;
  for (const timer of timers) clearTimeout(timer);
  timers.clear(); copyStatus.value = '';
  rootEl.value.innerHTML = renderAgentMarkdown(props.content || '');
  for (const pre of rootEl.value.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const text = code?.textContent || pre.textContent;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'code-copy-btn'; btn.innerHTML = `${copyIcon}<span>复制</span>`;
    btn.title = '复制代码'; btn.setAttribute('aria-label', '复制代码');
    btn.onclick = async event => {
      event.stopPropagation(); btn.disabled = true; copyStatus.value = '正在复制代码…';
      try {
        await copyText(text);
        if (disposed || current !== revision) return;
        btn.textContent = '已复制'; copyStatus.value = '已复制代码';
      } catch {
        if (disposed || current !== revision) return;
        btn.textContent = '重试复制'; copyStatus.value = '复制失败，请选中代码后复制'; btn.title = copyStatus.value;
      } finally {
        if (!disposed && current === revision) {
          btn.disabled = false;
          const timer = setTimeout(() => { timers.delete(timer); btn.innerHTML = `${copyIcon}<span>复制</span>`; btn.title = '复制代码'; }, 2000);
          timers.add(timer);
        }
      }
    };
    pre.classList.add('has-code-copy'); pre.style.position = 'relative';
    const label = document.createElement('span'); label.className = 'code-language';
    label.textContent = code?.className.match(/language-([\w+-]+)/)?.[1] || '代码';
    pre.append(label, btn);
  }
}
watch(() => props.content, renderContent, { flush: 'post' });
onMounted(renderContent);
onBeforeUnmount(() => { disposed = true; revision += 1; for (const timer of timers) clearTimeout(timer); timers.clear(); });
</script>
