import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineComponent, KeepAlive, ref } from 'vue';
const { getOperations } = vi.hoisted(() => ({ getOperations: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api: { getAgentSessionOperations: getOperations } }));
import AgentOperationsPanel from '../src/components/agent/AgentOperationsPanel.vue';
let wrapper;
const queued = { operation: { kind: 'change', id: 'release-1', hostId: 'node-a', projectId: 'api', status: 'queued', running: true, businessVerified: false }, verification: { status: 'pending', reason: '已进入持久队列，尚未完成业务验收。' } };
beforeEach(() => { vi.useFakeTimers(); getOperations.mockReset(); getOperations.mockResolvedValue({ operations: [queued] }); });
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.useRealTimers(); });
const options = { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } };
it('shows submitted work honestly and recovers final status from the server', async () => {
  wrapper = mount(AgentOperationsPanel, { ...options, props: { sessionId: 1 } }); await flushPromises();
  expect(wrapper.text()).toContain('已排队'); expect(wrapper.text()).toContain('尚未完成业务验收'); expect(wrapper.text()).not.toContain('业务验收通过');
  getOperations.mockResolvedValue({ operations: [{ ...queued, operation: { ...queued.operation, status: 'succeeded', running: false, businessVerified: true }, verification: { status: 'passed', reason: '已完成验收' } }] });
  await vi.advanceTimersByTimeAsync(5000); await flushPromises(); expect(wrapper.text()).toContain('业务验收通过');
  const calls = getOperations.mock.calls.length; await vi.advanceTimersByTimeAsync(15000); expect(getOperations).toHaveBeenCalledTimes(calls);
});
it('switching sessions clears old jobs and rejects late stale responses', async () => {
  let resolve; getOperations.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  wrapper = mount(AgentOperationsPanel, { ...options, props: { sessionId: 1 } }); await flushPromises();
  getOperations.mockResolvedValue({ operations: [] }); await wrapper.setProps({ sessionId: 2 }); await flushPromises();
  resolve({ operations: [queued] }); await flushPromises(); expect(wrapper.text()).not.toContain('已排队');
  expect(getOperations.mock.calls[0][1].aborted).toBe(true);
});
it('keep-alive deactivation aborts requests and stops polling, activation refreshes', async () => {
  const visible = ref(true);
  wrapper = mount(defineComponent({ components: { AgentOperationsPanel, KeepAlive }, setup: () => ({ visible }), template: '<KeepAlive><AgentOperationsPanel v-if="visible" :session-id="1" /></KeepAlive>' }), options);
  await flushPromises(); visible.value = false; await flushPromises();
  expect(getOperations.mock.calls[0][1].aborted).toBe(true);
  const calls = getOperations.mock.calls.length; await vi.advanceTimersByTimeAsync(15000); expect(getOperations).toHaveBeenCalledTimes(calls);
  visible.value = true; await flushPromises(); expect(getOperations).toHaveBeenCalledTimes(calls + 1);
});
it('unavailable records remain visible as unknown, without offering replay', async () => {
  getOperations.mockResolvedValue({ operations: [{ ...queued, operation: { ...queued.operation, status: 'unavailable', running: false, needsReconciliation: true }, verification: { status: 'unknown', reason: '请核对，未重放任务。' } }] });
  wrapper = mount(AgentOperationsPanel, { ...options, props: { sessionId: 1 } }); await flushPromises();
  expect(wrapper.text()).toContain('需要核对'); expect(wrapper.findAll('button').map(row => row.text())).toEqual(['刷新状态']);
});
it('retries a failed initial read even when no running tasks are known', async () => {
  getOperations.mockRejectedValueOnce(new Error('读取暂时失败'));
  wrapper = mount(AgentOperationsPanel, { ...options, props: { sessionId: 1 } }); await flushPromises();
  expect(wrapper.text()).toContain('读取暂时失败');
  await vi.advanceTimersByTimeAsync(5000); await flushPromises();
  expect(wrapper.text()).toContain('已排队'); expect(wrapper.text()).not.toContain('读取暂时失败');
});
it('suppresses timer and change-event refreshes while hidden, then refreshes once', async () => {
  const { DATA_CHANGED_EVENT } = await import('../src/lib/data-changes.js');
  wrapper = mount(AgentOperationsPanel, { ...options, props: { sessionId: 1 } }); await flushPromises();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
  await vi.advanceTimersByTimeAsync(60000); expect(getOperations).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
  expect(getOperations).toHaveBeenCalledTimes(2);
});
