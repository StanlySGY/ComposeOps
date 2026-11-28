import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import AgentExecutionHistoryView from '../src/views/AgentExecutionHistoryView.vue';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';
const { api } = vi.hoisted(() => ({ api: { getAgentExecutions: vi.fn(), getAgentUsage: vi.fn() } }));
vi.mock('../src/api/client.js', () => ({ api }));
const plan = (id, message) => ({ id, user_message: message, status: 'completed', created_at: '2026-11-28 20:00:00', plan_json: '{}', result_json: '{}' });
const payload = (id = 1, message = '当前执行') => ({ plans: [plan(id, message)], executions: [] });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
let wrapper;
const render = async () => { wrapper = mount(AgentExecutionHistoryView); await flushPromises(); };
const button = text => wrapper.findAll('button').find(item => item.text() === text);
beforeEach(() => { vi.resetAllMocks(); api.getAgentExecutions.mockResolvedValue(payload()); api.getAgentUsage.mockResolvedValue({ days: 30, totals: { calls: 7 }, byModel: [] }); });
afterEach(() => wrapper?.unmount());

it('首次读取失败展示可重试错误而不是暂无执行记录', async () => {
  api.getAgentExecutions.mockRejectedValueOnce(new Error('历史服务暂不可用'));
  await render(); expect(wrapper.text()).toContain('历史服务暂不可用'); expect(wrapper.text()).not.toContain('暂无执行记录');
  expect(wrapper.text()).toContain('LLM 调用');
  await button('重新读取历史').trigger('click'); await flushPromises(); expect(wrapper.text()).toContain('当前执行');
});

it('用量失败明确提示，历史记录仍可查看并重试', async () => {
  api.getAgentUsage.mockRejectedValueOnce(new Error('用量读取失败'));
  await render(); expect(wrapper.text()).toContain('当前执行'); expect(wrapper.text()).toContain('用量读取失败');
  await button('重新读取用量').trigger('click'); await flushPromises(); expect(wrapper.text()).not.toContain('用量读取失败'); expect(wrapper.text()).toContain('LLM 调用');
});

it('身份变化清除已显示记录和用量，旧读取不能恢复内容', async () => {
  await render(); const old = deferred(); api.getAgentExecutions.mockReturnValueOnce(old.promise);
  await button('刷新').trigger('click'); advanceAuthEpoch(); await nextTick();
  expect(wrapper.text()).not.toContain('当前执行');
  old.resolve(payload(2, 'OLD-PRIVATE-HISTORY')); await flushPromises();
  expect(wrapper.text()).not.toContain('OLD-PRIVATE-HISTORY'); expect(wrapper.text()).not.toContain('LLM 调用');
});

it('隐藏缓存页取消请求，重新激活不接受旧结果且只发一次新读取', async () => {
  const visible = ref(true), old = deferred(); api.getAgentExecutions.mockReturnValueOnce(old.promise);
  wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(AgentExecutionHistoryView) : null }) }));
  await flushPromises(); const signal = api.getAgentExecutions.mock.calls[0][2]; expect(api.getAgentExecutions).toHaveBeenCalledTimes(1);
  visible.value = false; await nextTick(); expect(signal?.aborted).toBe(true);
  visible.value = true; await flushPromises(); expect(api.getAgentExecutions).toHaveBeenCalledTimes(2); expect(wrapper.text()).toContain('当前执行');
  old.resolve(payload(3, '隐藏期间旧结果')); await flushPromises(); expect(wrapper.text()).not.toContain('隐藏期间旧结果');
});

it('切换节点立即开始新读取，旧请求不能覆盖新数据或结束新加载', async () => {
  const old = deferred(); api.getAgentExecutions.mockReturnValueOnce(old.promise).mockResolvedValue(payload(2, '新节点后读取'));
  await render(); window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises();
  expect(wrapper.text()).toContain('新节点后读取'); old.resolve(payload(1, '旧读取')); await flushPromises(); expect(wrapper.text()).not.toContain('旧读取');
});

it('展开详情单独读取该计划完整窗口，保留真实失败与零值结果', async () => {
  api.getAgentExecutions.mockImplementation(async id => id ? { plan: plan(1, '当前执行'), executions: [
    { id: 12, tool_name: 'container.inspect', status: 'failed', error: '真实工具失败', result: 'false', duration_ms: 0 },
  ] } : payload());
  await render(); await button('详情').trigger('click'); await flushPromises();
  expect(api.getAgentExecutions).toHaveBeenLastCalledWith(1, 500, expect.any(AbortSignal));
  expect(wrapper.text()).toContain('真实工具失败'); expect(wrapper.text()).toContain('false'); expect(wrapper.text()).toContain('0ms');
});

it('详情失败可原位重试，不把错误显示成没有工具调用', async () => {
  api.getAgentExecutions.mockImplementation(async id => { if (id) throw new Error('详情暂不可用'); return payload(); });
  await render(); await button('详情').trigger('click'); await flushPromises(); expect(wrapper.text()).toContain('详情暂不可用');
  api.getAgentExecutions.mockResolvedValue({ plan: plan(1, '当前执行'), executions: [{ id: 1, tool_name: '恢复后工具', status: 'success', result: '0' }] });
  await button('重试详情').trigger('click'); await flushPromises(); expect(wrapper.text()).toContain('恢复后工具');
});

it('关闭详情取消请求，迟到数据不能重新展开', async () => {
  const detail = deferred(); api.getAgentExecutions.mockImplementation(id => id ? detail.promise : Promise.resolve(payload()));
  await render(); await button('详情').trigger('click'); const signal = api.getAgentExecutions.mock.calls.at(-1)[2];
  await button('收起').trigger('click'); expect(signal?.aborted).toBe(true);
  detail.resolve({ plan: plan(1, '当前执行'), executions: [{ tool_name: '迟到工具', status: 'failed' }] }); await flushPromises(); expect(wrapper.text()).not.toContain('迟到工具');
});
