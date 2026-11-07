import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, ref } from 'vue';

const getComposeFile = vi.hoisted(() => vi.fn());
const validateCompose = vi.hoisted(() => vi.fn());
const previewCompose = vi.hoisted(() => vi.fn());
const previewDeploy = vi.hoisted(() => vi.fn());
const streamComposeControl = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  projects: [{ id: 'p1', projectName: '测试项目', editable: true }],
  refresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/api/client.js', () => ({
  api: { getComposeFile, validateCompose, previewCompose, previewDeploy },
  streamComposeControl,
}));
vi.mock('../src/stores/services.js', () => ({ useServicesStore: () => store }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));

import ChangeReviewView from '../src/views/ChangeReviewView.vue';

let wrapper;
beforeEach(() => {
  getComposeFile.mockReset();
  validateCompose.mockReset();
  previewCompose.mockReset();
  previewDeploy.mockReset();
  streamComposeControl.mockReset();
  store.projects = [{ id: 'p1', projectName: '测试项目', editable: true }];
  store.refresh.mockClear().mockResolvedValue(undefined);
  getComposeFile.mockResolvedValue({ hostId: 'local', content: 'services:\n  web:\n    image: nginx:latest\n' });
  validateCompose.mockResolvedValue({ issues: [] });
  previewCompose.mockResolvedValue({ added: [], changed: [], restarted: [], removed: [], portConflicts: [] });
  previewDeploy.mockResolvedValue({ summary: { create: 1, recreate: 0, keep: 0, pulls: 0, conflicts: 0, orphan: 0 }, pullsNeeded: [], conflicts: [], volumeRisks: [], bindRisks: [], services: [] });
  streamComposeControl.mockImplementation(async (_projectId, _action, onFrame) => { onFrame({ type: 'exit', data: { code: 0 } }); });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; });
function mountView() {
  return mount(ChangeReviewView, {
    global: {
      stubs: {
        EmptyState: { template: '<div class="empty-state"><slot /></div>' },
        BaseModal: { props: ['show', 'title', 'sizeClass', 'bodyClass'], template: '<div v-if="show" class="modal-stub"><slot name="header-actions"/><slot/><slot name="footer"/></div>' },
      },
    },
  });
}

