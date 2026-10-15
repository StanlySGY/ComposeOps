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
  it('每行报告都有可通过键盘聚焦的命名按钮打开明细', async () => {
    wrapper = mountView();
    await flushPromises();

    const openReport = wrapper.get('tbody button[aria-label="查看巡检报告：2026/10/15 16:00:00，来源：手动"]');
    expect(openReport.element.tagName).toBe('BUTTON');
    expect(openReport.attributes('type')).toBe('button');

    await openReport.trigger('click');
    await flushPromises();

    expect(api.getInspectionReport).toHaveBeenCalledWith('report-42');
    expect(wrapper.get('[role="dialog"]').exists()).toBe(true);
  });
});
