import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

const api = vi.hoisted(() => ({
  getAgentTasks: vi.fn(),
  getWorkflowInstances: vi.fn(),
  getEvents: vi.fn(),
  getOperations: vi.fn(),
  listJobs: vi.fn(),
  getAgentExecutions: vi.fn(),
  getAgentAuditEvents: vi.fn(),
  getWorkflowInstance: vi.fn(),
  getAgentTask: vi.fn(),
  getJob: vi.fn(),
  updateEvent: vi.fn(),
  approveWorkflowInstance: vi.fn(),
  cancelWorkflowInstance: vi.fn(),
  stopAgentTask: vi.fn(),
}));
vi.mock('../src/api/client.js', () => ({ api }));

const { default: AutonomousOpsView } = await import('../src/views/AutonomousOpsView.vue');
const { default: ConfirmDialog } = await import('../src/components/common/ConfirmDialog.vue');

let wrapper;
let router;
const workflow = {
  id: 'wfi-1',
  name: '生产发布审批',
  status: 'waiting_approval',
  currentNode: 'approval',
  createdAt: '2026-11-04 10:00:00',
  context: { pendingApprovalIntent: { actionIntent: { action: 'restart', projectId: 'cf-1' } } },
  steps: [{ id: 1, nodeId: 'approval', nodeType: 'approval', status: 'waiting_approval', startedAt: '2026-11-04 10:00:00' }],
};

beforeEach(async () => {
  vi.clearAllMocks();
  api.getAgentTasks.mockResolvedValue({ tasks: [{ id: 'task-1', label: '日志收集', taskType: 'logs', status: 'running', projectId: 'cf-1', startedAt: '2026-11-04T10:05:00Z', sessionId: 7 }] });
  api.getWorkflowInstances.mockResolvedValue({ instances: [workflow] });
  api.getEvents.mockResolvedValue({ events: [{ id: 1, eventType: 'workflow', source: 'workflow', title: '发布检查等待审批', detail: '实例 wfi-1', severity: 'warning', status: 'open', payload: { instanceId: 'wfi-1' }, createdAt: '2026-11-04 10:01:00' }] });
  api.getOperations.mockResolvedValue({ operations: [{ id: 9, projectId: 'cf-1', projectName: 'content-factory', action: 'compose.restart', status: 'success', detail: '健康检查通过', createdAt: '2026-11-04 10:02:00' }] });
  api.listJobs.mockResolvedValue({ jobs: [{ id: 'job-1', action: 'pull', status: 'success', total: 1, completed: 1, createdAt: '2026-11-04 09:00:00', finishedAt: '2026-11-04 09:01:00' }] });
  api.getAgentExecutions.mockResolvedValue({ plans: [
    { id: 'plan-1', session_id: 7, user_message: '检查 content-factory 服务', plan_json: '{"role":"validator"}', status: 'success', created_at: '2026-11-04 10:03:00', executed_at: '2026-11-04T10:04:00Z' },
  ], executions: [] });
  api.getAgentAuditEvents.mockResolvedValue({ events: [
    { id: 'audit-1', planId: 'plan-1', executionId: 'exec-1', eventType: 'approval_requested', toolName: 'compose.restart', decision: 'requested', createdAt: '2026-11-04 10:03:30' },
  ] });
  api.getWorkflowInstance.mockResolvedValue({ instance: workflow });
  api.getAgentTask.mockResolvedValue({ task: { id: 'task-1', status: 'running', output: 'collecting logs', outputBytes: 14 } });
  api.getJob.mockResolvedValue({ id: 'job-1', status: 'success', items: [{ id: 1, projectName: 'content-factory', status: 'success', output: 'pull completed' }] });
  api.updateEvent.mockResolvedValue({ event: { id: 1, status: 'resolved' } });
  api.approveWorkflowInstance.mockResolvedValue({ instance: { ...workflow, status: 'running' } });
  api.cancelWorkflowInstance.mockResolvedValue({ instance: { ...workflow, status: 'cancelled' } });
  api.stopAgentTask.mockResolvedValue({ stopped: true, killed: true });

  router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<main />' } },
    { path: '/agent', component: { template: '<main />' } },
    { path: '/agent/history', component: { template: '<main />' } },
  ] });
  await router.push('/');
  await router.isReady();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

