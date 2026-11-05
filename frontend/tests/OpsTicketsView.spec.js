import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

const api = vi.hoisted(() => ({
  getOpsTickets: vi.fn(),
  getOpsTicket: vi.fn(),
  createOpsTicket: vi.fn(),
  updateOpsTicket: vi.fn(),
  issueOpsMandate: vi.fn(),
  revokeOpsMandate: vi.fn(),
  createOpsAssignment: vi.fn(),
  updateOpsAssignment: vi.fn(),
  reconcileOpsAssignment: vi.fn(),
  createOpsReport: vi.fn(),
  decideOpsReport: vi.fn(),
  createOpsEffect: vi.fn(),
  getOpsEffectWorkerStatus: vi.fn(),
  approveOpsEffect: vi.fn(),
  cancelOpsEffect: vi.fn(),
  reconcileOpsEffect: vi.fn(),
}));
vi.mock('../src/api/client.js', () => ({ api }));

const { default: OpsTicketsView } = await import('../src/views/OpsTicketsView.vue');

const ticket = {
  id: 'opt-1', title: '检查 staging Compose 服务', description: '核对镜像与运行状态。',
  status: 'active', priority: 'high', sourceType: 'manual', projectId: 'project-staging',
  acceptanceCriteria: ['报告包含服务状态证据'], createdAt: '2026-11-04T10:00:00Z',
};
const mandate = {
  id: 'omd-1', ticketId: 'opt-1', version: 1, status: 'active',
  scope: { projectIds: ['project-staging'], hostIds: [], resourceIds: [] },
  allowedActions: ['service.inspect'], deniedActions: ['volume.delete'],
  fingerprint: 'a'.repeat(64), expiresAt: '2026-12-01T00:00:00Z',
};
const assignment = {
  id: 'oas-1', ticketId: 'opt-1', sequence: 1, workerRole: 'executor', sourceType: 'agent-session',
  sourceId: 'session-source-7', sessionId: 7, status: 'running', attempt: 1,
  handoffSummary: '只读检查 staging 服务。', createdAt: '2026-11-04T10:01:00Z', updatedAt: '2026-11-04T10:02:00Z',
};
const effect = {
  id: 'oef-1', ticketId: 'opt-1', effectType: 'service.inspect', mode: 'execute', risk: 'low',
  status: 'awaiting_approval', target: { projectId: 'project-staging' }, payload: { readOnly: true },
  mandateId: 'omd-1', createdAt: '2026-11-04T10:03:00Z',
};
const detail = {
  ticket, mandates: [mandate], assignments: [assignment], reports: [], effects: [effect],
  activity: [{ id: 'evt-1', eventType: 'ticket_created', createdAt: '2026-11-04T10:00:00Z', details: { title: ticket.title } }],
};

let wrapper;
let router;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'prompt').mockReturnValue('人工核对记录');
  api.getOpsTickets.mockResolvedValue({ tickets: [{ ...ticket, assignmentCount: 1, pendingReports: 0, attentionEffects: 1 }], stats: { open: 1, blocked: 0, review: 0, terminal: 0 } });
  api.getOpsTicket.mockResolvedValue(structuredClone(detail));
  api.createOpsTicket.mockImplementation(async (payload) => ({ ticket: { ...ticket, ...payload, id: 'opt-new' }, replayed: false }));
  api.updateOpsTicket.mockResolvedValue({ ticket: { ...ticket, status: 'ready' } });
  api.issueOpsMandate.mockResolvedValue({ mandate: mandate });
  api.revokeOpsMandate.mockResolvedValue({ mandate: { ...mandate, status: 'revoked' } });
  api.createOpsAssignment.mockResolvedValue({ assignment: { ...assignment, id: 'oas-new' } });
  api.updateOpsAssignment.mockResolvedValue({ assignment });
  api.reconcileOpsAssignment.mockResolvedValue({ assignment: { ...assignment, status: 'failed' } });
  api.createOpsReport.mockResolvedValue({ report: { id: 'orp-new', status: 'submitted' } });
  api.decideOpsReport.mockResolvedValue({ report: { id: 'orp-new', status: 'accepted' } });
  api.createOpsEffect.mockResolvedValue({ effect: { ...effect, status: 'proposed' } });
  api.getOpsEffectWorkerStatus.mockResolvedValue({ state: 'running', enabled: true, readOnlyOnly: true, queueDepth: 0, executing: 0, leased: 0, outcomeUnknown: 0, supportedActions: [{ effectType: 'service.inspect' }, { effectType: 'container.inspect' }] });
  api.approveOpsEffect.mockResolvedValue({ effect: { ...effect, status: 'queued' } });
  api.cancelOpsEffect.mockResolvedValue({ effect: { ...effect, status: 'cancelled' } });
  api.reconcileOpsEffect.mockResolvedValue({ effect: { ...effect, status: 'failed' } });

  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tickets', component: OpsTicketsView },
      { path: '/ops-center', component: { template: '<main />' } },
    ],
  });
  await router.push('/tickets');
  await router.isReady();
  wrapper = mount(OpsTicketsView, { global: { plugins: [router] } });
  await flushPromises();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
});

