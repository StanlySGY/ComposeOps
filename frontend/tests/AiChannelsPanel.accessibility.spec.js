import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AiChannelsPanel from '../src/components/settings/AiChannelsPanel.vue';

const api = vi.hoisted(() => ({ saveAiChannel: vi.fn(), reorderAiChannels: vi.fn(), getAiConfig: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));

let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

const channel = (id, name, overrides = {}) => ({
  id, name, baseUrl: 'https://api.example.test/v1', apiKey: '', model: 'example-model', enabled: true,
  supportsTools: true, streamToolCalls: true, firstTokenTimeoutMs: 30000, saved: true, dirty: false, revision: 1,
  ...overrides,
});
function mountPanel(channels) {
  return mount(AiChannelsPanel, {
    props: { channels },
    global: { stubs: { ConfirmDialog: true } },
  });
}

describe('AI 渠道编辑器可访问性反馈', () => {
  it('关键配置输入都有通过可见标签关联的名称', () => {
    wrapper = mountPanel([channel('main', '主渠道', { dirty: true, saved: false })]);
    for (const field of ['name', 'baseUrl', 'apiKey', 'model', 'timeout', 'streamToolCalls']) {
      const input = wrapper.get(`[data-field="${field}"]`);
      expect(input.element.closest('label'), `${field} 应关联可见标签`).not.toBeNull();
      expect(input.element.closest('label').textContent.trim().length).toBeGreaterThan(0);
    }
  });

  it('保存渠道失败时通过 assertive alert 播报错误，而非普通状态消息', async () => {
    api.saveAiChannel.mockRejectedValueOnce(new Error('上游拒绝保存'));
    wrapper = mountPanel([channel('main', '主渠道', { dirty: true, saved: false })]);
    await wrapper.get('[data-action="save"]').trigger('click');
    await flushPromises();
    const alert = wrapper.get('[role="alert"][aria-live="assertive"]');
    expect(alert.attributes('aria-atomic')).toBe('true');
    expect(alert.text()).toBe('上游拒绝保存');
    expect(wrapper.find('[role="status"]')).toBeTruthy();
  });

  it('渠道排序失败时也按紧急错误播报', async () => {
    api.reorderAiChannels.mockRejectedValueOnce(new Error('排序冲突，请刷新后重试'));
    wrapper = mountPanel([channel('first', '第一条'), channel('second', '第二条')]);
    await wrapper.findAll('button[aria-label="提高优先级"]')[1].trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"][aria-live="assertive"]').text()).toBe('排序冲突，请刷新后重试');
  });
});
