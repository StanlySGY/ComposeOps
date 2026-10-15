import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AgentDrawer from '../src/components/AgentDrawer.vue';

vi.mock('../src/composables/useAgentConsole.js', async () => {
  const { ref } = await import('vue');
  return { useAgentConsole: () => ({ open: ref(true), context: ref({ page: '服务', mode: '运维问答', summary: '测试页面上下文' }), closeAgent: vi.fn() }) };
});
vi.mock('../src/composables/useAgentChat.js', async () => {
  const { ref } = await import('vue');
  const messages = ref([{
    id: 'confirmation-1', role: 'assistant', content: '需要确认', streaming: false,
    confirmation: { tool: 'compose.up', description: '启动示例服务', params: { projectId: 'p1' }, paramsText: '{"projectId":"p1"}', risk: 'medium', busy: false },
  }]);
  return {
    PAGE_DRAWER_CHANNEL: 'test-page-drawer',
    useAgentChat: () => ({
      messages, input: ref(''), running: ref(false), scrollEl: ref(null), onScroll: vi.fn(),
      resetSession: vi.fn(), sendMessage: vi.fn(), pendingQueue: ref([]), approve: vi.fn(), reject: vi.fn(),
      interrupt: vi.fn(), handleRichBlockClick: vi.fn(), zoomOpen: ref(false), zoomContent: ref(''),
      zoomScale: ref(1), onZoomWheel: vi.fn(), closeZoom: vi.fn(),
    }),
  };
});
vi.mock('../src/composables/useEscapeKey.js', () => ({ useEscapeKey: vi.fn() }));

let wrapper;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

describe('页面 Agent 抽屉可访问性', () => {
  it('消息输入框和确认参数编辑区有明确名称，等待状态可被播报', async () => {
    wrapper = mount(AgentDrawer, { global: { stubs: { AgentMarkdown: true, AgentThinking: true } } });
    await flushPromises();
    expect(wrapper.get('textarea[aria-label="给页面 Agent 发送消息"]').exists()).toBe(true);
    expect(wrapper.get('textarea[aria-label="确认执行参数 JSON"]').exists()).toBe(true);
    expect(wrapper.get('button[aria-label="关闭 Agent"]').exists()).toBe(true);

    const message = wrapper.vm.$.setupState.messages;
    message[0].streaming = true;
    message[0].content = '';
    await flushPromises();
    expect(wrapper.get('.agent-typing[role="status"][aria-live="polite"]').text()).toContain('正在处理');
  });
});
