import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { api } from '../src/api/client.js';
import WorkflowCenterView from '../src/views/WorkflowCenterView.vue';
import { useWorkflowStore } from '../src/stores/workflow.js';

vi.mock('../src/api/client.js', () => ({ api: {
  getProjects: vi.fn(), getWorkflowDefinitions: vi.fn(), getWorkflowInstances: vi.fn(),
} }));
let wrapper;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  api.getProjects.mockResolvedValue({ projects: [] });
  api.getWorkflowDefinitions.mockResolvedValue({ definitions: [{ id: 'wf', name: '审查流程', enabled: true, nodes: [] }] });
  api.getWorkflowInstances.mockResolvedValue({ instances: [{ id: 'run', name: '审查实例', status: 'waiting_approval' }] });
});
afterEach(() => wrapper?.unmount());

it('异步加载的定义和待审批实例显示在页面,刷新状态保持响应性', async () => {
  wrapper = mount(WorkflowCenterView);
  await flushPromises();
  expect(wrapper.text()).toContain('审查流程');
  expect(wrapper.text()).toContain('审查实例');
  expect(wrapper.text()).toContain('通过');
  const store = useWorkflowStore();
  store.definitions = [];
  store.instances = [];
  store.error = '刷新失败';
  await flushPromises();
  expect(wrapper.text()).toContain('暂无工作流');
  expect(wrapper.text()).toContain('暂无运行实例');
  expect(wrapper.text()).toContain('刷新失败');
});

it('点击刷新获取服务端最新定义和实例', async () => {
  wrapper = mount(WorkflowCenterView);
  await flushPromises();
  api.getWorkflowDefinitions.mockResolvedValue({ definitions: [{ id: 'wf', name: '更新流程', enabled: true, nodes: [] }] });
  await wrapper.findAll('button').find(button => button.text() === '刷新').trigger('click');
  await flushPromises();
  expect(api.getWorkflowDefinitions).toHaveBeenLastCalledWith(true);
  expect(api.getWorkflowInstances).toHaveBeenLastCalledWith({ limit: 100 }, true);
  expect(wrapper.text()).toContain('更新流程');
});