describe('OpsTicketsView long-lived operations workspace', () => {
  it('任务和标签页写入地址，离开后重新进入能恢复同一详情', async () => {
    await wrapper.findAll('[role="tab"]').find(item => item.text().includes('报告验收')).trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ ticket: 'opt-1', tab: 'reports' });
    const source = router.currentRoute.value.fullPath;
    wrapper.unmount(); wrapper = null;
    await router.push('/ops-center');
    await router.push(source);
    wrapper = mount(OpsTicketsView, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toContain('报告验收');
    expect(api.getOpsTicket).toHaveBeenLastCalledWith('opt-1');
  });

  it('快速切换任务时迟到的详情不能覆盖当前任务', async () => {
    const two = { ...ticket, id: 'opt-2', title: '第二个任务' };
    const three = { ...ticket, id: 'opt-3', title: '第三个任务' };
    api.getOpsTickets.mockResolvedValue({ tickets: [ticket, two, three], stats: {} });
    await wrapper.get('button').trigger('click'); await flushPromises();
    let resolveTwo;
    api.getOpsTicket.mockImplementation(id => id === 'opt-2' ? new Promise(resolve => { resolveTwo = resolve; }) : Promise.resolve({ ...structuredClone(detail), ticket: three }));
    await wrapper.findAll('aside button').find(button => button.text().includes(two.title)).trigger('click');
    await wrapper.findAll('aside button').find(button => button.text().includes(three.title)).trigger('click');
    await flushPromises();
    resolveTwo({ ...structuredClone(detail), ticket: two }); await flushPromises();
    expect(wrapper.findAll('h2').map(heading => heading.text())).toContain(three.title);
    expect(wrapper.findAll('h2').map(heading => heading.text())).not.toContain(two.title);
    expect(router.currentRoute.value.query.ticket).toBe('opt-3');
  });

  it('loads independent Tickets and presents Mandates, Assignments and Effect states', () => {
    expect(wrapper.text()).toContain('长期运维任务');
    expect(wrapper.text()).toContain(ticket.title);
    expect(wrapper.text()).toContain('任务独立于 Agent 会话');
    expect(wrapper.text()).toContain('授权');
    expect(wrapper.text()).toContain('派工');
    expect(wrapper.text()).toContain('批准不等于执行');
    expect(api.getOpsTickets).toHaveBeenCalled();
    expect(api.getOpsTicket).toHaveBeenCalledWith('opt-1');
  });

  it('creates a Ticket with acceptance criteria without starting an Agent', async () => {
    await wrapper.get('button').trigger('click');
    await flushPromises();
    const createButton = wrapper.findAll('button').find((button) => button.text().includes('新建长期任务'));
    await createButton.trigger('click');
    await flushPromises();
    await wrapper.get('input[placeholder*="检查 staging"]').setValue('备份演练任务');
    await wrapper.get('textarea[placeholder*="说明要解决"]').setValue('只创建任务，不开始执行。');
    await wrapper.get('input[placeholder="project-id"]').setValue('project-new');
    await wrapper.get('textarea[placeholder*="有明确证据"]').setValue('报告包含证据\n人工验收通过');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(api.createOpsTicket).toHaveBeenCalledWith(expect.objectContaining({
      title: '备份演练任务', projectId: 'project-new',
      acceptanceCriteria: ['报告包含证据', '人工验收通过'],
    }));
    expect(wrapper.text()).toContain('尚未启动任何 Agent');
  });

  it('prefills an event-sourced Ticket draft without creating it automatically', async () => {
    wrapper.unmount();
    await router.push({ path: '/tickets', query: { create: '1', sourceType: 'event', sourceId: 'event-77', title: '磁盘空间告警跟进', description: '来源事件 ID：event-77\n该内容仅作为观察证据。', projectId: 'project-staging' } });
    wrapper = mount(OpsTicketsView, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.get('input[placeholder*="检查 staging"]').element.value).toBe('磁盘空间告警跟进');
    expect(wrapper.get('input[placeholder="event-id / inspection-id / agent-plan-id"]').element.value).toBe('event-77');
    expect(wrapper.get('input[placeholder="project-id"]').element.value).toBe('project-staging');
    expect(api.createOpsTicket).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('先定义目标和验收标准，不会自动启动 Agent');
  });

  it('issues a versioned scoped Mandate from the dedicated tab', async () => {
    await wrapper.findAll('[role="tab"]').find((item) => item.text().includes('授权')).trigger('click');
    await wrapper.get('button').element;
    const issue = wrapper.findAll('button').find((button) => button.text().includes('签发授权'));
    await issue.trigger('click');
    await flushPromises();
    await wrapper.get('textarea[placeholder="project-staging"]').setValue('project-staging');
    await wrapper.get('textarea[placeholder="composeops"]').setValue('compose-worker-test');
    await wrapper.findAll('form').at(-1).trigger('submit');
    await flushPromises();
    expect(api.issueOpsMandate, wrapper.text()).toHaveBeenCalledWith('opt-1', expect.objectContaining({
      scope: expect.objectContaining({ projectIds: ['project-staging'], composeProjectNames: ['compose-worker-test'] }),
      allowedActions: ['service.inspect'],
    }));
    expect(wrapper.text()).toContain('已签发新的 Mandate 快照');
  });

  it('blocks a read-only Mandate without an explicit Compose project scope', async () => {
    await wrapper.findAll('[role="tab"]').find((item) => item.text().includes('授权')).trigger('click');
    await wrapper.findAll('button').find((button) => button.text().includes('签发授权')).trigger('click');
    await flushPromises();
    await wrapper.findAll('form').at(-1).trigger('submit');
    await flushPromises();
    expect(api.issueOpsMandate).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('必须在 Mandate 中明确填写 Compose 项目名范围');
  });

  it('requires explicit confirmation and explains the read-only worker allowlist', async () => {
    await wrapper.findAll('[role="tab"]').find((item) => item.text().includes('Effect 队列')).trigger('click');
    const approve = wrapper.findAll('button').find((button) => button.text().includes('批准并入队'));
    await approve.trigger('click');
    await flushPromises();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('只读白名单'));
    expect(api.approveOpsEffect).toHaveBeenCalledWith('opt-1', 'oef-1');
    expect(wrapper.text()).toContain('等待派发队列');
    expect(wrapper.text()).toContain('受控 Effect Worker');
    expect(wrapper.text()).toContain('service.inspect');
    expect(wrapper.text()).toContain('明确禁止');
    expect(wrapper.text()).toContain('运行中');
    expect(api.getOpsEffectWorkerStatus).toHaveBeenCalled();
  });

  it('offers only the supported read-only actions and asks for an exact Compose project', async () => {
    await wrapper.findAll('[role="tab"]').find((item) => item.text().includes('Effect 队列')).trigger('click');
    await wrapper.findAll('button').find((button) => button.text().includes('新增意图')).trigger('click');
    const form = wrapper.findAll('form').find((item) => item.text().includes('Compose 项目名'));
    expect(form.text()).toContain('service.inspect');
    expect(form.text()).toContain('container.inspect');
    expect(form.text()).not.toContain('image.pull');
    expect(form.find('input[placeholder="compose-project-name"]').exists()).toBe(true);
    await form.get('select').setValue('container.inspect');
    await flushPromises();
    expect(form.find('input[placeholder="Docker container ID"]').exists()).toBe(true);
  });

  it('submits structured reports through the report workflow', async () => {
    await wrapper.findAll('[role="tab"]').find((item) => item.text().includes('报告验收')).trigger('click');
    const add = wrapper.findAll('button').find((button) => button.text().includes('提交报告'));
    await add.trigger('click');
    await flushPromises();
    await wrapper.get('textarea[required][maxlength="4000"]').setValue('所有检查结果均有证据。');
    const evidence = wrapper.get('input[placeholder*="说明证据实际证明"]');
    await evidence.setValue('Docker inspect 证明容器健康。');
    await wrapper.findAll('form').at(-1).trigger('submit');
    await flushPromises();
    expect(api.createOpsReport, wrapper.text()).toHaveBeenCalledWith('opt-1', expect.objectContaining({
      summary: '所有检查结果均有证据。',
      evidence: [expect.objectContaining({ summary: 'Docker inspect 证明容器健康。' })],
    }));
  });
});
