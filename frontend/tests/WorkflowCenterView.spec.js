import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DOMWrapper, mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api } from '../src/api/client.js';
import WorkflowCenterView from '../src/views/WorkflowCenterView.vue';
import { useWorkflowStore } from '../src/stores/workflow.js';

vi.mock('../src/api/client.js', () => ({ api: {
  getProjects: vi.fn(), getWorkflowDefinitions: vi.fn(), getWorkflowInstances: vi.fn(),
} }));
let wrapper;
let router;
beforeEach(async () => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  api.getProjects.mockResolvedValue({ projects: [] });
  api.getWorkflowDefinitions.mockResolvedValue({ definitions: [{ id: 'wf', name: '审查流程', enabled: true, nodes: [] }] });
  api.getWorkflowInstances.mockResolvedValue({ instances: [{ id: 'run', name: '审查实例', status: 'waiting_approval' }] });
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<main>测试路由</main>' } }],
  });
  await router.push('/');
  await router.isReady();
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

it('异步加载的定义和待审批实例显示在页面,刷新状态保持响应性', async () => {
  wrapper = mount(WorkflowCenterView, { global: { plugins: [router] } });
  await flushPromises();
  expect(wrapper.text()).toContain('审查流程');
  expect(wrapper.text()).toContain('审查实例');
  expect(wrapper.text()).toContain('通过');
  const store = useWorkflowStore();
  store.definitions = [];
  store.instances = [];
  store.error = '刷新失败';
  await flushPromises();
  expect(wrapper.text()).toContain('还没有工作流');
  expect(wrapper.text()).toContain('暂无运行实例');
  expect(wrapper.text()).toContain('刷新失败');
});

it('点击刷新获取服务端最新定义和实例', async () => {
  wrapper = mount(WorkflowCenterView, { global: { plugins: [router] } });
  await flushPromises();
  api.getWorkflowDefinitions.mockResolvedValue({ definitions: [{ id: 'wf', name: '更新流程', enabled: true, nodes: [] }] });
  await wrapper.findAll('button').find(button => button.text() === '刷新').trigger('click');
  await flushPromises();
  expect(api.getWorkflowDefinitions).toHaveBeenLastCalledWith(true);
  expect(api.getWorkflowInstances).toHaveBeenLastCalledWith({ limit: 100 }, true);
  expect(wrapper.text()).toContain('更新流程');
});

async function editor() {
  wrapper = mount(WorkflowCenterView, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
  await wrapper.findAll('button').find(button => button.text() === '新建工作流').trigger('click');
  return new DOMWrapper(document.querySelector('[role="dialog"]'));
}
function saveButton(dialog) { return dialog.findAll('button').find(button => button.text() === '保存' || button.text() === '保存中…'); }

it('连续验证错误立即替换局部提示并聚焦问题字段，表单值保留', async () => {
  const dialog = await editor();
  await saveButton(dialog).trigger('click'); await flushPromises();
  expect(dialog.find('[role=alert]').text()).toBe('请填写工作流名称');
  expect(document.activeElement.id).toBe('workflow-name');
  await dialog.find('#workflow-name').setValue('我的工作流');
  await dialog.find('#workflow-node-1-id').setValue('trigger');
  await saveButton(dialog).trigger('click'); await flushPromises();
  expect(dialog.find('[role=alert]').text()).toBe('节点 ID 重复：trigger');
  expect(document.activeElement.id).toBe('workflow-node-1-id');
  expect(dialog.find('#workflow-node-1-id').attributes('aria-invalid')).toBe('true');
  expect(dialog.find('#workflow-name').element.value).toBe('我的工作流');
});

it('清空必填触发设置后保存不会偷偷补回默认值', async () => {
  const dialog = await editor();
  await dialog.find('#workflow-name').setValue('事件流程');
  await dialog.find('#workflow-trigger-type').setValue('event');
  await dialog.find('#workflow-event-types').setValue('');
  await saveButton(dialog).trigger('click'); await flushPromises();
  expect(dialog.find('[role=alert]').text()).toContain('事件触发必须选择');
  expect(dialog.find('#workflow-event-types').element.value).toBe('');
  expect(document.activeElement.id).toBe('workflow-event-types');
});

it('保存中防止重复提交和关闭，失败时保留输入并允许重试', async () => {
  const dialog = await editor();
  await dialog.find('#workflow-name').setValue('保存测试');
  await dialog.find('[aria-label="删除节点 3"]').trigger('click');
  let rejectSave;
  const create = vi.spyOn(useWorkflowStore(), 'create').mockImplementation(() => new Promise((_, reject) => { rejectSave = reject; }));
  await saveButton(dialog).trigger('click');
  expect(saveButton(dialog).element.disabled).toBe(true);
  expect(dialog.find('#workflow-name').element.matches(':disabled')).toBe(true);
  await saveButton(dialog).trigger('click');
  expect(create).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flushPromises();
  expect(document.querySelector('[role=dialog]')).not.toBeNull();
  rejectSave(new Error('暂时无法保存')); await flushPromises();
  expect(dialog.find('[role=alert]').text()).toBe('暂时无法保存');
  expect(document.activeElement.id).toBe('workflow-editor-error');
  expect(dialog.find('#workflow-name').element.value).toBe('保存测试');
  create.mockResolvedValue({ id: 'saved' });
  await saveButton(dialog).trigger('click'); await flushPromises();
  expect(create).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role=dialog]')).toBeNull();
});
