import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, nextTick } from 'vue';
import { previewCorrelation } from '../preview/sre-telemetry.js';
const api = vi.hoisted(() => ({ getIncidentCorrelation: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { default: Correlation } = await import('../src/components/IncidentCorrelation.vue');
let wrapper;
const example = () => previewCorrelation({ hostId: 'local', projectId: 'app', openedAt: '2026-11-10T08:00:00Z' });
beforeEach(() => { vi.resetAllMocks(); api.getIncidentCorrelation.mockResolvedValue(example()); });
afterEach(() => { wrapper?.unmount(); wrapper = null; });
const opts = { props: { incidentId: 'a' }, global: { stubs: { BaseModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' } } } };
it('手动关联展示假设限制和来源，时间线可按类型筛选', async () => {
  wrapper = mount(Correlation, opts); expect(api.getIncidentCorrelation).not.toHaveBeenCalled(); await wrapper.find('button').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('尚未通过干预验证因果'); expect(wrapper.findAll('ol li')).toHaveLength(2);
  await wrapper.find('select').setValue('trace'); expect(wrapper.findAll('ol li')).toHaveLength(1); await wrapper.find('ol button').trigger('click'); expect(wrapper.find('pre').text()).toContain('traceId');
});
it('旧故障的迟到请求不污染新故障', async () => {
  let resolve; api.getIncidentCorrelation.mockReturnValue(new Promise(done => { resolve = done; }));
  wrapper = mount(Correlation, opts); await wrapper.find('button').trigger('click'); const signal = api.getIncidentCorrelation.mock.calls[0][1]; await wrapper.setProps({ incidentId: 'b' });
  expect(signal.aborted).toBe(true); resolve(example()); await flushPromises(); expect(wrapper.find('ol').exists()).toBe(false);
});
it('缓存失活取消读取，不主动在后台重新请求', async () => {
  const visible = ref(true), Host = defineComponent({ components: { Correlation }, setup: () => ({ visible }), template: '<KeepAlive><Correlation v-if="visible" incident-id="a" /></KeepAlive>' });
  wrapper = mount(Host, { global: opts.global }); await wrapper.find('button').trigger('click'); await flushPromises(); const signal = api.getIncidentCorrelation.mock.calls[0][1];
  visible.value = false; await nextTick(); expect(signal.aborted).toBe(true); visible.value = true; await nextTick(); expect(api.getIncidentCorrelation).toHaveBeenCalledTimes(1);
});
