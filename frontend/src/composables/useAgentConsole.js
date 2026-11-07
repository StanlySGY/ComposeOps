import { computed, ref } from 'vue';

const open = ref(false);
const context = ref({});
const autoContext = ref({});
const manualContext = ref({});
const manualContextRoute = ref('');
let observer;
let syncTimer;
const SENSITIVE_FIELD_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|\bPASS\b|(?:API|PRIVATE|ACCESS|SECRET|AUTH|SIGNING)[_-]?KEY)/i;
// 字段名不带敏感关键词、但值本身长得像凭据的兜底过滤。
const SENSITIVE_VALUE_RE = /(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

const PAGE_LABELS = {
  '/services': '服务',
  '/compose': 'Compose 编辑器',
  '/logs': '日志',
  '/shell': '终端',
  '/agent': 'AI 助手',
  '/agent/history': 'Agent 执行历史',
  '/monitor': '实时监控',
  '/review': '变更与回滚',
  '/events': '事件中心',
  '/resources': '存储清理',
  '/cron': '定时任务',
  '/gitops': 'GitOps',
  '/cost': '成本分析',
  '/marketplace': '应用市场',
  '/settings': '设置',
};

function currentRoute() {
  return window.location.hash.replace(/^#/, '').split('?')[0] || '/services';
}

function collectPageSnapshot() {
  const root = document.querySelector('.app-main');
  if (!root) return {};
  const visibleText = String(root.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
  const fields = [...root.querySelectorAll('input, select, textarea')]
    .filter((field) => field.type !== 'password' && !field.disabled)
    .map((field) => ({
      label: field.getAttribute('aria-label') || field.getAttribute('name') || field.placeholder || field.closest('label')?.innerText?.split(field.value || '')[0]?.trim() || field.tagName.toLowerCase(),
      value: String(field.value || '').slice(0, 500),
    }))
    .filter((field) => !SENSITIVE_FIELD_RE.test(field.label))
    .filter((field) => !SENSITIVE_VALUE_RE.test(field.value))
    .filter((field) => field.value || field.label);
  const headings = [...root.querySelectorAll('h1, h2, h3, .page-title, .page-subtitle')]
    .map((node) => (node.innerText || node.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    summary: headings.join(' · ').slice(0, 1000),
    state: JSON.stringify({ visibleText, fields }).slice(0, 12000),
  };
}

function syncPageContext() {
  const route = currentRoute();
  if (route === '/agent') open.value = false;
  const snapshot = collectPageSnapshot();
  autoContext.value = {
    page: PAGE_LABELS[route] || route,
    route: window.location.hash.replace(/^#/, '') || route,
    mode: '运维问答与操作',
    summary: snapshot.summary || `当前页面:${PAGE_LABELS[route] || route}`,
    state: snapshot.state || '',
  };
  if (manualContextRoute.value && manualContextRoute.value !== route) {
    manualContext.value = {};
    manualContextRoute.value = '';
  }
  context.value = { ...autoContext.value, ...manualContext.value };
}

function scheduleSync() {
  // 快照要走 innerText(强制布局)且随页面 DOM 变化高频触发;
  // 抽屉关闭时无人消费上下文,直接跳过,openAgent 时会补一次同步。
  if (!open.value) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncPageContext, 120);
}

export function useAgentConsole() {
  function openAgent(nextContext = {}) {
    syncPageContext();
    manualContext.value = { ...manualContext.value, ...nextContext };
    context.value = { ...autoContext.value, ...manualContext.value };
    if (currentRoute() === '/agent') {
      open.value = false;
      window.dispatchEvent(new CustomEvent('composeops:agent-focus'));
    } else open.value = true;
  }

  function updateAgentContext(nextContext = {}) {
    manualContextRoute.value = currentRoute();
    manualContext.value = { ...manualContext.value, ...nextContext };
    context.value = { ...autoContext.value, ...manualContext.value };
  }

  function closeAgent() { open.value = false; }

  function resetAgentContext() {
    manualContext.value = {};
    manualContextRoute.value = '';
    context.value = { ...autoContext.value };
  }

  function startPageTracking() {
    if (observer) return;
    syncPageContext();
    window.addEventListener('hashchange', syncPageContext);
    observer = new MutationObserver(scheduleSync);
    observer.observe(document.querySelector('.app-main') || document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopPageTracking() {
    window.removeEventListener('hashchange', syncPageContext);
    observer?.disconnect();
    observer = null;
    clearTimeout(syncTimer);
  }

  return { open: computed(() => open.value), context, openAgent, updateAgentContext, closeAgent, resetAgentContext, startPageTracking, stopPageTracking };
}
