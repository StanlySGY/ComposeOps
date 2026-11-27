import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, KeepAlive, ref } from 'vue';

const mocks = vi.hoisted(() => ({
  getProjectUpdates: vi.fn(),
  getComposeFile: vi.fn(),
  previewCompose: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('../src/api/client.js', () => ({
  api: {
    getProjectUpdates: mocks.getProjectUpdates,
    getComposeFile: mocks.getComposeFile,
    previewCompose: mocks.previewCompose,
  },
}));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => ({ info: mocks.toastInfo }) }));

import ProjectUpgradeModal from '../src/components/services/ProjectUpgradeModal.vue';

const project = { id: 'project-1', projectName: 'demo' };
const updateResult = () => ({
  projectId: project.id,
  projectName: project.projectName,
  checkedAt: 1792660000000,
  hasUpdate: true,
  images: [
    { service: 'web', image: 'nginx:latest', status: 'updated', hasUpdate: true, localDigest: 'sha256:aaa', remoteDigest: 'sha256:bbb', reachable: true },
    { service: 'api', image: 'ghcr.io/example/api:latest', status: 'updated', hasUpdate: true, localDigest: 'sha256:ccc', remoteDigest: 'sha256:ddd', reachable: true },
    { service: 'worker', image: '', status: 'local_build', hasUpdate: false, reachable: true, reason: '服务通过 build 配置本地构建' },
  ],
});

let wrapper;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjectUpdates.mockResolvedValue(updateResult());
  mocks.getComposeFile.mockResolvedValue({ content: 'services: {}' });
  mocks.previewCompose.mockResolvedValue({ changes: [] });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

function mountModal() {
  return mount(ProjectUpgradeModal, {
    props: { project },
    global: {
      stubs: {
        BaseModal: {
          props: ['show', 'title'],
          template: '<div v-if="show" role="dialog"><h2>{{ title }}</h2><slot name="header-actions"/><slot/><slot name="footer"/></div>',
        },
        ConfirmDialog: {
          props: ['show', 'message'],
          emits: ['confirm', 'cancel'],
          template: '<div v-if="show" data-testid="upgrade-confirm"><p>{{ message }}</p><slot/><button type="button" @click="$emit(\'confirm\')">确认升级</button></div>',
        },
      },
    },
  });
}

describe('镜像更新弹窗按 Compose 服务选择升级', () => {
  it('默认只勾选有远端更新的服务，本地构建服务不会成为升级选项', async () => {
    wrapper = mountModal();
    await flushPromises();

    const web = wrapper.get('input[aria-label="选择升级服务 web"]');
    const api = wrapper.get('input[aria-label="选择升级服务 api"]');
    expect(web.element.checked).toBe(true);
    expect(api.element.checked).toBe(true);
    expect(wrapper.find('input[aria-label="选择升级服务 worker"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('服务通过 build 配置本地构建');
    expect(wrapper.get('button.btn-primary').text()).toContain('升级所选服务（2）');
  });

  it('确认范围后只提交选中服务，说明镜像变化边界和可能中断', async () => {
    wrapper = mountModal();
    await flushPromises();

    await wrapper.get('input[aria-label="选择升级服务 web"]').setValue(false);
    await wrapper.get('button.btn-primary').trigger('click');
    await flushPromises();

    expect(mocks.getComposeFile).not.toHaveBeenCalled();
    expect(mocks.previewCompose).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="upgrade-confirm"]').text()).toContain('中的这些服务：api');
    expect(wrapper.get('[data-testid="upgrade-confirm"]').text()).not.toContain('web');
    expect(wrapper.get('[data-testid="upgrade-confirm"]').text()).toContain('可能短暂中断服务');
    expect(wrapper.get('[data-testid="upgrade-confirm"]').text()).toContain('无法从当前配置预览');

    await wrapper.get('[data-testid="upgrade-confirm"] button').trigger('click');
    expect(wrapper.emitted('upgrade')?.[0]?.[0]).toEqual({ project, services: ['api'] });
    expect(mocks.toastInfo).toHaveBeenCalledOnce();
  });

  it('初次失败可重试，刷新失败后旧结果不能继续升级', async () => {
    mocks.getProjectUpdates.mockRejectedValueOnce(new Error('网络失败'));
    wrapper = mountModal(); await flushPromises();
    expect(wrapper.text()).toContain('重新检查');
    await wrapper.get('[role="alert"] button').trigger('click'); await flushPromises();
    expect(wrapper.find('button.btn-primary').element.disabled).toBe(false);
    mocks.getProjectUpdates.mockRejectedValueOnce(new Error('刷新失败'));
    await wrapper.get('[aria-label="立即刷新"]').trigger('click'); await flushPromises();
    expect(wrapper.find('button.btn-primary').element.disabled).toBe(true);
    expect(wrapper.find('[data-testid="upgrade-confirm"]').exists()).toBe(false);
  });

  it('部分失败同时显示更新和待确认，只允许确认成功的服务，并展示真正的镜像内容摘要', async () => {
    const result = updateResult();
    result.images[1] = { service: 'api', status: 'failed', hasUpdate: false, error: '检查期限已到' };
    result.images[0].localImageId = 'sha256:' + 'a'.repeat(64);
    result.images[0].remoteImageId = 'sha256:' + 'b'.repeat(64);
    mocks.getProjectUpdates.mockResolvedValue(result);
    wrapper = mountModal(); await flushPromises();
    expect(wrapper.text()).toContain('有可用更新 · 部分待确认');
    expect(wrapper.text()).toContain('运行镜像内容');
    expect(wrapper.text()).toContain('aaaaaaaaaa…aaaaaaaa');
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(1);
  });

  it('切项目取消旧请求，迟到结果不能覆盖新项目；卸载释放当前请求', async () => {
    let finish;
    mocks.getProjectUpdates.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    wrapper = mountModal();
    const signal = mocks.getProjectUpdates.mock.calls[0][2].signal;
    await wrapper.setProps({ project: { id: 'p2', projectName: 'new' } }); await flushPromises();
    expect(signal.aborted).toBe(true);
    finish({ hasUpdate: false, images: [] }); await flushPromises();
    expect(wrapper.text()).toContain('有可用更新');
    const latest = mocks.getProjectUpdates.mock.calls.at(-1)[2].signal;
    wrapper.unmount(); wrapper = null;
    expect(latest.aborted).toBe(true);
  });

  it('缓存失活撤销升级确认，返回不会恢复旧确认或重复已完成的检查', async () => {
    const show = ref(true);
    const Host = defineComponent({ components: { KeepAlive, ProjectUpgradeModal }, setup: () => ({ show, project }), template: '<KeepAlive><ProjectUpgradeModal v-if="show" :project="project"/></KeepAlive>' });
    wrapper = mount(Host, { global: { stubs: { BaseModal: { props: ['show'], template: '<div v-if="show"><slot/><slot name="footer"/></div>' } } } });
    await flushPromises();
    const modal = wrapper.getComponent(ProjectUpgradeModal);
    await modal.get('button.btn-primary').trigger('click');
    expect(modal.vm.showConfirm).toBe(true);
    show.value = false; await flushPromises();
    expect(mocks.getProjectUpdates.mock.calls[0][2].signal.aborted).toBe(true);
    expect(modal.vm.showConfirm).toBe(false);
    show.value = true; await flushPromises();
    expect(mocks.getProjectUpdates).toHaveBeenCalledTimes(1);
    expect(modal.vm.showConfirm).toBe(false);
  });
});
