import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

const mocks = vi.hoisted(() => ({ api: { getProjects: vi.fn(), getCapabilities: vi.fn() }, channels: [], terminals: [] }));
vi.mock('../src/api/client.js', () => ({ api: mocks.api, wsUrl: value => value }));
vi.mock('../src/composables/useWebSocket.js', () => ({ useWebSocket(url, options) {
  const connected = ref(false);
  const channel = { connected, sent: [], connect: vi.fn(() => { connected.value = true; options.onOpen(); }), close: vi.fn(() => { connected.value = false; }), send: vi.fn(value => { if (connected.value) channel.sent.push(value); }), url, options };
  mocks.channels.push(channel); return channel;
} }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  constructor() { this.cols = 80; this.rows = 24; this.dispose = vi.fn(); mocks.terminals.push(this); }
  loadAddon() {} open() {} focus() {} reset() {} write() {}
  onData(callback) { this.input = callback; } onResize() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
import ShellView from '../src/views/ShellView.vue';

const projects = [{ id: 'p', managed: true, projectName: '测试项目', containers: [{ id: 'c1', name: 'web', state: 'running' }, { id: 'c2', name: 'worker', state: 'running' }] }];
let wrapper; let router;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function start() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/shell', name: 'shell', component: ShellView }, { path: '/services', name: 'services', component: {} }] });
  await router.push('/shell?projectId=p&containerId=c1');
  wrapper = mount(ShellView, { global: { plugins: [router] } });
  await flushPromises();
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.channels.length = 0; mocks.terminals.length = 0;
  mocks.api.getProjects.mockResolvedValue({ projects });
  mocks.api.getCapabilities.mockResolvedValue({ shellEnabled: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.unstubAllGlobals(); });

describe('终端目标与会话一致性', () => {
  it('深链进入停止容器时解释原因且不尝试连接', async () => {
    mocks.api.getProjects.mockResolvedValue({ projects: [{ ...projects[0], containers: [{ id: 'c1', name: 'web', state: 'exited' }] }] });
    await start();
    expect(mocks.channels[0].connect).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('当前容器未运行');
    expect(wrapper.findAll('button').find(button => button.text() === '连接').attributes('disabled')).toBeDefined();
  });
  it('切换容器先断开旧会话，输入不再发送，显式连接后才连接新目标', async () => {
    await start();
    const channel = mocks.channels[0];
    expect(channel.connected.value).toBe(true);
    await wrapper.get('[aria-label="选择终端容器"]').setValue('c2'); await flushPromises();
    expect(channel.connected.value).toBe(false);
    expect(router.currentRoute.value.query.containerId).toBe('c2');
    const sent = channel.sent.length;
    mocks.terminals[0].input('echo must-not-send\n');
    expect(channel.sent).toHaveLength(sent);
    expect(wrapper.get('[role="status"]').text()).toContain('worker');
    await wrapper.findAll('button').find(button => button.text() === '连接').trigger('click');
    expect(channel.connected.value).toBe(true);
    expect(channel.url()).toContain('containerId=c2');
  });
  it('同页深链切换目标不会在旧终端中继续输入', async () => {
    await start();
    await router.push('/shell?projectId=p&containerId=c2'); await flushPromises();
    expect(mocks.channels[0].connected.value).toBe(false);
    expect(wrapper.get('[aria-label="选择终端容器"]').element.value).toBe('c2');
  });
  it('切换 Shell 类型也结束旧会话', async () => {
    await start();
    await wrapper.get('[aria-label="选择终端 Shell"]').setValue('bash');
    expect(mocks.channels[0].connected.value).toBe(false);
    expect(wrapper.get('[role="status"]').text()).toContain('bash');
  });
  it('节点切换清除旧项目与容器，并忽略旧节点迟到的列表', async () => {
    const old = deferred(); mocks.api.getProjects.mockReturnValueOnce(old.promise);
    await start();
    mocks.api.getProjects.mockResolvedValue({ projects: [{ id: 'new', projectName: '新节点', managed: true, containers: [] }] });
    window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises();
    old.resolve({ projects }); await flushPromises();
    expect(wrapper.get('[aria-label="选择终端项目"]').text()).toContain('新节点');
    expect(wrapper.get('[aria-label="选择终端项目"]').text()).not.toContain('测试项目');
    expect(router.currentRoute.value.query).toEqual({});
    expect(mocks.channels[0].connect).not.toHaveBeenCalled();
  });
  it('首次加载失败可以重试，终端不会无限停在骨架屏', async () => {
    mocks.api.getProjects.mockRejectedValueOnce(new Error('暂时不可达'));
    await start();
    expect(wrapper.get('[role="alert"]').text()).toContain('暂时不可达');
    expect(wrapper.text()).toContain('终端未连接');
    await wrapper.findAll('button').find(button => button.text() === '重新加载').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(mocks.channels[0].connected.value).toBe(false);
  });
  it('请求期间离开后不再创建终端或建立连接', async () => {
    const pending = deferred(); mocks.api.getProjects.mockReturnValueOnce(pending.promise);
    await start(); const terminal = mocks.terminals[0];
    wrapper.unmount(); wrapper = null;
    pending.resolve({ projects }); await flushPromises();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.channels[0].connect).not.toHaveBeenCalled();
  });
});
