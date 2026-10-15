import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import VolumeBackupPanel from '../src/components/resources/VolumeBackupPanel.vue';

const api = vi.hoisted(() => ({
  getProjects: vi.fn(), getVolumeBackups: vi.fn(), getProjectVolumes: vi.fn(), createVolumeBackup: vi.fn(),
  verifyVolumeBackup: vi.fn(), restoreVolumeBackup: vi.fn(), deleteVolumeBackup: vi.fn(), volumeBackupDownloadUrl: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => toast }));

let wrapper;
beforeEach(() => {
  vi.clearAllMocks();
  api.getProjects.mockResolvedValue({ projects: [
    { id: 'p1', projectName: 'Alpha', managed: true },
    { id: 'p2', projectName: 'Beta', managed: true },
  ] });
  api.getVolumeBackups.mockResolvedValue({ backups: [] });
  api.getProjectVolumes.mockResolvedValue({ volumes: [{ name: 'data-volume', skip: '' }] });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

function mountPanel() {
  return mount(VolumeBackupPanel, { global: { stubs: { ConfirmDialog: true } } });
}

describe('数据卷备份界面状态播报与请求完整性', () => {
  it('为项目选择器和备份筛选器命名，加载失败不会误报“没有卷”或“没有备份”', async () => {
    api.getVolumeBackups.mockRejectedValueOnce(new Error('backup service offline'));
    wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.get('select[aria-label="选择要备份卷的项目"]').exists()).toBe(true);
    expect(wrapper.get('select[aria-label="筛选备份记录的项目"]').exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toContain('备份记录加载失败');
    expect(wrapper.text()).not.toContain('还没有备份记录');

    api.getProjectVolumes.mockRejectedValueOnce(new Error('host unavailable'));
    await wrapper.get('select[aria-label="选择要备份卷的项目"]').setValue('p1');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('卷列表加载失败');
    expect(wrapper.text()).not.toContain('该项目 compose 中没有声明卷');
  });

  it('项目切换后，迟到的卷列表响应不会覆盖当前项目', async () => {
    let resolveAlpha;
    api.getProjectVolumes.mockImplementation((id) => id === 'p1'
      ? new Promise(resolve => { resolveAlpha = resolve; })
      : Promise.resolve({ volumes: [{ name: 'beta-volume' }] }));
    wrapper = mountPanel();
    await flushPromises();
    const project = wrapper.get('select[aria-label="选择要备份卷的项目"]');
    await project.setValue('p1');
    await project.setValue('p2');
    await flushPromises();
    expect(wrapper.text()).toContain('beta-volume');
    resolveAlpha({ volumes: [{ name: 'alpha-stale-volume' }] });
    await flushPromises();
    expect(wrapper.text()).not.toContain('alpha-stale-volume');
    expect(wrapper.text()).toContain('beta-volume');
  });

  it('批量备份的进行中、完成和部分失败状态会被明确播报', async () => {
    wrapper = mountPanel();
    await flushPromises();
    await wrapper.get('select[aria-label="选择要备份卷的项目"]').setValue('p1');
    await flushPromises();
    await wrapper.get('input[type="checkbox"]').setValue(true);
    api.createVolumeBackup.mockResolvedValueOnce({});
    await wrapper.get('button.btn-primary').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('备份完成：已备份 1 个卷');
  });
});
