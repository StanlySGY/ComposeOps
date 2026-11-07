import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api } = vi.hoisted(() => ({
  api: {
    getOperations: vi.fn(),
    listJobs: vi.fn(),
    getJob: vi.fn(),
    streamJobUpdates: vi.fn(),
  },
}));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));

import OperationsView from '../src/views/OperationsView.vue';

let wrapper;
let router;

beforeEach(async () => {
  localStorage.clear();
  api.getOperations.mockReset().mockResolvedValue({ operations: [] });
  api.listJobs.mockReset().mockResolvedValue({ jobs: [] });
  api.getJob.mockReset();
  api.streamJobUpdates.mockReset();
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  });
  await router.push('/');
  await router.isReady();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  localStorage.clear();
});

async function mountView() {
  wrapper = mount(OperationsView, {
    attachTo: document.body,
    global: {
      plugins: [router],
      stubs: {
        StatusBadge: true,
        EmptyState: true,
        BaseModal: { props: ['show'], emits: ['close'], template: '<div v-if="show" role="dialog"><button @click="$emit(\'close\')">关闭详情</button><slot /></div>' },
      },
    },
  });
  await flushPromises();
}

describe('操作中心视图标签页键盘可访问性', () => {
  it('标签具有面板关联、单一 Tab 停靠点，并支持左右方向键循环切换', async () => {
    await mountView();

    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    const [recordsTab, jobsTab] = tabs;

    expect(recordsTab.attributes('id')).toBe('operations-tab-records');
    expect(recordsTab.attributes('aria-controls')).toBe('operations-panel-records');
    expect(recordsTab.attributes('aria-selected')).toBe('true');
    expect(recordsTab.element.tabIndex).toBe(0);
    expect(jobsTab.attributes('aria-controls')).toBe('operations-panel-jobs');
    expect(jobsTab.attributes('aria-selected')).toBe('false');
    expect(jobsTab.element.tabIndex).toBe(-1);

    const recordsPanel = wrapper.get('#operations-panel-records');
    const jobsPanel = wrapper.get('#operations-panel-jobs');
    expect(recordsPanel.attributes('role')).toBe('tabpanel');
    expect(recordsPanel.attributes('aria-labelledby')).toBe('operations-tab-records');
    expect(jobsPanel.attributes('role')).toBe('tabpanel');
    expect(jobsPanel.attributes('aria-labelledby')).toBe('operations-tab-jobs');
    expect(recordsPanel.element.style.display).not.toBe('none');
    expect(jobsPanel.element.style.display).toBe('none');

    recordsTab.element.focus();
    await recordsTab.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();

    expect(document.activeElement).toBe(jobsTab.element);
    expect(jobsTab.attributes('aria-selected')).toBe('true');
    expect(jobsTab.element.tabIndex).toBe(0);
    expect(recordsTab.element.tabIndex).toBe(-1);
    expect(jobsPanel.element.style.display).not.toBe('none');
    expect(recordsPanel.element.style.display).toBe('none');

    await jobsTab.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(document.activeElement).toBe(recordsTab.element);
    expect(recordsTab.attributes('aria-selected')).toBe('true');
  });

  it('Home 和 End 将焦点切换到首个或末尾标签', async () => {
    await mountView();
    const tabs = wrapper.findAll('[role="tab"]');
    const [recordsTab, jobsTab] = tabs;

    recordsTab.element.focus();
    await recordsTab.trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(document.activeElement).toBe(jobsTab.element);
    expect(jobsTab.attributes('aria-selected')).toBe('true');

    await jobsTab.trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(document.activeElement).toBe(recordsTab.element);
    expect(recordsTab.attributes('aria-selected')).toBe('true');
  });
});

