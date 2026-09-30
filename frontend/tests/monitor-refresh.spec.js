import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { nextTick } from 'vue';

const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['getMetrics', 'getDockerUsage', 'getCapabilities', 'getPreferences'].map(name => [name, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api }));
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
    api.getMetrics.mockResolvedValue(metrics());
    api.getDockerUsage.mockResolvedValue(usage);
    api.getCapabilities.mockResolvedValue({ hostMetricsScope: 'host' });
    api.getPreferences.mockResolvedValue({ refreshInterval: 5 });
  });
  afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); });
  async function start(path = '/monitor') {
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/monitor', component: MonitorView }] });
    await router.push(path);
    wrapper = mount(MonitorView, { global: { plugins: [router], stubs: { ResourceMonitorView: true } } });
    await flushPromises();
  }

  it('Docker 存储失败不阻断已成功的 CPU/内存指标', async () => {
    api.getDockerUsage.mockRejectedValue(new Error('磁盘统计不可用'));
    await start();
    expect(wrapper.text()).toContain('23%');
    expect(wrapper.text()).toContain('磁盘统计不可用');
  });

  it('能力或偏好加载失败仍可查看实时数据', async () => {
    api.getPreferences.mockRejectedValue(new Error('偏好不可用'));
    await start();
    expect(api.getMetrics).toHaveBeenCalled();
    expect(wrapper.text()).toContain('23%');
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
});
