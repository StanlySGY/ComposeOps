import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SettingsView from '../src/views/SettingsView.vue';

const mocks = vi.hoisted(() => {
  const api = {};
  for (const name of [
    'getPreferences', 'getNotifications', 'getUpdateSettings', 'getCapabilities', 'getMountPlan',
    'getStorageDf', 'getNotificationEvents', 'savePreferences', 'changePassword', 'saveNotifications',
    'saveNotificationEvents', 'testNotifications', 'saveUpdateSettings', 'checkUpdates', 'getAiConfig',
    'pingHost', 'saveMcpConfig', 'getMcpConfig', 'getProjects', 'getProjectManagement', 'revealMcpToken',
  ]) api[name] = vi.fn(async () => ({}));
  const aiStore = {
    config: { channels: [], failoverEnabled: true, systemPrompt: '', searchProvider: 'builtin', searchProviders: ['builtin'], searchApiKey: '' },
    loadConfig: vi.fn(async () => {}),
    saveConfig: vi.fn(async () => {}),
  };
  const hostsStore = { hosts: [], activeHostId: 'local', pinging: null, load: vi.fn(async () => {}), ping: vi.fn(async () => {}), switchHost: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  return { api, aiStore, hostsStore, route: { name: 'settings', query: { tab: 'personal' } } };
});

vi.mock('../src/api/client.js', () => ({ api: mocks.api }));
vi.mock('../src/stores/ai.js', () => ({ useAiStore: () => mocks.aiStore }));
vi.mock('../src/stores/hosts.js', () => ({ useHostsStore: () => mocks.hostsStore }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));
vi.mock('vue-router', () => ({ useRoute: () => mocks.route, useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

let wrapper;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.route.query = { tab: 'personal' };
  Object.assign(mocks.aiStore.config, { channels: [], failoverEnabled: true, systemPrompt: '', searchProvider: 'builtin', searchProviders: ['builtin'], searchApiKey: '' });
  mocks.api.getPreferences.mockResolvedValue({ refreshInterval: 5, logTail: 200 });
  mocks.api.getNotifications.mockResolvedValue({ enabled: true, intervalSeconds: 30, memoryThreshold: 90, dockerStorageThresholdGb: 1, channels: [] });
  mocks.api.getUpdateSettings.mockResolvedValue({ autoEnabled: false, intervalHours: 24, lastResults: [] });
  mocks.api.getCapabilities.mockResolvedValue({});
  mocks.api.getMountPlan.mockResolvedValue({ projects: [], unsupportedProjects: [], summary: {} });
  mocks.api.getStorageDf.mockResolvedValue(null);
  mocks.api.getNotificationEvents.mockResolvedValue({ events: ['exit', 'oom', 'unhealthy'] });
  mocks.api.saveNotifications.mockImplementation(async (value) => value);
  mocks.api.saveNotificationEvents.mockResolvedValue({ ok: true });
  mocks.api.savePreferences.mockImplementation(async (value) => value);
  mocks.aiStore.loadConfig.mockResolvedValue();
  mocks.api.getMcpConfig.mockResolvedValue({ enabled: true, mode: 'all', toolsExported: 12 });
  mocks.api.saveMcpConfig.mockImplementation(async value => value);
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function mountSettings() {
  wrapper = mount(SettingsView, {
    global: {
      stubs: {
        DataMaintenancePanel: true,
        AiChannelsPanel: true,
        MetricTile: true,
        EmptyState: true,
        StoragePruneModal: true,
        ConfirmDialog: true,
        BaseModal: { template: '<div><slot name="header-actions"/><slot/><slot name="footer"/></div>' },
      },
    },
  });
  await flushPromises();
}

describe('设置页面表单可访问性', () => {
  it('偏好读取完成前不能保存默认值，其他面板慢加载不阻塞偏好', async () => {
    let finishPreferences;
    let finishMounts;
    mocks.api.getPreferences.mockImplementationOnce(() => new Promise(resolve => { finishPreferences = resolve; }));
    mocks.api.getMountPlan.mockImplementationOnce(() => new Promise(resolve => { finishMounts = resolve; }));
    await mountSettings();
    const save = () => wrapper.findAll('button').find(button => button.text().trim() === '保存偏好');
    expect(save().element.disabled).toBe(true);
    await save().trigger('click');
    expect(mocks.api.savePreferences).not.toHaveBeenCalled();
    finishPreferences({ refreshInterval: 10, logTail: 300 });
    await flushPromises();
    expect(save().element.disabled).toBe(false);
    await wrapper.get('input[aria-label="日志默认行数"]').setValue(150);
    await save().trigger('click');
    await flushPromises();
    expect(mocks.api.savePreferences).toHaveBeenCalledWith({ refreshInterval: 10, logTail: 150 });
    finishMounts({ projects: [], summary: {} });
    await flushPromises();
    expect(wrapper.get('input[aria-label="日志默认行数"]').element.value).toBe('150');
  });

  it('偏好读取失败后保留禁用状态，重试成功恢复编辑', async () => {
    mocks.api.getPreferences.mockRejectedValueOnce(new Error('连接失败'));
    await mountSettings();
    expect(wrapper.text()).toContain('读取偏好失败：连接失败');
    expect(wrapper.findAll('button').find(button => button.text().trim() === '保存偏好').element.disabled).toBe(true);
    await wrapper.findAll('button').find(button => button.text().trim() === '重试').trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('读取偏好失败');
    expect(wrapper.findAll('button').find(button => button.text().trim() === '保存偏好').element.disabled).toBe(false);
  });

  it('AI 配置失败不阻塞通知、项目纳管和更新策略', async () => {
    mocks.aiStore.loadConfig.mockRejectedValueOnce(new Error('模型配置不可达'));
    await mountSettings();
    expect(mocks.api.getNotifications).toHaveBeenCalled();
    expect(mocks.api.getUpdateSettings).toHaveBeenCalled();
    expect(mocks.api.getMountPlan).toHaveBeenCalled();
    await wrapper.findAll('button').find(button => button.text().trim() === '通知').trigger('click');
    await flushPromises();
    expect(wrapper.get('input[aria-label="通知轮询间隔（秒）"]').element.value).toBe('30');
    await wrapper.findAll('button').find(button => button.text().trim() === 'AI').trigger('click');
    expect(wrapper.find('ai-channels-panel-stub').exists()).toBe(false);
    await wrapper.get('[data-settings-load="ai"] button').trigger('click');
    await flushPromises();
    expect(wrapper.find('ai-channels-panel-stub').exists()).toBe(true);
  });

  it('更新策略读取前禁用默认值，失败后可单独重试', async () => {
    let rejectUpdates;
    mocks.api.getUpdateSettings.mockImplementationOnce(() => new Promise((_, reject) => { rejectUpdates = reject; }));
    await mountSettings();
    await wrapper.findAll('button').find(button => button.text().trim() === '维护').trigger('click');
    await flushPromises();
    const save = () => wrapper.findAll('button').find(button => button.text().trim() === '保存更新策略');
    expect(save().element.matches(':disabled')).toBe(true);
    rejectUpdates(new Error('读取超时'));
    await flushPromises();
    expect(save().element.matches(':disabled')).toBe(true);
    await wrapper.get('[data-settings-load="updates"] button').trigger('click');
    await flushPromises();
    expect(save().element.matches(':disabled')).toBe(false);
    expect(mocks.api.saveUpdateSettings).not.toHaveBeenCalled();
  });

  it('MCP 配置读取失败不能用默认关闭状态覆盖真实设置', async () => {
    mocks.api.getMcpConfig.mockRejectedValueOnce(new Error('读取超时'));
    await mountSettings();
    await wrapper.findAll('button').find(button => button.text().trim() === 'MCP').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-settings-load="mcp"]').text()).toContain('读取超时');
    expect(wrapper.get('input[aria-label="启用 MCP 服务"]').element.matches(':disabled')).toBe(true);
    await wrapper.get('[data-settings-load="mcp"] button').trigger('click');
    await flushPromises();
    expect(wrapper.get('input[aria-label="启用 MCP 服务"]').element.checked).toBe(true);
    expect(wrapper.get('select').element.value).toBe('all');
  });

  it('复制 MCP Token 被浏览器拒绝时不会显示成功', async () => {
    mocks.api.revealMcpToken.mockResolvedValue({ token: 'fixture-token-not-a-real-secret' });
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('剪贴板权限未开放')) } });
    await mountSettings();
    await wrapper.findAll('button').find(button => button.text().trim() === 'MCP').trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text().trim() === '复制 Token').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('剪贴板权限未开放');
    expect(wrapper.text()).not.toContain('Token 已复制');
  });

  it('MCP 深链直接读取，保存失败恢复服务器状态且等待中阻止重复提交', async () => {
    mocks.route.query = { tab: 'mcp' };
    let rejectSave;
    mocks.api.saveMcpConfig.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    await mountSettings();
    expect(mocks.api.getMcpConfig).toHaveBeenCalledTimes(1);
    const enabled = wrapper.get('input[aria-label="启用 MCP 服务"]');
    expect(enabled.element.checked).toBe(true);
    await enabled.setValue(false);
    expect(enabled.element.matches(':disabled')).toBe(true);
    expect(mocks.api.saveMcpConfig).toHaveBeenCalledExactlyOnceWith({ enabled: false, mode: 'all' });
    rejectSave(new Error('保存未完成'));
    await flushPromises();
    expect(enabled.element.checked).toBe(true);
    expect(enabled.element.matches(':disabled')).toBe(false);
    expect(wrapper.get('select').element.value).toBe('all');
    expect(wrapper.get('[role="alert"]').text()).toContain('保存未完成');
  });

  it('通知事件读取失败时禁止默认事件覆盖，重试保留服务器的空选集', async () => {
    mocks.route.query = { tab: 'notifications' };
    mocks.api.getNotificationEvents.mockRejectedValueOnce(new Error('告警事件暂不可用'));
    await mountSettings();
    const save = () => wrapper.findAll('button').find(button => button.text().trim() === '保存通知设置');
    expect(save().element.matches(':disabled')).toBe(true);
    expect(mocks.api.saveNotifications).not.toHaveBeenCalled();
    mocks.api.getNotificationEvents.mockResolvedValueOnce({ events: [] });
    await wrapper.get('[data-settings-load="notifications"] button').trigger('click');
    await flushPromises();
    expect(save().element.matches(':disabled')).toBe(false);
    for (const label of ['容器崩溃退出', 'OOM 内存溢出', '容器不健康']) {
      expect(wrapper.get(`input[aria-label="${label}"]`).element.checked).toBe(false);
    }
  });

  it('为偏好、密码和联网检索控件提供稳定的可访问名称', async () => {
    await mountSettings();
    expect(wrapper.get('input[aria-label="自动刷新间隔（秒）"]').exists()).toBe(true);
    expect(wrapper.get('input[aria-label="日志默认行数"]').exists()).toBe(true);
    expect(wrapper.get('input[aria-label="当前密码"]').attributes('autocomplete')).toBe('current-password');
    expect(wrapper.get('input[aria-label="新密码"]').attributes('autocomplete')).toBe('new-password');

    await wrapper.findAll('button').find(button => button.text().trim() === 'AI').trigger('click');
    await flushPromises();
    expect(wrapper.get('select[aria-label="检索后端"]').exists()).toBe(true);
    await wrapper.get('select[aria-label="检索后端"]').setValue('tavily');
    await flushPromises();
    expect(wrapper.get('input[aria-label="检索 API Key"]').exists()).toBe(true);
  });

  it('通知与维护表单的数字输入均可被准确命名', async () => {
    await mountSettings();
    await wrapper.findAll('button').find(button => button.text().trim() === '通知').trigger('click');
    await flushPromises();
    expect(wrapper.get('input[aria-label="通知轮询间隔（秒）"]').exists()).toBe(true);
    expect(wrapper.get('input[aria-label="内存告警阈值（%）"]').exists()).toBe(true);
    expect(wrapper.get('input[aria-label="Docker 空间告警阈值（GB）"]').exists()).toBe(true);

    await wrapper.findAll('button').find(button => button.text().trim() === '维护').trigger('click');
    await flushPromises();
    expect(wrapper.get('input[aria-label="镜像更新检查间隔（小时）"]').exists()).toBe(true);
  });

  it('操作成功和失败都以辅助技术可识别的状态语义呈现', async () => {
    await mountSettings();
    await wrapper.get('button.btn-primary').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toContain('个人偏好已保存');

    await wrapper.get('button.btn-secondary').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('请填写当前密码');
  });
});
