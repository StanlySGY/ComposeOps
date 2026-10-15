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
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

function mountDrawer(project = projectA, attachTo = undefined) {
  return mount(ProjectActivityDrawer, {
    ...(attachTo ? { attachTo } : {}),
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

  it('作为模态对话框将焦点移入、循环 Tab，并在关闭后恢复焦点', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = '打开项目活动';
    document.body.appendChild(opener);
    opener.focus();

    wrapper = mountDrawer(projectA, document.body);
    await flushPromises();

    const dialog = wrapper.get('aside[role="dialog"][aria-modal="true"][aria-labelledby="project-activity-title"]');
    expect(dialog.attributes('tabindex')).toBe('-1');
    expect(dialog.get('h2#project-activity-title').text()).toBe('项目 A');
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog.element));

    const focusable = [...dialog.element.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
    expect(focusable.length).toBeGreaterThan(2);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    await dialog.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    await dialog.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    await wrapper.setProps({ project: null });
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
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
