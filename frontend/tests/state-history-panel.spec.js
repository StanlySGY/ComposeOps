import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api } = vi.hoisted(() => ({
  api: Object.fromEntries(
    ['getProjects', 'getStateUptime', 'getStateExits', 'getStateHistory', 'pruneStateHistory'].map((name) => [name, vi.fn()]),
  ),
}));
vi.mock('../src/api/client.js', () => ({ api }));

import StateHistoryPanel from '../src/components/events/StateHistoryPanel.vue';
import ConfirmDialog from '../src/components/common/ConfirmDialog.vue';

const PROJECTS = { projects: [{ id: 'p1', projectName: 'web-stack', managed: true }, { id: 'p2', projectName: 'scratch', managed: false }] };

const report = () => ({
  window: { since: 1, until: 1000, seconds: 999 },
  truncated: false,
  containers: [
    { containerId: 'c-api', containerName: 'api', projectName: 'web-stack', upSeconds: 1900, downSeconds: 1100, unknownSeconds: 0, transitions: 3, exits: 1, abnormalExits: 0, availability: 63.33, lastAction: 'start', lastExitCode: 0, destroyed: false },
    { containerId: 'c-web', containerName: 'web', projectName: 'web-stack', upSeconds: 1500, downSeconds: 1500, unknownSeconds: 0, transitions: 1, exits: 1, abnormalExits: 1, availability: 50, lastAction: 'die', lastExitCode: 137, destroyed: false },
    { containerId: 'c-probe', containerName: 'probe', projectName: 'other', upSeconds: 0, downSeconds: 0, unknownSeconds: 3000, transitions: 0, exits: 0, abnormalExits: 0, availability: null, lastAction: 'health_status', lastExitCode: null, destroyed: false },
  ],
  summary: { containers: 3, availability: 57.14, upSeconds: 3400, downSeconds: 2600, unknownSeconds: 3000, transitions: 4, exits: 2, abnormalExits: 1 },
});

const exits = () => ({
  total: 2,
  exits: [
    { containerId: 'c-web', containerName: 'web', projectName: 'web-stack', exitCode: 137, execDuration: 42, timestamp: 1_700_000_000, abnormal: true },
    { containerId: 'c-api', containerName: 'api', projectName: 'web-stack', exitCode: 0, execDuration: 1000, timestamp: 1_700_000_001, abnormal: false },
  ],
});

const history = () => ({
  history: [
    { id: 2, containerId: 'c-web', containerName: 'web', projectName: 'web-stack', action: 'die', healthStatus: '', exitCode: 137, execDuration: 42, timestamp: 1_700_000_000 },
    { id: 1, containerId: 'c-api', containerName: 'api', projectName: 'web-stack', action: 'start', healthStatus: '', exitCode: null, execDuration: null, timestamp: 1_700_000_001 },
  ],
});

