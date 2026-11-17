import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, nextTick } from 'vue';
const api = vi.hoisted(() => ({ getSreResource: vi.fn(), getSreTargets: vi.fn(), sreOperation: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const { default: Business } = await import('../src/components/ReliabilityBusiness.vue');
let wrapper;
const plan = { id: 'p', hostId: 'local', projectId: 'app', projectName: '应用', version: 1, enabled: true, config: { engine: 'postgres', dbService: 'db', appService: 'web', database: 'biz', assertions: [{ table: 'items' }], rpoMinutes: 60, rtoMinutes: 10 } };
const state = () => ({ plans: [structuredClone(plan)], backups: [{ id: 'backup-fixed', planId: 'p', version: 1, status: 'verified', createdAt: Date.now(), snapshot: { plan }, result: { sha256: 'sha', bytes: 100, snapshotAt: Date.now() } }], runs: [{ id: 'r', planId: 'p', status: 'failed', snapshot: { plan }, result: { businessRecoveryVerified: false, assertions: [{ passed: true }], httpChecks: [{ passed: false }], cleanupComplete: true }, error: '业务 HTTP 未通过' }] });
const options = { global: { stubs: { BaseModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' } } } };
beforeEach(() => { vi.resetAllMocks(); api.getSreResource.mockResolvedValue(state()); api.getSreTargets.mockResolvedValue({ targets: [] }); api.sreOperation.mockResolvedValue({}); });
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); });
it('恢复依赖指定备份确认，SQL 通过但 HTTP 失败不显示成功', async () => {
  wrapper = mount(Business, options); await flushPromises(); expect(wrapper.text()).toContain('业务 HTTP 未通过'); expect(wrapper.text()).not.toContain('业务恢复通过');
  await wrapper.findAll('button').find(row => row.text() === '选择备份并演练').trigger('click'); await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(api.sreOperation).toHaveBeenCalledWith('business-recovery/plans/p/run', { confirm: 'ISOLATED_BUSINESS_RECOVERY', backupId: 'backup-fixed' });
});
it('缓存页失活后停止轮询并中止请求，激活只恢复一次', async () => {
  vi.useFakeTimers(); const visible = ref(true), Host = defineComponent({ components: { Business }, setup: () => ({ visible }), template: '<KeepAlive><Business v-if="visible" /></KeepAlive>' });
  wrapper = mount(Host, options); await flushPromises(); const count = api.getSreResource.mock.calls.length, signal = api.getSreResource.mock.calls.at(-1)[1]; visible.value = false; await nextTick(); expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(20000); expect(api.getSreResource).toHaveBeenCalledTimes(count); visible.value = true; await nextTick(); await flushPromises(); expect(api.getSreResource).toHaveBeenCalledTimes(count + 1);
});
