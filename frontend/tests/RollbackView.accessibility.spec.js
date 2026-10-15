import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const getVolumeBackups = vi.hoisted(() => vi.fn());
const getBackups = vi.hoisted(() => vi.fn());
const restoreBackup = vi.hoisted(() => vi.fn());
const restoreVolumeBackup = vi.hoisted(() => vi.fn());
const streamRollback = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  projects: [
    { id: 'a', projectName: '项目 A', managed: true, editable: true, status: 'stopped' },
    { id: 'b', projectName: '项目 B', managed: true, editable: true, status: 'stopped' },
  ],
  refresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/api/client.js', () => ({
  api: { getVolumeBackups, getBackups, restoreBackup, restoreVolumeBackup, streamRollback },
}));
vi.mock('../src/stores/services.js', () => ({ useServicesStore: () => store }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));

import RollbackView from '../src/views/RollbackView.vue';

let wrapper;
beforeEach(() => {
  getVolumeBackups.mockReset();
  getBackups.mockReset();
  restoreBackup.mockReset();
  restoreVolumeBackup.mockReset();
  streamRollback.mockReset();
  store.refresh.mockClear().mockResolvedValue(undefined);
  getVolumeBackups.mockResolvedValue({ backups: [] });
  getBackups.mockResolvedValue({ backups: [] });
  restoreBackup.mockResolvedValue(undefined);
  restoreVolumeBackup.mockResolvedValue({ message: '数据卷恢复完成' });
  streamRollback.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ repositories: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});
function mountView() {
  return mount(RollbackView, {
    global: {
      stubs: {
        BaseModal: { props: ['show', 'title', 'sizeClass', 'bodyClass'], template: '<div v-if="show" class="modal-stub"><slot name="header-actions"/><slot/><slot name="footer"/></div>' },
        ConfirmDialog: {
          props: ['show', 'confirmText', 'title', 'message'],
          template: '<div v-if="show" class="confirm-stub"><p>{{ title }} {{ message }}</p><button @click="$emit(\'confirm\')">{{ confirmText }}</button><button @click="$emit(\'cancel\')">取消</button></div>',
        },
      },
    },
  });
}

describe('回滚中心加载反馈与执行结果语义', () => {
  it('数据卷备份读取失败时播报错误，不伪装成没有备份', async () => {
    getVolumeBackups.mockRejectedValueOnce(new Error('storage offline'));
    wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('数据卷备份加载失败');
    expect(wrapper.findAll('.section-panel')[1].text()).not.toContain('暂无数据卷备份');
    expect(wrapper.find('.page-shell').attributes('aria-busy')).toBe('false');
  });

  it('GitOps 和 Compose 备份来源失败时分别说明，不显示误导性的空列表', async () => {
    getBackups.mockRejectedValue(new Error('backup index unavailable'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'git service unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })));
    wrapper = mountView();
    await flushPromises();

    const alerts = wrapper.findAll('[role="alert"]').map(alert => alert.text());
    expect(alerts.some(message => message.includes('GitOps 仓库加载失败'))).toBe(true);
    expect(alerts.some(message => message.includes('Compose 配置备份加载失败'))).toBe(true);
    expect(wrapper.findAll('.section-panel')[0].text()).not.toContain('暂无 Compose 配置备份');
    expect(wrapper.findAll('.section-panel')[2].text()).not.toContain('暂无 GitOps 仓库');
  });

  it('项目选择快速切换时，迟到的旧项目请求不能覆盖新项目备份', async () => {
    let resolveA;
    getBackups.mockImplementation((projectId) => {
      if (projectId === 'a') return new Promise(resolve => { resolveA = resolve; });
      return Promise.resolve({ backups: [{ id: 'backup-b', projectId: 'b', filePath: 'compose-b.yml', createdAt: '2026-10-15T05:00:00' }] });
    });
    wrapper = mountView();
    // 等待 mounted 初始化加载启动,其请求仍被有意挂起。
    await vi.waitFor(() => expect(getBackups).toHaveBeenCalledWith('a'));
    await wrapper.get('select[aria-label="选择项目"]').setValue('b');
    await vi.waitFor(() => expect(wrapper.text()).toContain('compose-b.yml'));

    resolveA({ backups: [{ id: 'backup-a', projectId: 'a', filePath: 'STALE-compose-a.yml', createdAt: '2026-10-15T04:00:00' }] });
    await flushPromises();
    expect(wrapper.text()).toContain('compose-b.yml');
    expect(wrapper.text()).not.toContain('STALE-compose-a.yml');
  });

  it('回滚 SSE 缺少退出码时播报结果未确认，不能假报成功', async () => {
    streamRollback.mockResolvedValueOnce(undefined);
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('回滚升级')).trigger('click');
    await wrapper.get('.confirm-stub button').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('回滚结果未确认');
    expect(wrapper.get('[role="region"][aria-label="回滚执行输出"]').text()).toContain('未收到 Compose 退出码');
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });

  it('回滚 SSE 正常结束但退出码非零时，状态仍为失败并朗读输出', async () => {
    streamRollback.mockImplementationOnce(async (_projectId, onFrame) => {
      onFrame({ type: 'stderr', data: '容器启动失败' });
      onFrame({ type: 'exit', data: { code: 2 } });
    });
    wrapper = mountView();
    await flushPromises();
    const rollbackButton = wrapper.findAll('button').find(button => button.text().includes('回滚升级'));
    await rollbackButton.trigger('click');
    await wrapper.get('.confirm-stub button').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('回滚失败');
    expect(wrapper.get('[role="region"][aria-label="回滚执行输出"]').text()).toContain('[退出码 2]');
    expect(store.refresh).toHaveBeenCalledTimes(1); // 仅 onMounted 刷新，不把失败的回滚当成功刷新状态
  });
});