async function mountView() {
  wrapper = mount(AutonomousOpsView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe('AutonomousOpsView command center', () => {
  it('汇聚 Agent、后台任务、工作流和批量任务，并默认聚焦待审批记录', async () => {
    await mountView();
    expect(wrapper.text()).toContain('Autonomous Ops');
    expect(wrapper.text()).toContain('日志收集');
    expect(wrapper.text()).toContain('生产发布审批');
    expect(wrapper.text()).toContain('检查 content-factory 服务');
    expect(wrapper.text()).toContain('批量拉取镜像');
    expect(wrapper.text()).toContain('工作流审批意图');
    expect(api.getAgentExecutions).toHaveBeenCalledWith('', 250);
  });

  it('支持关键词搜索及结果待核对快捷入口', async () => {
    await mountView();
    const search = wrapper.get('input[aria-label="搜索任务"]');
    await search.setValue('content-factory');
    await flushPromises();
    expect(wrapper.text()).toContain('检查 content-factory 服务');
    expect(wrapper.text()).not.toContain('日志收集');

    await wrapper.get('button[role="tab"]').trigger('click');
    const reviewTab = wrapper.findAll('button[role="tab"]').find((button) => button.text().includes('结果待核对'));
    await reviewTab.trigger('click');
    expect(wrapper.text()).toContain('没有待核对或失败任务');
  });

  it('在待审批列表中保留 Agent 审批来源并可定位回原会话', async () => {
    await mountView();
    const approvalTab = wrapper.findAll('button[role="tab"]').find((button) => button.text().includes('待你审批'));
    await approvalTab.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Agent 会话确认');
    const agentApproval = wrapper.findAll('.ops-record').find((button) => button.text().includes('compose.restart'));
    await agentApproval.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Agent 执行历史');
    const openSession = wrapper.findAll('button').find((button) => button.text().includes('打开原会话'));
    expect(openSession).toBeTruthy();
    const push = vi.spyOn(router, 'push');
    await openSession.trigger('click');
    expect(push).toHaveBeenCalledWith({ path: '/agent', query: { sessionId: '7' } });
  });

  it('工作流审批必须经过二次确认 UI，并使用原有审批 API', async () => {
    await mountView();
    const approve = wrapper.findAll('button').find((button) => button.text().includes('审批通过'));
    expect(approve).toBeTruthy();
    await approve.trigger('click');
    await flushPromises();
    const dialog = wrapper.findComponent(ConfirmDialog);
    expect(dialog.props('show')).toBe(true);
    expect(dialog.props('title')).toBe('确认通过工作流审批');
    dialog.vm.$emit('confirm');
    await flushPromises();
    expect(api.approveWorkflowInstance).toHaveBeenCalledWith('wfi-1', { approved: true });
  });

  it('事件处理仅更新事件状态，不会调用执行或部署端点', async () => {
    await mountView();
    const eventsTab = wrapper.findAll('button[role="tab"]').find((button) => button.text().includes('事件观察'));
    await eventsTab.trigger('click');
    await flushPromises();
    const eventRow = wrapper.findAll('.ops-record').find((button) => button.text().includes('发布检查等待审批'));
    await eventRow.trigger('click');
    await flushPromises();
    const resolved = wrapper.findAll('button').find((button) => button.text().includes('标记解决'));
    await resolved.trigger('click');
    await flushPromises();
    expect(api.updateEvent).toHaveBeenCalledWith(1, { status: 'resolved' });
    expect(api.approveWorkflowInstance).not.toHaveBeenCalled();
    expect(api.cancelWorkflowInstance).not.toHaveBeenCalled();
    expect(api.stopAgentTask).not.toHaveBeenCalled();
  });
});
