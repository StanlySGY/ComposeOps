import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, nextTick } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
const api = vi.hoisted(() => ({ getSreResource: vi.fn(), sreOperation: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { default: Health } = await import('../src/components/ReliabilityHealth.vue');
let wrapper, router, data;
const buttons = () => [...document.body.querySelectorAll('button')];
const button = text => buttons().find(item => item.textContent.trim() === text);
const profiles = [{ id: 'p', projectName: '知识库', serviceName: 'web', hostId: 'local', version: 2 }];
const thresholds = { heartbeatSeconds: 90, queueMinutes: 10, executionMinutes: 30, databaseGiB: 10, walMiB: 1024, growthMiBPerHour: 512, diskFreePercent: 10, backupHours: 48, backupMinutes: 30, externalSeconds: 120, maintenanceUntil: 0 };
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetAllMocks();
  data = { stale: true, config: { version: 2, thresholds }, sample: { at: Date.now(), workers: [], queues: {}, backup: { state: 'unknown' }, external: { configured: true, location: 'same-host', at: Date.now() } }, history: [], alerts: [], deliveries: [] };
  api.getSreResource.mockImplementation(async path => path === 'platform' ? structuredClone(data) : { rule: { version: 1, profileVersion: 1, config: { enabled: false, minimumCoverage: 0.9, recoverMinutes: 5, maintenanceUntil: 0, fast: { shortMinutes: 5, longMinutes: 60, burnRate: 14.4 }, slow: { shortMinutes: 30, longMinutes: 360, burnRate: 6 } } }, evidence: {} });
  api.sreOperation.mockResolvedValue({});
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] }); await router.push('/');
});
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); document.body.innerHTML = ''; });
async function render(tab = 'platform') { wrapper = mount(Health, { props: { tab, profiles }, global: { plugins: [router] }, attachTo: document.body }); await flushPromises(); }
it('平台缺测、备份未知和同宿主检查范围如实展示', async () => {
  await render(); expect(wrapper.text()).toContain('观测缺失或已过期'); expect(wrapper.text()).toContain('最近备份：未知'); expect(wrapper.text()).toContain('同宿主部署无法发现整机断电');
  expect(wrapper.text()).not.toContain('平台健康检查通过');
});
it('阈值保存绑定版本，失败保留表单输入，轮询不覆盖编辑草稿', async () => {
  await render(); button('配置阈值').click(); await flushPromises();
  const input = document.querySelector('input'); input.value = '120'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(15000); expect(document.querySelector('input').value).toBe('120');
  api.sreOperation.mockRejectedValueOnce(new Error('阈值版本冲突'));
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises();
  expect(document.body.textContent).toContain('阈值版本冲突'); expect(document.querySelector('input').value).toBe('120');
  expect(api.sreOperation).toHaveBeenCalledWith('platform/config', { version: 2, thresholds: { ...thresholds, heartbeatSeconds: 120 } }, 'PUT');
});
it('告警默认关闭且显示配置改版，显式保存当前目标规则', async () => {
  await render('alerts'); button('查看与配置告警').click(); await flushPromises();
  expect(document.body.textContent).toContain('应用目标已改版'); expect(document.querySelector('input[type=checkbox]').checked).toBe(false);
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises();
  expect(api.sreOperation).toHaveBeenCalledWith('profiles/p/alerts', expect.objectContaining({ version: 1, config: expect.objectContaining({ enabled: false }) }), 'PUT');
});
it('离开缓存页面取消轮询和读取；复活只重新读取一次，旧响应不能覆盖', async () => {
  const shown = ref(true), Host = defineComponent({ components: { Health }, setup: () => ({ shown }), template: '<KeepAlive><Health v-if="shown" /></KeepAlive>' });
  wrapper = mount(Host, { global: { plugins: [router] } }); await flushPromises();
  const signal = api.getSreResource.mock.calls[0][1]; shown.value = false; await nextTick(); expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60000); expect(api.getSreResource).toHaveBeenCalledTimes(1);
  shown.value = true; await nextTick(); await flushPromises(); expect(api.getSreResource).toHaveBeenCalledTimes(2);
});
it('晚到的规则请求不会在卸载后弹出表单', async () => {
  await render('alerts'); let resolve;
  api.getSreResource.mockImplementation(() => new Promise(done => { resolve = done; }));
  button('查看与配置告警').click(); await nextTick(); const signal = api.getSreResource.mock.calls.at(-1)[1];
  wrapper.unmount(); wrapper = null; expect(signal.aborted).toBe(true); resolve({ rule: {}, evidence: {} }); await flushPromises();
  expect(document.body.textContent).not.toContain('应用错误预算告警');
});
it('通知未知与未配置状态可见，凭据轮换必须通过确认并且不进入持久存储', async () => {
  data.deliveries = [{ id: 'd', alertKey: 'platform:1:test', status: 'outcome_unknown', channel: 'webhook', attempts: 1 }];
  api.sreOperation.mockResolvedValue({ token: 'preview-token' }); await render();
  expect(wrapper.text()).toContain('发送结果未知'); button('生成或轮换检查凭据').click(); await flushPromises();
  expect(api.sreOperation).not.toHaveBeenCalled(); button('生成新凭据').click(); await flushPromises();
  expect(document.querySelector('textarea').value).toBe('preview-token'); expect(localStorage.length).toBe(0);
});
