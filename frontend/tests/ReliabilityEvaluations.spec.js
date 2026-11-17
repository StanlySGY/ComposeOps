import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, nextTick } from 'vue';
const api = vi.hoisted(() => ({ getSreResource: vi.fn(), sreOperation: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { default: Evaluations } = await import('../src/components/ReliabilityEvaluations.vue');
let wrapper, data;
const report = (id, score, hash = 'same') => ({ id, status: 'completed', suiteHash: hash, protocolVersion: 1, suiteVersion: 'v1', config: { model: 'test' }, createdAt: Date.now(),
  result: { quality: 'needs_review', cases: [], summary: { averageScore: score, cases: 9, rootCauseCorrect: 7, citationValid: 8, dangerousAdvice: 1, falsePositives: 1, falseNegatives: 1, failed: 1, correctUncertainty: 7, totalLatencyMs: 1000, usageReportingCases: 0, reportedUsage: 0 } } });
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); data = { evaluations: [report('a', 70), report('b', 80)], channels: [{ id: 'c', name: '测试', model: 'test' }], suite: { version: 'v1', protocolVersion: 1, cases: Array(9).fill({}), passThreshold: 85 } }; api.getSreResource.mockImplementation(async () => structuredClone(data)); api.sreOperation.mockResolvedValue({}); });
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); });
it('执行完成与质量通过区分，费用未知且能比较同版本分数', async () => {
  wrapper = mount(Evaluations); await flushPromises(); expect(wrapper.text()).toContain('执行完成 · 质量需改进'); expect(wrapper.text()).toContain('费用未知'); expect(wrapper.text()).toContain('平均分变化 -10.0');
  data.evaluations[1].suiteHash = 'different'; await vi.advanceTimersByTimeAsync(5000); await flushPromises(); expect(wrapper.text()).toContain('不能直接比较');
});
it('评测排队防止重复，停用缓存后取消轮询且复活只恢复一次', async () => {
  const visible = ref(true), Host = defineComponent({ components: { Evaluations }, setup: () => ({ visible }), template: '<KeepAlive><Evaluations v-if="visible" /></KeepAlive>' });
  wrapper = mount(Host); await flushPromises();
  data.evaluations.unshift({ ...report('queued', 0), status: 'queued' });
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(api.sreOperation).toHaveBeenCalledWith('diagnosis/evaluations', { channelId: 'c' });
  expect(wrapper.find('form button').attributes('disabled')).toBeDefined();
  const calls = api.getSreResource.mock.calls.length, signal = api.getSreResource.mock.calls.at(-1)[1];
  visible.value = false; await nextTick(); expect(signal.aborted).toBe(true); await vi.advanceTimersByTimeAsync(30000); expect(api.getSreResource).toHaveBeenCalledTimes(calls);
  visible.value = true; await nextTick(); await flushPromises(); expect(api.getSreResource).toHaveBeenCalledTimes(calls + 1);
});
