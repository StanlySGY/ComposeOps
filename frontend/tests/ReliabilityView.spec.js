import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, nextTick } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
const api = vi.hoisted(() => ({ getSreProfiles: vi.fn(), getSreTargets: vi.fn(), saveSreProfile: vi.fn(), pauseSreProfile: vi.fn(), saveSreAutonomy: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { default: ReliabilityPage } = await import('../src/views/ReliabilityView.vue');
let wrapper, router, profile;
const button = text => [...document.body.querySelectorAll('button')].find(item => item.textContent.trim() === text);
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetAllMocks();
  profile = { id: 'p1', projectId: 'app-1', projectName: 'wiki', serviceName: 'web', hostId: 'node-a', version: 1, enabled: true,
    config: { url: 'http://localhost/health', expectedStatus: 200, timeoutMs: 3000, maxLatencyMs: 1000, failureThreshold: 3, targetPercent: 99.9, windowDays: 7 },
    statistics: { observedAvailabilityPercent: 100, coveragePercent: 25, unknownMs: 90000, samples: 1, budgetRemainingMs: -89000 }, policy: null,
    latest: { at: Date.now(), outcome: 'good' } };
  api.getSreProfiles.mockImplementation(async () => ({ profiles: [JSON.parse(JSON.stringify(profile))], insights: {} }));
  api.getSreTargets.mockResolvedValue({ targets: [{ projectId: 'app-1', projectName: 'wiki', hostId: 'node-a', services: ['web'] }] });
  api.saveSreProfile.mockResolvedValue({}); api.saveSreAutonomy.mockResolvedValue({}); api.pauseSreProfile.mockResolvedValue({});
  router = createRouter({ history: createMemoryHistory(), routes: ['/reliability', '/oncall'].map(path => ({ path, component: { template: '<div />' } })) });
  await router.push('/reliability'); await router.isReady();
});
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); document.body.innerHTML = ''; });
async function render(component = ReliabilityPage) { wrapper = mount(component, { global: { plugins: [router] }, attachTo: document.body }); await flushPromises(); }
it('覆盖不足单独展示，暂停或过期探针不能标记达标', async () => {
  await render(); expect(wrapper.text()).toContain('100.00%'); expect(wrapper.text()).toContain('25.00%'); expect(wrapper.text()).toContain('覆盖率不足');
  profile.latest.at = Date.now() - 90000;
  await vi.advanceTimersByTimeAsync(15000); await flushPromises();
  expect(wrapper.text()).toContain('观测不足'); expect(wrapper.text()).not.toContain('探针达标');
});
it('自动授权必须二次确认，确认固定应用和预算，等待期间防重复', async () => {
  await render(); button('审阅自动授权').click(); await flushPromises();
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises();
  expect(api.saveSreAutonomy).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('wiki / web · node-a');
  let finish; api.saveSreAutonomy.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  button('确认授权').click(); await nextTick();
  expect(api.saveSreAutonomy).toHaveBeenCalledWith('p1', expect.objectContaining({ confirm: 'ENABLE_AUTONOMY', maxDaily: 1, cooldownMs: 3600000, enabled: true, version: 0 }));
  expect(button('确认授权').disabled).toBe(true);
  finish({}); await flushPromises(); expect(document.body.textContent).toContain('应用自动处置授权已保存');
});
it('目标保存失败保留输入与错误，成功后关闭编辑器', async () => {
  await render(); button('编辑目标').click(); await flushPromises();
  expect(document.body.textContent).toContain('已有自动授权会停用');
  api.saveSreProfile.mockRejectedValueOnce(new Error('版本已改变'));
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises();
  expect(document.body.textContent).toContain('版本已改变'); expect(document.querySelector('input[type=url]').value).toBe('http://localhost/health');
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises();
  expect(api.saveSreProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'p1', version: 1, hostId: 'node-a' }));
});
it('暂停即时请求后端并保留操作反馈，轮询失败不显示空白健康态', async () => {
  await render(); button('暂停探针与授权').click(); await flushPromises();
  expect(api.pauseSreProfile).toHaveBeenCalledWith('p1');
  api.getSreProfiles.mockRejectedValueOnce(new Error('offline'));
  await vi.advanceTimersByTimeAsync(15000); await flushPromises();
  expect(wrapper.text()).toContain('offline'); expect(wrapper.text()).toContain('wiki / web');
});
it('失活释放请求与定时器，恢复时只启动一个轮询', async () => {
  const shown = ref(true);
  const Host = defineComponent({ components: { ReliabilityPage }, setup: () => ({ shown }), template: '<KeepAlive><ReliabilityPage v-if="shown" /></KeepAlive>' });
  await render(Host); const signal = api.getSreProfiles.mock.calls[0][0];
  shown.value = false; await nextTick(); expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(45000); expect(api.getSreProfiles).toHaveBeenCalledTimes(1);
  shown.value = true; await nextTick(); await flushPromises(); expect(api.getSreProfiles).toHaveBeenCalledTimes(2);
  wrapper.unmount(); wrapper = null; await vi.advanceTimersByTimeAsync(45000); expect(api.getSreProfiles).toHaveBeenCalledTimes(2);
});
