import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

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
  store.refresh.mockClear().mockResolvedValue(undefined);
  getComposeFile.mockResolvedValue({ content: 'services:\n  web:\n    image: nginx:latest\n' });
  validateCompose.mockResolvedValue({ issues: [] });
  previewCompose.mockResolvedValue({ added: [], changed: [], restarted: [], removed: [], portConflicts: [] });
  previewDeploy.mockResolvedValue({ summary: { create: 1, recreate: 0, keep: 0, pulls: 0, conflicts: 0, orphan: 0 }, pullsNeeded: [], conflicts: [], volumeRisks: [], bindRisks: [], services: [] });
  streamComposeControl.mockResolvedValue(undefined);
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
    const previewButton = wrapper.findAll('button').find(button => button.text().includes('生成预言'));
    await previewButton.trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('部署预言失败');
  });

  it('SSE 流结束但 Compose 退出码非零或错误帧出现时仍播报部署失败', async () => {
    streamComposeControl.mockImplementationOnce(async (_projectId, _action, onFrame) => {
      onFrame({ type: 'stderr', data: '服务启动失败' });
      onFrame({ type: 'exit', data: { code: 2 } });
    });
    wrapper = mountView();
    await wrapper.get('select[aria-label="选择项目"]').setValue('p1');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.findAll('button').find(button => button.text().includes('一键部署')).trigger('click');
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
    await wrapper.findAll('button').find(button => button.text().includes('一键部署')).trigger('click');
    await wrapper.findAll('.modal-stub button').find(button => button.text().includes('确认部署')).trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('部署失败');
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });

  it('部署输出区域可键盘聚焦并有名称，部署终态得到播报', async () => {
    wrapper = mountView();
    await wrapper.get('select[aria-label="选择项目"]').setValue('p1');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    const deployButton = wrapper.findAll('button').find(button => button.text().includes('一键部署'));
    await deployButton.trigger('click'); // 一键部署
    const confirmButton = wrapper.findAll('.modal-stub button').find(button => button.text().includes('确认部署'));
    await confirmButton.trigger('click'); // 确认部署
    await flushPromises();

    expect(wrapper.get('[role="region"][aria-label="部署执行输出"]').attributes('tabindex')).toBe('0');
    expect(wrapper.get('[role="region"][aria-label="部署执行输出"]').attributes('aria-live')).toBe('off');
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('部署完成');
  });
});
