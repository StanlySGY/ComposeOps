import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, KeepAlive, ref } from 'vue';
import { routeLocationKey } from 'vue-router';

const api = vi.hoisted(() => ({ getProjectActivity: vi.fn(), restoreBackup: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
import ProjectActivityDrawer from '../src/components/ProjectActivityDrawer.vue';
import ConfirmDialog from '../src/components/common/ConfirmDialog.vue';

const projectA = { id: 'a', projectName: '项目 A', editable: true, composeFiles: ['/a/compose.yml'] };
const projectB = { id: 'b', projectName: '项目 B', editable: true, composeFiles: ['/b/compose.yml'] };
const operation = { id: 'op-1', action: 'up', status: 'success', detail: 'started', createdAt: '2026-11-09T00:00:00Z' };
const backup = { id: 'backup-1', reason: 'save', filePath: '/a/compose.yml', createdAt: '2026-11-09T00:00:00Z', size: 120 };
const deferred = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };
let wrapper;
const button = text => wrapper.findAll('button').find(item => item.text().trim() === text);
const confirm = () => wrapper.findComponent(ConfirmDialog);
async function open(project = projectA) {
  wrapper = mount(ProjectActivityDrawer, { attachTo: document.body, props: { project }, global: {
    provide: { [routeLocationKey]: { fullPath: '/services' } },
    renderStubDefaultSlot: true,
    stubs: { ConfirmDialog: true, BaseModal: { props: ['show'], template: '<div v-if="show"><slot/></div>' }, RouterLink: { props: ['to'], template: '<a href="#compose"><slot/></a>' } },
  } });
  await flushPromises();
}
async function chooseRestore() {
  await wrapper.findAll('.tabs button')[1].trigger('click');
  await button('恢复').trigger('click'); await flushPromises();
}
beforeEach(() => {
  vi.resetAllMocks();
  api.getProjectActivity.mockResolvedValue({ operations: [operation], backups: [backup] });
  api.restoreBackup.mockResolvedValue({ ok: true });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

describe('项目活动恢复与连续操作', () => {
  it('ISO 时间正常显示，成功与失败有明确状态文本', async () => {
    api.getProjectActivity.mockResolvedValue({ operations: [operation, { ...operation, id: 'failed', status: 'failed' }], backups: [backup] });
    await open();
    expect(wrapper.text()).not.toContain('Invalid Date');
    expect(wrapper.text()).toContain('执行成功');
    expect(wrapper.text()).toContain('执行失败');
    await wrapper.findAll('.tabs button')[1].trigger('click');
    expect(wrapper.text()).not.toContain('Invalid Date');
  });

  it('刷新失败保留已加载记录并支持原地重试', async () => {
    await open();
    api.getProjectActivity.mockRejectedValueOnce(new Error('活动暂不可用'));
    await button('刷新').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('活动暂不可用');
    expect(wrapper.findAll('.activity-item')).toHaveLength(1);
    await button('重试').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.findAll('.activity-item')).toHaveLength(1);
  });

  it('恢复期间保留确认门并防重复，错误原地重试', async () => {
    const request = deferred(); api.restoreBackup.mockReturnValueOnce(request.promise);
    await open(); await chooseRestore();
    confirm().vm.$emit('confirm'); confirm().vm.$emit('confirm'); await flushPromises();
    expect(api.restoreBackup).toHaveBeenCalledExactlyOnceWith('a', 'backup-1');
    expect(confirm().props('show')).toBe(true);
    expect(confirm().props('busy')).toBe(true);
    request.reject(new Error('恢复暂不可用')); await flushPromises();
    expect(confirm().props('show')).toBe(true);
    expect(confirm().props('busy')).toBe(false);
    expect(confirm().text()).toContain('恢复暂不可用');
    confirm().vm.$emit('confirm'); await flushPromises();
    expect(api.restoreBackup).toHaveBeenCalledTimes(2);
  });

  it('恢复成功返回固定项目身份，并保留仅修改文件的后续提示', async () => {
    await open(); await chooseRestore();
    expect(confirm().props('message')).toContain('不会自动更新容器');
    confirm().vm.$emit('confirm'); await flushPromises();
    expect(wrapper.emitted('restored')).toEqual([[{ projectId: 'a', backupId: 'backup-1', filePath: '/a/compose.yml' }]]);
    expect(wrapper.text()).toContain('尚未应用到容器');
  });

  it('切换项目后旧恢复不触发新项目完成回调或额外读取', async () => {
    const request = deferred(); api.restoreBackup.mockReturnValueOnce(request.promise);
    await open(); await chooseRestore(); confirm().vm.$emit('confirm'); await flushPromises();
    api.getProjectActivity.mockResolvedValue({ operations: [], backups: [] });
    await wrapper.setProps({ project: projectB }); await flushPromises();
    const reads = api.getProjectActivity.mock.calls.length;
    request.resolve({ ok: true }); await flushPromises();
    expect(wrapper.emitted('restored')).toBeUndefined();
    expect(api.getProjectActivity).toHaveBeenCalledTimes(reads);
    expect(wrapper.text()).not.toContain('尚未应用到容器');
  });

  it('文件恢复完成后活动刷新慢，不再锁住退出操作', async () => {
    await open(); await chooseRestore();
    const refresh = deferred(); api.getProjectActivity.mockReturnValueOnce(refresh.promise);
    confirm().vm.$emit('confirm'); await flushPromises();
    expect(wrapper.text()).toContain('尚未应用到容器');
    expect(wrapper.get('[aria-label="关闭项目活动"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[aria-label="关闭项目活动"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    refresh.resolve({ operations: [], backups: [] }); await flushPromises();
  });

  it('关闭后迟到恢复不发送完成回调', async () => {
    const request = deferred(); api.restoreBackup.mockReturnValueOnce(request.promise);
    await open(); await chooseRestore(); confirm().vm.$emit('confirm'); await flushPromises();
    await wrapper.setProps({ project: null }); await flushPromises();
    request.resolve({ ok: true }); await flushPromises();
    expect(wrapper.emitted('restored')).toBeUndefined();
  });

  it('换节点即关闭抽屉，旧请求不发出完成回调', async () => {
    const request = deferred(); api.restoreBackup.mockReturnValueOnce(request.promise);
    await open(); await chooseRestore(); confirm().vm.$emit('confirm'); await flushPromises();
    window.dispatchEvent(new CustomEvent('composeops:host-changed')); await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);
    request.resolve({ ok: true }); await flushPromises();
    expect(wrapper.emitted('restored')).toBeUndefined();
  });

  it('配置版本标签可以用方向键切换并把焦点留在当前标签', async () => {
    await open();
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    tabs[0].element.focus(); await tabs[0].trigger('keydown', { key: 'ArrowRight' }); await flushPromises();
    expect(tabs[1].attributes('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1].element);
    await tabs[1].trigger('keydown', { key: 'Home' }); await flushPromises();
    expect(tabs[0].attributes('aria-selected')).toBe('true');
  });
  it('新项目加载失败不保留旧项目记录', async () => {
    await open();
    api.getProjectActivity.mockRejectedValueOnce(new Error('新项目读取失败'));
    await wrapper.setProps({ project: projectB }); await flushPromises();
    expect(wrapper.text()).toContain('新项目读取失败');
    expect(wrapper.findAll('.activity-item')).toHaveLength(0);
    expect(wrapper.findAll('.version-card')).toHaveLength(0);
  });

  it('旧恢复的 finally 不解锁新项目的恢复操作', async () => {
    const oldRequest = deferred(); const newRequest = deferred();
    api.restoreBackup.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    await open(); await chooseRestore(); confirm().vm.$emit('confirm'); await flushPromises();
    api.getProjectActivity.mockResolvedValue({ operations: [], backups: [{ ...backup, id: 'backup-b', filePath: '/b/compose.yml' }] });
    await wrapper.setProps({ project: projectB }); await flushPromises();
    await chooseRestore(); confirm().vm.$emit('confirm'); await flushPromises();
    expect(api.restoreBackup).toHaveBeenLastCalledWith('b', 'backup-b');
    oldRequest.resolve({ ok: true }); await flushPromises();
    expect(confirm().props('busy')).toBe(true);
    expect(wrapper.emitted('restored')).toBeUndefined();
    newRequest.resolve({ ok: true }); await flushPromises();
    expect(confirm().props('busy')).toBe(false);
  });

  it('父页面缓存失活关闭抽屉，迟到恢复不再次发送完成回调', async () => {
    const active = ref(true); const closed = vi.fn(); const restored = vi.fn();
    const Pane = defineComponent({ components: { ProjectActivityDrawer }, setup: () => ({ projectA, closed, restored }), template: '<ProjectActivityDrawer :project="projectA" @close="closed" @restored="restored"/>' });
    const Other = defineComponent({ template: '<p>other page</p>' });
    const request = deferred(); api.restoreBackup.mockReturnValueOnce(request.promise);
    wrapper = mount(defineComponent({ components: { KeepAlive }, setup: () => ({ active, Pane, Other }), template: '<KeepAlive><component :is="active ? Pane : Other"/></KeepAlive>' }), { global: { provide: { [routeLocationKey]: { fullPath: '/services' } }, stubs: { ConfirmDialog: true, BaseModal: true, RouterLink: true } } });
    await flushPromises(); await chooseRestore(); confirm().vm.$emit('confirm'); await flushPromises();
    active.value = false; await flushPromises();
    expect(closed).toHaveBeenCalledTimes(1);
    request.resolve({ ok: true }); await flushPromises();
    expect(restored).not.toHaveBeenCalled();
  });

});
