import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import CostAnalysisView from '../src/views/CostAnalysisView.vue';
const { api, toast } = vi.hoisted(() => ({ api: { getCostAnalysisReport: vi.fn(), getCostSuggestions: vi.fn(), getCostTrends: vi.fn(), recordCostSnapshot: vi.fn() }, toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => toast }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));
let wrapper;
beforeEach(() => {
  vi.clearAllMocks();
  api.getCostAnalysisReport.mockResolvedValue({ summary: {}, projects: [], images: [], trends: [], storage: {} });
  api.getCostSuggestions.mockResolvedValue([]);
  api.getCostTrends.mockResolvedValue([{ timestamp: 1793500000000, totalCPUPercent: 4, totalMemoryMB: 600 }]);
});
afterEach(() => wrapper?.unmount());
async function start() { wrapper = mount(CostAnalysisView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } }); await flushPromises(); }
describe('成本快照反馈', () => {
  it('快照成功后采用新的趋势，即使报告仍被服务端缓存', async () => {
    api.recordCostSnapshot.mockResolvedValue({ timestamp: 1793501000000 }); await start();
    api.getCostTrends.mockResolvedValue([{ timestamp: 1793500000000, totalCPUPercent: 4, totalMemoryMB: 600 }, { timestamp: 1793501000000, totalCPUPercent: 9, totalMemoryMB: 700 }]);
    await wrapper.findAll('button').find(button => button.text() === '记录快照').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('2 个快照'); expect(wrapper.findAll('figure')).toHaveLength(2); expect(toast.success).toHaveBeenCalledWith('成本快照已记录');
  });
  it('记录失败不报成功，并保留错误对象供详情展示', async () => {
    const failure = new Error('连接失败'); api.recordCostSnapshot.mockRejectedValue(failure); await start();
    await wrapper.findAll('button').find(button => button.text() === '记录快照').trigger('click'); await flushPromises();
    expect(toast.error).toHaveBeenCalledWith(failure); expect(toast.success).not.toHaveBeenCalled();
  });
});
