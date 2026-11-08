import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
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
  api.createVolumeBackup.mockResolvedValue({});
  api.deleteVolumeBackup.mockResolvedValue({});
  api.verifyVolumeBackup.mockResolvedValue({ status: 'verified', files: 4, durationMs: 300 });
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

  async function prepareBatch() {
    api.getProjectVolumes.mockResolvedValue({ volumes: [{ name: 'alpha-data' }, { name: 'alpha-cache' }] });
    wrapper = mountPanel();
    await flushPromises();
    await wrapper.get('select[aria-label="选择要备份卷的项目"]').setValue('p1');
    await flushPromises();
    for (const checkbox of wrapper.findAll('input[type="checkbox"]')) await checkbox.setValue(true);
  }

  it('批次进行时锁住项目和卷选择，并在节点变化后停止后续卷', async () => {
    let finishFirst;
    api.createVolumeBackup.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    await prepareBatch();
    await wrapper.get('button.btn-primary').trigger('click');
    expect(wrapper.get('select[aria-label="选择要备份卷的项目"]').element.disabled).toBe(true);
    expect(wrapper.get('input[type="checkbox"]').element.disabled).toBe(true);
    window.dispatchEvent(new CustomEvent('composeops:host-changed'));
    await flushPromises();
    finishFirst({});
    await flushPromises();
    expect(api.createVolumeBackup).toHaveBeenCalledExactlyOnceWith('p1', 'alpha-data');
    expect(wrapper.get('select[aria-label="选择要备份卷的项目"]').element.value).toBe('');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('离开页面后不继续发送批次，也不回填旧页面成功消息', async () => {
    let finishFirst;
    api.createVolumeBackup.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    await prepareBatch();
    await wrapper.get('button.btn-primary').trigger('click');
    wrapper.unmount();
    wrapper = null;
    finishFirst({});
    await flushPromises();
    expect(api.createVolumeBackup).toHaveBeenCalledExactlyOnceWith('p1', 'alpha-data');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('部分失败时仅保留失败卷，重试不会重复备份成功项', async () => {
    await prepareBatch();
    api.createVolumeBackup.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('空间暂不足'));
    await wrapper.get('button.btn-primary').trigger('click');
    await flushPromises();
    expect(wrapper.get('input[aria-label="选择数据卷 alpha-data"]').element.checked).toBe(false);
    expect(wrapper.get('input[aria-label="选择数据卷 alpha-cache"]').element.checked).toBe(true);
    await wrapper.get('button.btn-primary').trigger('click');
    await flushPromises();
    expect(api.createVolumeBackup.mock.calls).toEqual([['p1', 'alpha-data'], ['p1', 'alpha-cache'], ['p1', 'alpha-cache']]);
  });

  it('项目列表读取失败有独立重试，不显示成没有可备份项目', async () => {
    api.getProjects.mockRejectedValueOnce(new Error('节点连接中断'));
    wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('项目列表读取失败');
    await wrapper.get('button[aria-label="重新读取备份项目"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('select[aria-label="选择要备份卷的项目"]').text()).toContain('Alpha');
    expect(wrapper.text()).not.toContain('项目列表读取失败');
  });

  it('缓存页面失活会停止剩余批次，返回后重新读取当前记录', async () => {
    const visible = ref(true);
    let finishFirst;
    api.createVolumeBackup.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    api.getProjectVolumes.mockResolvedValue({ volumes: [{ name: 'alpha-data' }, { name: 'alpha-cache' }] });
    wrapper = mount({ components: { VolumeBackupPanel }, setup: () => ({ visible }), template: '<KeepAlive><VolumeBackupPanel v-if="visible" /></KeepAlive>' }, { global: { stubs: { ConfirmDialog: true } } });
    await flushPromises();
    await wrapper.get('select[aria-label="选择要备份卷的项目"]').setValue('p1');
    await flushPromises();
    for (const checkbox of wrapper.findAll('input[type="checkbox"]')) await checkbox.setValue(true);
    await wrapper.get('button.btn-primary').trigger('click');
    visible.value = false;
    await flushPromises();
    finishFirst({});
    await flushPromises();
    expect(api.createVolumeBackup).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    const reads = api.getVolumeBackups.mock.calls.length;
    visible.value = true;
    await flushPromises();
    expect(api.getVolumeBackups.mock.calls.length).toBeGreaterThan(reads);
  });

  it('换节点时丢弃旧项目响应，保留新节点的项目列表', async () => {
    let finishOld;
    api.getProjects.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    wrapper = mountPanel();
    await flushPromises();
    api.getProjects.mockResolvedValueOnce({ projects: [{ id: 'new-host', projectName: '新节点项目', managed: true }] });
    window.dispatchEvent(new CustomEvent('composeops:host-changed'));
    await flushPromises();
    finishOld({ projects: [{ id: 'old-host', projectName: '过期项目', managed: true }] });
    await flushPromises();
    const choices = wrapper.get('select[aria-label="选择要备份卷的项目"]').text();
    expect(choices).toContain('新节点项目');
    expect(choices).not.toContain('过期项目');
  });

  const backup = { id: 'b1', file: 'data.tar.gz', projectName: 'Alpha', volume: 'alpha-data', host: 'local', bytes: 1024, createdAt: '2026-11-08T14:00:00Z' };
  it('验证备份时不能同时恢复或删除，成功后重新开放操作', async () => {
    let finish;
    api.getVolumeBackups.mockResolvedValue({ backups: [backup] });
    api.verifyVolumeBackup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    wrapper = mountPanel();
    await flushPromises();
    await wrapper.get('button[aria-label="验证备份 data.tar.gz"]').trigger('click');
    expect(wrapper.get('button[aria-label="恢复卷 alpha-data 的备份"]').element.disabled).toBe(true);
    expect(wrapper.get('button[aria-label="删除备份 data.tar.gz"]').element.disabled).toBe(true);
    finish({ status: 'verified', files: 4, durationMs: 300 });
    await flushPromises();
    expect(wrapper.get('button[aria-label="删除备份 data.tar.gz"]').element.disabled).toBe(false);
    expect(wrapper.text()).toContain('备份演练通过');
    expect(wrapper.text()).not.toContain('Invalid Date');
  });

  it('删除等待时确认门保持忙碌，失败后可以在原确认门重试', async () => {
    let rejectDelete;
    api.getVolumeBackups.mockResolvedValue({ backups: [backup] });
    api.deleteVolumeBackup.mockImplementationOnce(() => new Promise((_, reject) => { rejectDelete = reject; }));
    wrapper = mountPanel();
    await flushPromises();
    await wrapper.get('button[aria-label="删除备份 data.tar.gz"]').trigger('click');
    const dialog = wrapper.findAllComponents({ name: 'ConfirmDialog' }).find(item => item.props('title') === '删除备份');
    dialog.vm.$emit('confirm');
    await flushPromises();
    expect(dialog.props('busy')).toBe(true);
    dialog.vm.$emit('confirm');
    expect(api.deleteVolumeBackup).toHaveBeenCalledTimes(1);
    rejectDelete(new Error('删除服务暂不可用'));
    await flushPromises();
    expect(dialog.props('show')).toBe(true);
    expect(dialog.props('busy')).toBe(false);
    dialog.vm.$emit('confirm');
    await flushPromises();
    expect(dialog.props('show')).toBe(false);
    expect(api.deleteVolumeBackup).toHaveBeenCalledTimes(2);
  });
});