describe('变更评审异步反馈可访问性', () => {
  it('评审加载有礼貌播报，评审失败通过 alert 呈现', async () => {
    let reject;
    getComposeFile.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
    wrapper = mountView();
    await wrapper.get('select[aria-label="选择项目"]').setValue('p1');
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('正在加载变更评审');
    reject(new Error('network offline'));
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('变更评审失败');
    expect(wrapper.attributes('aria-busy')).toBe('false');
  });

  it('宿主预演失败会通过 alert 播报原因', async () => {
    previewDeploy.mockRejectedValueOnce(new Error('host unavailable'));
    wrapper = mountView();
    await wrapper.get('select[aria-label="选择项目"]').setValue('p1');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    const previewButton = wrapper.findAll('button').find(button => button.text().includes('检查宿主'));
    await previewButton.trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('宿主检查失败');
  });

  it('SSE 流结束但 Compose 退出码非零或错误帧出现时仍播报部署失败', async () => {
    streamComposeControl.mockImplementationOnce(async (_projectId, _action, onFrame) => {
      onFrame({ type: 'stderr', data: '服务启动失败' });
      onFrame({ type: 'exit', data: { code: 2 } });
    });
    wrapper = mountView();
    await wrapper.get('select[aria-label="选择项目"]').setValue('p1');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.findAll('button').find(button => button.text().includes('确认部署…')).trigger('click');
    await wrapper.findAll('.modal-stub button').find(button => button.text().includes('确认部署')).trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('部署失败');
    expect(wrapper.get('[role="region"][aria-label="部署执行输出"]').text()).toContain('[退出码 2]');
    expect(store.refresh).toHaveBeenCalledTimes(1); // 只包含项目初始化刷新，不在失败后刷新运行态
  });

  it('即使收到退出码 0，服务端显式错误帧也不能被播报为部署成功', async () => {
    streamComposeControl.mockImplementationOnce(async (_projectId, _action, onFrame) => {
      onFrame({ type: 'error', data: '执行前置检查失败' });
      onFrame({ type: 'exit', data: { code: 0 } });
    });
    wrapper = mountView();
    await wrapper.get('select[aria-label="选择项目"]').setValue('p1');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.findAll('button').find(button => button.text().includes('确认部署…')).trigger('click');
    await wrapper.findAll('.modal-stub button').find(button => button.text().includes('确认部署')).trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('部署失败');
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });

  it('SSE 未发出退出码时播报结果未确认，而不是部署成功', async () => {
    streamComposeControl.mockResolvedValueOnce(undefined);
    wrapper = mountView();
    await wrapper.get('select[aria-label="选择项目"]').setValue('p1');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.findAll('button').find(button => button.text().includes('确认部署…')).trigger('click');
    await wrapper.findAll('.modal-stub button').find(button => button.text().includes('确认部署')).trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('部署结果未确认');
    expect(wrapper.get('[role="region"][aria-label="部署执行输出"]').text()).toContain('未收到 Compose 退出码');
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });

  it('部署输出区域可键盘聚焦并有名称，部署终态得到播报', async () => {
    wrapper = mountView();
    await wrapper.get('select[aria-label="选择项目"]').setValue('p1');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    const deployButton = wrapper.findAll('button').find(button => button.text().includes('确认部署…'));
    await deployButton.trigger('click'); // 一键部署
    const confirmButton = wrapper.findAll('.modal-stub button').find(button => button.text().includes('确认部署'));
    await confirmButton.trigger('click'); // 确认部署
    await flushPromises();

    expect(wrapper.get('[role="region"][aria-label="部署执行输出"]').attributes('tabindex')).toBe('0');
    expect(wrapper.get('[role="region"][aria-label="部署执行输出"]').attributes('aria-live')).toBe('off');
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('部署完成');
  });
});

