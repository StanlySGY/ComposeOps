import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const getGitOpsRepos = vi.hoisted(() => vi.fn());
const getGitOpsDrift = vi.hoisted(() => vi.fn());
const getGitOpsHistory = vi.hoisted(() => vi.fn());
const getProjects = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));
const pullRefresh = vi.hoisted(() => ({ callback: null }));

vi.mock('../src/api/client.js', () => ({
  api: { getGitOpsRepos, getGitOpsDrift, getGitOpsHistory, getProjects },
}));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => toast }));
vi.mock('../src/composables/usePullRefresh.js', () => ({
  usePullRefresh: (callback) => { pullRefresh.callback = callback; },
}));

import GitOpsView from '../src/views/GitOpsView.vue';

let wrapper;

beforeEach(() => {
  getGitOpsRepos.mockReset().mockResolvedValue({ repositories: [] });
  getGitOpsDrift.mockReset().mockResolvedValue({ repos: [], counts: {} });
  getGitOpsHistory.mockReset().mockResolvedValue({ commits: [] });
  getProjects.mockReset().mockResolvedValue({ projects: [] });
  toast.error.mockReset();
  toast.success.mockReset();
  toast.info.mockReset();
  pullRefresh.callback = null;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

function mountView() {
  return mount(GitOpsView, {
    global: {
      stubs: {
        BaseModal: {
          props: ['show', 'title', 'sizeClass', 'bodyClass'],
          template: '<div v-if="show"><slot name="header-actions"/><slot/><slot name="footer"/></div>',
        },
        ConfirmDialog: { template: '<div />' },
        EmptyState: {
          props: ['title', 'description', 'actionLabel'],
          template: '<div class="empty-state">{{ title }} {{ description }}<button @click="$emit(\'action\')">{{ actionLabel }}</button></div>',
        },
      },
    },
  });
}

describe('GitOps 页面加载反馈与异步状态语义', () => {
  it('提交历史加载失败会明确播报原因并可重试，不伪装成空历史', async () => {
    getGitOpsRepos.mockResolvedValueOnce({ repositories: [{ id: 'repo-a', name: '仓库 A', url: 'https://example.invalid/a.git', status: 'synced' }] });
    getGitOpsHistory.mockRejectedValueOnce(new Error('git history offline'));
    wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('article').find(article => article.text().includes('仓库 A')).findAll('button').find(button => button.text().includes('历史')).trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('提交历史加载失败');
    expect(wrapper.get('[role="alert"]').text()).toContain('git history offline');
    expect(wrapper.find('.empty-state').exists()).toBe(false);

    await wrapper.get('[role="alert"] button').trigger('click');
    await flushPromises();
    expect(getGitOpsHistory).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('.empty-state').exists()).toBe(true);
  });

  it('快速切换仓库历史时旧请求不能覆盖新仓库结果', async () => {
    getGitOpsRepos.mockResolvedValueOnce({ repositories: [
      { id: 'repo-a', name: '仓库 A', url: 'https://example.invalid/a.git', status: 'synced', lastCommit: 'a-current' },
      { id: 'repo-b', name: '仓库 B', url: 'https://example.invalid/b.git', status: 'synced', lastCommit: 'b-current' },
    ] });
    let resolveA;
    getGitOpsHistory
      .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
      .mockResolvedValueOnce({ commits: [{ hash: 'b-commit', date: 'today', message: '仓库 B 的新提交', author: 'tester' }] });
    wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('article').find(article => article.text().includes('仓库 A')).findAll('button').find(button => button.text().includes('历史')).trigger('click');
    await wrapper.findAll('article').find(article => article.text().includes('仓库 B')).findAll('button').find(button => button.text().includes('历史')).trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('仓库 B 的新提交');

    resolveA({ commits: [{ hash: 'a-commit', date: 'yesterday', message: 'STALE 仓库 A 的历史', author: 'tester' }] });
    await flushPromises();
    expect(wrapper.text()).toContain('仓库 B 的新提交');
    expect(wrapper.text()).not.toContain('STALE 仓库 A 的历史');
  });

  it('仓库列表加载失败时播报原因，不把失败伪装成空仓库列表', async () => {
    getGitOpsRepos.mockRejectedValueOnce(new Error('repository service offline'));
    wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('仓库列表加载失败');
    expect(wrapper.get('[role="alert"]').text()).toContain('repository service offline');
    expect(wrapper.find('.empty-state').exists()).toBe(false);
    expect(wrapper.attributes('aria-busy')).toBe('false');
  });

  it('漂移检测失败有错误播报和可重试操作，重试成功后清除错误', async () => {
    getGitOpsDrift.mockRejectedValueOnce(new Error('git host unavailable'));
    wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('漂移检测失败');
    expect(wrapper.get('[role="alert"]').text()).toContain('git host unavailable');

    await wrapper.get('button[aria-label="重新检测 GitOps 漂移状态"]').trigger('click');
    await flushPromises();

    expect(getGitOpsDrift).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('并发刷新时旧的漂移检测响应不能覆盖较新的结果', async () => {
    let resolveOldRequest;
    getGitOpsDrift.mockImplementationOnce(() => new Promise(resolve => { resolveOldRequest = resolve; }));
    getGitOpsDrift.mockResolvedValueOnce({ repos: [{ repoId: 'repo', summary: 'new result' }], counts: { clean: 0, diverged: 2, behind: 0 } });

    wrapper = mountView();
    await vi.waitFor(() => expect(getGitOpsDrift).toHaveBeenCalledTimes(1));
    expect(typeof pullRefresh.callback).toBe('function');

    await pullRefresh.callback();
    await flushPromises();
    expect(wrapper.text()).toContain('有差异 2');

    resolveOldRequest({ repos: [{ repoId: 'repo', summary: 'stale result' }], counts: { clean: 0, diverged: 1, behind: 0 } });
    await flushPromises();

    expect(wrapper.text()).toContain('有差异 2');
    expect(wrapper.text()).not.toContain('有差异 1');
  });

  it('并发刷新时旧的仓库列表响应不能覆盖较新的数据', async () => {
    let resolveOldRequest;
    getGitOpsRepos.mockImplementationOnce(() => new Promise(resolve => { resolveOldRequest = resolve; }));
    getGitOpsRepos.mockResolvedValueOnce({ repositories: [{ id: 'new-repo', name: 'new repository', url: 'https://example.invalid/repo.git', status: 'synced' }] });

    wrapper = mountView();
    await vi.waitFor(() => expect(getGitOpsRepos).toHaveBeenCalledTimes(1));
    await pullRefresh.callback();
    await flushPromises();
    expect(wrapper.text()).toContain('new repository');

    resolveOldRequest({ repositories: [{ id: 'old-repo', name: 'stale repository', url: 'https://example.invalid/old.git', status: 'synced' }] });
    await flushPromises();

    expect(wrapper.text()).toContain('new repository');
    expect(wrapper.text()).not.toContain('stale repository');
  });
});
