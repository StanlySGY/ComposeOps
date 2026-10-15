import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

const { listCronJobs, getCronHistory, openAgent, updateAgentContext, resetAgentContext } = vi.hoisted(() => ({
  listCronJobs: vi.fn(),
  getCronHistory: vi.fn(),
  openAgent: vi.fn(),
  updateAgentContext: vi.fn(),
  resetAgentContext: vi.fn(),
}));

vi.mock('../src/api/client.js', () => ({
  api: {
    listCronJobs,
    getCronHistory,
    createCronJob: vi.fn(),
    updateCronJob: vi.fn(),
    deleteCronJob: vi.fn(),
    runCronJob: vi.fn(),
  },
}));

vi.mock('../src/composables/useAgentConsole.js', () => ({
  useAgentConsole: () => ({ openAgent, updateAgentContext, resetAgentContext }),
}));

import CronTasksView from '../src/views/CronTasksView.vue';

function backdropExists() {
  return Boolean(document.body.querySelector('.modal-backdrop'));
}

describe('CronTasksView Agent integration', () => {
  let wrapper;
  let router;

  beforeEach(async () => {
    setActivePinia(createPinia());
    listCronJobs.mockClear();
    getCronHistory.mockClear();
    listCronJobs.mockResolvedValue({ jobs: [], types: { 'db-backup': { label: '数据库备份', description: '备份' } } });
    getCronHistory.mockResolvedValue({ history: [] });
    openAgent.mockClear();
    updateAgentContext.mockClear();
    resetAgentContext.mockClear();
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<main>测试路由</main>' } }] });
    await router.push('/');
    await router.isReady();
  });

  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('从新建任务弹窗打开 Agent 时携带 cron-editor 上下文', async () => {
    wrapper = mount(CronTasksView, { global: { plugins: [router] } });
    await nextTick();
    await wrapper.find('button.btn-primary').trigger('click');
    await nextTick();

    const agentButton = document.body.querySelector('button[title="让 Agent 根据当前表单创建任务"]');
    expect(agentButton).toBeTruthy();
    agentButton.click();
    await nextTick();

    expect(openAgent).toHaveBeenCalledTimes(1);
    expect(updateAgentContext).toHaveBeenCalledWith(expect.objectContaining({ mode: 'cron-editor' }));
    expect(updateAgentContext.mock.calls.at(-1)[0].state).toContain('db-backup');
  });

  it('收到 cron.create 成功事件后关闭编辑器并刷新列表', async () => {
    wrapper = mount(CronTasksView, { global: { plugins: [router] } });
    await nextTick();
    await wrapper.find('button.btn-primary').trigger('click');
    await nextTick();
    expect(backdropExists()).toBe(true);

    window.dispatchEvent(new CustomEvent('composeops:cron-agent-created', { detail: { name: '夜间备份' } }));
    await nextTick();

    expect(backdropExists()).toBe(false);
    expect(listCronJobs).toHaveBeenCalledTimes(2);
  });
});