describe('评审上下文与部署前置条件', () => {
  const select = () => wrapper.get('select[aria-label="选择项目"]');
  const deploy = () => wrapper.findAll('button').find(button => button.text().includes('确认部署…'));
  const ready = () => vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

  it('加载中和失败后均不显示通过评分，也不能打开部署确认', async () => {
    let reject;
    getComposeFile.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
    wrapper = mountView();
    await select().setValue('p1');
    expect(wrapper.text()).toContain('正在检查当前项目');
    expect(deploy()).toBeUndefined();
    expect(wrapper.text()).not.toContain('规则风险等级');
    reject(new Error('offline'));
    await flushPromises();
    expect(deploy()).toBeUndefined();
    expect(wrapper.text()).toContain('重新评审');
    expect(wrapper.text()).not.toContain('可安全部署');
    await wrapper.findAll('button').find(b => b.text().includes('重新评审')).trigger('click');
    await ready();
    expect(deploy().element.disabled).toBe(false);
  });

  it('快速切换后丢弃旧配置，不以新项目 ID 校验旧配置', async () => {
    store.projects.push({ id: 'p2', projectName: '项目 B', editable: true });
    let resolveA;
    getComposeFile.mockReturnValueOnce(new Promise(resolve => { resolveA = resolve; }));
    wrapper = mountView();
    await select().setValue('p1');
    await select().setValue('p2');
    await ready();
    const calls = validateCompose.mock.calls.length;
    resolveA({ content: 'services: { old: { image: nginx } }', hostId: 'local' });
    await flushPromises();
    expect(validateCompose).toHaveBeenCalledTimes(calls);
    expect(wrapper.text()).toContain('项目 B · 检查于');
    expect(select().element.value).toBe('p2');
  });

  it('旧校验和旧宿主预演不能覆盖新项目', async () => {
    store.projects.push({ id: 'p2', projectName: '项目 B', editable: true });
    wrapper = mountView();
    await select().setValue('p1'); await ready();
    let resolveHost;
    previewDeploy.mockReturnValueOnce(new Promise(resolve => { resolveHost = resolve; }));
    await wrapper.findAll('button').find(b => b.text().includes('检查宿主')).trigger('click');
    expect(previewDeploy).toHaveBeenCalledWith('p1', false);
    let resolveValidation;
    validateCompose.mockReturnValueOnce(new Promise(resolve => { resolveValidation = resolve; }));
    await wrapper.findAll('button').find(b => b.text() === '刷新').trigger('click');
    await flushPromises();
    await select().setValue('p2'); await ready();
    resolveValidation({ issues: [{ level: 'error', message: '旧项目错误' }] });
    resolveHost({ summary: { create: 999 }, aiSummary: '旧宿主' });
    await flushPromises();
    expect(wrapper.text()).not.toContain('旧项目错误');
    expect(wrapper.text()).not.toContain('旧宿主');
    expect(deploy().element.disabled).toBe(false);
  });

  it('缺失预览结果不能被当作零风险', async () => {
    previewCompose.mockResolvedValueOnce(null);
    wrapper = mountView(); await select().setValue('p1'); await ready();
    expect(wrapper.text()).toContain('检查结果不完整');
    expect(deploy()).toBeUndefined();
  });

  it('确认前配置变化时拒绝部署并要求重新评审', async () => {
    wrapper = mountView(); await select().setValue('p1'); await ready();
    await deploy().trigger('click');
    getComposeFile.mockResolvedValueOnce({ hostId: 'local', content: 'services: {}' });
    await wrapper.findAll('.modal-stub button').find(b => b.text().includes('确认部署')).trigger('click');
    await flushPromises();
    expect(streamComposeControl).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('配置或节点已变化，本次未部署');
    expect(deploy()).toBeUndefined();
  });

  it('节点变化使现有评审和确认立即失效', async () => {
    wrapper = mountView(); await select().setValue('p1'); await ready();
    await deploy().trigger('click');
    window.dispatchEvent(new Event('composeops:host-changed'));
    await flushPromises();
    expect(wrapper.find('.modal-stub').exists()).toBe(false);
    expect(select().element.value).toBe('');
    expect(streamComposeControl).not.toHaveBeenCalled();
  });

  it('部署重复点击只发送一次，携带已评审配置和节点', async () => {
    wrapper = mountView(); await select().setValue('p1'); await ready();
    await deploy().trigger('click');
    const confirm = wrapper.findAll('.modal-stub button').find(b => b.text().includes('确认部署'));
    await Promise.all([confirm.trigger('click'), confirm.trigger('click')]);
    await flushPromises();
    expect(streamComposeControl).toHaveBeenCalledTimes(1);
    expect(streamComposeControl.mock.calls[0][4]).toEqual({ action: 'up', expectedHostId: 'local', expectedContent: 'services:\n  web:\n    image: nginx:latest\n' });
  });
});

describe('缓存评审生命周期', () => {
  it('切换标签后丢弃挂起请求，返回重新加载；完成结果返回后可打开确认', async () => {
    const visible = ref(true);
    let resolveOld;
    getComposeFile.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(ChangeReviewView) : h('div', '另一个标签') }) }), { global: { stubs: { BaseModal: { props: ['show'], template: '<div v-if="show" class="modal-stub"><slot/><slot name="footer"/></div>' } } } });
    await wrapper.get('select').setValue('p1');
    visible.value = false; await flushPromises();
    resolveOld({ content: 'services: { old: { image: nginx } }', hostId: 'local' }); await flushPromises();
    expect(validateCompose).not.toHaveBeenCalled();
    visible.value = true; await flushPromises();
    await vi.waitFor(() => expect(wrapper.text()).toContain('规则风险等级'));
    const calls = getComposeFile.mock.calls.length;
    visible.value = false; await flushPromises();
    visible.value = true; await flushPromises();
    expect(getComposeFile).toHaveBeenCalledTimes(calls);
    const deploy = wrapper.findAll('button').find(b => b.text().includes('确认部署…'));
    expect(deploy.element.disabled).toBe(false);
    await deploy.trigger('click');
    expect(wrapper.find('.modal-stub').exists()).toBe(true);
  });
});
