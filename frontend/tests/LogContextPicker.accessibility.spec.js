import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import LogContextPicker from '../src/components/agent/LogContextPicker.vue';

const getProjectLogs = vi.hoisted(() => vi.fn());
vi.mock('../src/api/client.js', () => ({ api: { getProjectLogs } }));

let wrapper;
const projects = [
  { id: 'p1', projectName: '项目一', containers: [{ id: 'c1', name: 'web' }] },
  { id: 'p2', projectName: '项目二', containers: [{ id: 'c2', name: 'api' }] },
];

beforeEach(() => {
  localStorage.removeItem('composeops:logpicker');
  getProjectLogs.mockReset();
  getProjectLogs.mockResolvedValue({ logs: 'INFO service ready\nERROR connection refused' });
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  localStorage.removeItem('composeops:logpicker');
});
function mountPicker() {
  return mount(LogContextPicker, { props: { projects } });
}
async function selectContainer(projectId = 'p1', containerId = 'c1') {
  await wrapper.get('select[aria-label="选择项目"]').setValue(projectId);
  await wrapper.get('select[aria-label="选择容器"]').setValue(containerId);
  await flushPromises();
}

describe('Agent 日志上下文选择器可访问性与加载反馈', () => {
  it('项目、容器和日志检索均有可访问名称，加载的日志行可通过复选框选择', async () => {
    wrapper = mountPicker();
    await selectContainer();
    expect(wrapper.get('input[aria-label="检索日志上下文"]').exists()).toBe(true);
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('2 行');
    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].element.closest('label').textContent).toContain('INFO service ready');
  });

  it('加载失败时显示明确错误，而不是伪装成“暂无日志”', async () => {
    getProjectLogs.mockRejectedValueOnce(new Error('network offline'));
    wrapper = mountPicker();
    await selectContainer();
    expect(wrapper.get('[role="alert"]').text()).toContain('日志加载失败');
    expect(wrapper.text()).not.toContain('暂无日志');
  });

  it('刷新失败时清空已经勾选的旧日志挂载，防止 Agent 收到过期上下文', async () => {
    wrapper = mountPicker();
    await selectContainer();
    await wrapper.get('input[type="checkbox"]').setValue(true);
    expect(wrapper.emitted('attach').at(-1)[0]).toMatchObject({ count: 1 });

    getProjectLogs.mockRejectedValueOnce(new Error('network offline'));
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').exists()).toBe(true);
    expect(wrapper.emitted('attach').at(-1)[0]).toEqual({ text: '', count: 0 });
    expect(wrapper.findAll('input[type="checkbox"]').every(input => !input.element.checked)).toBe(true);
  });

  it('容器切换后，旧请求的迟到响应不会覆盖新容器日志', async () => {
    let resolveOld;
    getProjectLogs.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    wrapper = mountPicker();
    await wrapper.get('select[aria-label="选择项目"]').setValue('p1');
    await wrapper.get('select[aria-label="选择容器"]').setValue('c1');
    await wrapper.get('select[aria-label="选择项目"]').setValue('p2');
    await wrapper.get('select[aria-label="选择容器"]').setValue('c2');
    await flushPromises();
    expect(wrapper.text()).toContain('service ready');
    resolveOld({ logs: 'STALE old project response' });
    await flushPromises();
    expect(wrapper.text()).not.toContain('STALE old project response');
  });
});
