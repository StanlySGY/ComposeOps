import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { nextTick } from 'vue';

const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['getMetrics', 'getDockerUsage', 'getCapabilities', 'getPreferences', 'getHosts', 'getProjects', 'setActiveHost'].map(name => [name, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api, bumpHostEpoch: vi.fn() }));
import MonitorView from '../src/views/MonitorView.vue';

const metrics = (cpu = 23) => ({ host: { cpu: { percent: cpu, cores: 4 }, memory: { percent: 40, used: 100, total: 250 }, uptime: 60 }, network: { rx: 0, tx: 0 }, containers: [] });
const usage = { images: { total: 0, reclaimable: 0 }, buildCache: { total: 0, reclaimable: 0 }, reclaimable: 0 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('实时监控刷新与生命周期', () => {
  let wrapper;
  let router;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.getProjects.mockResolvedValue({ projects: [] });
    api.getHosts.mockResolvedValue({ hosts: [{ id: 'local', name: '本机', active: true }, { id: 'remote', name: '远端' }] });
    api.getMetrics.mockResolvedValue(metrics());
    api.getDockerUsage.mockResolvedValue(usage);
    api.getCapabilities.mockResolvedValue({ hostMetricsScope: 'host' });
    api.getPreferences.mockResolvedValue({ refreshInterval: 5 });
  });
  afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); });
  async function start(path = '/monitor') {
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/monitor', component: MonitorView }] });
    await router.push(path);
    wrapper = mount(MonitorView, { global: { plugins: [router, createPinia()], stubs: { ResourceMonitorView: true } } });
    await flushPromises();
  }

  it('Docker 存储失败不阻断已成功的 CPU/内存指标', async () => {
    api.getDockerUsage.mockRejectedValue(new Error('磁盘统计不可用'));
    await start();
    expect(wrapper.text()).toContain('23%');
    expect(wrapper.text()).toContain('磁盘统计不可用');
  });

  it('慢指标请求期间先显示容器名称和镜像，不伪报 CPU 为零', async () => {
    const pending = deferred();
    api.getMetrics.mockReturnValueOnce(pending.promise);
    api.getProjects.mockResolvedValue({ projects: [{ id: 'p1', hostId: 'local', containers: [{ id: 'c1', name: 'web-first-paint', image: 'nginx:stable' }] }] });
    await start();
    expect(wrapper.text()).toContain('web-first-paint');
    expect(wrapper.text()).toContain('nginx:stable');
    expect(wrapper.text()).toContain('等待指标');
    pending.resolve(metrics()); await flushPromises();
  });

  it('存储请求未完成也立即渲染已到达的指标', async () => {
    const pending = deferred(); api.getDockerUsage.mockReturnValueOnce(pending.promise);
    await start();
    expect(wrapper.text()).toContain('23%');
    pending.resolve(usage); await flushPromises();
  });

  it('能力或偏好加载失败仍可查看实时数据', async () => {
    api.getPreferences.mockRejectedValue(new Error('偏好不可用'));
    await start();
    expect(api.getMetrics).toHaveBeenCalled();
    expect(wrapper.text()).toContain('23%');
  });

  it('首次请求尚未返回时显示加载状态而不是 0 个容器', async () => {
    const pending = deferred();
    api.getMetrics.mockReturnValueOnce(pending.promise);
    await start();

    expect(wrapper.text()).toContain('正在加载容器…');
    expect(wrapper.text()).not.toContain('0 个容器');

    pending.resolve(metrics());
    await flushPromises();
    expect(wrapper.text()).toContain('0 个容器');
  });

  it('加载中离开页面不会在响应返回后重新启动轮询', async () => {
    const pending = deferred();
    api.getMetrics.mockReturnValueOnce(pending.promise);
    await start();
    wrapper.unmount(); wrapper = null;
    pending.resolve(metrics());
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15000);
    expect(api.getMetrics).toHaveBeenCalledTimes(1);
  });

  it('关闭自动刷新后往返历史页仍保持暂停', async () => {
    await start();
    await wrapper.get('input[type=checkbox]').setValue(false);
    await router.push('/monitor?tab=history');
    await flushPromises();
    await router.push('/monitor');
    await flushPromises();
    const calls = api.getMetrics.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(api.getMetrics).toHaveBeenCalledTimes(calls);
  });

  it('切换节点会立即发新请求并忽略旧节点迟到的响应', async () => {
    const pending = deferred();
    api.getMetrics.mockReturnValueOnce(pending.promise);
    await start();
    api.getMetrics.mockResolvedValue(metrics(72));
    window.dispatchEvent(new CustomEvent('composeops:host-changed'));
    await flushPromises();
    expect(wrapper.text()).toContain('72%');
    pending.resolve(metrics(13));
    await flushPromises();
    expect(wrapper.text()).toContain('72%');
    expect(wrapper.text()).not.toContain('13%');
  });

  it('加载过程中进入历史页不启动后台轮询', async () => {
    const pending = deferred();
    api.getMetrics.mockReturnValueOnce(pending.promise);
    await start();
    await router.push('/monitor?tab=history');
    await nextTick();
    pending.resolve(metrics());
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15000);
    expect(api.getMetrics).toHaveBeenCalledTimes(1);
  });
  it('节点筛选保存在 URL，指标与存储使用同一范围且清除旧容器过滤', async () => {
    await start('/monitor?containerId=old&from=node-groups');
    await wrapper.get('select[aria-label="监控节点"]').setValue('remote'); await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ hostId: 'remote', from: 'node-groups' });
    expect(api.getMetrics).toHaveBeenLastCalledWith('remote');
    expect(api.getDockerUsage).toHaveBeenLastCalledWith('remote');
    expect(wrapper.text()).toContain('固定来自面板所在环境');
    expect(api.setActiveHost).not.toHaveBeenCalled();
  });

  it('全部节点存储的缺失范围明确提示，容器缺失时可清除过滤', async () => {
    api.getDockerUsage.mockResolvedValue({ ...usage, unavailableHosts: ['remote'] });
    api.getMetrics.mockResolvedValue({ ...metrics(), containers: [{ id: 'one', hostId: 'local', name: 'api', memUsage: 1024, memPercent: 1, cpuPercent: 2 }] });
    await start('/monitor?hostId=all&containerId=gone');
    expect(wrapper.text()).toContain('部分统计：远端');
    expect(wrapper.text()).toContain('没有匹配的容器');
    await wrapper.findAll('button').find(b => b.text().includes('查看全部容器')).trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('api');
    expect(wrapper.text()).not.toContain('undefined%');
    expect(router.currentRoute.value.query.hostId).toBe('all');
  });

  it('远端历史显式切换节点后才挂载，全部节点不会读当前节点历史', async () => {
    await start('/monitor?hostId=remote&tab=history&containerId=c1');
    expect(wrapper.find('resource-monitor-view-stub').exists()).toBe(false);
    api.setActiveHost.mockResolvedValue({ activeHostId: 'remote' });
    await wrapper.findAll('button').find(b => b.text().includes('切换工作节点并查看历史')).trigger('click'); await flushPromises();
    expect(api.setActiveHost).toHaveBeenCalledWith('remote');
    expect(wrapper.get('resource-monitor-view-stub').attributes('initialcontainerid') || wrapper.get('resource-monitor-view-stub').attributes('initial-container-id')).toBe('c1');
    await router.replace('/monitor?hostId=all&tab=history'); await flushPromises();
    expect(wrapper.find('resource-monitor-view-stub').exists()).toBe(false);
    expect(wrapper.text()).toContain('选择一个节点查看历史');
  });

  it('切换筛选后旧存储响应不会进入新节点', async () => {
    const old = deferred(); api.getDockerUsage.mockReturnValueOnce(old.promise);
    await start();
    api.getDockerUsage.mockResolvedValue({ ...usage, images: { total: 2048, reclaimable: 0 } });
    await router.replace('/monitor?hostId=remote'); await flushPromises();
    old.resolve({ ...usage, images: { total: 8192, reclaimable: 0 } }); await flushPromises();
    expect(wrapper.text()).toContain('2.0 KB');
    expect(wrapper.text()).not.toContain('8.0 KB');
  });

});
