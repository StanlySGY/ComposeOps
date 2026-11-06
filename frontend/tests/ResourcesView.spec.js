import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, ref } from 'vue';

const { api } = vi.hoisted(() => ({ api: { getStorageResources: vi.fn(), removeStorageResource: vi.fn() } }));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));
import ResourcesView from '../src/views/ResourcesView.vue';

const inventory = (hostId = 'local') => ({ hostId, hostName: hostId, checkedAt: Date.now(), warnings: [], images: [
  { id: 'sha256:alpha', tags: ['alpha:old'], inUse: false, dangling: false, size: 200 },
  { id: 'sha256:beta', tags: ['beta:old'], inUse: false, dangling: false, size: 100 },
  { id: 'sha256:used', tags: ['used:latest'], inUse: true, containers: 1, size: 300 },
], volumes: [], networks: [{ id: 'network-id', name: 'network-name', driver: 'bridge', scope: 'local', unused: true }] });
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const confirmStub = { props: ['show', 'message'], emits: ['confirm', 'cancel'], template: '<div v-if="show" role="dialog"><p>{{ message }}</p><slot /><button @click="$emit(\'confirm\')">确认删除</button><button @click="$emit(\'cancel\')">取消</button></div>' };
let wrapper, router, shown;
const stubs = { VolumeBackupPanel: { template: '<div>备份面板</div>' }, BaseModal: true, ConfirmDialog: confirmStub };
const button = text => wrapper.findAll('button').find(b => b.text().includes(text));
async function start(keepAlive = false) {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/resources', component: {} }] });
  await router.push('/resources');
  await router.isReady();
  shown = ref(true);
  const component = keepAlive ? defineComponent({ components: { ResourcesView }, setup: () => ({ shown }), template: '<KeepAlive><ResourcesView v-if="shown" /></KeepAlive>' }) : ResourcesView;
  wrapper = mount(component, { attachTo: document.body, global: { plugins: [router], stubs } });
  await flushPromises();
}
beforeEach(() => { api.getStorageResources.mockReset().mockImplementation(async () => inventory()); api.removeStorageResource.mockReset().mockResolvedValue({ ok: true }); });
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

