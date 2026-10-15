import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SettingsView from '../src/views/SettingsView.vue';

const mocks = vi.hoisted(() => {
  const api = {};
  for (const name of [
    'getPreferences', 'getNotifications', 'getUpdateSettings', 'getCapabilities', 'getMountPlan',
    'getStorageDf', 'getNotificationEvents', 'savePreferences', 'changePassword', 'saveNotifications',
    'saveNotificationEvents', 'testNotifications', 'saveUpdateSettings', 'checkUpdates', 'getAiConfig',
    'pingHost', 'saveMcpConfig', 'getMcpConfig', 'getProjects', 'getProjectManagement',
  ]) api[name] = vi.fn(async () => ({}));
  const aiStore = {
    config: { channels: [], failoverEnabled: true, systemPrompt: '', searchProvider: 'builtin', searchProviders: ['builtin'], searchApiKey: '' },
    loadConfig: vi.fn(async () => {}),
    saveConfig: vi.fn(async () => {}),
  };
  const hostsStore = { hosts: [], activeHostId: 'local', pinging: null, load: vi.fn(async () => {}), ping: vi.fn(async () => {}), switchHost: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  return { api, aiStore, hostsStore };
});

vi.mock('../src/api/client.js', () => ({ api: mocks.api }));
vi.mock('../src/stores/ai.js', () => ({ useAiStore: () => mocks.aiStore }));
vi.mock('../src/stores/hosts.js', () => ({ useHostsStore: () => mocks.hostsStore }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: { tab: 'personal' } }), useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

let wrapper;
beforeEach(() => {
  vi.clearAllMocks();
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
        AiChannelsPanel: true,
        StatCard: true,
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
