import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

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
        ChangePreviewModal: {
          props: ['show', 'fallbackMessage'],
          emits: ['confirm', 'cancel'],
          template: '<div v-if="show" data-testid="change-preview"><p>{{ fallbackMessage }}</p><button type="button" @click="$emit(\'confirm\')">确认升级</button></div>',
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

  it('预览并确认时只提交用户选中的服务', async () => {
    wrapper = mountModal();
    await flushPromises();

    await wrapper.get('input[aria-label="选择升级服务 web"]').setValue(false);
    await wrapper.get('button.btn-primary').trigger('click');
    await flushPromises();

    expect(mocks.getComposeFile).toHaveBeenCalledWith(project.id);
    expect(mocks.previewCompose).toHaveBeenCalledWith(project.id, 'services: {}');
    expect(wrapper.get('[data-testid="change-preview"]').text()).toContain('只拉取并重建这些服务：api');
    expect(wrapper.get('[data-testid="change-preview"]').text()).not.toContain('web');

    await wrapper.get('[data-testid="change-preview"] button').trigger('click');
    expect(wrapper.emitted('upgrade')?.[0]?.[0]).toEqual({ project, services: ['api'] });
    expect(mocks.toastInfo).toHaveBeenCalledOnce();
  });
});
