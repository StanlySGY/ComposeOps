import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, nextTick } from 'vue';
const api = vi.hoisted(() => ({ getSreResource: vi.fn(), getSreTargets: vi.fn(), sreOperation: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { default: Onboarding } = await import('../src/components/ApplicationOnboarding.vue');
let wrapper, records;
const context = () => ({ projectName: '应用', services: ['web', 'db'], profiles: [{ id: 'p', hostId: 'local', projectId: 'app', serviceName: 'web', enabled: true, version: 1, config: { url: 'http://localhost/health' } }], recoveryPlans: [], recovery: { supported: false, limitations: '应用没有完整工作区' }, notifications: { ready: false, channels: [] } });
const options = { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } };
const click = async text => { const button = wrapper.findAll('button').find(row => row.text() === text); expect(button, text).toBeTruthy(); await button.trigger('click'); await flushPromises(); };
const host = visible => defineComponent({ components: { Onboarding }, setup: () => ({ visible }), template: '<KeepAlive><Onboarding v-if="visible" /></KeepAlive>' });
beforeEach(() => {
  vi.resetAllMocks(); records = []; api.getSreTargets.mockResolvedValue({ targets: [{ hostId: 'local', projectId: 'app', projectName: '应用', services: ['web', 'db'] }] });
  api.getSreResource.mockImplementation(async path => path.includes('/context') ? context() : { drafts: records });
  api.sreOperation.mockImplementation(async (path, body) => {
    if (path.endsWith('/apply')) { records[0].status = 'complete'; records[0].progress = { recovery: { status: 'deferred', reason: '没有业务数据库' }, autonomy: { status: 'configured', enabled: false } }; return { draft: structuredClone(records[0]) }; }
    const draft = { id: 'draft', version: 1, hostId: 'local', projectId: 'app', projectName: '应用', fingerprint: 'x'.repeat(64), status: 'draft', progress: {}, config: structuredClone(body.config) }; records = [draft]; return { draft };
  });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; });
it('完整流程默认关闭自动修复，审阅后提交，灾备待配置不会伪装完成', async () => {
  wrapper = mount(Onboarding, options); await flushPromises(); await click('接入一个应用'); await wrapper.find('select').setValue('local:app'); await flushPromises();
  await click('下一步'); expect(wrapper.text()).toContain('健康目标'); await click('下一步'); await wrapper.find('textarea').setValue('没有业务数据库');
  await click('下一步'); expect(wrapper.text()).toContain('尚无启用'); await click('下一步'); expect(wrapper.find('input[type=checkbox]').element.checked).toBe(false);
  await click('下一步'); await click('确认配置并接入');
  expect(api.sreOperation.mock.calls[0][1].config.autonomy.enabled).toBe(false); expect(api.sreOperation.mock.calls[1][1].autonomyConfirm).toBeUndefined();
  expect(wrapper.text()).toContain('接入配置已提交'); expect(wrapper.text()).toContain('待配置'); expect(wrapper.text()).toContain('没有业务数据库');
});
it('晚到的应用上下文不会覆盖新选择，切出缓存中止请求', async () => {
  let resolve; api.getSreResource.mockImplementation(path => path.includes('/context') ? new Promise(done => { resolve = done; }) : Promise.resolve({ drafts: [] }));
  const visible = ref(true); wrapper = mount(host(visible), options); await flushPromises(); await click('接入一个应用'); await wrapper.find('select').setValue('local:app');
  const signal = api.getSreResource.mock.calls.at(-1)[1]; visible.value = false; await nextTick(); expect(signal.aborted).toBe(true); resolve(context()); await flushPromises();
  visible.value = true; await nextTick(); await flushPromises(); expect(wrapper.text()).not.toContain('应用没有完整工作区');
});
it('部分提交显示错误且允许恢复，自动授权必须单独确认', async () => {
  wrapper = mount(Onboarding, options); await flushPromises(); await click('接入一个应用'); await wrapper.find('select').setValue('local:app'); await flushPromises(); await click('下一步'); await click('下一步'); await wrapper.find('textarea').setValue('没有业务数据库'); await click('下一步'); await click('下一步');
  await wrapper.find('input[type=checkbox]').setValue(true); await click('下一步'); expect(wrapper.findAll('button').find(row => row.text() === '确认配置并接入').attributes('disabled')).toBeDefined();
  await wrapper.find('input[type=checkbox]').setValue(true);
  api.sreOperation.mockImplementationOnce(async (_path, body) => ({ draft: { id: 'partial', version: 1, hostId: 'local', projectId: 'app', fingerprint: 'x'.repeat(64), config: structuredClone(body.config), progress: {}, status: 'draft' } }));
  api.sreOperation.mockImplementationOnce(async () => ({ draft: { id: 'partial', version: 1, config: {}, progress: { health: { status: 'configured' } }, status: 'partial', error: '通知渠道未启用' } }));
  await click('确认配置并接入'); expect(wrapper.text()).toContain('通知渠道未启用'); expect(wrapper.text()).toContain('恢复未完成步骤'); expect(api.sreOperation.mock.calls.at(-1)[1].autonomyConfirm).toBe('ENABLE_AUTONOMY');
});
