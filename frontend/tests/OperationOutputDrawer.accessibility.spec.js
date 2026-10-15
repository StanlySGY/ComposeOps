import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import OperationOutputDrawer from '../src/components/services/OperationOutputDrawer.vue';

vi.mock('../src/composables/useEscapeKey.js', () => ({ useEscapeKey: vi.fn() }));
let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('操作输出抽屉可访问性', () => {
  it('为对话框标题、焦点进入与恢复、关闭按钮、输出区域和批量进度提供语义', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = '启动服务';
    document.body.appendChild(opener);
    opener.focus();

    wrapper = mount(OperationOutputDrawer, {
      attachTo: document.body,
      props: {
        label: '部署', name: 'web', text: 'Pulling image…', running: true,
        batchTasks: [{ id: '1', name: '拉取镜像', status: 'running' }, { id: '2', name: '启动服务', status: 'pending' }],
        batchProgress: 25, completedCount: 0,
      },
    });

    const dialog = wrapper.get('[role="dialog"][aria-labelledby="operation-output-title"]');
    expect(dialog.attributes('tabindex')).toBe('-1');
    expect(dialog.get('h2#operation-output-title').text()).toBe('部署 · web 操作输出');
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog.element));
    expect(wrapper.get('button[aria-label="关闭输出面板"]').exists()).toBe(true);
    expect(wrapper.get('pre[role="region"]').attributes('aria-label')).toBe('操作执行输出');
    expect(wrapper.get('pre[role="region"]').attributes('aria-live')).toBe('off');
    const progress = wrapper.get('[role="progressbar"]');
    expect(progress.attributes('aria-label')).toBe('批量任务总体进度');
    expect(progress.attributes('aria-valuenow')).toBe('25');
    expect(progress.attributes('aria-valuetext')).toContain('0 / 2');
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('0 / 2 项任务已完成');

    await wrapper.get('button[aria-label="关闭输出面板"]').trigger('click');
    expect(wrapper.emitted('close')).toBeTruthy();

    wrapper.unmount();
    wrapper = null;
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
