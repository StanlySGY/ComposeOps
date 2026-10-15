import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AIDiagnosisModal from '../src/components/services/AIDiagnosisModal.vue';

const streamSse = vi.hoisted(() => vi.fn());
vi.mock('../src/api/client.js', () => ({ streamSse }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  streamSse.mockReset();
});

function mountModal() {
  return mount(AIDiagnosisModal, {
    props: { open: false, projectId: 'project-1', projectName: '示例项目' },
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
});
