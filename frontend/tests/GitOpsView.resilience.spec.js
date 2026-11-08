import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, reactive, ref } from 'vue';
const mocks = vi.hoisted(() => ({ api: Object.fromEntries(['getProjects', 'getGitOpsRepos', 'getGitOpsDrift', 'getGitOpsHistory', 'addGitOpsRepo', 'updateGitOpsRepo', 'deleteGitOpsRepo', 'syncGitOpsRepo', 'rollbackGitOpsRepo'].map(name => [name, vi.fn()])), toast: { success: vi.fn(), error: vi.fn() }, route: null }));
vi.mock('../src/api/client.js', () => ({ api: mocks.api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => mocks.toast }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));
vi.mock('vue-router', () => ({ useRoute: () => mocks.route }));
import GitOpsView from '../src/views/GitOpsView.vue';
const a = { id: 'repo-a', name: '仓库 A', url: 'https://example.invalid/a.git', branch: 'main', localPath: '/workspace/a', projectId: 'project-a', autoSync: false, sshKey: null, lastCommit: 'aaaaaaa1', status: 'synced' };
const b = { ...a, id: 'repo-b', name: '仓库 B', projectId: 'project-b' };
let wrapper;
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const state = () => wrapper.findComponent(GitOpsView).vm.$.setupState;
async function mountView() {
  wrapper = mount(GitOpsView, { global: { stubs: { teleport: true, RouterLink: { props: ['to'], template: '<a><slot/></a>' } } } });
  await flushPromises(); return state();
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.route = reactive({ query: {} });
  mocks.api.getGitOpsRepos.mockResolvedValue({ repositories: [{ ...a }, { ...b }] });
  mocks.api.getProjects.mockResolvedValue({ projects: [{ id: 'project-a', name: '项目 A' }] });
  mocks.api.getGitOpsDrift.mockResolvedValue({ repos: [], counts: {} });
  mocks.api.getGitOpsHistory.mockResolvedValue({ commits: [{ hash: 'bbbbbbb2', date: '2026-11-01T00:00:00Z', message: 'previous', author: 'tester' }] });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; });

