import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineComponent, KeepAlive, ref } from 'vue';
const api = vi.hoisted(() => Object.fromEntries(['getAgentRuns','getAgentRun','resumeAgentRun','stopAgentRun','agentApprove','reconcileAgentEffect'].map(key => [key, vi.fn()])));
vi.mock('../src/api/client.js', () => ({ api }));
import AgentRunsPanel from '../src/components/agent/AgentRunsPanel.vue';
let wrapper;
const run = { id: 'run-1', goal: '发布应用', status: 'interrupted', checkpoint: { content: '已保存步骤' }, revision: 3, context: { hostId: 'a' } };
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); api.getAgentRuns.mockResolvedValue({ runs: [run] }); api.getAgentRun.mockResolvedValue({ run, effects: [] }); });
afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); });
const options = { global: { stubs: { BaseModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' } } } };
it('restores saved run after refresh and resumes with revision, not a new chat task', async () => {
  wrapper = mount(AgentRunsPanel, { ...options, props: { sessionId: 1 } }); await flushPromises();
  expect(wrapper.text()).toContain('发布应用'); await wrapper.findAll('button').find(b => b.text() === '核对并继续').trigger('click'); await flushPromises();
  expect(api.resumeAgentRun).toHaveBeenCalledWith('run-1', 3);
});
it('unknown effect cannot resume; requires explicit outcome and evidence', async () => {
  const unknown = { ...run, status: 'needs_reconciliation' };
  api.getAgentRuns.mockResolvedValue({ runs: [unknown] }); api.getAgentRun.mockResolvedValue({ run: unknown, effects: [{ id: 'effect-1', tool: 'compose.restart', status: 'unknown' }] });
  wrapper = mount(AgentRunsPanel, { ...options, props: { sessionId: 1 } }); await flushPromises(); expect(wrapper.text()).not.toContain('核对并继续');
  await wrapper.findAll('button').find(b => b.text() === '查看记录').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('无法确认时保持未知'); await wrapper.find('select').setValue('applied'); await wrapper.find('textarea').setValue('核对 local 项目容器启动时间已更新且健康正常'); await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(api.reconcileAgentEffect).toHaveBeenCalledWith('run-1', 'effect-1', { outcome: 'applied', evidence: '核对 local 项目容器启动时间已更新且健康正常' });
});
it('approval survives refresh, explicit approve uses original execution and call ids', async () => {
  api.getAgentRuns.mockResolvedValue({ runs: [{ ...run, status: 'waiting_approval', approval: { tool: 'compose.restart', executionId: 'plan-a', toolCallId: 'call-a', params: { projectId: 'p' } } }] });
  wrapper = mount(AgentRunsPanel, { ...options, props: { sessionId: 1 } }); await flushPromises();
  await wrapper.findAll('button').find(b => b.text() === '批准此步骤').trigger('click'); await flushPromises(); expect(api.agentApprove).toHaveBeenCalledWith({ executionId: 'plan-a', toolCallId: 'call-a', approved: true });
});
it('deactivation aborts and stops polling; old session responses cannot leak', async () => {
  const visible = ref(true); wrapper = mount(defineComponent({ components: { AgentRunsPanel, KeepAlive }, setup: () => ({ visible }), template: '<KeepAlive><AgentRunsPanel v-if="visible" :session-id="1" /></KeepAlive>' }), options); await flushPromises();
  visible.value = false; await flushPromises(); expect(api.getAgentRuns.mock.calls[0][1].aborted).toBe(true); const count = api.getAgentRuns.mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(api.getAgentRuns).toHaveBeenCalledTimes(count);
  visible.value = true; await flushPromises(); expect(api.getAgentRuns).toHaveBeenCalledTimes(count + 1);
});
