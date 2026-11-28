import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, KeepAlive, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => Object.fromEntries([
  'getAgentRuns', 'getAgentRun', 'resumeAgentRun', 'stopAgentRun', 'agentApprove', 'reconcileAgentEffect',
  'getMemberRuns', 'getMemberRun', 'createMemberRun', 'memberRunAction',
].map(name => [name, vi.fn()])));
vi.mock('../src/api/client.js', () => ({ api }));
import AgentRunsPanel from '../src/components/agent/AgentRunsPanel.vue';
import MemberAgentPanel from '../src/components/agent/MemberAgentPanel.vue';

const run = { id: 'saved-run', goal: '检查旧项目', status: 'needs_reconciliation', revision: 2, context: { hostId: 'local' }, checkpoint: {} };
const effect = { id: 'effect-a', tool: 'container.restart', status: 'unknown' };
const record = { run, effects: [effect] };
const projects = [{ id: 'a', hostId: 'local', projectName: 'A' }, { id: 'b', hostId: 'local', projectName: 'B' }];
const options = { global: { stubs: { BaseModal: {
  props: ['show'], emits: ['close'],
  template: '<div v-if="show" data-detail><button data-close @click="$emit(\'close\')">关闭记录</button><slot /></div>',
} } } };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
let wrapper;
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); });
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each([
  { name: 'admin', component: AgentRunsPanel, props: { sessionId: 1 }, list: 'getAgentRuns', detail: 'getAgentRun', write: 'reconcileAgentEffect', inspect: '查看记录' },
  { name: 'member', component: MemberAgentPanel, props: { projects, canWrite: true }, list: 'getMemberRuns', detail: 'getMemberRun', write: 'memberRunAction', inspect: '执行证据' },
])('$name task ownership', config => {
  async function setup() {
    api[config.list].mockResolvedValue({ runs: [run] });
    api[config.detail].mockResolvedValue(record);
    wrapper = mount(config.component, { ...options, props: config.props });
    await flushPromises();
  }
  const inspect = async () => { await wrapper.findAll('button').find(b => b.text() === config.inspect).trigger('click'); await flushPromises(); };
  const changeScope = async () => {
    if (config.name === 'admin') await wrapper.setProps({ sessionId: 2 });
    else await wrapper.find('select').setValue('local:b');
    await flushPromises();
  };
  const submitEvidence = async () => {
    const modal = wrapper.find('[data-detail]');
    await modal.find('select').setValue('applied');
    await modal.find('textarea').setValue('检查 local 节点容器时间与健康结果，确认重启已生效');
    await modal.find('form').trigger('submit');
  };

  it('drops late detail after scope change and aborts its read', async () => {
    await setup(); const pending = deferred(); api[config.detail].mockReturnValueOnce(pending.promise);
    await inspect(); await changeScope();
    expect(api[config.detail].mock.calls[0][1]?.aborted).toBe(true);
    pending.resolve(record); await flushPromises();
    expect(wrapper.find('[data-detail]').exists()).toBe(false);
    expect(wrapper.findAll('button').find(b => b.text() === config.inspect).attributes('disabled')).toBeUndefined();
  });

  it('closing during reconciliation neither reopens the modal nor reads another run', async () => {
    await setup(); await inspect(); const pending = deferred(); api[config.write].mockReturnValueOnce(pending.promise);
    await submitEvidence(); await wrapper.find('[data-close]').trigger('click');
    pending.resolve({}); await flushPromises();
    expect(api[config.write]).toHaveBeenCalledTimes(1);
    expect(api[config.detail]).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-detail]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('old reconciliation cannot overwrite a new scope or release its busy state', async () => {
    await setup(); await inspect(); const pending = deferred(); api[config.write].mockReturnValueOnce(pending.promise);
    await submitEvidence(); await changeScope();
    const next = deferred(); api[config.detail].mockReturnValueOnce(next.promise); await inspect();
    pending.reject(new Error('旧会话保存失败')); await flushPromises();
    expect(wrapper.text()).not.toContain('旧会话保存失败');
    expect(wrapper.findAll('button').find(b => b.text() === config.inspect).attributes('disabled')).toBeDefined();
    next.resolve({ run: { ...run, id: 'new-run' }, effects: [] }); await flushPromises();
    expect(api[config.detail]).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-detail]').exists()).toBe(true);
  });

  it('submits reconciliation once even when the form fires twice before rendering', async () => {
    await setup(); await inspect(); const pending = deferred(); api[config.write].mockReturnValue(pending.promise);
    const modal = wrapper.find('[data-detail]');
    await modal.find('select').setValue('applied'); await modal.find('textarea').setValue('人工确认节点和容器状态已更新且健康正常');
    const form = modal.find('form').element;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(api[config.write]).toHaveBeenCalledTimes(1);
    pending.resolve({}); await flushPromises();
  });

  it('keeps a write error visible when background polling succeeds', async () => {
    await setup(); await inspect(); api[config.write].mockRejectedValueOnce(new Error('证据保存未成功，请核对'));
    await submitEvidence(); await flushPromises(); await vi.advanceTimersByTimeAsync(30000);
    expect(wrapper.text()).toContain('证据保存未成功，请核对');
    expect(api[config.write]).toHaveBeenCalledTimes(1);
  });

  it('pauses polling while hidden and refreshes immediately when visible', async () => {
    await setup(); const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange')); const count = api[config.list].mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000); expect(api[config.list]).toHaveBeenCalledTimes(count);
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(api[config.list]).toHaveBeenCalledTimes(count + 1);
  });

  it('uses a slower refresh for settled tasks and a fast refresh for background results', async () => {
    await setup(); await vi.advanceTimersByTimeAsync(29000); expect(api[config.list]).toHaveBeenCalledTimes(1);
    api[config.list].mockResolvedValue({ runs: [{ ...run, status: 'awaiting_results' }] });
    await vi.advanceTimersByTimeAsync(1000); expect(api[config.list]).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000); expect(api[config.list]).toHaveBeenCalledTimes(3);
  });

  it('discards list failures from the previous scope and resets reconciliation fields', async () => {
    await setup(); await inspect();
    await wrapper.find('[data-detail] textarea').setValue('属于旧项目的核对证据');
    const pending = deferred(); api[config.list].mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(30000); await changeScope();
    pending.reject(new Error('旧项目读取失败')); await flushPromises(); await inspect();
    expect(wrapper.text()).not.toContain('旧项目读取失败');
    expect(wrapper.find('[data-detail] textarea').element.value).toBe('');
  });

  it('does not cancel or replay a write when the browser tab is hidden', async () => {
    await setup(); await inspect(); const pending = deferred(); api[config.write].mockReturnValueOnce(pending.promise);
    await submitEvidence(); const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange')); const count = api[config.list].mock.calls.length;
    pending.resolve({}); await flushPromises(); await vi.advanceTimersByTimeAsync(60000);
    expect(api[config.list]).toHaveBeenCalledTimes(count);
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(api[config.write]).toHaveBeenCalledTimes(1);
    expect(api[config.list]).toHaveBeenCalledTimes(count + 1);
  });

  it('drops pending detail across keep-alive deactivation and reactivation', async () => {
    api[config.list].mockResolvedValue({ runs: [run] }); const pending = deferred(); api[config.detail].mockReturnValue(pending.promise);
    const visible = ref(true);
    wrapper = mount(defineComponent({ components: { Panel: config.component, KeepAlive }, setup: () => ({ visible, panelProps: config.props }), template: '<KeepAlive><Panel v-if="visible" v-bind="panelProps" /></KeepAlive>' }), options);
    await flushPromises(); await inspect(); visible.value = false; await flushPromises();
    visible.value = true; await flushPromises(); pending.resolve(record); await flushPromises();
    expect(wrapper.find('[data-detail]').exists()).toBe(false);
  });
});

it('member task completion preserves a newer draft typed while submission is pending', async () => {
  api.getMemberRuns.mockResolvedValue({ runs: [] }); const pending = deferred(); api.createMemberRun.mockReturnValue(pending.promise);
  wrapper = mount(MemberAgentPanel, { ...options, props: { projects, canWrite: true } }); await flushPromises();
  await wrapper.find('select').setValue('local:a'); await wrapper.find('textarea').setValue('第一个任务'); await wrapper.find('form').trigger('submit');
  await wrapper.find('textarea').setValue('接着要执行的任务'); pending.resolve({}); await flushPromises();
  expect(wrapper.find('textarea').element.value).toBe('接着要执行的任务');
  expect(api.createMemberRun).toHaveBeenCalledTimes(1);
});
