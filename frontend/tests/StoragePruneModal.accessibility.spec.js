import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import StoragePruneModal from '../src/components/settings/StoragePruneModal.vue';

const api = vi.hoisted(() => ({ getStorageDf: vi.fn(), pruneStorage: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => toast }));

let wrapper;
beforeEach(() => {
  vi.clearAllMocks();
  api.getStorageDf.mockResolvedValue({
    total: 1024 * 1024 * 1024, reclaimable: 1024 * 1024,
    images: { total: 512 * 1024 * 1024 }, volumes: { total: 256 * 1024 * 1024, orphans: 1, reclaimable: 1024 },
    containers: { total: 128 * 1024 * 1024 }, buildCache: { total: 128 * 1024 * 1024 },
    disk: { free: 5 * 1024 * 1024 * 1024, total: 10 * 1024 * 1024 * 1024 },
  });
  api.pruneStorage.mockResolvedValue({ reclaimedMB: 5 });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });
function mountModal() {
  return mount(StoragePruneModal, { props: { open: true }, global: { stubs: {
    BaseModal: { template: '<div><slot/><slot name="footer"/></div>', props: ['show', 'title', 'sizeClass', 'bodyClass'] },
  } } });
}

describe('Docker 存储清理状态的可访问性', () => {
  it('为磁盘分布图提供文本等价，并播报释放空间结果', async () => {
    wrapper = mountModal();
    await flushPromises();
    const chart = wrapper.get('[role="img"]');
    expect(chart.attributes('aria-label')).toContain('镜像');
    expect(chart.attributes('aria-label')).toContain('卷');
    await wrapper.get('button.btn-primary').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('已释放');
  });

  it('磁盘信息读取失败时播报错误，不会无限显示加载中', async () => {
    api.getStorageDf.mockRejectedValueOnce(new Error('Docker socket unavailable'));
    wrapper = mountModal();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Docker socket unavailable');
    expect(wrapper.text()).toContain('磁盘占用暂不可用');
    expect(wrapper.text()).not.toContain('正在读取磁盘占用');
  });

  it('清理操作失败通过 alert 播报，保留当前页面供恢复', async () => {
    api.pruneStorage.mockRejectedValueOnce(new Error('prune permission denied'));
    wrapper = mountModal();
    await flushPromises();
    await wrapper.get('button.btn-primary').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('prune permission denied');
    expect(wrapper.get('[role="img"]').exists()).toBe(true);
  });
});
