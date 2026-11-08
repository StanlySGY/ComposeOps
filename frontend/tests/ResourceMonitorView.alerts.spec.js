import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api, metricsApi } = vi.hoisted(() => ({ api: { getProjects: vi.fn() }, metricsApi: Object.fromEntries(['getAlerts', 'getContainerMetrics', 'getHistoricalMetrics', 'detectAnomalies', 'createAlert', 'deleteAlert'].map(name => [name, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api, metricsApi }));
import ResourceMonitorView from '../src/views/ResourceMonitorView.vue';
const project = { id: 'p1', projectName: 'stack', managed: true, containers: [{ id: 'c1', name: 'api', state: 'running' }, { id: 'c2', name: 'worker', state: 'running' }] };
const rule = { id: 'rule1', projectId: 'p1', containerId: 'c1', containerName: 'api', metric: 'cpu', threshold: 80, action: 'notify' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let wrapper;
async function open(props = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
  await router.push('/');
  wrapper = mount(ResourceMonitorView, { attachTo: document.body, props: { initialProjectId: 'p1', initialContainerId: 'c1', ...props }, global: { plugins: [router, createPinia()], stubs: { InteractiveChart: true, StatusBadge: true } } });
  await flushPromises();
}
const button = text => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
const dialog = () => document.querySelector('[role="dialog"]');
async function click(text) { const target = button(text); expect(target, `按钮 ${text} 应可达`).toBeTruthy(); target.click(); await flushPromises(); }
async function configure() { await click('配置告警'); expect(dialog()).toBeTruthy(); }
async function threshold(value) { const input = document.querySelector('#resource-alert-threshold'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises(); }
beforeEach(() => {
  vi.resetAllMocks();
  api.getProjects.mockResolvedValue({ projects: [project] });
  metricsApi.getAlerts.mockResolvedValue({ alerts: [rule] });
  metricsApi.getContainerMetrics.mockResolvedValue({ data: { current: 25, unit: '%', trend: 'stable' } });
  metricsApi.getHistoricalMetrics.mockResolvedValue({ metrics: [{ timestamp: 1000, value: 25 }] });
  metricsApi.detectAnomalies.mockResolvedValue({ anomalies: [] });
  metricsApi.createAlert.mockImplementation(async payload => ({ ruleId: 'new-rule', rule: { ...rule, id: 'new-rule', ...payload, containerId: payload.container } }));
  metricsApi.deleteAlert.mockResolvedValue({ deleted: 1 });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

describe('历史指标中的告警操作闭环', () => {
  it('正常嵌入监控入口能够为所选容器配置规则', async () => {
    await open({ embedded: true }); await configure();
    expect(dialog().textContent).toContain('api');
  });

  it('指标读取失败时规则仍可读取、新建和删除', async () => {
    metricsApi.getContainerMetrics.mockRejectedValue(new Error('指标源暂不可用'));
    await open({ embedded: true });
    expect(wrapper.text()).toContain('指标源暂不可用');
    expect(wrapper.text()).toContain('阈值：80%');
    expect(button('删除')).toBeTruthy();
    await configure();
  });

  it('规则首轮读取慢时显示加载，不误报暂无规则', async () => {
    const request = deferred(); metricsApi.getAlerts.mockReturnValueOnce(request.promise);
    await open({ embedded: true });
    expect(wrapper.text()).not.toContain('暂无告警规则');
    expect(wrapper.text()).toContain('正在读取告警规则');
    request.resolve({ alerts: [] }); await flushPromises();
    expect(wrapper.text()).toContain('暂无告警规则');
  });

  it('创建时固定容器和表单，防重复并锁住退出', async () => {
    const request = deferred(); metricsApi.createAlert.mockReturnValueOnce(request.promise);
    await open(); await configure(); await threshold('92');
    await click('创建规则'); await click('创建规则');
    expect(metricsApi.createAlert).toHaveBeenCalledExactlyOnceWith({ container: 'c1', metric: 'cpu', threshold: 92, action: 'notify' });
    expect(button('取消').disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flushPromises();
    expect(dialog()).toBeTruthy();
    request.resolve({ ruleId: 'new-rule', rule: { ...rule, id: 'new-rule', threshold: 92 } }); await flushPromises();
  });

  it('创建失败保留表单并行内解释，可以原地重试', async () => {
    metricsApi.createAlert.mockRejectedValueOnce(new Error('规则写入暂不可用'));
    await open(); await configure(); await threshold('92'); await click('创建规则');
    expect(dialog()).toBeTruthy();
    expect(dialog().textContent).toContain('规则写入暂不可用');
    expect(document.querySelector('#resource-alert-threshold').value).toBe('92');
    await click('创建规则'); expect(metricsApi.createAlert).toHaveBeenCalledTimes(2);
  });

  it('创建成功后刷新失败，仍展示服务端确认的新规则', async () => {
    await open(); await configure(); await threshold('92');
    metricsApi.getAlerts.mockRejectedValueOnce(new Error('规则列表暂不可用'));
    await click('创建规则');
    expect(dialog()).toBeNull();
    expect(wrapper.text()).toContain('阈值：92%');
    expect(wrapper.text()).toContain('规则列表暂不可用');
  });

  it.each(['', '-1', '101'])('CPU 阈值 %s 无效时不能发起创建', async value => {
    await open(); await configure(); await threshold(value);
    expect(button('创建规则').disabled).toBe(true);
    await click('创建规则'); expect(metricsApi.createAlert).not.toHaveBeenCalled();
  });

  it('删除先确认，失败保留确认门，再试成功不因刷新失败恢复旧记录', async () => {
    await open(); await click('删除');
    expect(metricsApi.deleteAlert).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('删除告警规则');
    metricsApi.deleteAlert.mockRejectedValueOnce(new Error('删除暂不可用'));
    await click('确认删除');
    expect(dialog().textContent).toContain('删除暂不可用');
    metricsApi.getAlerts.mockRejectedValueOnce(new Error('规则列表暂不可用'));
    await click('确认删除');
    expect(dialog()).toBeNull();
    expect(wrapper.text()).not.toContain('阈值：80%');
    expect(wrapper.text()).toContain('规则列表暂不可用');
  });

  it('规则刷新失败保留已读规则，重试只刷新规则分区', async () => {
    await open(); metricsApi.getAlerts.mockRejectedValueOnce(new Error('规则列表暂不可用'));
    document.querySelector('[aria-label="刷新告警规则"]').click(); await flushPromises();
    expect(wrapper.text()).toContain('阈值：80%');
    const reads = metricsApi.getContainerMetrics.mock.calls.length;
    await click('重新读取规则');
    expect(wrapper.text()).not.toContain('规则列表暂不可用');
    expect(metricsApi.getContainerMetrics).toHaveBeenCalledTimes(reads);
  });

  it('切换节点后迟到创建不关闭新节点表单，不显示旧成功反馈', async () => {
    const request = deferred(); metricsApi.createAlert.mockReturnValueOnce(request.promise);
    await open(); await configure(); await click('创建规则');
    api.getProjects.mockResolvedValue({ projects: [{ ...project, id: 'p2', containers: [{ id: 'c2', name: 'other-api', state: 'running' }] }] });
    metricsApi.getAlerts.mockResolvedValue({ alerts: [] });
    window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises();
    expect(dialog()).toBeNull();
    const reads = metricsApi.getAlerts.mock.calls.length;
    await wrapper.get('#resource-monitor-container').setValue('c2');
    await configure();
    const next = deferred(); metricsApi.createAlert.mockReturnValueOnce(next.promise);
    await click('创建规则');
    request.resolve({ rule: { ...rule, id: 'old-created' } }); await flushPromises();
    expect(metricsApi.getAlerts).toHaveBeenCalledTimes(reads);
    expect(wrapper.text()).not.toContain('告警规则已创建');
    expect(dialog().textContent).toContain('other-api');
    expect(button('取消').disabled).toBe(true);
    next.resolve({ rule: { ...rule, id: 'new-host-rule', containerId: 'c2' } }); await flushPromises();
    expect(dialog()).toBeNull();
  });

  it('删除等待期间禁止重复提交与退出，切换容器后迟到结果不污染新上下文', async () => {
    const request = deferred(); metricsApi.deleteAlert.mockReturnValueOnce(request.promise);
    await open(); await click('删除'); await click('确认删除'); await click('确认删除');
    expect(metricsApi.deleteAlert).toHaveBeenCalledExactlyOnceWith('rule1');
    expect(button('取消').disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flushPromises();
    expect(dialog()).toBeTruthy();
    await wrapper.get('#resource-monitor-container').setValue('c2');
    expect(dialog()).toBeNull();
    const reads = metricsApi.getAlerts.mock.calls.length;
    request.resolve({ deleted: 1 }); await flushPromises();
    expect(metricsApi.getAlerts).toHaveBeenCalledTimes(reads);
    expect(wrapper.text()).not.toContain('已删除');
  });

  it('创建确认后列表慢刷新不阻塞继续操作，旧列表读取不能覆盖新规则', async () => {
    const oldList = deferred();
    await open();
    metricsApi.getAlerts.mockReturnValueOnce(oldList.promise);
    document.querySelector('[aria-label="刷新告警规则"]').click(); await flushPromises();
    await configure(); await threshold('92');
    const newList = deferred(); metricsApi.getAlerts.mockReturnValueOnce(newList.promise);
    await click('创建规则');
    expect(dialog()).toBeNull(); expect(button('配置告警').disabled).toBe(false);
    oldList.resolve({ alerts: [] }); await flushPromises();
    expect(wrapper.text()).toContain('阈值：92%');
    newList.reject(new Error('慢刷新失败')); await flushPromises();
    expect(wrapper.text()).toContain('阈值：92%');
  });

  it('离开页面后迟到创建不重新刷新规则或显示反馈', async () => {
    const request = deferred(); metricsApi.createAlert.mockReturnValueOnce(request.promise);
    await open(); await configure(); await click('创建规则');
    const reads = metricsApi.getAlerts.mock.calls.length;
    wrapper.unmount(); wrapper = null;
    request.resolve({ rule }); await flushPromises();
    expect(metricsApi.getAlerts).toHaveBeenCalledTimes(reads);
    expect(dialog()).toBeNull(); expect(document.body.style.overflow).toBe('');
  });
});