describe('resource cleanup workflow', () => {
  it('visible select-all preserves hidden selections, and confirmation names all targets', async () => {
    await start();
    await wrapper.get('[aria-label="选择资源 alpha:old"]').setValue(true);
    await wrapper.get('[aria-label="搜索存储资源"]').setValue('beta');
    expect(wrapper.get('[aria-label="全选可删除资源"]').element.checked).toBe(false);
    expect(wrapper.text()).toContain('含 1 项被筛选隐藏');
    await wrapper.get('[aria-label="全选可删除资源"]').setValue(true);
    expect(wrapper.text()).toContain('已选择 2 项');
    await wrapper.get('[aria-label="全选可删除资源"]').setValue(false);
    expect(wrapper.text()).toContain('已选择 1 项');
    await button('批量删除').trigger('click');
    expect(wrapper.get('[aria-label="待删除资源"]').text()).toContain('alpha:old');
    expect(wrapper.get('[aria-label="待删除资源"]').text()).not.toContain('beta:old');
    await button('取消').trigger('click');
    expect(api.removeStorageResource).not.toHaveBeenCalled();
  });
  it('keeps single deletion errors after refreshing and enables a deliberate retry', async () => {
    api.removeStorageResource.mockRejectedValue(new Error('资源刚被挂载'));
    await start();
    await wrapper.get('[aria-label="删除资源 alpha:old"]').trigger('click');
    await button('确认删除').trigger('click');
    await flushPromises();
    expect(api.removeStorageResource).toHaveBeenCalledWith('image', 'sha256:alpha', 'local');
    expect(wrapper.text()).toContain('alpha:old：资源刚被挂载');
    expect(wrapper.text()).toContain('已选择 1 项');
    expect(wrapper.get('[role="status"]').text()).toContain('已删除 0 项');
  });
  it('keeps success feedback after the resource disappears from the refreshed inventory', async () => {
    await start();
    const result = inventory(); result.images = result.images.slice(1);
    api.getStorageResources.mockResolvedValue(result);
    await wrapper.get('[aria-label="删除资源 alpha:old"]').trigger('click');
    await button('确认删除').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('已删除 1 项资源');
    expect(wrapper.text()).not.toContain('alpha:old');
  });
  it('deletes networks by immutable ID rather than display name', async () => {
    await start();
    await wrapper.get('#resources-tab-networks').trigger('click');
    await flushPromises();
    await wrapper.get('[aria-label="删除资源 network-name"]').trigger('click');
    await button('确认删除').trigger('click');
    await flushPromises();
    expect(api.removeStorageResource).toHaveBeenCalledWith('network', 'network-id', 'local');
  });
  it('ignores an old inventory response after switching hosts', async () => {
    const old = deferred(); api.getStorageResources.mockReturnValueOnce(old.promise);
    await start();
    const next = inventory('remote'); next.images = [];
    api.getStorageResources.mockResolvedValue(next);
    window.dispatchEvent(new Event('composeops:host-changed'));
    await flushPromises();
    old.resolve(inventory()); await flushPromises();
    expect(wrapper.text()).toContain('remote');
    expect(wrapper.text()).not.toContain('alpha:old');
  });
  it('locks controls, snapshots the batch, and stops remaining deletions on host change', async () => {
    const first = deferred(); api.removeStorageResource.mockReturnValueOnce(first.promise);
    await start();
    await wrapper.get('[aria-label="全选可删除资源"]').setValue(true);
    await button('批量删除').trigger('click');
    await button('确认删除').trigger('click');
    expect(wrapper.get('#resources-tab-networks').element.disabled).toBe(true);
    expect(wrapper.get('[aria-label="搜索存储资源"]').element.disabled).toBe(true);
    api.getStorageResources.mockResolvedValue(inventory('remote'));
    window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises();
    first.resolve({ ok: true }); await flushPromises();
    expect(api.removeStorageResource).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('节点已切换');
    expect(wrapper.text()).not.toContain('已删除 1 项');
  });
  it('invalidates an open confirmation when the host changes', async () => {
    await start();
    await wrapper.get('[aria-label="删除资源 alpha:old"]').trigger('click');
    window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(api.removeStorageResource).not.toHaveBeenCalled();
  });
  it('supports keyboard tabs, browser back, and hides resource filters for backups', async () => {
    await start();
    await wrapper.get('#resources-tab-images').trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(router.currentRoute.value.query.tab).toBe('backups');
    expect(wrapper.get('#resources-tab-backups').attributes('aria-selected')).toBe('true');
    expect(wrapper.find('[aria-label="搜索存储资源"]').exists()).toBe(false);
    router.back(); await flushPromises();
    expect(wrapper.get('#resources-tab-images').attributes('aria-selected')).toBe('true');
  });
  it('does not fetch while deactivated and reloads the new host on activation', async () => {
    await start(true);
    expect(api.getStorageResources).toHaveBeenCalledTimes(1);
    shown.value = false; await flushPromises();
    window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises();
    expect(api.getStorageResources).toHaveBeenCalledTimes(1);
    api.getStorageResources.mockResolvedValue(inventory('remote'));
    shown.value = true; await flushPromises();
    expect(api.getStorageResources).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('remote');
  });
  it('a refreshed inventory from another host clears same-ID selections and an open confirmation', async () => {
    await start();
    await wrapper.get('[aria-label="选择资源 alpha:old"]').setValue(true);
    await button('批量删除').trigger('click');
    api.getStorageResources.mockResolvedValue(inventory('remote'));
    await button('刷新清单').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.get('[aria-label="选择资源 alpha:old"]').element.checked).toBe(false);
    expect(wrapper.text()).toContain('已清空原节点的选择和确认');
    expect(api.removeStorageResource).not.toHaveBeenCalled();
  });
  it.each(['remote', 'local'])('a server host conflict stops the queue and clears selection even when refresh returns %s', async nextHost => {
    api.removeStorageResource.mockRejectedValueOnce(Object.assign(new Error('节点已切换'), { code: 'resource_host_changed' }));
    await start();
    await wrapper.get('[aria-label="全选可删除资源"]').setValue(true);
    await button('批量删除').trigger('click');
    api.getStorageResources.mockResolvedValue(inventory(nextHost));
    await button('确认删除').trigger('click'); await flushPromises();
    expect(api.removeStorageResource).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('剩余删除已停止，请重新选择');
    expect(wrapper.get('[aria-label="选择资源 alpha:old"]').element.checked).toBe(false);
    expect(wrapper.get('[aria-label="选择资源 beta:old"]').element.checked).toBe(false);
    expect(wrapper.find('.resource-selection').exists()).toBe(false);
  });

});
