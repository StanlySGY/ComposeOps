import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api, metricsApi } = vi.hoisted(() => ({
  api: { getProjects: vi.fn() },
  metricsApi: {
    getAlerts: vi.fn(),
    getContainerMetrics: vi.fn(),
    getHistoricalMetrics: vi.fn(),
    detectAnomalies: vi.fn(),
    createAlert: vi.fn(),
    deleteAlert: vi.fn(),
  },
}));

vi.mock('../src/api/client.js', () => ({ api, metricsApi }));

import ResourceMonitorView from '../src/views/ResourceMonitorView.vue';

let wrapper;
let router;
const offsetParentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');

beforeEach(async () => {
  vi.resetAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body });
  api.getProjects.mockResolvedValue({ projects: [{ id: 'p1', projectName: 'web-stack', managed: true, containers: [{ id: 'c1', name: 'api', state: 'running' }] }] });
  metricsApi.getAlerts.mockResolvedValue({ alerts: [] });
  metricsApi.getContainerMetrics.mockResolvedValue({ data: { current: 25, unit: '%' } });
  metricsApi.getHistoricalMetrics.mockResolvedValue({ metrics: [] });
  metricsApi.detectAnomalies.mockResolvedValue({ anomalies: [] });
  metricsApi.createAlert.mockResolvedValue({ ok: true });
  metricsApi.deleteAlert.mockResolvedValue({ ok: true });
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<main>测试路由</main>' } }],
  });
  await router.push('/');
  await router.isReady();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDescriptor);
});

async function mountView(props = {}) {
  wrapper = mount(ResourceMonitorView, {
    props: { initialProjectId: 'p1', initialContainerId: 'c1', ...props },
    attachTo: document.body,
    global: {
      plugins: [router],
      stubs: { StatusBadge: true, InteractiveChart: true },
    },
  });
  await flushPromises();
  return wrapper;
}

it('显示聚合依据与采样不足，失败后不遗留上次统计说明', async () => {
  metricsApi.getHistoricalMetrics.mockResolvedValue({ metrics: [{ timestamp: 1000, value: 20 }], sampling: { sourceSamples: 5000, aggregationSeconds: 60, adjusted: true, approximate: true } });
  metricsApi.detectAnomalies.mockResolvedValue({ anomalies: [], analysis: { sufficientSamples: false, basis: 'bucket-means' } });
  await mountView();
  expect(wrapper.get('[data-testid="history-sampling"]').text()).toContain('5000 个原始样本 · 按 60 秒聚合');
  expect(wrapper.get('[data-testid="history-sampling"]').text()).toContain('近似统计');
  expect(wrapper.get('[data-testid="history-analysis"]').text()).toContain('不足 10 个');
  expect(wrapper.get('[data-testid="history-analysis"]').text()).toContain('不代表业务健康');
  metricsApi.getHistoricalMetrics.mockRejectedValue(new Error('暂不可用'));
  metricsApi.detectAnomalies.mockRejectedValue(new Error('暂不可用'));
  await wrapper.get('[aria-label="选择内存指标"]').trigger('click'); await flushPromises();
  expect(wrapper.find('[data-testid="history-sampling"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="history-analysis"]').exists()).toBe(false);
});

