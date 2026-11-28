import { afterEach, expect, it, vi } from 'vitest';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';
import { useAgentConsole } from '../src/composables/useAgentConsole.js';

afterEach(() => { const agent = useAgentConsole(); agent.stopPageTracking(); agent.closeAgent(); agent.resetAgentContext(); vi.useRealTimers(); });

it('认证变化清空手动目标和页面快照，旧 DOM 或定时回调不能重新填回', async () => {
  vi.useFakeTimers(); window.location.hash = '#/services';
  document.body.innerHTML = '<main class="app-main"><h1>旧账号</h1><input aria-label="配置" value="old-private-setting"></main>';
  const agent = useAgentConsole(); agent.startPageTracking(); agent.openAgent({ projectId: 'old-project', attachedLogs: 'old-logs' });
  document.querySelector('h1').textContent = '旧账号项目'; await Promise.resolve();
  advanceAuthEpoch();
  expect(agent.open.value).toBe(false); expect(agent.context.value).toEqual({});
  window.dispatchEvent(new HashChangeEvent('hashchange')); await vi.runAllTimersAsync();
  expect(agent.context.value).toEqual({});
  document.body.innerHTML = '<main class="app-main"><h1>新账号</h1></main>';
  agent.openAgent();
  expect(agent.context.value.projectId).toBe(''); expect(agent.context.value.attachedLogs).toBeUndefined();
  expect(JSON.stringify(agent.context.value)).not.toContain('old-');
});
