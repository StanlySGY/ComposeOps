import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

const mocks = vi.hoisted(() => ({ api: { getProjects: vi.fn(), getCapabilities: vi.fn() }, channels: [], terminals: [], searches: [] }));
vi.mock('../src/api/client.js', () => ({ api: mocks.api, wsUrl: value => value }));
vi.mock('../src/composables/useWebSocket.js', () => ({ useWebSocket(url, options) {
  const connected = ref(false);
  const channel = { connected, sent: [], connect: vi.fn(() => { connected.value = true; options.onOpen(); }), close: vi.fn(() => { connected.value = false; }), send: vi.fn(value => { if (connected.value) channel.sent.push(value); }), url, options };
  mocks.channels.push(channel); return channel;
} }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.dispose = vi.fn(); mocks.terminals.push(this); }
  loadAddon() {} open() {} focus = vi.fn(); reset() {} write = vi.fn();
  clearSelection = vi.fn(); scrollToBottom = vi.fn(); onScroll() {} onWriteParsed() {}
  buffer = { active: { viewportY: 0, baseY: 0 } };
  clear = vi.fn(); getSelection() { return ""; } onSelectionChange() {} options = {};
  onData(callback) { this.input = callback; } onResize() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {
  constructor() { mocks.searches.push(this); }
  findNext = vi.fn(); findPrevious = vi.fn(); clearDecorations = vi.fn(); dispose = vi.fn();
  onDidChangeResults(callback) { this.results = callback; }
} }));
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
  vi.clearAllMocks(); mocks.channels.length = 0; mocks.terminals.length = 0; mocks.searches.length = 0;
  mocks.api.getProjects.mockResolvedValue({ projects });
  mocks.api.getCapabilities.mockResolvedValue({ shellEnabled: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

describe('终端查找与输入隔离', () => {
  async function open() {
    await start(); mocks.channels[0].options.onMessage({ data: JSON.stringify({ type: 'ready' }) }); await flushPromises();
    await wrapper.get('[aria-label="查找终端输出"]').trigger('click'); await flushPromises();
  }
  it('输入即查找、切换大小写、上下匹配和关闭均不发送命令', async () => {
    await open(); const search = mocks.searches.at(-1), channel = mocks.channels[0], sent = channel.sent.length;
    await wrapper.get('input[aria-label="终端查找内容"]').setValue('Error');
    expect(search.findNext).toHaveBeenLastCalledWith('Error', expect.objectContaining({ incremental: true, caseSensitive: false }));
    search.results({ resultIndex: 0, resultCount: 3 }); await flushPromises();
    expect(wrapper.get('.shell-search-result').text()).toBe('1 / 3');
    await wrapper.get('[aria-label="区分大小写"]').trigger('click');
    expect(search.findNext).toHaveBeenLastCalledWith('Error', expect.objectContaining({ caseSensitive: true }));
    await wrapper.get('[aria-label="上一个匹配"]').trigger('click');
    expect(search.findPrevious).toHaveBeenCalledWith('Error', expect.objectContaining({ incremental: false }));
    await wrapper.get('input').trigger('keydown', { key: 'Enter' });
    expect(search.findNext).toHaveBeenLastCalledWith('Error', expect.objectContaining({ incremental: false }));
    await wrapper.get('[aria-label="关闭终端查找"]').trigger('click');
    expect(wrapper.find('.shell-search').exists()).toBe(false);
    expect(search.clearDecorations).toHaveBeenCalled(); expect(mocks.terminals[0].focus).toHaveBeenCalled();
    expect(channel.sent).toHaveLength(sent);
  });
  it('中文输入确认不触发匹配跳转，空内容清除高亮且反馈真实', async () => {
    await open(); const search = mocks.searches.at(-1);
    await wrapper.get('input').setValue('服务'); search.findNext.mockClear();
    await wrapper.get('input').trigger('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(search.findNext).not.toHaveBeenCalled();
    search.results({ resultIndex: -1, resultCount: 0 }); await flushPromises();
    expect(wrapper.get('.shell-search-result').text()).toBe('未找到匹配');
    search.results({ resultIndex: -1, resultCount: 1000 }); await flushPromises();
    expect(wrapper.get('.shell-search-result').text()).toBe('至少 1000 处');
    await wrapper.get('input').setValue('');
    expect(wrapper.get('.shell-search-result').text()).toBe('输入关键词');
    expect(wrapper.get('[aria-label="下一个匹配"]').attributes('disabled')).toBeDefined();
    expect(search.clearDecorations).toHaveBeenCalled();
  });
  it('断开仍可查找保留输出，新会话清除旧匹配和关键词', async () => {
    await open(); await wrapper.get('input').setValue('old');
    await wrapper.findAll('button').find(button => button.text() === '断开').trigger('click');
    expect(wrapper.find('.shell-search').exists()).toBe(true);
    await wrapper.findAll('button').find(button => button.text() === '新建会话').trigger('click');
    expect(wrapper.find('.shell-search').exists()).toBe(false);
    mocks.channels[0].options.onMessage({ data: JSON.stringify({ type: 'ready' }) }); await flushPromises();
    await wrapper.get('[aria-label="查找终端输出"]').trigger('click');
    expect(wrapper.get('input').element.value).toBe('');
  });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.unstubAllGlobals(); vi.useRealTimers(); });

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


describe('终端就绪反馈与操作连续性', () => {
  const ready = () => mocks.channels[0].options.onMessage({ data: JSON.stringify({ type: 'ready' }) });
  const button = label => wrapper.findAll('button').find(b => b.text() === label);
  it('早到的Shell输出在就绪后解析，自动终端回复不会被禁用输入吞掉', async () => {
    await start(); const terminal = mocks.terminals[0], channel = mocks.channels[0];
    terminal.write.mockImplementation(() => { if (!terminal.options.disableStdin) terminal.input('\x1b[1;1R'); });
    channel.options.onMessage({ data: new Uint8Array([27, 91, 54, 110]).buffer });
    expect(terminal.write).not.toHaveBeenCalled();
    ready();
    expect(terminal.options.disableStdin).toBe(false);
    expect(terminal.write).toHaveBeenCalledOnce();
    expect(channel.sent.at(-1)).toBe('\x1b[1;1R');
  });
  it('启动失败仍显示早到的诊断输出且不发送任何终端回复', async () => {
    await start(); const terminal = mocks.terminals[0], channel = mocks.channels[0]; const before = channel.sent.length;
    channel.options.onMessage({ data: 'shell startup error' });
    channel.options.onMessage({ data: JSON.stringify({ type: 'error', data: 'Shell未能启动' }) });
    expect(terminal.write).toHaveBeenCalledWith('shell startup error');
    expect(terminal.options.disableStdin).toBe(true); expect(channel.sent).toHaveLength(before);
  });
  it('WebSocket已打开但Shell未就绪时仍等待且不发送键盘输入', async () => {
    await start();
    expect(wrapper.get('.terminal-session-bar').text()).toContain('正在启动 Shell');
    const sent = mocks.channels[0].sent.length; mocks.terminals[0].input('do-not-run\n');
    expect(mocks.channels[0].sent).toHaveLength(sent);
    ready(); await flushPromises();
    expect(wrapper.get('.terminal-session-bar').text()).toContain('已连接');
    mocks.terminals[0].input('pwd\n'); expect(mocks.channels[0].sent.at(-1)).toBe('pwd\n');
  });
  it('Shell初始化超时会断开并可手动重试', async () => {
    vi.useFakeTimers(); await start(); await vi.advanceTimersByTimeAsync(31000);
    expect(mocks.channels[0].connected.value).toBe(false);
    expect(wrapper.text()).toContain('初始化超时');
    expect(button('连接').attributes('disabled')).toBeUndefined();
  });
  it('连接后断开保留可选中的终端输出，重新连接明确开启新会话', async () => {
    await start(); ready(); await flushPromises();
    await button('断开').trigger('click'); await flushPromises();
    expect(wrapper.find('.terminal-empty').exists()).toBe(false);
    expect(wrapper.get('.terminal-session-bar').text()).toContain('已断开');
    expect(wrapper.text()).toContain('输出已保留');
    expect(button('新建会话')).toBeDefined();
  });
  it('清除滚动记录只操作本地显示，不把clear拼进用户命令', async () => {
    await start(); ready(); await flushPromises();
    const before = mocks.channels[0].sent.length;
    await wrapper.get('[aria-label="清除终端滚动记录"]').trigger('click');
    expect(mocks.terminals[0].clear).toHaveBeenCalledOnce(); expect(mocks.channels[0].sent).toHaveLength(before);
  });
  it('刷新发现容器停止立即结束输入并保留结果', async () => {
    await start(); ready(); await flushPromises();
    mocks.api.getProjects.mockResolvedValue({ projects: [{ ...projects[0], containers: [{ id: 'c1', name: 'web', state: 'exited' }] }] });
    await wrapper.get('[aria-label="刷新终端目标"]').trigger('click'); await flushPromises();
    expect(mocks.channels[0].connected.value).toBe(false); expect(wrapper.text()).toContain('当前容器未运行');
    expect(wrapper.find('.terminal-empty').exists()).toBe(false);
  });
  it('功能开关加载失败仍可浏览项目，重试成功后不自动误连', async () => {
    mocks.api.getCapabilities.mockRejectedValueOnce(new Error('功能开关暂时不可达'));
    await start(); expect(wrapper.get('[aria-label="选择终端项目"]').text()).toContain('测试项目');
    expect(mocks.channels[0].connect).not.toHaveBeenCalled();
    await button('重新加载').trigger('click'); await flushPromises();
    expect(mocks.channels[0].connect).not.toHaveBeenCalled();
    expect(button('连接').attributes('disabled')).toBeUndefined();
  });
  it('Shell类型保存在深链中，前进后退不会沿用错误Shell', async () => {
    await start(); await wrapper.get('[aria-label="选择终端 Shell"]').setValue('bash'); await flushPromises();
    expect(router.currentRoute.value.query.cmd).toBe('bash');
    await router.push('/shell?projectId=p&containerId=c2&cmd=sh'); await flushPromises();
    expect(wrapper.get('[aria-label="选择终端 Shell"]').element.value).toBe('sh');
  });
});
