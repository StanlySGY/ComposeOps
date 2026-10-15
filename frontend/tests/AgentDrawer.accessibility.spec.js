import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AgentDrawer from '../src/components/AgentDrawer.vue';

const agentState = vi.hoisted(() => ({ open: null, closeAgent: vi.fn() }));
vi.mock('../src/composables/useAgentConsole.js', async () => {
  const { ref } = await import('vue');
  agentState.open = ref(true);
  agentState.closeAgent = vi.fn(() => { agentState.open.value = false; });
  const context = ref({ page: '服务', mode: '运维问答', summary: '测试页面上下文' });
  return { useAgentConsole: () => ({ open: agentState.open, context, closeAgent: agentState.closeAgent }) };
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
beforeEach(() => {
  agentState.open.value = true;
  agentState.closeAgent.mockClear();
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('页面 Agent 抽屉可访问性', () => {
  it('消息输入框和确认参数编辑区有明确名称，等待状态可被播报', async () => {
    wrapper = mount(AgentDrawer, { global: { stubs: { AgentMarkdown: true, AgentThinking: true } } });
    await flushPromises();
    expect(wrapper.get('textarea[aria-label="给页面 Agent 发送消息"]').exists()).toBe(true);
    expect(wrapper.get('textarea[aria-label="确认执行参数 JSON"]').exists()).toBe(true);
    expect(wrapper.get('button[aria-label="关闭 Agent"]').exists()).toBe(true);
    const mobileHandle = wrapper.get('button.agent-drawer-handle');
    expect(mobileHandle.attributes('type')).toBe('button');
    expect(mobileHandle.attributes('aria-label')).toBe('关闭 Agent');

    const message = wrapper.vm.$.setupState.messages;
    message[0].streaming = true;
    message[0].content = '';
    await flushPromises();
    expect(wrapper.get('.agent-typing[role="status"][aria-live="polite"]').text()).toContain('正在处理');
  });

  it('打开时把焦点移入抽屉，循环 Tab，关闭后恢复到触发按钮', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = '打开页面 Agent';
    document.body.appendChild(opener);
    opener.focus();

    wrapper = mount(AgentDrawer, {
      attachTo: document.body,
      global: { stubs: { AgentMarkdown: true, AgentThinking: true } },
    });
    await flushPromises();

    const dialog = wrapper.get('aside[role="dialog"][aria-modal="true"]');
    const input = dialog.get('textarea[aria-label="给页面 Agent 发送消息"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(input.element));

    const selector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])';
    const focusable = [...dialog.element.querySelectorAll(selector)].filter((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getAttribute('aria-hidden') !== 'true';
    });
    expect(focusable.length).toBeGreaterThan(2);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    await dialog.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    await dialog.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    await dialog.get('.agent-drawer-head button[aria-label="关闭 Agent"]').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('aside[role="dialog"]').exists()).toBe(false));
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    expect(agentState.closeAgent).toHaveBeenCalledTimes(1);
  });
});
