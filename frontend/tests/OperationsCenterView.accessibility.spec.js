import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const listCronJobs = vi.hoisted(() => vi.fn());
const getInspectionOverview = vi.hoisted(() => vi.fn());
const createCronJob = vi.hoisted(() => vi.fn());
const getAgentTasks = vi.hoisted(() => vi.fn());
const getAgentTask = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  projects: [{ id: 'p1', projectName: '测试项目' }],
  refresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/api/client.js', () => ({ api: { listCronJobs, getInspectionOverview, createCronJob, getAgentTasks, getAgentTask } }));
vi.mock('../src/stores/services.js', () => ({ useServicesStore: () => store }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));

import OperationsCenterView from '../src/views/OperationsCenterView.vue';

let wrapper;
beforeEach(() => {
  listCronJobs.mockReset();
  getInspectionOverview.mockReset();
  createCronJob.mockReset();
  getAgentTasks.mockReset();
  getAgentTask.mockReset();
  store.refresh.mockClear().mockResolvedValue(undefined);
  listCronJobs.mockResolvedValue({ jobs: [] });
  getInspectionOverview.mockResolvedValue({ latest: null, schedule: { enabled: false, intervalHours: 24 }, reports: [] });
  createCronJob.mockResolvedValue({ id: 'created-job' });
  getAgentTasks.mockResolvedValue({ tasks: [] });
  getAgentTask.mockResolvedValue({ task: { output: '' } });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; });
function mountView() {
  return mount(OperationsCenterView, {
    global: {
      stubs: {
        'router-link': { template: '<a><slot /></a>' },
      },
    },
  });
}

describe('运维任务中心的加载失败与部分创建反馈', () => {
  it('定时任务列表读取失败时显示错误，不伪装成暂无任务', async () => {
    listCronJobs.mockRejectedValueOnce(new Error('cron database offline'));
    wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('定时任务加载失败');
    expect(wrapper.get('[role="alert"]').text()).toContain('cron database offline');
    expect(wrapper.text()).not.toContain('暂无定时任务');
    expect(wrapper.attributes('aria-busy')).toBe('false');
  });

  it('巡检状态读取失败时显示独立错误，不伪装成暂无报告', async () => {
    getInspectionOverview.mockRejectedValueOnce(new Error('inspection service unavailable'));
    wrapper = mountView();
    await flushPromises();

    const alerts = wrapper.findAll('[role="alert"]').map(item => item.text());
    expect(alerts.some(message => message.includes('AI 巡检状态加载失败') && message.includes('inspection service unavailable'))).toBe(true);
    expect(wrapper.text()).not.toContain('暂无巡检报告');
    expect(wrapper.text()).toContain('暂无定时任务'); // 另一数据源成功，保留真实空态
  });

  it('加载期间播报进度，两个数据源成功返回空列表后才展示真实空态', async () => {
    let resolveJobs;
    let resolveInspection;
    listCronJobs.mockImplementationOnce(() => new Promise(resolve => { resolveJobs = resolve; }));
    getInspectionOverview.mockImplementationOnce(() => new Promise(resolve => { resolveInspection = resolve; }));
    wrapper = mountView();
    await vi.waitFor(() => expect(listCronJobs).toHaveBeenCalledOnce());
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('正在加载运维任务中心');
    expect(wrapper.text()).toContain('正在加载定时任务');
    expect(wrapper.text()).toContain('正在加载巡检状态');

    resolveJobs({ jobs: [] });
    resolveInspection({ latest: null, schedule: { enabled: false, intervalHours: 24 }, reports: [] });
    await flushPromises();
    expect(wrapper.text()).toContain('暂无定时任务');
    expect(wrapper.text()).toContain('暂无巡检报告');
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(0);
  });

  it('展示持久化 Agent 后台任务并支持展开查看输出', async () => {
    getAgentTasks.mockResolvedValueOnce({ tasks: [{
      id: 'agt-1', label: 'compose.up demo', projectId: 'p1',
      status: 'completed', startedAt: '2026-11-02T10:00:00.000Z',
    }] });
    getAgentTask.mockResolvedValueOnce({ task: { id: 'agt-1', status: 'completed', output: 'compose operation completed' } });
    wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('compose.up demo');
    expect(wrapper.text()).toContain('已完成');
    await wrapper.findAll('button').find(button => button.text().includes('输出')).trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('compose operation completed');
  });

  it('计划只创建出部分定时任务时刷新列表、明确告知勿整组重试', async () => {
    createCronJob.mockResolvedValueOnce({ id: 'created-volume' }).mockRejectedValueOnce(new Error('pull job rejected'));
    wrapper = mountView();
    await flushPromises();
    await wrapper.get('select[aria-label="目标项目"]').setValue('p1');
    await wrapper.findAll('button').find(button => button.text().includes('生成任务流')).trigger('click');
    await wrapper.findAll('button').find(button => button.text().includes('创建定时任务')).trigger('click');
    await flushPromises();

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain('任务仅部分创建');
    expect(alert.text()).toContain('已创建 1/3 项');
    expect(alert.text()).toContain('不要直接重试');
    expect(createCronJob).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('button').some(button => button.text().includes('创建定时任务'))).toBe(false);
  });
});
