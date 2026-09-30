import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

const { api, channels } = vi.hoisted(() => ({ api: { getProjects: vi.fn(), getPreferences: vi.fn() }, channels: [] }));
vi.mock('../src/api/client.js', () => ({ api, wsUrl: path => path }));
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
  });
  afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });
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
});
