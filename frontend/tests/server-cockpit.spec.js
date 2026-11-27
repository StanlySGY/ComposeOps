import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive, defineComponent, ref, nextTick } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
const { api, state } = vi.hoisted(() => ({ api: { getInfrastructure: vi.fn(), getInfrastructureHistory: vi.fn(), getInfrastructureStorage: vi.fn() }, state: { hosts: null } }));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/hosts.js', () => ({ useHostsStore: () => state.hosts }));
import ServerCockpit from '../src/components/dashboard/ServerCockpit.vue';
import { cockpitReturn, rankProjects, serviceFocusLocation, trendSegments } from '../src/lib/infrastructure.js';

const sample = (hostId = 'local', percent = 34) => ({ nodes: [{ hostId, name: hostId, status: 'ready', sampledAt: Date.now(), host: { status: 'ready', sampledAt: Date.now(), scope: 'linux', cpu: { percent, cores: 4 }, memory: { percent: 40, used: 400, total: 1000 }, network: { rx: 10, tx: 20, interfaces: [] }, disks: [] }, alerts: [], containers: [{ id: 'c', state: 'running', memUsage: 100 }], services: [{ key: 'service:p:db', hostId, projectId: 'p', projectName: 'app', name: 'db', service: 'db', cpuHostPercent: 20, cpuPercent: 80, memUsage: 100, total: 1, running: 1, containers: [{ hostId, id: 'c', projectId: 'p', service: 'db', name: 'db-1', state: 'running' }] }] }] });
describe('服务器驾驶舱', () => {
  let wrapper, router;
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    state.hosts = reactive({ activeHostId: 'local', hosts: [{ id: 'local', name: '本机' }, { id: 'remote', name: '远端' }] });
    api.getInfrastructure.mockImplementation(id => Promise.resolve(sample(id)));
    api.getInfrastructureHistory.mockResolvedValue({ points: [], start: Date.now() - 3600000, end: Date.now(), interval: 10000 });
    api.getInfrastructureStorage.mockResolvedValue({ hostId: 'local', disks: [] });
  });
  afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); });
  async function start(component = ServerCockpit) {
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/dashboard', component }, { path: '/services', component: { template: '<div>服务</div>' } }, { path: '/settings', component: { template: '<div />' } }] });
    await router.push('/dashboard'); await router.isReady();
    wrapper = mount(component, { global: { plugins: [router] } }); await flushPromises();
  }
  it('服务深链携带节点、服务与来源视图，展开后可定位容器', async () => {
    await start(); await wrapper.get('.cockpit-project-summary').trigger('click');
    const link = wrapper.get('.cockpit-service-name');
    const target = new URL(link.attributes('href'), 'http://localhost');
    expect(target.pathname).toBe('/services'); expect(target.searchParams.get('focus')).toBe('p'); expect(target.searchParams.get('service')).toBe('db'); expect(target.searchParams.get('hostId')).toBe('local'); expect(target.searchParams.get('returnTo')).toBe('/dashboard');
    expect(wrapper.text()).toContain('34.0%');
  });
  it('节点切换后忽略迟到响应且不显示旧节点数值', async () => {
    let resolve; api.getInfrastructure.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await start(); await router.replace('/dashboard?hostId=remote'); await flushPromises();
    expect(wrapper.text()).toContain('remote'); resolve(sample('local', 99)); await flushPromises();
    expect(wrapper.text()).not.toContain('99.0%'); expect(wrapper.text()).toContain('34.0%');
  });
  it('未接入、空采样与请求失败不能变成正常零指标', async () => {
    api.getInfrastructure.mockResolvedValue({ nodes: [{ hostId: 'local', status: 'ready', host: { status: 'unavailable', reason: '仅 Docker API' }, containers: [], services: [], alerts: [] }] });
    await start(); expect(wrapper.text()).toContain('仅 Docker API'); expect(wrapper.text()).not.toContain('0.0%');
    api.getInfrastructure.mockRejectedValue(new Error('断线')); await vi.advanceTimersByTimeAsync(5000); await flushPromises(); expect(wrapper.text()).toContain('断线'); expect(wrapper.text()).not.toContain('宿主采集正常');
  });
  it('缓存页面失活暂停轮询，激活恢复且不会重复注册', async () => {
    const visible = ref(true);
    const Host = defineComponent({ components: { ServerCockpit }, setup: () => ({ visible }), template: '<KeepAlive><ServerCockpit v-if="visible" /></KeepAlive>' });
    await start(Host); expect(api.getInfrastructure).toHaveBeenCalledTimes(1);
    visible.value = false; await nextTick(); await vi.advanceTimersByTimeAsync(20000); expect(api.getInfrastructure).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange')); await flushPromises(); expect(api.getInfrastructure).toHaveBeenCalledTimes(1);
    visible.value = true; await nextTick(); await flushPromises(); expect(api.getInfrastructure).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000); expect(api.getInfrastructure).toHaveBeenCalledTimes(3);
    wrapper.unmount(); wrapper = null; const count = api.getInfrastructure.mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(api.getInfrastructure).toHaveBeenCalledTimes(count);
  });
  it('历史筛选写入 URL，返回上下文只接受驾驶舱白名单参数', async () => {
    await start(); await wrapper.get('[aria-label="趋势时间范围"]').setValue('24'); await flushPromises();
    expect(router.currentRoute.value.query.hours).toBe('24'); expect(api.getInfrastructureHistory.mock.calls.at(-1)[0].hours).toBe('24');
    expect(cockpitReturn('//evil.example')).toBe('/dashboard');
    expect(cockpitReturn('/dashboard?hostId=remote&hours=24&token=secret')).toBe('/dashboard?hostId=remote&hours=24');
  });
  it('全屏切换时间不会退出，Esc 关闭；非法时间与指标回退到默认值', async () => {
    await start(); await wrapper.get('[aria-pressed="false"].btn-secondary').trigger('click');
    expect(wrapper.classes()).toContain('cockpit-fullscreen');
    await wrapper.get('[aria-label="趋势时间范围"]').setValue('24'); await flushPromises();
    expect(wrapper.classes()).toContain('cockpit-fullscreen');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await nextTick();
    expect(wrapper.classes()).not.toContain('cockpit-fullscreen');
    await router.replace('/dashboard?metric=invalid&hours=-1'); await flushPromises();
    expect(api.getInfrastructureHistory.mock.calls.at(-1)[0]).toMatchObject({ hours: '1', metric: 'cpu' });
  });
  it('磁盘告警定位对应文件系统并保持磁盘卡片选中', async () => {
    const data = sample();
    data.nodes[0].host.disks = [{ device: 'a', type: 'ext4', mountpoint: '/', percent: 99 }, { device: 'b', type: 'ext4', mountpoint: '/data', percent: 90 }];
    data.nodes[0].alerts = [{ key: 'disk:b', disk: 'b', title: '/data 空间不足' }];
    api.getInfrastructure.mockResolvedValue(data);
    api.getInfrastructureStorage.mockResolvedValue({ hostId: 'local', disks: data.nodes[0].host.disks });
    await start(); await wrapper.get('.cockpit-alerts button').trigger('click'); await flushPromises();
    expect(router.currentRoute.value.query.resource).toBe('disk:b:ext4');
    expect(wrapper.findAll('.cockpit-metric')[2].attributes('aria-pressed')).toBe('true');
  });
});

it('资源排行不把不同限额百分比相加，缺测图表断开，深链不需要容器才能定位服务', () => {
  const groups = rankProjects([{ projectId: 'p', projectName: 'app', name: 'db', memUsage: 10 }, { projectId: 'p', projectName: 'app', name: 'web', memUsage: 20 }], 'memory');
  expect(groups[0].value).toBe(30);
  const chart = trendSegments([{ timestamp: 1000, value: 10 }, { timestamp: 2000, value: 20 }, { timestamp: 20000, value: 30 }], 1000, 0, 21000);
  expect(chart.segments).toHaveLength(2);
  expect(serviceFocusLocation({ hostId: 'remote', projectId: 'p', service: 'db' }, '/dashboard?hours=24').query).toMatchObject({ hostId: 'remote', focus: 'p', service: 'db', returnTo: '/dashboard?hours=24' });
});
