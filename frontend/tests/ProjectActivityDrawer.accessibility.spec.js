import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

const getProjectActivity = vi.hoisted(() => vi.fn());
vi.mock('../src/api/client.js', () => ({ api: { getProjectActivity, restoreBackup: vi.fn() } }));
vi.mock('../src/composables/useEscapeKey.js', () => ({ useEscapeKey: vi.fn() }));

import ProjectActivityDrawer from '../src/components/ProjectActivityDrawer.vue';

let wrapper;
const projectA = { id: 'a', projectName: '项目 A', editable: true };
const projectB = { id: 'b', projectName: '项目 B', editable: true };
const operation = { id: 'op-1', action: 'up', status: 'success', detail: 'started', createdAt: '2026-10-15T05:00:00' };
const backup = { id: 'backup-1', reason: 'save', filePath: 'compose.yml', createdAt: '2026-10-15T05:00:00', size: 120 };

beforeEach(() => {
  getProjectActivity.mockReset();
  getProjectActivity.mockResolvedValue({ operations: [], backups: [] });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; });

function mountDrawer(project = projectA) {
  return mount(ProjectActivityDrawer, {
    props: { project },
    global: {
      stubs: {
        EmptyState: { props: ['title'], template: '<p class="empty-state">{{ title }}</p>' },
        ConfirmDialog: true,
        BaseModal: { template: '<div v-if="show"><slot /></div>', props: ['show', 'title', 'bodyClass'] },
        RouterLink: { template: '<a><slot /></a>', props: ['to'] },
      },
    },
  });
}

describe('项目活动抽屉的空状态、加载反馈和请求时序', () => {
  it('只在活动或版本列表真的为空时显示对应空状态', async () => {
    getProjectActivity.mockResolvedValueOnce({ operations: [operation], backups: [backup] });
    wrapper = mountDrawer();
    await flushPromises();
    expect(wrapper.findAll('.activity-item')).toHaveLength(1);
    expect(wrapper.find('.empty-state').exists()).toBe(false);

    await wrapper.findAll('.tabs button')[1].trigger('click'); // 切到配置版本标签
    await flushPromises();
    expect(wrapper.findAll('.version-card')).toHaveLength(1);
    expect(wrapper.find('.empty-state').exists()).toBe(false);
  });

  it('加载中和请求失败分别作为 status / alert 播报', async () => {
    let rejectRequest;
    getProjectActivity.mockReturnValueOnce(new Promise((_, reject) => { rejectRequest = reject; }));
    wrapper = mountDrawer();
    await nextTick();
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('正在加载');
    rejectRequest(new Error('连接失败'));
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('连接失败');
  });

  it('切换项目后旧请求不会覆盖新项目的数据或错误状态', async () => {
    let resolveOld;
    getProjectActivity
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ operations: [{ ...operation, id: 'op-b', action: 'restart' }], backups: [] });
    wrapper = mountDrawer(projectA);
    await wrapper.setProps({ project: projectB });
    await flushPromises();
    expect(wrapper.text()).toContain('重启项目');

    resolveOld({ operations: [{ ...operation, id: 'op-old', action: 'stop' }], backups: [] });
    await flushPromises();
    expect(wrapper.text()).toContain('重启项目');
    expect(wrapper.text()).not.toContain('停止项目');
    expect(getProjectActivity.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
  });
});
