import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const api = vi.hoisted(() => ({
  getInspectionOverview: vi.fn(),
  runInspection: vi.fn(),
  saveInspectionSchedule: vi.fn(),
  pruneInspections: vi.fn(),
  getInspectionReport: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const agent = vi.hoisted(() => ({ openAgent: vi.fn(), updateAgentContext: vi.fn(), resetAgentContext: vi.fn() }));

vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => toast }));
vi.mock('../src/composables/useAgentConsole.js', () => ({ useAgentConsole: () => agent }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));

import InspectionView from '../src/views/InspectionView.vue';

let wrapper;
const report = {
  id: 'report-42',
  createdAt: '2026-10-15T08:00:00Z',
  source: 'manual',
  score: 92,
  grade: 'healthy',
  summary: '巡检正常',
  counts: { critical: 0, warning: 0, info: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getInspectionOverview.mockResolvedValue({
    latest: null,
    reports: [{ ...report }],
    schedule: { enabled: false, intervalHours: 24, lastRunAt: 0 },
  });
  api.getInspectionReport.mockResolvedValue({
    report: { ...report, report: { summary: '巡检正常', findings: [] } },
  });
  api.runInspection.mockResolvedValue({ report });
  api.saveInspectionSchedule.mockResolvedValue({ schedule: { enabled: false, intervalHours: 24, lastRunAt: 0 } });
  api.pruneInspections.mockResolvedValue({ removed: 0 });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

function mountView() {
  return mount(InspectionView, {
    global: {
      stubs: {
        BaseModal: {
          props: ['show', 'title', 'sizeClass', 'bodyClass'],
          template: '<div v-if="show" role="dialog"><slot name="header-actions"/><slot/><slot name="footer"/></div>',
        },
      },
    },
  });
}

describe('AI 巡检报告列表键盘可访问性', () => {
  it('刷新失败通过 alert 播报原因', async () => {
    api.getInspectionOverview.mockRejectedValueOnce(new Error('inspection service offline'));
    wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('加载巡检数据失败');
    expect(wrapper.get('[role="alert"]').text()).toContain('inspection service offline');
    expect(wrapper.attributes('aria-busy')).toBe('false');
  });

  it('刷新请求过程中提供读屏状态播报，完成后清除状态', async () => {
    wrapper = mountView();
    await flushPromises();

    let resolveOverview;
    api.getInspectionOverview.mockImplementationOnce(() => new Promise(resolve => { resolveOverview = resolve; }));
    await wrapper.get('.page-actions button.btn-secondary').trigger('click');

    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('正在加载巡检数据');
    expect(wrapper.attributes('aria-busy')).toBe('true');

    resolveOverview({ latest: null, reports: [], schedule: { enabled: false, intervalHours: 24, lastRunAt: 0 } });
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.attributes('aria-busy')).toBe('false');
  });

  it('每行报告都有可通过键盘聚焦的命名按钮打开明细', async () => {
    wrapper = mountView();
    await flushPromises();

    // 时间格式取决于执行环境的时区；测试只验证控件语义和报告来源，不固定本地时间文本。
    const openReport = wrapper.get('tbody button[aria-label^="查看巡检报告："]');
    expect(openReport.element.tagName).toBe('BUTTON');
    expect(openReport.attributes('type')).toBe('button');
    expect(openReport.attributes('aria-label')).toContain('来源：手动');

    await openReport.trigger('click');
    await flushPromises();

    expect(api.getInspectionReport).toHaveBeenCalledWith('report-42');
    expect(wrapper.get('[role="dialog"]').exists()).toBe(true);
  });
});
