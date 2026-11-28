import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useAgentConsole } = await import('../src/composables/useAgentConsole.js');

describe('useAgentConsole', () => {
  beforeEach(() => {
    window.location.hash = '#/services';
    document.body.innerHTML = '<main class="app-main"><h1 class="page-title">服务</h1><p>2 个项目</p><label>搜索<input value="api" /></label><label>私钥<textarea name="privateKey">do-not-send</textarea></label></main>';
  });

  it('收集当前页面摘要和表单状态', () => {
    const agent = useAgentConsole();
    agent.startPageTracking();
    agent.openAgent();

    expect(agent.context.value.page).toBe('服务');
    expect(agent.context.value.route).toBe('/services');
    expect(agent.context.value.summary).toContain('服务');
    expect(agent.context.value.state).toContain('api');
    expect(agent.context.value.state).not.toContain('do-not-send');

    agent.stopPageTracking();
  });

  it('页面切换时清理旧页面的手动上下文', () => {
    const agent = useAgentConsole();
    agent.startPageTracking();
    agent.updateAgentContext({ mode: 'cron-editor', state: '{"name":"backup"}' });
    agent.openAgent();
    expect(agent.context.value.mode).toBe('cron-editor');

    window.location.hash = '#/monitor';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(agent.context.value.page).toBe('实时监控');
    expect(agent.context.value.mode).toBe('运维问答与操作');

    agent.stopPageTracking();
  });

  it('重复启动跟踪不会注册多个观察器', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const agent = useAgentConsole();
    agent.startPageTracking();
    agent.startPageTracking();
    expect(observe).toHaveBeenCalledTimes(1);
    agent.stopPageTracking();
    observe.mockRestore();
  });
});

it('openAgent 的结构化目标随页面切换清空，不把旧节点带到新页面', () => {
  window.location.hash = '#/reliability';
  const agent = useAgentConsole(); agent.startPageTracking();
  agent.openAgent({ hostId: 'node-a', projectId: 'p1', state: JSON.stringify({ resource: { type: 'sre-profile', id: 'health-1', version: 2 } }) });
  expect(agent.context.value.hostId).toBe('node-a');
  window.location.hash = '#/services'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  expect(agent.context.value.hostId).not.toBe('node-a'); expect(agent.context.value.state).not.toContain('health-1');
  agent.stopPageTracking(); agent.resetAgentContext(); agent.closeAgent();
});