describe('资源监控告警配置弹窗的键盘可访问性', () => {
  it('提供命名模态框语义及正确关联的表单标签，并在打开时聚焦弹窗内', async () => {
    await mountView();
    const trigger = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '配置告警');
    trigger.focus();
    trigger.click();
    await flushPromises();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('配置告警规则');
    expect(document.querySelector('label[for="resource-alert-metric"]')).not.toBeNull();
    expect(document.querySelector('label[for="resource-alert-threshold"]')).not.toBeNull();
    expect(document.querySelector('label[for="resource-alert-action"]')).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('循环 Tab 焦点，Escape 关闭并恢复触发按钮焦点与滚动', async () => {
    await mountView();
    const trigger = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '配置告警');
    trigger.focus();
    trigger.click();
    await flushPromises();

    const dialog = document.querySelector('[role="dialog"]');
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )];
    expect(focusable.length).toBeGreaterThan(2);

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    first.focus();
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe('');
  });

  it('所选容器没有告警时显示空状态，不受其他容器的规则影响', async () => {
    api.getProjects.mockResolvedValue({
      projects: [{
        id: 'p1',
        projectName: 'web-stack',
        managed: true,
        containers: [
          { id: 'c1', name: 'api', state: 'running', health: 'healthy' },
          { id: 'c2', name: 'worker', state: 'running', health: 'healthy' },
        ],
      }],
    });
    metricsApi.getAlerts.mockResolvedValue({
      alerts: [{ id: 'rule-c2', containerId: 'c2', metric: 'cpu', threshold: 80 }],
    });
    await mountView();

    const selects = [...document.querySelectorAll('select')];
    selects[1].value = 'c1';
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(document.body.textContent).toContain('暂无告警规则');
    expect(document.body.textContent).not.toContain('rule-c2');
    expect(document.body.textContent).not.toContain('阈值: 80%');
  });

  it('指标卡片可通过 Enter 和 Space 选择，且向读屏器暴露按钮及选中状态', async () => {
    api.getProjects.mockResolvedValue({
      projects: [{
        id: 'p1',
        projectName: 'web-stack',
        managed: true,
        containers: [{ id: 'c1', name: 'api', state: 'running', health: 'healthy' }],
      }],
    });
    await mountView();

    const selects = [...document.querySelectorAll('select')];
    selects[1].value = 'c1';
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    const cpu = document.querySelector('[aria-label="选择CPU指标"]');
    const memory = document.querySelector('[aria-label="选择内存指标"]');
    expect(cpu).not.toBeNull();
    expect(memory).not.toBeNull();
    expect(cpu.tagName).toBe('BUTTON');
    expect(cpu.getAttribute('aria-pressed')).toBe('true');
    expect(memory.getAttribute('aria-pressed')).toBe('false');

    memory.click();
    await flushPromises();
    expect(memory.getAttribute('aria-pressed')).toBe('true');
    expect(cpu.getAttribute('aria-pressed')).toBe('false');

    cpu.click();
    await flushPromises();
    expect(cpu.getAttribute('aria-pressed')).toBe('true');
    expect(memory.getAttribute('aria-pressed')).toBe('false');
  });

  it('点击遮罩或关闭按钮也会关闭弹窗并恢复焦点', async () => {
    await mountView();
    const trigger = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '配置告警');
    trigger.focus();
    trigger.click();
    await flushPromises();

    document.querySelector('.modal-backdrop').click();
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    await flushPromises();
    document.querySelector('button[aria-label="关闭"]').click();
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('历史图表使用可收缩的全宽容器，不再强制窄屏横向滚动', async () => {
    metricsApi.getHistoricalMetrics.mockResolvedValue({ metrics: [{ timestamp: 1_000, value: 35 }] });
    api.getProjects.mockResolvedValue({
      projects: [{ id: 'p1', projectName: 'web-stack', managed: true, containers: [{ id: 'c1', name: 'api', state: 'running', health: 'healthy' }] }],
    });
    await mountView();
    const selects = [...document.querySelectorAll('select')];
    selects[1].value = 'c1';
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    const panel = wrapper.find('.history-chart-panel');
    expect(panel.exists()).toBe(true);
    expect(panel.classes()).toContain('min-w-0');
    expect(wrapper.find('.history-chart-frame').classes()).toEqual(expect.arrayContaining(['min-w-0', 'w-full']));
    expect(wrapper.html()).not.toContain('min-w-[560px]');
  });

  it('节点切换后，旧容器指标请求的迟到结果不会回填到新节点', async () => {
    const oldMetricRequests = [];
    api.getProjects
      .mockResolvedValueOnce({ projects: [{ id: 'old-project', projectName: 'old-stack', managed: true, containers: [{ id: 'old-container', name: 'old-api', state: 'running', health: 'healthy' }] }] })
      .mockResolvedValueOnce({ projects: [{ id: 'new-project', projectName: 'new-stack', managed: true, containers: [{ id: 'new-container', name: 'new-api', state: 'running', health: 'healthy' }] }] });
    metricsApi.getContainerMetrics.mockImplementation(() => new Promise(resolve => { oldMetricRequests.push(resolve); }));
    await mountView();
    const selects = [...document.querySelectorAll('select')];
    selects[1].value = 'old-container';
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    window.dispatchEvent(new Event('composeops:host-changed'));
    await flushPromises();
    for (const resolve of oldMetricRequests) resolve({ data: { current: 99, unit: '%' } });
    await flushPromises();

    expect(wrapper.text()).toContain('new-stack');
    expect(wrapper.text()).not.toContain('99.0%');
    expect(wrapper.find('.history-chart-panel').exists()).toBe(false);
    expect(metricsApi.getHistoricalMetrics).toHaveBeenCalledTimes(1);
    expect(metricsApi.getHistoricalMetrics.mock.calls[0][0].signal.aborted).toBe(true);
  });
});


