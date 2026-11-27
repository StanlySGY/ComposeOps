import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { KeepAlive, defineComponent, h, ref } from 'vue';
import StoragePruneModal from '../src/components/settings/StoragePruneModal.vue';

const api = vi.hoisted(() => ({ getStorageDf: vi.fn(), pruneStorage: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => toast }));

let wrapper;
beforeEach(() => {
  vi.clearAllMocks();
  api.getStorageDf.mockResolvedValue({
    hostId: 'node-a', hostName: '研发节点', hostRevision: 'revision-a',
    total: 1024 * 1024 * 1024, reclaimable: 1024 * 1024,
    images: { total: 512 * 1024 * 1024 }, volumes: { total: 256 * 1024 * 1024, orphans: 1, reclaimable: 1024 },
    containers: { total: 128 * 1024 * 1024 }, buildCache: { total: 128 * 1024 * 1024 },
    disk: { free: 5 * 1024 * 1024 * 1024, total: 10 * 1024 * 1024 * 1024 },
  });
  api.pruneStorage.mockResolvedValue({ ok: true, reclaimedMB: 5 });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });
function mountModal() {
  return mount(StoragePruneModal, { props: { open: true }, global: { stubs: {
    ConfirmDialog: { props: ['show', 'message'], emits: ['confirm', 'cancel'], template: '<div v-if="show" data-test="confirmation">{{message}}<button data-test="approve" @click="$emit(\'confirm\')">确认清理</button><button data-test="cancel" @click="$emit(\'cancel\')">取消</button></div>' },
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
    expect(api.pruneStorage).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test=confirmation]').text()).toContain('研发节点');
    expect(wrapper.get('[data-test=confirmation]').text()).toContain('包含未纳管项目');
    await wrapper.get('[data-test=approve]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('已释放');
    expect(api.pruneStorage).toHaveBeenCalledExactlyOnceWith('safe', 'PRUNE', 'node-a', 'revision-a');
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
    expect(api.pruneStorage).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test=confirmation]').text()).toContain('研发节点');
    expect(wrapper.get('[data-test=confirmation]').text()).toContain('包含未纳管项目');
    await wrapper.get('[data-test=approve]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('prune permission denied');
    expect(wrapper.find('[role="img"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('重新读取后再操作');
  });
});


describe('Docker 清理目标与缓存页生命周期', () => {
  it('节点变化撤销旧确认，迟到统计不会恢复旧节点按钮', async () => {
    let resolve;
    api.getStorageDf.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    wrapper = mountModal();
    window.dispatchEvent(new Event('composeops:host-changed'));
    resolve({ hostId: 'old', hostRevision: 'old', total: 100 });
    await flushPromises();
    expect(wrapper.find('button.btn-primary').exists()).toBe(false);
    expect(wrapper.text()).toContain('节点已变化');
    await wrapper.findAll('button').find(b => b.text() === '重新读取').trigger('click');
    await flushPromises();
    await wrapper.get('button.btn-primary').trigger('click');
    window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises();
    expect(wrapper.find('[data-test=confirmation]').exists()).toBe(false);
    expect(api.pruneStorage).not.toHaveBeenCalled();
  });

  it('缺少范围或成功标记都不能继续删除或显示成功', async () => {
    api.getStorageDf.mockResolvedValueOnce({ total: 100 });
    wrapper = mountModal(); await flushPromises();
    expect(wrapper.text()).toContain('节点范围信息不完整');
    expect(wrapper.find('button.btn-primary').exists()).toBe(false);
    await wrapper.findAll('button').find(b => b.text() === '重新读取').trigger('click'); await flushPromises();
    api.pruneStorage.mockResolvedValueOnce({ reclaimedMB: 5 });
    await wrapper.get('button.btn-primary').trigger('click');
    await wrapper.get('[data-test=approve]').trigger('click'); await flushPromises();
    expect(toast.success).not.toHaveBeenCalled(); expect(wrapper.text()).toContain('清理结果不完整');
  });

  it('双选深度清理仅发送卷和缓存模式，重复点击确认只请求一次', async () => {
    wrapper = mountModal(); await flushPromises();
    for (const box of wrapper.findAll('input[type=checkbox]')) await box.setValue(true);
    await wrapper.get('button.btn-danger').trigger('click');
    const approve = wrapper.get('[data-test=approve]');
    await approve.trigger('click'); await approve.trigger('click'); await flushPromises();
    expect(api.pruneStorage).toHaveBeenCalledExactlyOnceWith('all', 'PRUNE', 'node-a', 'revision-a');
  });

  it('KeepAlive首次只读取一次；失活清掉确认，恢复重新读取', async () => {
    const visible = ref(true);
    const Shell = defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(StoragePruneModal, { open: true }) : h('div', 'other') }) });
    wrapper = mount(Shell, { global: { stubs: { BaseModal: { props: ['show'], template: '<div v-if="show"><slot/><slot name="footer"/></div>' }, ConfirmDialog: true } } });
    await flushPromises(); expect(api.getStorageDf).toHaveBeenCalledTimes(1);
    await wrapper.get('button.btn-primary').trigger('click');
    expect(wrapper.findComponent({ name: 'ConfirmDialog' }).props('show')).toBe(true);
    visible.value = false; await flushPromises(); visible.value = true; await flushPromises();
    expect(api.getStorageDf).toHaveBeenCalledTimes(2);
    expect(wrapper.findComponent({ name: 'ConfirmDialog' }).props('show')).toBe(false);
    expect(api.pruneStorage).not.toHaveBeenCalled();
  });
});
