import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import CronTasksView from '../src/views/CronTasksView.vue';

const mocks = vi.hoisted(() => ({
  api: Object.fromEntries(['listCronJobs', 'getCronHistory', 'previewCronSchedule', 'createCronJob', 'updateCronJob', 'runCronJob', 'deleteCronJob'].map(key => [key, vi.fn()])),
  route: { query: {} }, replace: vi.fn(), toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/api/client.js', () => ({ api: mocks.api }));
vi.mock('vue-router', () => ({ useRoute: () => mocks.route, useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => mocks.toast }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));
vi.mock('../src/composables/useAgentConsole.js', () => ({ useAgentConsole: () => ({ openAgent: vi.fn(), updateAgentContext: vi.fn(), resetAgentContext: vi.fn() }) }));
const preview = { timezone: 'Asia/Shanghai', nextRuns: ['2026-11-08T19:00:00Z', '2026-11-09T19:00:00Z', '2026-11-10T19:00:00Z'] };
let wrapper;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.route.query = {};
  mocks.api.listCronJobs.mockResolvedValue({ jobs: [], types: { 'db-backup': { label: '数据库备份', description: '测试范围' }, 'prune-safe': { label: '安全清理' }, 'images-check': { label: '镜像检查' } } });
  mocks.api.getCronHistory.mockResolvedValue({ history: [] });
  mocks.api.previewCronSchedule.mockResolvedValue(preview);
});
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; });
async function start() {
  wrapper = mount(CronTasksView, { global: { stubs: { BaseModal: { props: ['show'], template: '<div v-if="show" role="dialog"><slot /><slot name="footer" /></div>' }, ConfirmDialog: true } } });
  await flushPromises();
}
const buttons = () => wrapper.findAll('button');
const button = text => buttons().find(item => item.text().includes(text));

