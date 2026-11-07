import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import OperationOutputDrawer from '../src/components/services/OperationOutputDrawer.vue';

vi.mock('../src/composables/useEscapeKey.js', () => ({ useEscapeKey: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api: { getProjects: vi.fn().mockResolvedValue({ projects: [] }) } }));
let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('操作输出抽屉可访问性', () => {
  it('切到其他节点后禁用项目操作，明确解释状态不可复用', () => {
    wrapper = mount(OperationOutputDrawer, { props: { projectId: 'p', action: 'restart', exitCode: 1, contextValid: false } });
    expect(wrapper.text()).toContain('当前节点已切换');
    expect(wrapper.text()).toContain('请切回操作所属节点');
    const diagnose = wrapper.findAll('button').find(button => button.text() === '一键 AI 诊断');
    const inspect = wrapper.findAll('button').find(button => button.text() === '查看项目状态');
    expect(diagnose.attributes('disabled')).toBeDefined();
    expect(inspect.attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('button').some(button => button.text() === '查看日志')).toBe(false);
  });
  it('未收到退出码时不把断流误报为成功', () => {
    wrapper = mount(OperationOutputDrawer, { props: { projectId: 'p', text: 'Starting service...', running: false, exitCode: null } });
    expect(wrapper.get('[data-state="unknown"]').text()).toContain('尚未确认执行结果');
    expect(wrapper.text()).not.toContain('执行完成');
    expect(wrapper.findAll('button').some(button => button.text() === '查看项目状态')).toBe(true);
  });
  it('退出码为零只说明命令成功，仍引导检查业务状态', () => {
    wrapper = mount(OperationOutputDrawer, { props: { projectId: 'p', text: 'done', running: false, exitCode: 0 } });
    expect(wrapper.get('[data-state="success"]').text()).toContain('确认容器状态与业务是否正常');
  });
  it('健康验收失败时零退出码不能覆盖具体失败原因', () => {
    wrapper = mount(OperationOutputDrawer, { props: { projectId: 'p', exitCode: 0, failureReason: '升级后容器未通过健康检查' } });
    const result = wrapper.get('[data-state="failed"]');
    expect(result.text()).toContain('升级后容器未通过健康检查');
    expect(result.text()).not.toContain('命令退出码为 0');
  });
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