describe('GitOps 连续操作、失败恢复与上下文隔离', () => {
  it('历史请求符合真实 API 的 100 条上限', async () => {
    const vm = await mountView(); await vm.loadHistory(a.id);
    expect(mocks.api.getGitOpsHistory).toHaveBeenCalledWith(a.id, 100);
  });
  it('编辑只发送可编辑字段，把空 SSH 路径规范成字符串', async () => {
    const vm = await mountView(); vm.openEditModal(a); mocks.api.updateGitOpsRepo.mockResolvedValue({ ...a, name: '已修改' });
    await vm.updateRepo();
    expect(mocks.api.updateGitOpsRepo).toHaveBeenCalledWith(a.id, { name: a.name, url: a.url, branch: 'main', localPath: a.localPath, projectId: a.projectId, autoSync: false, sshKey: '' });
  });
  it('保存等待有 busy 且重复提交只写入一次，失败保留草稿与窗口', async () => {
    const pending = deferred(); mocks.api.updateGitOpsRepo.mockReturnValue(pending.promise);
    const vm = await mountView(); vm.openEditModal(a); vm.formData.name = '未保存草稿';
    const first = vm.updateRepo(); const second = vm.updateRepo(); await flushPromises();
    expect(mocks.api.updateGitOpsRepo).toHaveBeenCalledTimes(1); expect(vm.saving).toBe(true);
    pending.reject(new Error('无法保存')); await Promise.all([first, second]); await flushPromises();
    expect(vm.showEditModal).toBe(true); expect(vm.formData.name).toBe('未保存草稿');
    expect(wrapper.get('[role="dialog"]').text()).toContain('无法保存'); expect(vm.saving).toBe(false);
  });
  it('新增已确认后立即显示记录，刷新失败不反转成功', async () => {
    const vm = await mountView(); vm.openAddModal(); vm.formData = { ...a, name: '新仓库' };
    mocks.api.addGitOpsRepo.mockResolvedValue({ ...a, id: 'repo-new', name: '新仓库' });
    mocks.api.getGitOpsRepos.mockRejectedValue(new Error('刷新断网'));
    await vm.addRepo(); await flushPromises();
    expect(vm.repos.some(repo => repo.id === 'repo-new')).toBe(true); expect(vm.showAddModal).toBe(false);
    expect(wrapper.text()).toContain('仓库已添加'); expect(wrapper.text()).toContain('刷新断网');
  });
  it('删除等待保留确认门，失败可原地重试', async () => {
    const pending = deferred(); mocks.api.deleteGitOpsRepo.mockReturnValueOnce(pending.promise);
    const vm = await mountView(); await vm.deleteRepo(a.id); const first = vm.confirmDelete(); await vm.confirmDelete(); await flushPromises();
    expect(vm.deleteTarget).toBeTruthy(); expect(mocks.api.deleteGitOpsRepo).toHaveBeenCalledTimes(1);
    pending.reject(new Error('仓库忙')); await first; await flushPromises();
    expect(wrapper.get('[role="dialog"]').text()).toContain('仓库忙'); expect(vm.deleteTarget).toBeTruthy();
    mocks.api.deleteGitOpsRepo.mockResolvedValue({ ok: true }); mocks.api.getGitOpsRepos.mockRejectedValue(new Error('刷新失败'));
    await vm.confirmDelete(); await flushPromises(); expect(vm.repos.some(repo => repo.id === a.id)).toBe(false);
  });
  it('同步成功立即更新提交、刷新漂移并提供配置应用入口', async () => {
    const vm = await mountView(); mocks.api.syncGitOpsRepo.mockResolvedValue({ ok: true, commit: 'ccccccc3', syncedAt: '2026-11-09T00:00:00Z', hasChanges: true });
    mocks.api.getGitOpsRepos.mockRejectedValue(new Error('刷新失败'));
    await vm.syncRepo(a.id); await flushPromises();
    expect(vm.repos.find(repo => repo.id === a.id).lastCommit).toBe('ccccccc3');
    expect(mocks.api.getGitOpsDrift).toHaveBeenCalledTimes(2); expect(wrapper.text()).toContain('尚未应用到容器');
    expect(wrapper.text()).toContain('检查并应用配置');
  });
  it('回滚固定仓库和提交，失败保持确认，完成不误报部署', async () => {
    const pending = deferred(); mocks.api.rollbackGitOpsRepo.mockReturnValueOnce(pending.promise);
    const vm = await mountView(); await vm.loadHistory(a.id); await vm.rollback('bbbbbbb2'); const first = vm.confirmRollback();
    await vm.confirmRollback(); expect(mocks.api.rollbackGitOpsRepo).toHaveBeenCalledTimes(1);
    expect(vm.rollbackTarget).toBeTruthy(); pending.reject(new Error('不能回滚')); await first; await flushPromises();
    expect(wrapper.text()).toContain('不能回滚'); expect(vm.showHistoryModal).toBe(true);
    mocks.api.rollbackGitOpsRepo.mockResolvedValue({ ok: true, commit: 'bbbbbbb2' }); mocks.api.getGitOpsRepos.mockRejectedValue(new Error('列表暂不可用'));
    await vm.confirmRollback(); await flushPromises();
    expect(vm.repos.find(repo => repo.id === a.id)).toMatchObject({ lastCommit: 'bbbbbbb2', status: 'rolled_back' });
    expect(wrapper.text()).toContain('尚未应用到容器');
  });
  it('关闭深链历史后刷新列表不重新弹开', async () => {
    mocks.route.query.repo = a.id; const vm = await mountView(); expect(vm.showHistoryModal).toBe(true);
    vm.showHistoryModal = false; await vm.loadRepos(); expect(vm.showHistoryModal).toBe(false);
  });
  it('读取项目失败可见局部重试，不把失败当成没有项目', async () => {
    mocks.api.getProjects.mockRejectedValueOnce(new Error('项目服务断开')); const vm = await mountView(); vm.openAddModal(); await flushPromises();
    expect(wrapper.get('[role="dialog"]').text()).toContain('项目服务断开');
    expect(wrapper.get('[role="dialog"]').text()).toContain('重试项目');
  });
  it('宿主切换取消旧窗口，迟到保存不污染新上下文', async () => {
    const pending = deferred(); mocks.api.updateGitOpsRepo.mockReturnValue(pending.promise);
    const vm = await mountView(); vm.openEditModal(a); const first = vm.updateRepo();
    window.dispatchEvent(new CustomEvent('composeops:host-changed')); await flushPromises();
    expect(vm.showEditModal).toBe(false); pending.resolve({ ...a, name: '旧节点结果' }); await first; await flushPromises();
    expect(wrapper.text()).not.toContain('旧节点结果'); expect(mocks.toast.success).not.toHaveBeenCalled();
  });
  it('卸载后保存结果不发送完成通知', async () => {
    const pending = deferred(); mocks.api.updateGitOpsRepo.mockReturnValue(pending.promise);
    const vm = await mountView(); vm.openEditModal(a); const first = vm.updateRepo(); wrapper.unmount(); wrapper = null;
    pending.resolve(a); await first; expect(mocks.toast.success).not.toHaveBeenCalled();
  });
  it('保存后列表刷新很慢也不困住用户，旧读取不覆盖确认结果', async () => {
    const vm = await mountView(); const old = deferred(); mocks.api.getGitOpsRepos.mockReturnValueOnce(old.promise);
    const loading = vm.loadRepos(); vm.openEditModal(a);
    mocks.api.updateGitOpsRepo.mockResolvedValue({ ...a, name: '保存后的名称' });
    const refresh = deferred(); mocks.api.getGitOpsRepos.mockReturnValueOnce(refresh.promise);
    await vm.updateRepo(); await flushPromises();
    expect(vm.saving).toBe(false); expect(vm.showEditModal).toBe(false);
    old.resolve({ repositories: [{ ...a, name: '旧读取结果' }] }); await loading;
    expect(vm.repos.find(repo => repo.id === a.id).name).toBe('保存后的名称');
    refresh.resolve({ repositories: [{ ...a, name: '保存后的名称' }] }); await flushPromises();
  });
  it('确认回滚后切换历史仓库也只对原仓库执行', async () => {
    const vm = await mountView(); await vm.loadHistory(a.id); vm.rollback('bbbbbbb2');
    await vm.loadHistory(b.id); mocks.api.rollbackGitOpsRepo.mockResolvedValue({ ok: true, commit: 'bbbbbbb2' });
    await vm.confirmRollback(); expect(mocks.api.rollbackGitOpsRepo).toHaveBeenCalledWith(a.id, 'bbbbbbb2');
  });
  it('缓存失活关闭弹窗并阻止旧保存通知，重新激活可继续编辑', async () => {
    const visible = ref(true); const pending = deferred(); mocks.api.updateGitOpsRepo.mockReturnValueOnce(pending.promise);
    // This host deliberately renders the real cached view to exercise its lifecycle.
    const Host = defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(GitOpsView) : null }) });
    wrapper = mount(Host, { global: { stubs: { teleport: true } } }); await flushPromises();
    const vm = state(); vm.openEditModal(a); const saving = vm.updateRepo();
    visible.value = false; await flushPromises(); pending.resolve({ ...a, name: '失活后的结果' }); await saving;
    expect(mocks.toast.success).not.toHaveBeenCalled();
    visible.value = true; await flushPromises(); expect(state().showEditModal).toBe(false); expect(state().saving).toBe(false);
    state().openEditModal(b); await flushPromises(); expect(state().formData.name).toBe(b.name);
  });

  it('真实漂移 API 返回数组时显示仓库结果、计数和扫描时间', async () => {
    mocks.api.getGitOpsDrift.mockResolvedValue([{ repoId: a.id, status: 'diverged', summary: '本地存在配置修改', scannedAt: '2026-11-09T00:00:00Z', drifts: [{ file: 'compose.yml', type: 'modified' }], repairs: [{ action: 'commit-or-restore', description: '提交或恢复本地更改' }] }, { repoId: b.id, status: 'error', summary: '无法读取仓库', drifts: [], repairs: [] }]);
    await mountView(); expect(wrapper.text()).toContain('本地存在配置修改'); expect(wrapper.text()).toContain('有差异 1');
    expect(wrapper.text()).toContain('扫描失败 1'); expect(wrapper.text()).toContain('compose.yml');
    expect(wrapper.text()).not.toContain('commit-or-restore');
  });

});