it('从实时容器进入历史自动定位同一项目和容器', async () => {
  api.getProjects.mockResolvedValue({ projects: [
    { id: 'p1', managed: true, containers: [{ id: 'c1', name: 'one' }] },
    { id: 'p2', managed: true, containers: [{ id: 'c2', name: 'two' }] },
  ] });
  await mountView({ embedded: true, initialProjectId: '', initialContainerId: 'c2' });
  expect(wrapper.get('#resource-monitor-project').element.value).toBe('p2');
  expect(wrapper.get('#resource-monitor-container').element.value).toBe('c2');
  expect(metricsApi.getContainerMetrics).toHaveBeenCalledWith('c2', 'cpu', '5m', expect.objectContaining({ signal: expect.anything() }));
});

describe('指标有效性与部分读取', () => {
  it('未知指标显示占位与原因，真实零保留0，缺少趋势不伪装下降', async () => {
    metricsApi.getContainerMetrics.mockImplementation(async (_id, metric) => ({ data: { current: metric === 'memory' ? 0 : null, trend: 'unknown', unit: '%', reason: metric === 'cpu' ? '等待有效 CPU 差分采样' : '' } }));
    await mountView();
    expect(wrapper.get('[aria-label="选择CPU指标"]').text()).toContain('—');
    expect(wrapper.get('[aria-label="选择CPU指标"]').text()).toContain('等待有效 CPU 差分采样');
    expect(wrapper.get('[aria-label="选择CPU指标"]').text()).toContain('趋势待采样');
    expect(wrapper.get('[aria-label="选择CPU指标"]').text()).not.toContain('下降');
    expect(wrapper.get('[aria-label="选择内存指标"]').text()).toContain('0.0%');
  });
  it('单个指标失败不丢掉其它指标与有效历史', async () => {
    metricsApi.getContainerMetrics.mockImplementation(async (_id, metric) => { if (metric === 'cpu') throw new Error('CPU 源暂不可用'); return { data: { current: 25, unit: '%', trend: 'stable' } }; });
    metricsApi.getHistoricalMetrics.mockResolvedValue({ metrics: [{ timestamp: 1000, value: 42 }] });
    await mountView();
    expect(wrapper.get('[aria-label="选择内存指标"]').text()).toContain('25.0%');
    expect(wrapper.get('[aria-label="选择CPU指标"]').text()).toContain('CPU 源暂不可用');
    expect(wrapper.text()).toContain('成功读取的结果已保留');
    expect(wrapper.findComponent({ name: 'InteractiveChart' }).props('data')).toEqual([{ timestamp: 1000, value: 42 }]);
  });
  it('历史读取失败时仍显示有效当前指标，并明确缺失历史', async () => {
    metricsApi.getHistoricalMetrics.mockRejectedValue(new Error('历史源暂不可用'));
    await mountView();
    expect(wrapper.get('[aria-label="选择内存指标"]').text()).toContain('25.0%');
    expect(wrapper.text()).toContain('历史源暂不可用');
    expect(wrapper.findComponent({ name: 'InteractiveChart' }).exists()).toBe(false);
  });
  it('历史里的null与布尔值不能在图中变成0，合法0保留', async () => {
    metricsApi.getHistoricalMetrics.mockResolvedValue({ metrics: [{ timestamp: 1000, value: null }, { timestamp: 2000, value: false }, { timestamp: 3000, value: 0 }] });
    await mountView();
    expect(wrapper.findComponent({ name: 'InteractiveChart' }).props('data')).toEqual([{ timestamp: 3000, value: 0 }]);
  });
  it('切换指标与离开页面会取消先前请求', async () => {
    const signals = [];
    metricsApi.getContainerMetrics.mockImplementation((_id, _metric, _period, options) => { signals.push(options.signal); return new Promise(() => {}); });
    await mountView();
    expect(signals.length).toBe(4); expect(signals.every(signal => !signal.aborted)).toBe(true);
    wrapper.unmount(); wrapper = null;
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
  it('网络和磁盘明确是累计计数，缺少一个方向显示占位', async () => {
    metricsApi.getContainerMetrics.mockImplementation(async (_id, metric) => ({ data: metric === 'network' ? { current: { rx: '1 MB', tx: null }, kind: 'counter', trend: 'unknown' } : { current: 25, unit: '%' } }));
    await mountView();
    const network = wrapper.get('[aria-label="选择网络指标"]');
    expect(network.text()).toContain('收 1 MB · 发 —'); expect(network.text()).toContain('累计计数');
    await network.trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('每秒速率请查看实时总览');
  });
});
