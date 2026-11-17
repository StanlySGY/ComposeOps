import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, nextTick } from 'vue';
const api = vi.hoisted(() => ({ getSreResource: vi.fn(), sreOperation: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { default: Releases } = await import('../src/components/ReliabilityReleases.vue');
let wrapper;
const profiles = ['api', 'web'].map(serviceName => ({ id: serviceName, serviceName, enabled: true, hostId: 'local', projectId: 'app', projectName: '应用' }));
const release = () => ({ id: 'release', status: 'reviewed', hostId: 'local', createdAt: Date.now(), fingerprint: 'fixed-review', result: {}, review: { projectName: '应用', order: ['api', 'web'], services: [], graph: { edges: [] }, rollbackScope: '只回退镜像' } });
const options = { props: { profiles }, global: { stubs: { BaseModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' } } } };
beforeEach(() => { vi.resetAllMocks(); api.getSreResource.mockResolvedValue({ releases: [release()] }); api.sreOperation.mockResolvedValue({}); });
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); });
it('审批固定评审指纹，兼容性单独确认，回退默认不授权', async () => {
  wrapper = mount(Releases, options); await flushPromises(); await wrapper.findAll('button').find(row => row.text() === '审阅并批准').trigger('click');
  expect(wrapper.find('form button').attributes('disabled')).toBeDefined(); await wrapper.find('input[type=checkbox]').setValue(true); await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(api.sreOperation).toHaveBeenCalledWith('releases/release/approve', { confirm: 'APPLY_APPLICATION_RELEASE', fingerprint: 'fixed-review', allowRollback: false, compatibilityConfirmed: true });
});
it('失活取消轮询与迟到请求，不在后台派发', async () => {
  vi.useFakeTimers(); let resolve; api.getSreResource.mockReturnValue(new Promise(done => { resolve = done; }));
  const visible = ref(true), Host = defineComponent({ components: { Releases }, setup: () => ({ visible, profiles }), template: '<KeepAlive><Releases v-if="visible" :profiles="profiles" /></KeepAlive>' });
  wrapper = mount(Host, { global: options.global }); await nextTick(); const signal = api.getSreResource.mock.calls[0][1]; visible.value = false; await nextTick(); expect(signal.aborted).toBe(true); resolve({ releases: [release()] }); await flushPromises(); await vi.advanceTimersByTimeAsync(20000);
  expect(api.getSreResource).toHaveBeenCalledTimes(1); expect(api.sreOperation).not.toHaveBeenCalled();
});
