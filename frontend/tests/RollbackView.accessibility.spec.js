import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, ref } from 'vue';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';

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
  api: { getVolumeBackups, getBackups, restoreBackup, restoreVolumeBackup, streamRollback,
    getGitOpsRepos: () => gitRequest('/api/v1/gitops'),
    getGitOpsHistory: (id, limit, signal) => gitRequest(`/api/v1/gitops/${id}/history?limit=${limit}`, { signal }),
    rollbackGitOpsRepo: (id, commitHash) => gitRequest(`/api/v1/gitops/${id}/rollback`, { method: 'POST', body: JSON.stringify({ commitHash }) }),
  },
}));
vi.mock('../src/stores/services.js', () => ({ useServicesStore: () => store }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));

import RollbackView from '../src/views/RollbackView.vue';

async function gitRequest(url, init) { const response = await fetch(url, init); const data = await response.json(); if (!response.ok) throw new Error(data.message || '请求失败'); return data; }
let wrapper;
beforeEach(() => {
  getVolumeBackups.mockReset();
  getBackups.mockReset();
  restoreBackup.mockReset();
  restoreVolumeBackup.mockReset();
  streamRollback.mockReset();
  store.refresh.mockClear().mockResolvedValue(undefined);
  getVolumeBackups.mockResolvedValue({ backups: [] });
  getBackups.mockResolvedValue({ backups: [{ id: 'upgrade-a', projectId: 'a', filePath: 'compose.yml', reason: 'upgrade', createdAt: '2026-11-05T00:00:00' }] });
  restoreBackup.mockResolvedValue({ ok: true });
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
          template: '<div v-if="show" class="confirm-stub"><p>{{ title }} {{ message }}</p><slot/><button @click="$emit(\'confirm\')">{{ confirmText }}</button><button @click="$emit(\'cancel\')">取消</button></div>',
        },
      },
    },
  });
}

function mountCachedView(visible) {
  return mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(RollbackView) : h('div', '评审') }) }), { global: { stubs: { BaseModal: true, ConfirmDialog: true } } });
}

describe('回滚中心加载反馈与执行结果语义', () => {
  it('恢复指定备份只写该版本，不再触发最近升级批次覆盖；提供评审发布入口', async () => {
    wrapper = mountView(); await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '恢复').trigger('click');
    expect(wrapper.get('.confirm-stub').text()).toContain('运行中的容器不会重建');
    await wrapper.get('.confirm-stub button').trigger('click'); await flushPromises();
    expect(restoreBackup).toHaveBeenCalledWith('a', 'upgrade-a');
    expect(streamRollback).not.toHaveBeenCalled();
    expect(wrapper.get('[aria-label="回滚执行输出"]').text()).toContain('评审并发布');
    expect(wrapper.text()).toContain('评审并发布此配置');
  });

  it('回滚退出码为零但终帧失败时显示失败原因', async () => {
    streamRollback.mockImplementationOnce(async (_id, onFrame) => {
      onFrame({ type: 'exit', data: { code: 0 } });
      onFrame({ type: 'result', data: { ok: false, message: '恢复后验证未通过' } });
    });
    wrapper = mountView(); await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('恢复升级前配置')).trigger('click');
    await wrapper.get('.confirm-stub button').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('回滚失败');
    expect(wrapper.get('[aria-label="回滚执行输出"]').text()).toContain('恢复后验证未通过');
  });

  it('回滚退出码为零但无成功终帧时，仍然是结果未确认', async () => {
    streamRollback.mockImplementationOnce(async (_id, onFrame) => onFrame({ type: 'exit', data: { code: 0 } }));
    wrapper = mountView(); await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('恢复升级前配置')).trigger('click');
    await wrapper.get('.confirm-stub button').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('回滚结果未确认');
  });
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
    await wrapper.findAll('button').find(button => button.text().includes('恢复升级前配置')).trigger('click');
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
    const rollbackButton = wrapper.findAll('button').find(button => button.text().includes('恢复升级前配置'));
    await rollbackButton.trigger('click');
    await wrapper.get('.confirm-stub button').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('回滚失败');
    expect(wrapper.get('[role="region"][aria-label="回滚执行输出"]').text()).toContain('[退出码 2]');
    expect(store.refresh).toHaveBeenCalledTimes(1); // 仅 onMounted 刷新，不把失败的回滚当成功刷新状态
  });
});

describe('缓存回滚生命周期', () => {
  it('隐藏后迟到备份不能提交到页面，返回重读且保持项目选择', async () => {
    const visible = ref(true);
    let resolveOld;
    getVolumeBackups.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    wrapper = mountCachedView(visible);
    await flushPromises();
    visible.value = false; await flushPromises();
    resolveOld({ backups: [{ id: 'old', volume: 'STALE-VOLUME' }] }); await flushPromises();
    visible.value = true; await flushPromises();
    expect(getVolumeBackups).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).not.toContain('STALE-VOLUME');
    await wrapper.get('select').setValue('b'); await flushPromises();
    visible.value = false; await flushPromises();
    window.dispatchEvent(new Event('composeops:refresh'));
    const count = getVolumeBackups.mock.calls.length;
    visible.value = true; await flushPromises();
    expect(wrapper.get('select').element.value).toBe('b');
    expect(getVolumeBackups).toHaveBeenCalledTimes(count);
  });
});

