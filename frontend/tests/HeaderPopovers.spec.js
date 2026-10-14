import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api } = vi.hoisted(() => ({
  api: {
    getHosts: vi.fn(),
    setActiveHost: vi.fn(),
    pingHost: vi.fn(),
    saveHost: vi.fn(),
    deleteHost: vi.fn(),
    getProjects: vi.fn(),
    getBlueprints: vi.fn(),
  },
}));
vi.mock('../src/api/client.js', () => ({ api, bumpHostEpoch: vi.fn() }));

import AppHeader from '../src/components/AppHeader.vue';
import HostSwitcher from '../src/components/HostSwitcher.vue';

function routerInstance() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'dashboard', component: { template: '<main><h1>运维总览</h1></main>' } },
      { path: '/services', name: 'services', component: { template: '<main><h1>服务总览</h1></main>' } },
      { path: '/settings', name: 'settings', component: { template: '<main><h1>设置</h1></main>' } },
    ],
  });
}

const hostFixtures = () => [
  { id: 'local', name: '本机', type: 'local', status: 'online', active: true, host: '', port: 0 },
  { id: 'remote', name: '测试节点', type: 'ssh', status: 'online', active: false, host: '192.0.2.10', port: 22 },
];

let wrapper;
let router;
let pinia;

beforeEach(() => {
  vi.clearAllMocks();
  api.getHosts.mockImplementation(async () => ({ hosts: hostFixtures() }));
  api.getProjects.mockResolvedValue({ projects: [{ id: 'project-1', projectName: '示例项目', owner: 'test', workingDir: '/workspace/demo', containers: [], managed: false }] });
  api.getBlueprints.mockResolvedValue({ blueprints: [] });
  api.setActiveHost.mockResolvedValue({ activeHostId: 'remote' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  localStorage.clear();
  document.body.innerHTML = '';
  pinia = createPinia();
  router = routerInstance();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
});

async function start(component, stubs = {}) {
  await router.push('/');
  await router.isReady();
  wrapper = mount(component, {
    attachTo: document.body,
    global: {
      plugins: [router, pinia],
      stubs: { HostSwitcher: true, EventCenter: true, CommandPalette: true, ConfirmDialog: true, ...stubs },
    },
  });
  await flushPromises();
}

describe('顶部下拉控件的可访问性与焦点恢复', () => {
  it('Docker 节点切换器公开展开状态和命名组，并在 Escape 后恢复焦点', async () => {
    await start(HostSwitcher);
    const trigger = document.querySelector('button[aria-label="切换 Docker 节点"]');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.focus();
    trigger.click();
    await flushPromises();

    const panel = document.querySelector('#docker-host-switcher-panel');
    expect(panel.getAttribute('role')).toBe('group');
    expect(panel.getAttribute('aria-labelledby')).toBe('docker-host-switcher-title');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe('docker-host-switcher-panel');
    expect(panel.querySelector('button[aria-label="刷新节点状态"]')).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(document.querySelector('#docker-host-switcher-panel')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('项目切换器打开后聚焦到有名称的搜索框，Escape 后焦点返回入口', async () => {
    await start(AppHeader);
    const trigger = document.querySelector('button[aria-label="快速切换项目"]');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.focus();
    trigger.click();
    await flushPromises();

    const panel = document.querySelector('#project-switcher-panel');
    const search = panel.querySelector('input[aria-label="搜索项目"]');
    expect(panel.getAttribute('role')).toBe('group');
    expect(panel.getAttribute('aria-labelledby')).toBe('project-switcher-title');
    expect(search).not.toBeNull();
    expect(document.activeElement).toBe(search);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(document.querySelector('#project-switcher-panel')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});
