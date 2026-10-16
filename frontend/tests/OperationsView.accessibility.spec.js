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
        BaseModal: { props: ['show'], template: '<div v-if="show" role="dialog"><slot /></div>' },
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
