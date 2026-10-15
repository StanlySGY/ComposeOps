import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api, channels } = vi.hoisted(() => ({ api: { getProjects: vi.fn(), getPreferences: vi.fn(), streamProjectStats: vi.fn(() => new Promise(() => {})) }, channels: [] }));
vi.mock('../src/api/client.js', () => ({ api, wsUrl: path => path, streamProjectStats: api.streamProjectStats }));
vi.mock('../src/composables/useWebSocket.js', () => ({ useWebSocket: (url, options) => {
  const connected = ref(false);
  const channel = { url, options, connected, reconnecting: ref(false), connect: vi.fn(() => { connected.value = true; }), close: vi.fn(() => { connected.value = false; }) };
  channels.push(channel);
  return channel;
} }));
import LogsView from '../src/views/LogsView.vue';

describe('日志页面生命周期与数据完整性', () => {
  let wrapper;
  let router;
  beforeEach(() => {
    channels.length = 0;
    vi.clearAllMocks();
    api.getProjects.mockResolvedValue({ projects: [{ id: 'p', projectName: '测试', managed: true, containers: [{ id: 'c', name: 'web' }] }] });
    api.getPreferences.mockResolvedValue({ logTail: 200 });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    // jsdom 的 rAF 挂在定时器上,flushPromises 等不到它。同步执行让 LogPane 的可视区间立刻可断言。
    vi.stubGlobal('requestAnimationFrame', callback => { callback(0); return 0; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    wrapper?.unmount();
    vi.unstubAllGlobals();
    // BaseModal 走 Teleport,弹层落在 document.body 上,卸载后仍要清干净。
    document.body.innerHTML = '';
    document.body.style.overflow = '';
  });
  async function start(route = '/logs?projectId=p&containerId=c') {
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/logs', component: LogsView }] });
    await router.push(route);
    wrapper = mount(LogsView, { global: { plugins: [router], stubs: { AIDiagnosisModal: { props: ['rawLogs'], template: '<div class="diagnosis">{{ rawLogs }}</div>' } } } });
    await flushPromises();
  }
  const send = (data, aggregate = false) => channels[aggregate ? 1 : 0].options.onMessage({ data: JSON.stringify(data) });

  it('单容器 stdout ERROR 能完整带换行交给 AI 诊断', async () => {
    await start();
    send({ type: 'stdout', data: 'ERROR 第一行', level: 'error', ts: '2026-09-29T12:00:00Z' });
    send({ type: 'stdout', data: 'ERROR 第二行', level: 'error' });
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('AI 诊断')).trigger('click');
    expect(wrapper.get('.diagnosis').text()).toBe('ERROR 第一行\nERROR 第二行');
  });

  it('暂停时清屏也清除待显示缓存,恢复后不出现旧日志', async () => {
    await start();
    await wrapper.get('button[title="暂停显示"]').trigger('click');
    send({ type: 'stdout', data: '旧日志' });
    await wrapper.get('button[title="清屏"]').trigger('click');
    await wrapper.get('button[title="继续接收"]').trigger('click');
    expect(wrapper.text()).toContain('0 条');
    expect(wrapper.text()).not.toContain('旧日志');
  });

  it('暂停缓存有上限并明确告知被丢弃的日志数量', async () => {
    await start();
    await wrapper.get('button[title="暂停显示"]').trigger('click');
    for (let i = 0; i < 5010; i++) send({ type: 'stdout', data: `line ${i}` });
    await flushPromises();
    expect(wrapper.text()).toContain('5000 条待显示');
    expect(wrapper.text()).toContain('已丢弃 10 条');
  });

  it('正常结束帧主动关闭连接,不会把结束提示当日志或重连回放', async () => {
    await start();
    channels[0].close.mockClear();
    send({ type: 'end', data: '日志流已结束' });
    await flushPromises();
    expect(channels[0].close).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('日志已结束');
    expect(wrapper.text()).toContain('0 条');
  });

  it('仅项目的日志链接自动连接聚合流并使用偏好的 tail', async () => {
    await start('/logs?projectId=p');
    expect(channels[1].connect).toHaveBeenCalledOnce();
    expect(channels[1].url()).toContain('tail=200');
  });

  it('离开页面后迟到的初始化请求不会再建立连接', async () => {
    let resolve;
    api.getPreferences.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await start();
    wrapper.unmount(); wrapper = null;
    resolve({ logTail: 200 });
    await flushPromises();
    expect(channels[0].connect).not.toHaveBeenCalled();
  });

  it('字段查询按容器与级别过滤聚合日志', async () => {
    api.getProjects.mockResolvedValue({ projects: [{ id: 'p', projectName: '测试', managed: true, containers: [{ id: 'c1', name: 'api', state: 'running' }, { id: 'c2', name: 'web', state: 'running' }] }] });
    await start('/logs?projectId=p');
    send({ type: 'line', data: { containerId: 'c1', containerName: 'api', type: 'stderr', data: 'ERROR boom', level: 'error' } }, true);
    send({ type: 'line', data: { containerId: 'c1', containerName: 'api', type: 'stdout', data: 'health ok', level: 'info' } }, true);
    send({ type: 'line', data: { containerId: 'c2', containerName: 'web', data: 'ERROR 500', level: 'error' } }, true);
    await flushPromises();
    expect(wrapper.findAll('.aggregate-line')).toHaveLength(3);

    await wrapper.get('input[placeholder="level:error | container:api"]').setValue('container:api level:error');
    const rows = wrapper.findAll('.aggregate-line');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain('ERROR boom');
    expect(wrapper.text()).toContain('1 条');
  });

  it('查询语法写错时保留上一次结果,只提示不清空日志', async () => {
    await start();
    send({ type: 'stdout', data: '第一行日志' });
    await flushPromises();
    const searchInput = wrapper.get('input[placeholder="level:error | container:api"]');
    await searchInput.setValue('第一行');
    expect(wrapper.findAll('.aggregate-line')).toHaveLength(1);

    // 未写完的字段谓词:提示错误,但屏幕上的日志维持上一次的有效过滤。
    await searchInput.setValue('第一行 container:');
    expect(wrapper.get('.alert-warning').text()).toContain('字段 container: 缺少取值');
    expect(wrapper.findAll('.aggregate-line')).toHaveLength(1);
    expect(wrapper.text()).toContain('第一行日志');

    // 上一次查询本身就无命中时,空态文案要说明结果是被保留的,不是被清空的。
    await searchInput.setValue('不存在的关键字');
    expect(wrapper.find('.alert-warning').exists()).toBe(false);
    expect(wrapper.findAll('.aggregate-line')).toHaveLength(0);
    await searchInput.setValue('不存在的关键字 container:');
    expect(wrapper.get('.alert-warning').text()).toContain('字段 container: 缺少取值');
    expect(wrapper.text()).toContain('查询语法有误,已保留上一次结果');
  });

  it('分栏按容器名拆栏,每栏自带徽章与本栏计数', async () => {
    api.getProjects.mockResolvedValue({ projects: [{ id: 'p', projectName: '测试', managed: true, containers: [{ id: 'c1', name: 'web', state: 'running' }, { id: 'c2', name: 'api', state: 'running' }] }] });
    await start('/logs?projectId=p');
    send({ type: 'line', data: { containerId: 'c1', containerName: 'web', data: 'web 日志', level: 'info' } }, true);
    send({ type: 'line', data: { containerId: 'c2', containerName: 'api', data: 'ERROR api', level: 'error' } }, true);
    send({ type: 'line', data: { containerId: 'c2', containerName: 'api', data: 'api 日志', level: 'info' } }, true);
    await flushPromises();

    await wrapper.get('button[title="按容器分栏显示(快捷键 s)"]').trigger('click');
    expect(wrapper.find('.log-pane-grid').exists()).toBe(true);
    expect(wrapper.text()).toContain('2 栏');
    const panes = wrapper.findAll('.log-pane');
    expect(panes).toHaveLength(2);
    // 栏头按容器名排序,api 在 web 之前。
    expect(panes.map(pane => pane.get('.container-badge').text())).toEqual(['api', 'web']);
    expect(panes[0].text()).toContain('2 条');
    expect(panes[0].text()).toContain('ERROR 1');
    expect(panes[1].text()).toContain('1 条');
  });

  it('分栏与查询叠加:无命中的容器不再占栏', async () => {
    api.getProjects.mockResolvedValue({ projects: [{ id: 'p', projectName: '测试', managed: true, containers: [{ id: 'c1', name: 'web', state: 'running' }, { id: 'c2', name: 'api', state: 'running' }] }] });
    await start('/logs?projectId=p');
    send({ type: 'line', data: { containerId: 'c1', containerName: 'web', data: 'web 日志', level: 'info' } }, true);
    send({ type: 'line', data: { containerId: 'c2', containerName: 'api', data: 'ERROR api', level: 'error' } }, true);
    await flushPromises();
    await wrapper.get('button[title="按容器分栏显示(快捷键 s)"]').trigger('click');
    expect(wrapper.findAll('.log-pane')).toHaveLength(2);

    await wrapper.get('input[placeholder="level:error | container:api"]').setValue('level:error');
    const panes = wrapper.findAll('.log-pane');
    expect(panes).toHaveLength(1);
    expect(panes[0].get('.container-badge').text()).toBe('api');
    expect(wrapper.text()).toContain('1 栏');

    await wrapper.get('input[placeholder="level:error | container:api"]').setValue('level:error container:missing');
    expect(wrapper.findAll('.log-pane')).toHaveLength(0);
    expect(wrapper.text()).toContain('没有匹配当前查询的容器日志。');
  });

  it('分栏只在聚合模式可用:s 快捷键切分栏,单容器模式下按钮禁用', async () => {
    await start();
    expect(wrapper.get('button[title="按容器分栏显示(快捷键 s)"]').attributes('disabled')).toBeDefined();
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's' }));
    await flushPromises();
    expect(wrapper.find('.log-pane-grid').exists()).toBe(false);
    wrapper.unmount();

    await start('/logs?projectId=p');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's' }));
    await flushPromises();
    expect(wrapper.find('.log-pane-grid').exists()).toBe(true);
    expect(wrapper.get('button[title="合并为单列(快捷键 s)"]').attributes('disabled')).toBeUndefined();

    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's' }));
    await flushPromises();
    expect(wrapper.find('.log-pane-grid').exists()).toBe(false);
  });

  it('日志筛选控件有明确名称，聚合容器按钮暴露选择状态', async () => {
    api.getProjects.mockResolvedValue({ projects: [{ id: 'p', projectName: '测试', managed: true, containers: [{ id: 'c1', name: 'web', state: 'running' }, { id: 'c2', name: 'api', state: 'running' }] }] });
    await start('/logs?projectId=p');

    expect(wrapper.get('select[aria-label="选择日志项目"]').exists()).toBe(true);
    expect(wrapper.get('select[aria-label="按日志级别过滤"]').exists()).toBe(true);
    expect(wrapper.get('input[aria-label="搜索和过滤实时日志"]').exists()).toBe(true);
    expect(wrapper.get('input[aria-label="过滤容器列表"]').exists()).toBe(true);
    expect(wrapper.get('button[title="当前为聚合模式,点击切换为单容器"]').attributes('aria-pressed')).toBe('true');

    const webChip = wrapper.findAll('.container-chip').find(button => button.text().includes('web'));
    expect(webChip.attributes('aria-pressed')).toBe('false');
    await webChip.trigger('click');
    expect(webChip.attributes('aria-pressed')).toBe('true');
  });

  it('查询语法弹窗列出解析器支持的写法', async () => {
    await start();
    await wrapper.get('button[title="查询语法"]').trigger('click');
    await flushPromises();
    const backdrop = document.body.querySelector('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop.textContent).toContain('正则逃生舱');
    expect(backdrop.textContent).toContain('level:error');
    expect(backdrop.textContent).toContain('!health');
  });
});
