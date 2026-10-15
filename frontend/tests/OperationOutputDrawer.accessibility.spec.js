import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import OperationOutputDrawer from '../src/components/services/OperationOutputDrawer.vue';

vi.mock('../src/composables/useEscapeKey.js', () => ({ useEscapeKey: vi.fn() }));
let wrapper;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

describe('操作输出抽屉可访问性', () => {
  it('为关闭按钮、输出区域和批量进度提供可访问语义', () => {
    wrapper = mount(OperationOutputDrawer, {
      props: {
        label: '部署', name: 'web', text: 'Pulling image…', running: true,
        batchTasks: [{ id: '1', name: '拉取镜像', status: 'running' }, { id: '2', name: '启动服务', status: 'pending' }],
        batchProgress: 25, completedCount: 0,
      },
    });
    expect(wrapper.get('button[aria-label="关闭输出面板"]').exists()).toBe(true);
    expect(wrapper.get('pre[role="region"]').attributes('aria-label')).toBe('操作执行输出');
    expect(wrapper.get('pre[role="region"]').attributes('aria-live')).toBe('off');
    const progress = wrapper.get('[role="progressbar"]');
    expect(progress.attributes('aria-label')).toBe('批量任务总体进度');
    expect(progress.attributes('aria-valuenow')).toBe('25');
    expect(progress.attributes('aria-valuetext')).toContain('0 / 2');
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('0 / 2 项任务已完成');
  });
});
