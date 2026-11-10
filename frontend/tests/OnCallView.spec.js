import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, nextTick } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';

const api = vi.hoisted(() => ({ getIncidents: vi.fn(), getIncident: vi.fn(), diagnoseIncident: vi.fn(), proposeIncidentRestart: vi.fn(), approveOpsEffect: vi.fn(), cancelOpsEffect: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { default: View } = await import('../src/views/OnCallView.vue');
const { default: Summary } = await import('../src/components/OnCallSummary.vue');
let wrapper, router, incident, detail;
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetAllMocks();
  incident = { id: 'incident-1', ticketId: 'incident-1', projectId: 'p-1', hostId: 'remote-a', projectName: 'web', serviceName: 'web', resourceId: 'a'.repeat(64),
    title: 'web 健康检查失败', status: 'awaiting_approval', openedAt: new Date().toISOString(), observedAt: new Date().toISOString(),
    latest: { state: 'running', health: 'unhealthy', fault: '健康检查失败' }, healthyCount: 0, verification: { scope: 'container_healthcheck' }, effectId: 'effect-1' };
  detail = { incident, effects: [{ id: 'effect-1', status: 'awaiting_approval' }], evidence: [{ id: 1, summary: '首次观测', observedAt: incident.openedAt, data: { state: 'unhealthy' } }] };
  api.getIncidents.mockImplementation(async () => ({ incidents: [incident], observer: { running: true, last: { checkedAt: new Date().toISOString() }, aiConfigured: true }, worker: { enabled: true } }));
  api.getIncident.mockImplementation(async () => structuredClone(detail));
  api.approveOpsEffect.mockResolvedValue({}); api.cancelOpsEffect.mockResolvedValue({});
  router = createRouter({ history: createMemoryHistory(), routes: ['/oncall', '/tickets', '/logs', '/agent', '/settings'].map(path => ({ path, component: { template: '<div />' } })) });
  await router.push('/oncall?incident=incident-1'); await router.isReady();
});
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); document.body.innerHTML = ''; });
async function render(component = View) { wrapper = mount(component, { global: { plugins: [router] }, attachTo: document.body }); await flushPromises(); }
const button = text => wrapper.findAll('button').find(item => item.text().includes(text));

it('展示证据与验证范围，目标链接保留节点与容器', async () => {
  await render();
  expect(wrapper.text()).toContain('待审批'); expect(wrapper.text()).toContain('首次观测');
  expect(wrapper.text()).toContain('Docker HEALTHCHECK');
  const links = wrapper.findAll('a').map(item => item.attributes('href'));
  expect(links.some(link => link.includes('hostId=remote-a') && link.includes('containerId='))).toBe(true);
  expect(links.some(link => link.includes('ticket=incident-1'))).toBe(true);
});

it('批准前显示固定目标，只有确认才提交，等待期间禁止重复提交', async () => {
  await render(); await button('审阅并批准').trigger('click'); await flushPromises();
  expect(api.approveOpsEffect).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('仅重启此容器一次');
  let finish;
  api.approveOpsEffect.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const confirm = [...document.body.querySelectorAll('button')].find(item => item.textContent.includes('批准并入队'));
  confirm.click(); await nextTick();
  expect(api.approveOpsEffect).toHaveBeenCalledWith('incident-1', 'effect-1');
  expect(confirm.disabled).toBe(true);
  finish({}); await flushPromises();
  expect(wrapper.text()).toContain('等待执行和独立验收');
});

it('执行成功仍展示验证中，未知结果提供人工核对', async () => {
  incident.status = 'verifying'; detail.effects[0].status = 'succeeded';
  await render();
  expect(wrapper.text()).toContain('处置完成，等待健康验收');
  expect(wrapper.text()).toContain('0 / 3 次连续健康观测');
  detail.effects[0].status = 'outcome_unknown'; incident.status = 'needs_attention';
  await button('刷新').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('执行结果未知，需要核对');
  expect(wrapper.text()).toContain('查看原因与核对结果');
  detail.effects[0].status = 'succeeded'; incident.status = 'resolved'; incident.resolvedAt = new Date().toISOString();
  await button('刷新').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('处置完成，健康验收已通过');
  expect(wrapper.text()).not.toContain('处置完成，等待健康验收');
});

it('列表失败保留证据并显示重试，切换事件不显示旧详情', async () => {
  await render(); api.getIncidents.mockRejectedValueOnce(new Error('network offline'));
  await button('刷新').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('network offline'); expect(wrapper.text()).toContain('首次观测');
  api.getIncident.mockImplementationOnce(() => new Promise(() => {}));
  await router.push('/oncall?incident=incident-2'); await flushPromises();
  expect(wrapper.text()).not.toContain('首次观测');
});

it('失活释放轮询和请求，重新激活仅恢复一份轮询', async () => {
  const shown = ref(true);
  const Host = defineComponent({ components: { OnCallPage: View }, setup: () => ({ shown }), template: '<KeepAlive><OnCallPage v-if="shown" /></KeepAlive>' });
  await render(Host);
  expect(api.getIncidents).toHaveBeenCalledTimes(1);
  const signal = api.getIncidents.mock.calls[0][1];
  shown.value = false; await nextTick();
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(45000); expect(api.getIncidents).toHaveBeenCalledTimes(1);
  shown.value = true; await nextTick(); await flushPromises(); expect(api.getIncidents).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15000); await flushPromises(); expect(api.getIncidents).toHaveBeenCalledTimes(3);
  wrapper.unmount(); wrapper = null;
  await vi.advanceTimersByTimeAsync(30000); expect(api.getIncidents).toHaveBeenCalledTimes(3);
});

it('总览提供待审批故障入口，读取失败不显示环境健康', async () => {
  await render(Summary); expect(wrapper.text()).toContain('1 项等待审批');
  api.getIncidents.mockRejectedValueOnce(new Error('offline'));
  await vi.advanceTimersByTimeAsync(15000); await flushPromises();
  expect(wrapper.text()).toContain('值守数据暂不可用');
});
