import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { api } = vi.hoisted(() => ({
  api: {
    getOperations: vi.fn(), getAgentExecutions: vi.fn(), getAlertEvents: vi.fn(), getCronHistory: vi.fn(),
    getProjects: vi.fn(), getStateUptime: vi.fn(), getStateExits: vi.fn(), getStateHistory: vi.fn(),
    listDbDumpTargets: vi.fn(), streamDbDump: vi.fn(),
  },
}));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => ({ success: vi.fn(), error: vi.fn() }) }));

import EventTimeline from '../src/components/events/EventTimeline.vue';
import StateHistoryPanel from '../src/components/events/StateHistoryPanel.vue';
import DbDumpModal from '../src/components/services/DbDumpModal.vue';

let wrapper;
beforeEach(() => {
  vi.clearAllMocks();
  api.getOperations.mockResolvedValue({ operations: [] });
  api.getAgentExecutions.mockResolvedValue({ plans: [] });
  api.getAlertEvents.mockResolvedValue({ events: [] });
  api.getCronHistory.mockResolvedValue({ history: [] });
  api.getProjects.mockResolvedValue({ projects: [] });
  api.getStateUptime.mockResolvedValue({ containers: [], summary: {} });
  api.getStateExits.mockResolvedValue({ exits: [], total: 0 });
  api.getStateHistory.mockResolvedValue({ history: [] });
  api.listDbDumpTargets.mockResolvedValue({ containers: [] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ repositories: [] }) }));
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

const modalStubs = {
  BaseModal: { template: '<div><slot name="header-actions"/><slot/><slot name="footer"/></div>', props: ['show', 'title', 'sizeClass', 'bodyClass'] },
  ConfirmDialog: true,
};

describe('事件时间线、状态历史和数据库备份的可访问性反馈', () => {
  it('事件时间线搜索有明确名称、结果计数可播报，数据源失败不会显示误导性空状态', async () => {
    api.getOperations.mockRejectedValueOnce(new Error('offline'));
    wrapper = mount(EventTimeline, { global: { stubs: { EmptyState: { props: ['title'], template: '<p class="empty-state">{{ title }}</p>' } } } });
    await flushPromises();

    expect(wrapper.get('input[aria-label="搜索事件标题、项目或详情"]').exists()).toBe(true);
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('显示 0 / 0');
    expect(wrapper.get('[role="alert"]').text()).toContain('操作记录');
    expect(wrapper.find('.empty-state').exists()).toBe(false);
  });

  it('状态历史搜索可访问，加载失败通过 alert 告知而非伪装为空历史', async () => {
    api.getStateUptime.mockRejectedValueOnce(new Error('offline'));
    wrapper = mount(StateHistoryPanel, { global: { stubs: { EmptyState: { props: ['title'], template: '<p class="empty-state">{{ title }}</p>' }, ConfirmDialog: true } } });
    await flushPromises();

    expect(wrapper.get('input[aria-label="搜索容器或项目名"]').exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toBe('offline');
    expect(wrapper.find('.empty-state').exists()).toBe(false);
  });

  it('数据库备份弹窗播报加载过程和失败原因', async () => {
    let resolveTargets;
    api.listDbDumpTargets.mockReturnValueOnce(new Promise(resolve => { resolveTargets = resolve; }));
    wrapper = mount(DbDumpModal, {
      props: { project: { id: 'p1', projectName: '示例项目' } },
      global: { stubs: modalStubs },
    });
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('正在读取');
    resolveTargets({ containers: [] });
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('没有运行中的数据库容器');

    wrapper.unmount();
    wrapper = null;
    api.listDbDumpTargets.mockRejectedValueOnce(new Error('连接断开'));
    wrapper = mount(DbDumpModal, {
      props: { project: { id: 'p1', projectName: '示例项目' } },
      global: { stubs: modalStubs },
    });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('连接断开');
  });
});