it('首次项目刷新期间离开标签，回来后仍加载备份', async () => {
  const visible = ref(true);
  let resolveProjects;
  store.refresh.mockReturnValueOnce(new Promise(resolve => { resolveProjects = resolve; }));
  wrapper = mountCachedView(visible);
  visible.value = false; await flushPromises();
  resolveProjects(); await flushPromises();
  expect(getVolumeBackups).not.toHaveBeenCalled();
  visible.value = true; await flushPromises();
  expect(getVolumeBackups).toHaveBeenCalledTimes(1);
});


const gitRepo = { id: 'repo-a', name: '仓库 A', projectId: 'a', lastCommit: 'a'.repeat(40) };
const gitCommit = { hash: 'b'.repeat(40), message: '合成历史提交', author: '测试', date: '2026-11-28' };
function mockGitops({ heldHistory = false, rollbackFailure = false } = {}) {
  let releaseHistory;
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    requests.push({ url, init });
    let body = { repositories: [gitRepo] }, status = 200;
    if (url.includes('/history')) {
      if (heldHistory) await new Promise(resolve => { releaseHistory = resolve; });
      body = { commits: [gitCommit] };
    }
    if (url.endsWith('/rollback')) { body = rollbackFailure ? { message: '仓库暂时忙碌' } : { ok: true, commit: gitCommit.hash }; status = rollbackFailure ? 409 : 200; }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return { requests, release: () => releaseHistory() };
}
async function openHistory() { await wrapper.findAll('button').find(button => button.text() === '历史').trigger('click'); await flushPromises(); }

it('历史请求立即显示加载状态，关闭后迟到结果不重新打开', async () => {
  const fixture = mockGitops({ heldHistory: true }); wrapper = mountView(); await flushPromises(); await openHistory();
  expect(wrapper.text()).toContain('正在读取提交历史');
  const modal = wrapper.findAll('.modal-stub').find(item => item.text().includes('正在读取提交历史'));
  await modal.findAll('button').find(button => button.text() === '关闭').trigger('click'); fixture.release(); await flushPromises();
  expect(wrapper.text()).not.toContain('合成历史提交'); expect(wrapper.findAll('.modal-stub')).toHaveLength(0);
});

it('GitOps 回滚失败保留确认框并在框内显示错误', async () => {
  mockGitops({ rollbackFailure: true }); wrapper = mountView(); await flushPromises(); await openHistory();
  await wrapper.findAll('button').find(button => button.text() === '回滚').trigger('click');
  await wrapper.get('.confirm-stub button').trigger('click'); await flushPromises();
  expect(wrapper.find('.confirm-stub').exists()).toBe(true);
  expect(wrapper.get('.confirm-stub').text()).toContain('仓库暂时忙碌');
});

it('GitOps 回滚成功明确说明工作区变化，保留后续检查入口', async () => {
  mockGitops(); wrapper = mountView(); await flushPromises(); await openHistory();
  await wrapper.findAll('button').find(button => button.text() === '回滚').trigger('click');
  await wrapper.get('.confirm-stub button').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('工作区已回滚'); expect(wrapper.text()).toContain('运行中的容器尚未应用');
});

it('身份变化后迟到的 GitOps 历史不能继续显示', async () => {
  const fixture = mockGitops({ heldHistory: true }); wrapper = mountView(); await flushPromises(); await openHistory();
  advanceAuthEpoch(); fixture.release(); await flushPromises();
  expect(wrapper.text()).not.toContain('合成历史提交'); expect(wrapper.text()).not.toContain('仓库 A');
});

it('旧节点配置恢复完成后不能刷新新节点或覆盖其输出', async () => {
  let finish; restoreBackup.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  wrapper = mountView(); await flushPromises();
  await wrapper.findAll('button').find(button => button.text() === '恢复').trigger('click');
  await wrapper.get('.confirm-stub button').trigger('click'); await flushPromises();
  window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises(); const refreshes = store.refresh.mock.calls.length;
  finish({ ok: true }); await flushPromises();
  expect(store.refresh).toHaveBeenCalledTimes(refreshes); expect(wrapper.text()).not.toContain('已恢复所选备份');
});


it('本人密码轮换后恢复读取，保留项目选择且仍可打开历史', async () => {
  mockGitops(); wrapper = mountView(); await flushPromises();
  await wrapper.get('select').setValue('b'); await flushPromises();
  advanceAuthEpoch({ identityChanged: false }); await flushPromises();
  expect(wrapper.get('select').element.value).toBe('b');
  await openHistory(); expect(wrapper.text()).toContain('合成历史提交');
});

it('旧节点操作 finally 不得结束新节点正在执行的恢复', async () => {
  let oldFinish, newFinish;
  restoreBackup.mockReturnValueOnce(new Promise(resolve => { oldFinish = resolve; })).mockReturnValueOnce(new Promise(resolve => { newFinish = resolve; }));
  wrapper = mountView(); await flushPromises();
  const restore = async () => { await wrapper.findAll('button').find(button => button.text() === '恢复').trigger('click'); await wrapper.get('.confirm-stub button').trigger('click'); await flushPromises(); };
  await restore(); window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises(); await restore();
  oldFinish({ ok: true }); await flushPromises();
  expect(wrapper.find('.page-shell').attributes('aria-busy')).toBe('true');
  expect(wrapper.get('[aria-label="回滚执行输出"]').text()).not.toContain('已恢复所选备份');
  newFinish({ ok: true }); await flushPromises();
  expect(wrapper.find('.page-shell').attributes('aria-busy')).toBe('false');
  expect(wrapper.get('[aria-label="回滚执行输出"]').text()).toContain('已恢复所选备份');
});
