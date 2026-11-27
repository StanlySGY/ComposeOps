import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { h, ref, KeepAlive } from 'vue';

const listCronJobs = vi.hoisted(() => vi.fn());
const getInspectionOverview = vi.hoisted(() => vi.fn());
const createCronJob = vi.hoisted(() => vi.fn());
const getAgentTasks = vi.hoisted(() => vi.fn());
const getAgentTask = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  projects: [{ id: 'p1', projectName: '测试项目', hostId: 'local', managed: true, editable: true }],
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
  listCronJobs.mockResolvedValue({ jobs: [], targets: [{ hostId: 'local', hostName: '本机', connectionRevision: 'rev-local' }] });
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
  it('不完整巡检保留未知评分和实际报告节点，不回退为健康', async () => {
    getInspectionOverview.mockResolvedValue({ latest: { score: null, grade: 'incomplete', hostName: '远端公司节点', summary: '宿主采样不可用' }, schedule: { enabled: false } });
    wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('远端公司节点 · 最近巡检:信息不完整');
    expect(wrapper.text()).not.toContain('最近巡检:健康');
    expect(wrapper.get('.h-12.w-12').text()).toBe('—');
  });
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
    await wrapper.findAll('button').find(button => button.text().includes('预览定时计划')).trigger('click');
    await wrapper.findAll('button').find(button => button.text().includes('创建定时任务')).trigger('click');
    await flushPromises();

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain('任务仅部分创建');
    expect(alert.text()).toContain('已创建 1/3 项');
    expect(alert.text()).toContain('不要直接重试');
    expect(createCronJob).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('button').some(button => button.text().includes('创建定时任务'))).toBe(false);
  });

  it('提交的每个任务都与预览范围一致：备份和拉取固定项目，巡检固定节点', async () => {
    wrapper = mountView(); await flushPromises();
    await wrapper.get('select[aria-label="目标项目"]').setValue('p1');
    await wrapper.findAll('button').find(button => button.text().includes('预览定时计划')).trigger('click');
    expect(wrapper.text()).toContain('每项任务独立按同一周期触发，不保证先后顺序');
    expect(wrapper.text()).toContain('独立巡检「本机」全部容器');
    expect(wrapper.text()).not.toContain('部署完成后');
    await wrapper.findAll('button').find(button => button.text().includes('创建定时任务')).trigger('click');
    await flushPromises();
    const bodies = createCronJob.mock.calls.map(([body]) => body);
    expect(bodies).toHaveLength(3);
    expect(bodies.slice(0, 2)).toEqual([
      expect.objectContaining({ scope: 'project', projectId: 'p1', hostId: 'local', connectionRevision: 'rev-local', type: 'volume-backup' }),
      expect.objectContaining({ scope: 'project', projectId: 'p1', hostId: 'local', connectionRevision: 'rev-local', type: 'pull-images' }),
    ]);
    expect(bodies[2]).toMatchObject({ type: 'inspection', hostId: 'local', connectionRevision: 'rev-local' });
    expect(bodies[2]).not.toHaveProperty('projectId');
  });

  it('修改周期或节点连接修订后撤销原预览，要求重新确认', async () => {
    wrapper = mountView(); await flushPromises();
    await wrapper.get('select[aria-label="目标项目"]').setValue('p1');
    const preview = () => wrapper.findAll('button').find(button => button.text().includes('预览定时计划')).trigger('click');
    await preview();
    await wrapper.get('select[aria-label="执行时间"]').setValue('0 4 * * 0');
    expect(wrapper.find('[data-testid="plan-scope"]').exists()).toBe(false);
    await preview();
    expect(wrapper.get('[data-testid="plan-scope"]').text()).toContain('每周日 04:00');
    listCronJobs.mockResolvedValue({ jobs: [], targets: [{ hostId: 'local', hostName: '本机', connectionRevision: 'changed' }] });
    await wrapper.findAll('button').find(button => button.text() === '刷新').trigger('click'); await flushPromises();
    expect(wrapper.find('[data-testid="plan-scope"]').exists()).toBe(false);
    expect(createCronJob).not.toHaveBeenCalled();
  });

  it('创建期间锁住表单且重复点击不会重复提交，使用已预览的不可变参数', async () => {
    let finish;
    createCronJob.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    wrapper = mountView(); await flushPromises();
    await wrapper.get('select[aria-label="目标项目"]').setValue('p1');
    await wrapper.findAll('button').find(button => button.text().includes('预览定时计划')).trigger('click');
    const submit = wrapper.findAll('button').find(button => button.text().includes('创建定时任务'));
    await submit.trigger('click'); await submit.trigger('click');
    expect(createCronJob).toHaveBeenCalledTimes(1);
    expect(wrapper.get('select[aria-label="执行时间"]').attributes('disabled')).toBeDefined();
    finish({ id: 'first' }); await flushPromises();
    expect(createCronJob).toHaveBeenCalledTimes(3);
    expect(createCronJob.mock.calls.every(([body]) => body.cron === '0 3 * * *')).toBe(true);
  });

  it('父页面缓存失活后停止后台任务轮询，重新激活仅恢复一个定时器', async () => {
    vi.useFakeTimers();
    try {
      const visible = ref(true);
      wrapper = mount({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(OperationsCenterView) : h('div') }) }, { global: { stubs: { 'router-link': true } } });
      await flushPromises(); const initial = getAgentTasks.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10000); expect(getAgentTasks).toHaveBeenCalledTimes(initial + 1);
      visible.value = false; await flushPromises(); await vi.advanceTimersByTimeAsync(30000);
      expect(getAgentTasks).toHaveBeenCalledTimes(initial + 1);
      visible.value = true; await flushPromises(); await vi.advanceTimersByTimeAsync(10000);
      expect(getAgentTasks).toHaveBeenCalledTimes(initial + 2);
    } finally { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); }
  });
});
