import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
const api = vi.hoisted(() => ({ getSreOperations: vi.fn(), sreOperation: vi.fn(), getSreTargets: vi.fn(), getRecoveryCandidates: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { default: Operations } = await import('../src/components/ReliabilityOperations.vue');
let wrapper, router, data;
const button = label => [...document.body.querySelectorAll('button')].find(el => el.textContent.trim() === label);
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetAllMocks();
  data = { changes: [{ id: 'change', status: 'reviewed', hostId: 'node-a', projectId: 'app', fingerprint: 'review-fingerprint', review: { projectName: 'wiki', serviceName: 'web', old: { imageId: 'sha256:old' }, next: { imageId: 'sha256:new', requested: 'app:new' }, rollbackScope: '不回退数据库。' }, result: {} }], recoveryPlans: [], recoveryRuns: [], retrospectives: [], insights: {} };
  api.getSreOperations.mockImplementation(async () => structuredClone(data)); api.sreOperation.mockResolvedValue({});
  api.getSreTargets.mockResolvedValue({ targets: [{ hostId: 'node-a', projectId: 'app', projectName: 'wiki', editable: true }] });
  api.getRecoveryCandidates.mockResolvedValue({ volumes: ['wiki_data'], excluded: [] });
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] }); await router.push('/');
});
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); document.body.innerHTML = ''; });
async function render(tab = 'changes') { wrapper = mount(Operations, { props: { tab, profiles: [{ id: 'p', projectName: 'wiki', serviceName: 'web', hostId: 'node-a', enabled: true }] }, global: { plugins: [router] }, attachTo: document.body }); await flushPromises(); }
it('变更确认绑定评审指纹，默认不授权回退，等待期间禁止重复批准', async () => {
  await render(); button('审阅并批准变更').click(); await flushPromises();
  expect(document.body.textContent).toContain('sha256:old'); expect(document.querySelector('input[type=checkbox]').checked).toBe(false);
  let finish; api.sreOperation.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  button('批准并执行').click(); await nextTick();
  expect(api.sreOperation).toHaveBeenCalledWith('changes/change/approve', { confirm: 'APPLY_PINNED_IMAGE', fingerprint: 'review-fingerprint', allowRollback: false });
  expect(button('批准并执行').disabled).toBe(true); finish({}); await flushPromises();
});
it('评审请求失败保留输入；成功创建评审不直接执行', async () => {
  await render(); button('评审镜像变更').click(); await flushPromises();
  const input = document.querySelector('input'); input.value = 'app:new'; input.dispatchEvent(new Event('input', { bubbles: true }));
  api.sreOperation.mockRejectedValueOnce(new Error('配置已变化'));
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises();
  expect(document.body.textContent).toContain('配置已变化'); expect(document.querySelector('input').value).toBe('app:new');
  expect(api.sreOperation).toHaveBeenCalledWith('changes/review', { profileId: 'p', image: 'app:new' });
});
it('未知结果单独展示且核对记录不算验收通过', async () => {
  data.changes[0].status = 'outcome_unknown'; await render();
  expect(wrapper.text()).toContain('结果未知，需要核对'); expect(wrapper.text()).not.toContain('变更已验收');
  button('核对未知结果').click(); await flushPromises();
  const textarea = document.querySelector('textarea'); textarea.value = '已核对实际镜像和应用状态，保留未知结论'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises();
  expect(api.sreOperation).toHaveBeenCalledWith('changes/change/acknowledge', { reason: '已核对实际镜像和应用状态，保留未知结论' });
});
it('恢复候选请求在离开页面时取消，迟到响应不能污染新页面', async () => {
  await render('recovery'); button('新建恢复计划').click(); await flushPromises();
  let finish; api.getRecoveryCandidates.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const select = document.querySelector('select'); select.value = 'node-a:app'; select.dispatchEvent(new Event('change', { bubbles: true })); await flushPromises();
  const signal = api.getRecoveryCandidates.mock.calls[0][1]; wrapper.unmount(); wrapper = null; expect(signal.aborted).toBe(true);
  finish({ volumes: ['late'], excluded: [] }); await flushPromises(); expect(document.body.textContent).not.toContain('late');
});
it('缓存失活取消轮询；复活只恢复一次；加载失败保留已有证据', async () => {
  const visible = ref(true), Host = defineComponent({ components: { Operations }, setup: () => ({ visible }), template: '<KeepAlive><Operations v-if="visible" tab="changes" /></KeepAlive>' });
  wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body }); await flushPromises();
  const signal = api.getSreOperations.mock.calls[0][0]; visible.value = false; await nextTick(); expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(30000); expect(api.getSreOperations).toHaveBeenCalledTimes(1);
  visible.value = true; await nextTick(); await flushPromises(); expect(api.getSreOperations).toHaveBeenCalledTimes(2);
  api.getSreOperations.mockRejectedValueOnce(new Error('offline')); await vi.advanceTimersByTimeAsync(10000); await flushPromises(); expect(wrapper.text()).toContain('offline'); expect(wrapper.text()).toContain('sha256:old');
});
