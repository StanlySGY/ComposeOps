import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import EventTimeline from '../src/components/events/EventTimeline.vue';
import MetricTile from '../src/components/common/MetricTile.vue';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';

const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['getOperations', 'getAgentExecutions', 'getAlertEvents', 'getCronHistory', 'getEvents'].map(name => [name, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api }));
let wrapper;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const now = new Date().toISOString(), utcRecent = new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const render = async () => { wrapper = mount(EventTimeline); await flushPromises(); };
beforeEach(() => {
  vi.resetAllMocks();
  api.getOperations.mockResolvedValue({ operations: [] }); api.getAgentExecutions.mockResolvedValue({ plans: [] }); api.getAlertEvents.mockResolvedValue({ events: [] }); api.getCronHistory.mockResolvedValue({ history: [] }); api.getEvents.mockResolvedValue({ events: [] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ repositories: [{ id: 'repo', name: '旧仓库快照', status: 'error', lastSync: now }] }), { headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });

it('GitOps 展示两条真实历史与原始时间，不从当前仓库状态伪造事件', async () => {
  api.getEvents.mockResolvedValue({ events: [
    { id: 1, eventType: 'gitops', title: 'GitOps 同步完成', status: 'resolved', severity: 'info', createdAt: now, detail: '提交 a' },
    { id: 2, eventType: 'gitops', title: 'GitOps 回滚失败', status: 'open', severity: 'warning', createdAt: now, detail: '真实失败保留' },
  ] });
  await render(); expect(wrapper.text()).toContain('GitOps 同步完成'); expect(wrapper.text()).toContain('GitOps 回滚失败'); expect(wrapper.text()).toContain('真实失败保留'); expect(wrapper.text()).not.toContain('旧仓库快照'); expect(fetch).not.toHaveBeenCalled();
});

it('SQLite UTC 时间落在最近一小时内，不受浏览器本地时区偏移影响', async () => {
  api.getOperations.mockResolvedValue({ operations: [{ id: 1, action: 'recent-utc-operation', status: 'success', createdAt: utcRecent }] });
  await render(); await wrapper.get('select[aria-label="时间范围"]').setValue('1h');
  expect(wrapper.text()).toContain('recent-utc-operation');
});

it('摘要数量与当前筛选结果一致', async () => {
  api.getOperations.mockResolvedValue({ operations: [
    { id: 1, action: '保留事件', status: 'success', createdAt: now },
    { id: 2, action: '排除事件', status: 'failed', createdAt: now },
  ] });
  await render(); await wrapper.get('input[aria-label="搜索事件标题、项目或详情"]').setValue('保留事件');
  const tiles = wrapper.findAllComponents(MetricTile);
  expect(tiles.find(tile => tile.props('title') === '事件总数').props('value')).toBe(1);
  expect(tiles.find(tile => tile.props('title') === '异常事件').props('value')).toBe(0);
});

it('身份变更清除时间线，旧聚合读取不复活记录', async () => {
  const held = deferred(); api.getOperations.mockReturnValueOnce(held.promise);
  await render(); advanceAuthEpoch(); held.resolve({ operations: [{ id: 1, action: 'OLD-PRIVATE-OP', createdAt: now }] }); await flushPromises();
  expect(wrapper.text()).not.toContain('OLD-PRIVATE-OP'); expect(wrapper.text()).not.toContain('旧仓库快照');
});

it('切节点立即开始新读取，旧轮次完成不能覆盖新结果', async () => {
  const old = deferred(); api.getOperations.mockReturnValueOnce(old.promise).mockResolvedValue({ operations: [{ id: 2, action: 'NEW-NODE-OP', createdAt: now }] });
  await render(); window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises();
  expect(wrapper.text()).toContain('NEW-NODE-OP');
  old.resolve({ operations: [{ id: 1, action: 'OLD-NODE-OP', createdAt: now }] }); await flushPromises();
  expect(wrapper.text()).not.toContain('OLD-NODE-OP'); expect(wrapper.text()).toContain('NEW-NODE-OP');
});

it('部分来源失败保留其他事件且可以原位重读', async () => {
  api.getEvents.mockRejectedValueOnce(new Error('GitOps unavailable'));
  api.getOperations.mockResolvedValue({ operations: [{ id: 1, action: '保留成功来源', createdAt: now }] });
  await render(); expect(wrapper.get('[role="alert"]').text()).toContain('GitOps'); expect(wrapper.text()).toContain('保留成功来源');
  await wrapper.findAll('button').find(button => button.text() === '重新读取').trigger('click'); await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
});