describe('定时计划创建与回看', () => {
  it('项目计划在列表和编辑器明确范围，修改周期不能扩大到全部节点', async () => {
    const job = { id: 'scoped', name: '项目卷备份', type: 'volume-backup', cron: '0 3 * * *', enabled: false, scope: 'project',
      target: { hostId: 'remote', hostName: '公司节点', projectId: 'p1', projectName: '应用一', connectionRevision: 'r1', engineId: 'e1' } };
    mocks.api.listCronJobs.mockResolvedValue({ jobs: [job], types: { 'volume-backup': { label: '数据卷备份', description: '所有纳管项目' } }, targets: [] });
    mocks.api.updateCronJob.mockResolvedValue(job);
    await start(); expect(wrapper.text()).toContain('公司节点 · 仅 应用一');
    await wrapper.get('button[aria-label="编辑定时任务 项目卷备份"]').trigger('click');
    expect(wrapper.get('[role=dialog]').text()).toContain('固定项目：公司节点 · 应用一');
    expect(wrapper.get('[role=dialog]').text()).not.toContain('所有纳管项目');
    expect(wrapper.get('#cron-type').attributes('disabled')).toBeDefined();
    await wrapper.get('#cron-schedule').setValue('0 2 * * *');
    await vi.waitFor(() => expect(wrapper.findAll('.cron-preview time')).toHaveLength(3));
    await button('保存修改').trigger('click'); await flushPromises();
    expect(mocks.api.updateCronJob).toHaveBeenCalledWith('scoped', { name: '项目卷备份', type: 'volume-backup', cron: '0 2 * * *', enabled: false, scope: 'project' });
  });
  it('所有快捷计划都显示实际周期，自定义模式保留表达式，重开恢复默认', async () => {
    await start();
    await wrapper.findAll('.cron-preset-card')[1].trigger('click');
    expect(wrapper.get('#cron-schedule').element.value).toBe('0 4 * * 0');
    await wrapper.get('#cron-schedule').setValue('custom');
    expect(wrapper.get('#cron-expression').element.value).toBe('0 4 * * 0');
    await wrapper.get('#cron-expression').setValue('*/30 * * * *');
    expect(wrapper.get('#cron-schedule').element.value).toBe('custom');
    await vi.waitFor(() => expect(wrapper.findAll('.cron-preview time')).toHaveLength(3));
    expect(mocks.api.previewCronSchedule).toHaveBeenLastCalledWith('*/30 * * * *');
    await button('取消').trigger('click');
    await button('新建定时任务').trigger('click');
    expect(wrapper.find('#cron-expression').exists()).toBe(false);
    expect(wrapper.get('#cron-schedule').element.value).toBe('0 3 * * *');
  });

  it('迟到的有效时间不能覆盖新表达式的失败结果，失败时不可创建', async () => {
    let resolveOld;
    mocks.api.previewCronSchedule.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    await start();
    await button('新建定时任务').trigger('click');
    await vi.waitFor(() => expect(mocks.api.previewCronSchedule).toHaveBeenCalledTimes(1));
    await wrapper.get('#cron-schedule').setValue('custom');
    mocks.api.previewCronSchedule.mockRejectedValueOnce(new Error('无效的 cron 字段'));
    await wrapper.get('#cron-expression').setValue('60 * * * *');
    resolveOld(preview);
    await vi.waitFor(() => expect(wrapper.text()).toContain('无效的 cron 字段'));
    expect(wrapper.findAll('.cron-preview time')).toHaveLength(0);
    expect(button('创建任务').attributes('disabled')).toBeDefined();
  });

  it('保存期间防重入并保持表单，关闭后的时间响应不能复活预览', async () => {
    let finish;
    mocks.api.createCronJob.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await start();
    await button('新建定时任务').trigger('click');
    await wrapper.get('#cron-name').setValue('每日备份');
    await vi.waitFor(() => expect(wrapper.findAll('.cron-preview time')).toHaveLength(3));
    await button('创建任务').trigger('click');
    await button('创建任务').trigger('click');
    expect(mocks.api.createCronJob).toHaveBeenCalledTimes(1);
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();
    expect(button('取消').attributes('disabled')).toBeDefined();
    finish({});
    await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
  });

  it('任务删除后仍可回看执行历史，并能清除入口携带的历史筛选', async () => {
    mocks.route.query = { job: 'deleted', from: 'events' };
    mocks.api.getCronHistory.mockResolvedValue({ history: [{ id: 'run-1', jobId: 'deleted', jobName: '已删除任务', at: Date.now(), status: 'success', durationMs: 12 }, { id: 'run-2', jobId: 'other', jobName: '其它任务', at: Date.now(), status: 'failed' }] });
    await start();
    expect(wrapper.text()).toContain('已删除任务');
    expect(wrapper.text()).not.toContain('其它任务');
    await button('查看全部历史').trigger('click');
    expect(mocks.replace).toHaveBeenCalledWith({ query: { from: 'events' } });
  });

  it('加载失败不伪装成没有任务', async () => {
    mocks.api.listCronJobs.mockRejectedValueOnce(new Error('服务暂不可用'));
    await start();
    expect(wrapper.get('[role=alert]').text()).toContain('服务暂不可用');
    expect(wrapper.find('.cron-empty').exists()).toBe(false);
  });

  it('清理计划固定选择节点与连接修订，切换工作节点不静默改写表单目标', async () => {
    const types = { 'prune-safe': { label: '安全清理', scope: 'host' }, 'db-backup': { label: '数据库备份', scope: 'all' } };
    const targets = [{ hostId: 'a', hostName: '公司A', connectionRevision: 'a-v1' }, { hostId: 'b', hostName: '公司B', connectionRevision: 'b-v1' }];
    mocks.api.listCronJobs.mockResolvedValue({ jobs: [], types, targets, currentTarget: targets[0] });
    mocks.api.createCronJob.mockResolvedValue({ id: 'saved', name: '固定清理', type: 'prune-safe', target: targets[0] });
    await start(); await button('新建定时任务').trigger('click');
    await wrapper.get('#cron-type').setValue('prune-safe'); await wrapper.get('#cron-name').setValue('固定清理');
    expect(wrapper.get('#cron-host').element.value).toBe('a');
    expect(wrapper.text()).toContain('未纳管资源');
    expect(wrapper.text()).toContain('保留全部容器与数据卷');
    mocks.api.listCronJobs.mockResolvedValue({ jobs: [], types, targets, currentTarget: targets[1] });
    window.dispatchEvent(new CustomEvent('composeops:host-changed')); await flushPromises();
    expect(wrapper.get('#cron-host').element.value).toBe('a');
    await vi.waitFor(() => expect(wrapper.findAll('.cron-preview time')).toHaveLength(3));
    await button('创建任务').trigger('click'); await flushPromises();
    expect(mocks.api.createCronJob).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'a', connectionRevision: 'a-v1' }));
  });

  it('旧计划缺少目标不能执行或直接启用，编辑时必须重新确认', async () => {
    const target = { hostId: 'a', hostName: '公司A', connectionRevision: 'a-v2' };
    mocks.api.listCronJobs.mockResolvedValue({ jobs: [{ id: 'old', name: '旧清理', type: 'prune-safe', cron: '0 0 * * *', enabled: false, targetError: '旧计划未绑定目标' }],
      types: { 'prune-safe': { label: '安全清理', scope: 'host' } }, targets: [target], currentTarget: target });
    await start(); expect(button('立即执行').attributes('disabled')).toBeDefined();
    expect(wrapper.get('input[aria-label="启用定时任务 旧清理"]').attributes('disabled')).toBeDefined();
    await wrapper.get('button[aria-label="编辑定时任务 旧清理"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.findAll('.cron-preview time')).toHaveLength(3));
    expect(button('保存修改').attributes('disabled')).toBeDefined();
    await button('重新确认所选节点').trigger('click');
    expect(button('保存修改').attributes('disabled')).toBeUndefined();
  });
});
