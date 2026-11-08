import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import CronTasksView from '../src/views/CronTasksView.vue';
import ConfirmDialog from '../src/components/common/ConfirmDialog.vue';

const mocks = vi.hoisted(() => ({
  api: Object.fromEntries(['listCronJobs', 'getCronHistory', 'previewCronSchedule', 'createCronJob', 'updateCronJob', 'runCronJob', 'deleteCronJob'].map(key => [key, vi.fn()])),
  route: { query: {} }, replace: vi.fn(), toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/api/client.js', () => ({ api: mocks.api }));
vi.mock('vue-router', () => ({ useRoute: () => mocks.route, useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => mocks.toast }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));
vi.mock('../src/composables/useAgentConsole.js', () => ({ useAgentConsole: () => ({ openAgent: vi.fn(), updateAgentContext: vi.fn(), resetAgentContext: vi.fn() }) }));

const task = () => ({ id: 'nightly', name: '夜间检查', cron: '0 2 * * *', type: 'images-check', typeLabel: '镜像检查', enabled: true, nextRunAt: 1794160800000 });
const types = { 'images-check': { label: '镜像检查' }, 'db-backup': { label: '数据库备份' } };
const preview = { timezone: 'Asia/Shanghai', nextRuns: ['2026-11-09T19:00:00Z', '2026-11-10T19:00:00Z', '2026-11-11T19:00:00Z'] };
let wrapper;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.route.query = {};
  mocks.api.listCronJobs.mockImplementation(async () => ({ jobs: [task()], types }));
  mocks.api.getCronHistory.mockResolvedValue({ history: [] });
  mocks.api.previewCronSchedule.mockResolvedValue(preview);
});
afterEach(() => wrapper?.unmount());
async function start() {
  wrapper = mount(CronTasksView, { global: { renderStubDefaultSlot: true, stubs: {
    SceneIllustration: true, ConfirmDialog: true,
    BaseModal: { props: ['show'], template: '<div v-if="show" role="dialog"><slot /><slot name="footer" /></div>' },
  } } });
  await flushPromises();
}
const button = text => wrapper.findAll('button').find(item => item.text() === text);

it('执行历史失败不阻塞任务清单与任务类型，支持仅重试历史', async () => {
  mocks.api.getCronHistory.mockRejectedValueOnce(new Error('历史读取失败'));
  await start();
  expect(wrapper.findAll('article')).toHaveLength(1);
  expect(wrapper.text()).toContain('历史读取失败');
  const listCalls = mocks.api.listCronJobs.mock.calls.length;
  await button('重试历史').trigger('click');
  await flushPromises();
  expect(mocks.api.listCronJobs).toHaveBeenCalledTimes(listCalls);
  expect(wrapper.text()).not.toContain('历史读取失败');
});

it('任务清单失败仍显示历史，毫秒时间戳可正确升降序排序', async () => {
  mocks.api.listCronJobs.mockRejectedValueOnce(new Error('任务读取失败'));
  mocks.api.getCronHistory.mockResolvedValue({ history: [
    { id: 'old', jobId: 'gone', jobName: '旧记录', at: 1794000000000, status: 'success' },
    { id: 'new', jobId: 'gone', jobName: '新记录', at: 1794080000000, status: 'failed' },
  ] });
  await start();
  expect(wrapper.findAll('tbody tr')[0].text()).toContain('新记录');
  await wrapper.get('thead button').trigger('click');
  expect(wrapper.findAll('tbody tr')[0].text()).toContain('旧记录');
  expect(wrapper.find('.cron-empty').exists()).toBe(false);
});

it('已确认的停用结果在刷新失败后保留，防止同任务重复写入', async () => {
  let finish;
  mocks.api.updateCronJob.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await start();
  const checkbox = wrapper.get('article input[type=checkbox]');
  await checkbox.trigger('change');
  await checkbox.trigger('change');
  expect(mocks.api.updateCronJob).toHaveBeenCalledTimes(1);
  mocks.api.listCronJobs.mockRejectedValue(new Error('列表更新失败'));
  finish({ ...task(), enabled: false, nextRunAt: null });
  await flushPromises();
  expect(checkbox.element.checked).toBe(false);
  expect(wrapper.get('article').text()).toContain('停用');
  expect(wrapper.text()).toContain('列表更新失败');
});

it('开关写入失败时原生复选框也恢复最后确认状态', async () => {
  mocks.api.updateCronJob.mockRejectedValueOnce(new Error('暂停失败'));
  await start();
  const checkbox = wrapper.get('article input[type=checkbox]');
  await checkbox.setValue(false);
  await flushPromises();
  expect(checkbox.element.checked).toBe(true);
  expect(mocks.toast.error).toHaveBeenCalled();
});

it('删除保持确认门，失败可重试，成功后刷新失败也不会复活任务', async () => {
  let reject;
  mocks.api.deleteCronJob.mockReturnValueOnce(new Promise((resolve, fail) => { reject = fail; }));
  await start();
  await wrapper.get('button[aria-label="删除定时任务 夜间检查"]').trigger('click');
  const dialog = wrapper.findComponent(ConfirmDialog);
  dialog.vm.$emit('confirm'); dialog.vm.$emit('confirm');
  await flushPromises();
  expect(mocks.api.deleteCronJob).toHaveBeenCalledTimes(1);
  expect(dialog.props('show')).toBe(true);
  expect(dialog.props('busy')).toBe(true);
  reject(new Error('删除暂不可用'));
  await flushPromises();
  expect(dialog.props('show')).toBe(true);
  expect(wrapper.text()).toContain('删除暂不可用');
  mocks.api.deleteCronJob.mockResolvedValueOnce({ ok: true });
  mocks.api.listCronJobs.mockRejectedValueOnce(new Error('列表更新失败'));
  dialog.vm.$emit('confirm');
  await flushPromises();
  expect(dialog.props('show')).toBe(false);
  expect(wrapper.findAll('article')).toHaveLength(0);
});

it('立即执行失败也刷新历史并保留具体错误，恢复其它任务操作', async () => {
  mocks.api.runCronJob.mockRejectedValueOnce(new Error('镜像检查连接超时'));
  await start();
  mocks.api.getCronHistory.mockResolvedValue({ history: [{ id: 'failed', jobId: 'nightly', jobName: '夜间检查', at: 1794080000000, status: 'failed', error: '镜像检查连接超时' }] });
  await button('立即执行').trigger('click');
  await flushPromises();
  expect(mocks.api.getCronHistory).toHaveBeenCalledTimes(2);
  expect(wrapper.get('tbody').text()).toContain('镜像检查连接超时');
  expect(button('立即执行').attributes('disabled')).toBeUndefined();
});

it('编辑使用独立草稿，取消不更改原任务；保存成功即显示服务端确认结果', async () => {
  await start();
  await wrapper.get('button[aria-label="编辑定时任务 夜间检查"]').trigger('click');
  await wrapper.get('#cron-name').setValue('取消的改名');
  expect(wrapper.get('article').text()).not.toContain('取消的改名');
  await button('取消').trigger('click');
  await wrapper.get('button[aria-label="编辑定时任务 夜间检查"]').trigger('click');
  expect(wrapper.get('#cron-name').element.value).toBe('夜间检查');
  await wrapper.get('#cron-name').setValue('新的夜间检查');
  await vi.waitFor(() => expect(wrapper.findAll('.cron-preview time')).toHaveLength(3));
  mocks.api.updateCronJob.mockResolvedValueOnce({ ...task(), name: '新的夜间检查' });
  mocks.api.listCronJobs.mockRejectedValueOnce(new Error('列表更新失败'));
  await button('保存修改').trigger('click');
  await flushPromises();
  expect(mocks.api.updateCronJob).toHaveBeenCalledWith('nightly', { name: '新的夜间检查', cron: '0 2 * * *', type: 'images-check', enabled: true });
  expect(wrapper.get('article').text()).toContain('新的夜间检查');
  expect(wrapper.find('[role=dialog]').exists()).toBe(false);
  expect(mocks.api.createCronJob).not.toHaveBeenCalled();
});

it('创建成功后的刷新失败仍显示新任务，避免误以为没保存再次创建', async () => {
  await start();
  await button('新建定时任务').trigger('click');
  await wrapper.get('#cron-name').setValue('新增备份');
  await vi.waitFor(() => expect(wrapper.findAll('.cron-preview time')).toHaveLength(3));
  mocks.api.createCronJob.mockResolvedValueOnce({ ...task(), id: 'created', name: '新增备份', type: 'db-backup' });
  mocks.api.listCronJobs.mockRejectedValueOnce(new Error('列表更新失败'));
  await button('创建任务').trigger('click');
  await flushPromises();
  expect(wrapper.findAll('article')).toHaveLength(2);
  expect(wrapper.text()).toContain('新增备份');
  expect(wrapper.find('[role=dialog]').exists()).toBe(false);
});
