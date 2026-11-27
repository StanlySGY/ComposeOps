import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
const { getProjects, getStandaloneContainers } = vi.hoisted(() => ({ getProjects: vi.fn(), getStandaloneContainers: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api: { getProjects, getStandaloneContainers } }));
import { useServicesStore } from '../src/stores/services.js';
import StandaloneContainersPanel from '../src/components/services/StandaloneContainersPanel.vue';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('项目列表刷新顺序', () => {
  beforeEach(() => { setActivePinia(createPinia()); getProjects.mockReset(); getStandaloneContainers.mockReset(); });
  it('较早的慢请求不会覆盖最新的强制刷新', async () => {
    const store = useServicesStore();
    const slow = deferred();
    getProjects.mockReturnValueOnce(slow.promise);
    const first = store.refresh();
    getProjects.mockResolvedValueOnce({ projects: [{ id: 'new' }] });
    await store.refresh(true);
    slow.resolve({ projects: [{ id: 'old' }] });
    await first;
    expect(store.projects).toEqual([{ id: 'new' }]);
  });
  it('新快照为空时移除已经删除的项目', () => {
    const store = useServicesStore();
    store.projects = [{ id: 'deleted' }];
    store.handleContainerEvent({ type: 'snapshot', projects: [] });
    expect(store.projects).toEqual([]);
  });
  it('WebSocket新快照到达后，先前HTTP刷新不能覆盖它或留下旧错误', async () => {
    const store = useServicesStore(), old = deferred();
    getProjects.mockReturnValueOnce(old.promise);
    const pending = store.refresh();
    store.error = '旧故障';
    store.handleContainerEvent({ type: 'snapshot', projects: [{ id: 'new-snapshot' }] });
    old.resolve({ projects: [{ id: 'old-http' }] }); await pending;
    expect(store.projects).toEqual([{ id: 'new-snapshot' }]);
    expect(store.loading).toBe(false); expect(store.error).toBe('');
  });
  it('切节点立即清空旧项目,旧请求不能填回列表', async () => {
    const store = useServicesStore();
    store.projects = [{ id: 'previous-host' }];
    const old = deferred();
    const current = deferred();
    getProjects.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = store.refresh();
    const switched = store.refreshForHost();
    expect(store.projects).toEqual([]);
    expect(store.lastLoadedAt).toBe(0);
    old.resolve({ projects: [{ id: 'old-host-late' }] });
    await first;
    expect(store.projects).toEqual([]);
    expect(store.loading).toBe(true);
    current.resolve({ projects: [{ id: 'current-host' }] });
    await switched;
    expect(store.projects).toEqual([{ id: 'current-host' }]);
    expect(store.loading).toBe(false);
  });
  it('独立容器首次遇到短暂网络故障时仅重试一次并恢复列表', async () => {
    vi.useFakeTimers();
    getStandaloneContainers.mockRejectedValueOnce(new Error('无法连接服务，请检查网络连接后重试。')).mockResolvedValueOnce({
      hostId: 'local', hostName: 'Local Daemon', containers: [{ id: 'container-1', name: 'maskit', image: 'example/maskit', ports: [], state: 'exited', statusText: 'Exited' }],
    });
    const wrapper = mount(StandaloneContainersPanel, { global: { stubs: ['ConfirmDialog', 'StatusBadge'] } });
    await flushPromises();
    expect(getStandaloneContainers).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(getStandaloneContainers).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.standalone-row').exists()).toBe(true);
    expect(wrapper.find('.alert-error').exists()).toBe(false);
    wrapper.unmount();
    vi.useRealTimers();
  });
  it('独立容器切节点时丢弃旧请求，不能重新显示旧节点容器', async () => {
    const slow = deferred();
    getStandaloneContainers.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ hostId: 'remote', hostName: 'Remote', containers: [] });
    const wrapper = mount(StandaloneContainersPanel, { props: { hostId: 'local' }, global: { stubs: ['ConfirmDialog', 'StatusBadge'] } });
    await wrapper.setProps({ hostId: 'remote' }); await flushPromises();
    slow.resolve({ hostId: 'local', hostName: 'Old', containers: [{ id: 'old', name: '旧节点容器', image: 'old', ports: [] }] });
    await flushPromises();
    expect(getStandaloneContainers).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).not.toContain('旧节点容器');
    expect(wrapper.text()).toContain('Remote');
    wrapper.unmount();
  });
});
