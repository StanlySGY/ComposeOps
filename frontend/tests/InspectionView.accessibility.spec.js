vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const api = vi.hoisted(() => ({
  getInspectionOverview: vi.fn(),
  listInspectionReports: vi.fn(),
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
  api.listInspectionReports.mockResolvedValue({ reports: [{ ...report }] });
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
          name: 'BaseModal',
          props: ['show', 'title', 'sizeClass', 'bodyClass'],
          template: '<div v-if="show" role="dialog" :data-title="title"><slot name="header-actions"/><slot/><slot name="footer"/></div>',
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

  it('巡检明细加载期间通过 polite status 播报，加载结束后清除状态', async () => {
    let resolveReport;
    api.getInspectionReport.mockImplementationOnce(() => new Promise(resolve => { resolveReport = resolve; }));
    wrapper = mountView();
    await flushPromises();

    const openReport = wrapper.get('tbody button[aria-label^="查看巡检报告："]');
    await openReport.trigger('click');
    expect(wrapper.get('[role="dialog"] [role="status"][aria-live="polite"]').text()).toContain('正在加载巡检报告明细');

    resolveReport({ report: { ...report, report: { summary: '巡检正常', findings: [] } } });
    await flushPromises();
    expect(wrapper.find('[role="dialog"] [role="status"]').exists()).toBe(false);
    expect(wrapper.get('[role="dialog"]').text()).toContain('巡检正常');
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

  it('巡检明细标题读取报告对象中的评分和等级', async () => {
    wrapper = mountView();
    await flushPromises();
    await wrapper.get('tbody button[aria-label^="查看巡检报告："]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="dialog"]').attributes('data-title')).toContain('评分 92 / 健康');
    expect(wrapper.get('[role="dialog"]').attributes('data-title')).not.toContain('undefined');
  });

  it('不完整报告明确显示目标与未知评分，不显示为0分或健康', async () => {
    const partial = { ...report, score: null, grade: 'incomplete', summary: '部分检查', hostId: 'remote', hostName: '公司研发节点', stats: { assessment: { complete: false } } };
    api.getInspectionOverview.mockResolvedValue({ latest: partial, schedule: { enabled: false } });
    api.listInspectionReports.mockResolvedValue({ reports: [partial] }); api.getInspectionReport.mockResolvedValue({ report: partial });
    wrapper = mountView(); await flushPromises();
    expect(wrapper.text()).toContain('信息不完整'); expect(wrapper.text()).toContain('公司研发节点');
    expect(wrapper.text()).not.toContain('无需处理');
    await wrapper.get('tbody button').trigger('click'); await flushPromises();
    expect(wrapper.get('[role=dialog]').attributes('data-title')).toContain('评分 — / 信息不完整');
    expect(wrapper.get('[role=dialog]').text()).toContain('未给出整体健康评分');
  });

  it('明细关闭后迟到响应不重新打开；快速切换报告保留最后选择', async () => {
    let release;
    api.getInspectionReport.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    wrapper = mountView(); await flushPromises(); await wrapper.get('tbody button').trigger('click');
    wrapper.findComponent({ name: 'BaseModal' }).vm.$emit('close'); await flushPromises();
    release({ report }); await flushPromises(); expect(wrapper.find('[role=dialog]').exists()).toBe(false);
    let old;
    api.getInspectionReport.mockReturnValueOnce(new Promise(resolve => { old = resolve; }));
    await wrapper.get('tbody button').trigger('click');
    api.getInspectionReport.mockResolvedValueOnce({ report: { ...report, summary: '最新响应' } });
    await wrapper.get('tbody button').trigger('click'); await flushPromises();
    old({ report: { ...report, summary: '不能复活的旧响应' } }); await flushPromises();
    expect(wrapper.get('[role=dialog]').text()).toContain('最新响应'); expect(wrapper.text()).not.toContain('不能复活的旧响应');
  });

  it('自动巡检保存明确目标与修订，调整间隔会立即保存', async () => {
    const target = { hostId: 'remote', hostName: '公司节点', connectionRevision: 'revision' };
    api.getInspectionOverview.mockResolvedValue({ latest: null, currentTarget: target, targets: [target], schedule: { enabled: false, intervalHours: 24 } });
    api.saveInspectionSchedule.mockResolvedValue({ schedule: { enabled: true, intervalHours: 24, target } });
    wrapper = mountView(); await flushPromises();
    await wrapper.get('input[type=checkbox]').setValue(true); await flushPromises();
    expect(api.saveInspectionSchedule).toHaveBeenLastCalledWith({ enabled: true, intervalHours: 24, hostId: 'remote', connectionRevision: 'revision' });
    await wrapper.get('select[aria-label="自动巡检间隔"]').setValue('6'); await flushPromises();
    expect(api.saveInspectionSchedule).toHaveBeenLastCalledWith({ enabled: true, intervalHours: 6, hostId: 'remote', connectionRevision: 'revision' });
  });
});