const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const job = (id = 'a', status = 'running', output = 'initial output') => ({ id, status, total: 1, completed: status === 'success' ? 1 : 0, action: 'up', createdAt: '2026-10-01T09:42:00Z', items: [{ id: id + '-item', projectName: 'app', status, output, exitCode: null }] });
async function openFirstJob() {
  await wrapper.get('#operations-tab-jobs').trigger('click');
  await flushPromises();
  await wrapper.findAll('[aria-label="查看任务详情"]')[0].trigger('click');
  await flushPromises();
}
describe('operation details and job subscription lifecycle', () => {
  it('renders ISO timestamps without appending a second timezone suffix', async () => {
    api.getOperations.mockResolvedValue({ operations: [{ id: 1, action: 'compose.save', status: 'success', createdAt: '2026-10-01T09:42:00Z' }] });
    await mountView();
    expect(wrapper.text()).not.toContain('Invalid Date');
    expect(wrapper.text()).toContain('2026');
  });
  it('updates the selected project output from snapshots and stops on completion', async () => {
    api.listJobs.mockResolvedValue({ jobs: [job()] });
    api.getJob.mockResolvedValue(job());
    let frame, signal;
    api.streamJobUpdates.mockImplementation((id, callback, abortSignal) => { frame = callback; signal = abortSignal; return new Promise(() => {}); });
    await mountView(); await openFirstJob();
    expect(wrapper.get('[role="dialog"]').text()).toContain('initial output');
    frame({ type: 'snapshot', job: job('a', 'running', 'streamed output') }); await flushPromises();
    expect(wrapper.get('[role="dialog"]').text()).toContain('streamed output');
    frame({ type: 'update', job: job('a', 'success', 'finished output') }); await flushPromises();
    expect(signal.aborted).toBe(true);
    expect(wrapper.get('[role="dialog"]').text()).toContain('finished output');
  });
  it('closing a pending detail request prevents a late response from reopening it', async () => {
    const pending = deferred();
    api.listJobs.mockResolvedValue({ jobs: [job()] });
    api.getJob.mockReturnValue(pending.promise);
    await mountView(); await openFirstJob();
    expect(wrapper.get('[role="dialog"]').text()).toContain('正在加载');
    await wrapper.get('[role="dialog"] button').trigger('click');
    pending.resolve(job()); await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(api.streamJobUpdates).not.toHaveBeenCalled();
  });
  it('closing a live detail never schedules fallback polling from an aborted stream', async () => {
    const stream = deferred();
    api.listJobs.mockResolvedValue({ jobs: [job()] });
    api.getJob.mockResolvedValue(job());
    api.streamJobUpdates.mockReturnValue(stream.promise);
    await mountView(); await openFirstJob();
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await wrapper.get('[role="dialog"] button').trigger('click');
    stream.reject(new Error('aborted')); await flushPromises();
    expect(timer.mock.calls.filter(call => call[1] === 1200)).toHaveLength(0);
    timer.mockRestore();
  });
  it('shows detail fetch errors with a retry that can recover', async () => {
    api.listJobs.mockResolvedValue({ jobs: [job('a', 'success')] });
    api.getJob.mockRejectedValueOnce(new Error('连接已断开')).mockResolvedValueOnce(job('a', 'success'));
    await mountView(); await openFirstJob();
    expect(wrapper.get('[role="dialog"] [role="alert"]').text()).toContain('连接已断开');
    await wrapper.get('[role="dialog"] .btn-secondary').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="dialog"]').text()).toContain('initial output');
    expect(wrapper.find('[role="dialog"] [role="alert"]').exists()).toBe(false);
  });
  it('ignores stale output from a previously selected job', async () => {
    const old = deferred();
    api.listJobs.mockResolvedValue({ jobs: [job('a'), job('b', 'success')] });
    api.getJob.mockReturnValueOnce(old.promise).mockResolvedValueOnce(job('b', 'success', 'second job output'));
    await mountView(); await openFirstJob();
    await wrapper.findAll('[aria-label="查看任务详情"]')[1].trigger('click'); await flushPromises();
    old.resolve(job('a')); await flushPromises();
    expect(wrapper.get('[role="dialog"]').text()).toContain('second job output');
    expect(api.streamJobUpdates).not.toHaveBeenCalled();
  });
});