describe('状态历史面板', () => {
  let wrapper;
  let router;
  beforeEach(async () => {
    vi.clearAllMocks();
    api.getProjects.mockResolvedValue(PROJECTS);
    api.getStateUptime.mockResolvedValue(report());
    api.getStateExits.mockResolvedValue(exits());
    api.getStateHistory.mockResolvedValue(history());
    api.pruneStateHistory.mockResolvedValue({ ok: true, removed: 0 });
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<main>测试路由</main>' } }] });
    await router.push('/');
    await router.isReady();
  });
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  async function start() {
    wrapper = mount(StateHistoryPanel, { global: { plugins: [router] } });
    await flushPromises();
  }

  it('挂载即按默认窗口拉取可用率、退出明细与转换流水', async () => {
    await start();
    expect(api.getStateUptime).toHaveBeenCalledTimes(1);
    expect(api.getStateUptime).toHaveBeenCalledWith({ projectId: '', days: 7 });
    expect(api.getStateExits).toHaveBeenCalledWith({ projectId: '', days: 7 });
    // 流水只要最近若干条:全量拉取会把 90 天窗口的原始事件全塞进前端
    expect(api.getStateHistory.mock.calls[0][0].limit).toBeLessThanOrEqual(200);
    expect(wrapper.text()).toContain('63.33%');
    expect(wrapper.text()).toContain('exit 137');
  });

  it('可用率为 null 时显示"不可判定",不伪装成 0%', async () => {
    await start();
    // 逐行断言:整页 text() 里 "50.00%" 也含 "0.00%",子串匹配会误判
    const row = wrapper.findAll('tbody tr').find((tr) => tr.text().includes('probe'));
    expect(row.text()).toContain('不可判定');
    expect(row.text()).not.toContain('%');
  });

  it('项目下拉只列纳管项目,选择后按 projectId 重新请求', async () => {
    await start();
    const select = wrapper.findAll('select')[0];
    const options = select.findAll('option').map((option) => option.text());
    expect(options.some((text) => text.includes('scratch'))).toBe(false);

    await select.setValue('p1');
    await flushPromises();
    expect(api.getStateUptime).toHaveBeenLastCalledWith({ projectId: 'p1', days: 7 });
    expect(api.getStateExits).toHaveBeenLastCalledWith({ projectId: 'p1', days: 7 });
  });

  it('切换时间窗口按新 days 请求(后端 schema 上限 365)', async () => {
    await start();
    await wrapper.findAll('select')[1].setValue('90');
    await flushPromises();
    expect(api.getStateUptime).toHaveBeenLastCalledWith({ projectId: '', days: 90 });
    expect(wrapper.text()).toContain('最近 90 天');
  });

  it('搜索为纯前端过滤,不额外发请求', async () => {
    await start();
    const calls = api.getStateUptime.mock.calls.length;
    await wrapper.get('input').setValue('probe');
    expect(api.getStateUptime.mock.calls.length).toBe(calls);
    expect(wrapper.text()).toContain('1 / 3 个容器');
    expect(wrapper.text()).not.toContain('63.33%');
  });

  it('后端截断窗口时提示结果不完整,避免把部分时长当成全貌', async () => {
    api.getStateUptime.mockResolvedValue({ ...report(), truncated: true });
    await start();
    expect(wrapper.find('.alert-warning').exists()).toBe(true);
  });

  it('任一接口失败仍展示已成功的分支数据,并给出错误', async () => {
    api.getStateExits.mockRejectedValue(new Error('退出明细不可用'));
    await start();
    expect(wrapper.text()).toContain('退出明细不可用');
    expect(wrapper.text()).toContain('63.33%');
  });

  it('无事件时给出空状态而不是空表格', async () => {
    api.getStateUptime.mockResolvedValue({ containers: [], summary: {}, truncated: false });
    api.getStateExits.mockResolvedValue({ exits: [], total: 0 });
    api.getStateHistory.mockResolvedValue({ history: [] });
    await start();
    expect(wrapper.text()).toContain('暂无状态历史');
    expect(wrapper.find('table').exists()).toBe(false);
  });

  it('下拉刷新重新拉取(常驻记录器写入的新事件要立刻可见)', async () => {
    await start();
    window.dispatchEvent(new CustomEvent('composeops:refresh'));
    await flushPromises();
    expect(api.getStateUptime).toHaveBeenCalledTimes(2);
  });

  it('卸载后不再响应下拉刷新(无监听泄漏)', async () => {
    await start();
    const calls = api.getStateUptime.mock.calls.length;
    wrapper.unmount();
    wrapper = null;
    window.dispatchEvent(new CustomEvent('composeops:refresh'));
    await flushPromises();
    expect(api.getStateUptime).toHaveBeenCalledTimes(calls);
  });

  it('清理历史需二次确认,确认后按保留天数清理并重新加载', async () => {
    await start();
    await wrapper.findAll('button').find((button) => button.text().includes('清理历史')).trigger('click');
    expect(api.pruneStateHistory).not.toHaveBeenCalled();

    wrapper.getComponent(ConfirmDialog).vm.$emit('confirm');
    await flushPromises();
    expect(api.pruneStateHistory).toHaveBeenCalledWith(90);
    expect(api.getStateUptime).toHaveBeenCalledTimes(2);
  });
});
