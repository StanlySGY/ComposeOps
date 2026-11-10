import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, nextTick } from 'vue';
const api = vi.hoisted(() => ({ getSreResource: vi.fn(), getSreTargets: vi.fn(), sreOperation: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { default: Telemetry } = await import('../src/components/ReliabilityTelemetry.vue');
const Modal = { props: ['show'], template: '<div v-if="show"><slot /></div>' };
let wrapper;
const host = visible => defineComponent({ components: { Telemetry }, setup: () => ({ visible }), template: '<KeepAlive><Telemetry v-if="visible" /></KeepAlive>' });
beforeEach(() => { vi.resetAllMocks(); api.getSreResource.mockResolvedValue({ credentials: [] }); api.getSreTargets.mockResolvedValue({ targets: [
  { hostId: 'a', projectId: 'x', projectName: '应用甲', services: ['web', 'db'] }, { hostId: 'b', projectId: 'y', projectName: '应用乙', services: ['api'] },
] }); api.sreOperation.mockResolvedValue({ token: 'only-once-value' }); });
afterEach(() => { wrapper?.unmount(); wrapper = null; });
const mountOptions = { global: { stubs: { BaseModal: Modal } } };
it('凭据只能使用已选应用的服务，切换范围清空选择，创建后一次显示', async () => {
  wrapper = mount(Telemetry, mountOptions); await flushPromises(); await wrapper.find('button').trigger('click');
  await wrapper.find('input').setValue('测试'); await wrapper.find('select').setValue('a:x'); await wrapper.find('input[type=checkbox]').setValue(true);
  await wrapper.find('select').setValue('b:y'); expect(wrapper.find('form button').attributes('disabled')).toBeDefined();
  await wrapper.find('input[type=checkbox]').setValue(true); await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(api.sreOperation).toHaveBeenCalledWith('telemetry/credentials', { name: '测试', hostId: 'b', projectId: 'y', services: ['api'] });
  expect(wrapper.find('textarea').element.value).toBe('only-once-value');
});
it('切出缓存清除密钥并取消读取，返回只加载一次', async () => {
  const visible = ref(true), Host = host(visible);
  wrapper = mount(Host, mountOptions); await flushPromises(); await wrapper.find('button').trigger('click');
  await wrapper.find('select').setValue('a:x'); await wrapper.find('input[type=checkbox]').setValue(true); await wrapper.find('form').trigger('submit'); await flushPromises();
  const count = api.getSreResource.mock.calls.length, signal = api.getSreResource.mock.calls.at(-1)[1];
  visible.value = false; await nextTick(); expect(signal.aborted).toBe(true); visible.value = true; await nextTick(); await flushPromises();
  expect(api.getSreResource).toHaveBeenCalledTimes(count + 1); expect(wrapper.find('textarea').exists()).toBe(false);
});
it('创建期间离开页面不会重新展示迟到密钥', async () => {
  let resolve; api.sreOperation.mockReturnValue(new Promise(done => { resolve = done; }));
  const visible = ref(true), Host = host(visible);
  wrapper = mount(Host, mountOptions); await flushPromises(); await wrapper.find('button').trigger('click'); await wrapper.find('select').setValue('a:x'); await wrapper.find('input[type=checkbox]').setValue(true); await wrapper.find('form').trigger('submit');
  visible.value = false; await nextTick(); resolve({ token: 'late-secret' }); await flushPromises(); visible.value = true; await nextTick(); await flushPromises();
  expect(wrapper.html()).not.toContain('late-secret'); expect(wrapper.find('textarea').exists()).toBe(false);
});
