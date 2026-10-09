import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

const { api, state } = vi.hoisted(() => ({
  api: Object.fromEntries(['getMetrics', 'getInspectionOverview', 'getOperations', 'getAgentExecutions', 'getAlertEvents', 'getCronHistory'].map(name => [name, vi.fn()])),
  state: { store: null },
}));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/services.js', () => ({ useServicesStore: () => state.store }));
import DashboardView from '../src/views/DashboardView.vue';
const metrics = (cpu = 23) => ({ host: { cpu: { percent: cpu }, memory: { percent: 40 } }, network: { rx: 0 } });

describe('总览数据与跳转', () => {
  let wrapper;
  beforeEach(() => {
    vi.clearAllMocks();
    state.store = reactive({ projects: [{ id: 'one', status: 'running', containers: [] }], error: '', refresh: vi.fn().mockResolvedValue() });
    api.getMetrics.mockResolvedValue(metrics());
    api.getInspectionOverview.mockResolvedValue({ latest: { score: 95 } });
    for (const name of ['getOperations', 'getAgentExecutions', 'getAlertEvents', 'getCronHistory']) api[name].mockResolvedValue({});
  });
  afterEach(() => wrapper?.unmount());
  async function start() {
    wrapper = mount(DashboardView, { global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } } });
    await flushPromises();
  }
  it('指标请求失败时不显示虚假的正常状态', async () => {
    api.getMetrics.mockRejectedValue(new Error('指标暂不可用'));
    await start();
    expect(wrapper.text()).toContain('指标暂不可用');
    expect(wrapper.text()).toContain('暂无指标');
    expect(wrapper.text()).not.toContain('运行正常');
    expect(wrapper.text()).not.toContain('资源充足');
  });
  it('切换节点后刷新指标并忽略旧节点的迟到响应', async () => {
    let resolve;
    api.getMetrics.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await start();
    api.getMetrics.mockResolvedValue(metrics(72));
    window.dispatchEvent(new CustomEvent('composeops:host-changed'));
    await flushPromises();
    expect(wrapper.text()).toContain('72%');
    resolve(metrics(13));
    await flushPromises();
    expect(wrapper.text()).toContain('72%');
    expect(wrapper.text()).not.toContain('13%');
  });
  it('无 Compose 项目时保留环境指标和可操作的空状态', async () => {
    state.store.projects = [];
    await start();
    expect(wrapper.text()).toContain('23%');
    expect(wrapper.get('a[href="/marketplace"]').text()).toContain('浏览应用市场');
  });
  it('刷新使用最新项目数据且指标可以直达详情页', async () => {
    await start();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(state.store.refresh).toHaveBeenLastCalledWith(true);
    expect(wrapper.findAll('a[href="/monitor"]')).toHaveLength(2);
    expect(wrapper.get('a[href="/inspection"]').text()).toContain('95');
  });
  it('常用运维入口直达服务、Compose、日志和 AI 助手', async () => {
    await start();
    const quickActions = wrapper.get('nav[aria-label="常用运维入口"]');
    expect(quickActions.get('a[href="/services"]').text()).toContain('管理服务');
    expect(quickActions.get('a[href="/compose"]').text()).toContain('编辑配置');
    expect(quickActions.get('a[href="/logs"]').text()).toContain('查看日志');
    expect(quickActions.get('a[href="/agent"]').text()).toContain('AI 助手');
  });
});
