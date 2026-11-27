import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { h, KeepAlive, ref } from 'vue';
import AIDiagnosisModal from '../src/components/services/AIDiagnosisModal.vue';

const streamSse = vi.hoisted(() => vi.fn());
vi.mock('../src/api/client.js', () => ({ streamSse }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('vue-router', () => ({ useRoute: () => ({ name: 'logs', query: {} }), useRouter: () => ({ push: vi.fn() }) }));

let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  streamSse.mockReset();
});

function mountModal(props = {}) {
  return mount(AIDiagnosisModal, {
    props: { open: false, projectId: 'project-1', projectName: '示例项目', ...props },
    global: {
      stubs: {
        BaseModal: { template: '<div><slot name="header-actions"/><slot/><slot name="footer"/></div>', props: ['show', 'title', 'sizeClass', 'bodyClass'] },
        AgentMarkdown: { template: '<div>{{ content }}</div>', props: ['content'] },
      },
    },
  });
}

describe('AI 诊断状态播报可访问性', () => {
  it('将诊断进行中和完成状态作为原子化的礼貌播报', async () => {
    let emitFrame;
    streamSse.mockImplementation((_url, _payload, onFrame) => {
      emitFrame = onFrame;
      return new Promise(() => {});
    });
    wrapper = mountModal();
    await wrapper.setProps({ open: true });
    await flushPromises();

    const status = wrapper.get('footer[role="status"]');
    expect(status.attributes('aria-live')).toBe('polite');
    expect(status.attributes('aria-atomic')).toBe('true');
    expect(status.text()).toContain('AI 正在分析日志');

    emitFrame({ type: 'done', data: '诊断结果' });
    await flushPromises();
    expect(wrapper.get('footer[role="status"]').text()).toBe('诊断完成');
  });

  it('将诊断错误作为紧急播报，避免屏幕阅读器用户错过失败原因', async () => {
    streamSse.mockImplementation(async (_url, _payload, onFrame) => {
      onFrame({ type: 'error', data: '模型暂时不可用' });
    });
    wrapper = mountModal();
    await wrapper.setProps({ open: true });
    await flushPromises();

    const alert = wrapper.get('footer[role="alert"]');
    expect(alert.attributes('aria-live')).toBe('assertive');
    expect(alert.attributes('aria-atomic')).toBe('true');
    expect(alert.text()).toBe('模型暂时不可用');
  });
  it('以 open=true 直接挂载时立即开始诊断，卸载会中止流', async () => {
    let signal;
    streamSse.mockImplementation((_url, _payload, _onFrame, inputSignal) => { signal = inputSignal; return new Promise(() => {}); });
    wrapper = mountModal({ open: true }); await flushPromises();
    expect(streamSse).toHaveBeenCalledTimes(1); expect(signal.aborted).toBe(false);
    wrapper.unmount(); wrapper = null; expect(signal.aborted).toBe(true);
  });
  it('切换目标后迟到 token、完成与异常不能覆盖新诊断', async () => {
    const calls = [];
    streamSse.mockImplementation((_url, payload, frame, signal) => new Promise((resolve, reject) => calls.push({ payload, frame, signal, resolve, reject })));
    wrapper = mountModal({ open: true }); await flushPromises();
    await wrapper.setProps({ projectId: 'project-2' }); await flushPromises();
    expect(calls).toHaveLength(2); expect(calls[0].signal.aborted).toBe(true);
    calls[1].frame({ type: 'token', data: 'new-result' });
    calls[0].frame({ type: 'done', data: 'old-result' }); calls[0].reject(new Error('old-error')); await flushPromises();
    expect(wrapper.text()).toContain('new-result'); expect(wrapper.text()).not.toContain('old-result');
    expect(wrapper.get('footer').text()).toContain('AI 正在分析');
    calls[1].frame({ type: 'done', data: 'new-finished' }); calls[1].frame({ type: 'error', data: 'late-error' }); await flushPromises();
    expect(wrapper.text()).toContain('new-finished'); expect(wrapper.text()).not.toContain('late-error');
  });
  it('流结束但没有完成帧会显示失败并允许明确重试', async () => {
    streamSse.mockResolvedValue(undefined);
    wrapper = mountModal({ open: true }); await flushPromises();
    expect(wrapper.get('footer[role="alert"]').text()).toContain('未收到完成结果');
    await wrapper.get('[aria-label="重新运行 AI 诊断"]').trigger('click'); await flushPromises();
    expect(streamSse).toHaveBeenCalledTimes(2);
  });

  it('缓存页面失活时取消诊断，恢复时不自动重复请求模型', async () => {
    const active = ref(true), signals = [];
    streamSse.mockImplementation((_url, _payload, _frame, signal) => { signals.push(signal); return new Promise(() => {}); });
    const Draft = ({ setup: () => () => h(AIDiagnosisModal, { open: true, projectId: 'p' }) });
    const Other = ({ setup: () => () => h('p', 'other') });
    wrapper = mount({ setup: () => () => h(KeepAlive, null, { default: () => h(active.value ? Draft : Other) }) }, { global: { stubs: {
      BaseModal: { template: '<div><slot/><slot name="footer"/></div>' },
      AgentMarkdown: { template: '<div>{{content}}</div>', props: ['content'] },
    } } });
    await flushPromises(); expect(signals).toHaveLength(1);
    active.value = false; await flushPromises(); expect(signals[0].aborted).toBe(true);
    active.value = true; await flushPromises(); expect(signals).toHaveLength(1);
    expect(wrapper.text()).toContain('诊断已中止');
    await wrapper.get('[aria-label="重新运行 AI 诊断"]').trigger('click'); expect(signals).toHaveLength(2);
  });

});
