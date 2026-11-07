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
    expect(quickActions.get('a[href="/services?from=dashboard"]').text()).toContain('管理服务');
    expect(quickActions.get('a[href="/compose?from=dashboard"]').text()).toContain('编辑配置');
    expect(quickActions.get('a[href="/logs?from=dashboard"]').text()).toContain('查看日志');
    expect(quickActions.get('a[href="/agent?from=dashboard"]').text()).toContain('AI 助手');
  });
  it('摘要区正确区分部分运行，未纳管项目引导到管理页面', async () => {
    state.store.projects = [{ id: 'partial', projectName: '示例', status: 'partial', managed: false, containers: [{ id: 'one', state: 'exited' }] }];
    await start();
    expect(wrapper.get('.overview-attention').text()).toContain('部分运行');
    expect(wrapper.get('.overview-attention').text()).toContain('1 个未运行');
    expect(wrapper.find('[aria-label="查看 示例 异常日志"]').exists()).toBe(false);
    expect(wrapper.get('[aria-label="打开 示例"]').exists()).toBe(true);
  });
  it('数据不完整时不显示全部正常的成功状态', async () => {
    api.getOperations.mockRejectedValue(new Error('操作记录不可用'));
    await start();
    expect(wrapper.text()).toContain('状态待确认');
    expect(wrapper.text()).not.toContain('当前项目状态正常');
  });
});
