import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { useWebSocket } from '../src/composables/useWebSocket.js';

class TestSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];
  readyState = 0;
  constructor(url) { this.url = url; TestSocket.instances.push(this); }
  close() { this.readyState = 3; }
  send() {}
}
describe('WebSocket 连接代际与卸载', () => {
  beforeEach(() => { TestSocket.instances = []; vi.stubGlobal('WebSocket', TestSocket); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('主动关闭后迟到的 open 不会让页面再次显示已连接', () => {
    const hook = useWebSocket('/test');
    hook.connect();
    const onOpen = TestSocket.instances[0].onopen;
    hook.close();
    onOpen();
    expect(hook.connected.value).toBe(false);
  });
  it('旧连接的消息不能混入新连接', () => {
    const onMessage = vi.fn();
    const hook = useWebSocket('/test', { onMessage });
    hook.connect();
    const oldMessage = TestSocket.instances[0].onmessage;
    hook.close(); hook.connect();
    oldMessage({ data: '旧节点的日志' });
    expect(onMessage).not.toHaveBeenCalled();
    TestSocket.instances[1].onmessage({ data: '新节点的日志' });
    expect(onMessage).toHaveBeenCalledOnce();
    hook.close();
  });
  it('组件卸载后异步初始化不能再调用 connect 创建连接', () => {
    let hook;
    const wrapper = mount({ setup() { hook = useWebSocket('/test'); }, template: '<div />' });
    wrapper.unmount();
    hook.connect();
    expect(TestSocket.instances).toHaveLength(0);
  });
  it('同地址重复连接不打断流，地址变化会关闭旧流并建立新连接', () => {
    let url = '/logs?containers=a';
    const hook = useWebSocket(() => url);
    hook.connect(); hook.connect();
    expect(TestSocket.instances).toHaveLength(1);
    const old = TestSocket.instances[0];
    const oldOpen = old.onopen;
    url = '/logs?containers=b'; hook.connect();
    expect(old.readyState).toBe(3);
    expect(TestSocket.instances[1].url).toBe(url);
    oldOpen();
    expect(hook.connected.value).toBe(false);
    hook.close();
  });
  it('握手超时释放旧连接，重试耗尽后可手动重连', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const hook = useWebSocket('/logs', { connectTimeout: 100, reconnectDelay: 10, maxReconnectAttempts: 1, onError });
    hook.connect();
    expect(hook.connecting.value).toBe(true);
    vi.advanceTimersByTime(110);
    expect(TestSocket.instances).toHaveLength(2);
    expect(TestSocket.instances[0].readyState).toBe(3);
    vi.advanceTimersByTime(100);
    expect(hook.reconnecting.value).toBe(false);
    expect(hook.connecting.value).toBe(false);
    expect(onError.mock.calls.at(-1)[0].message).toContain('重连 1 次');
    hook.connect();
    TestSocket.instances[2].onopen();
    expect(hook.connected.value).toBe(true);
    hook.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('构造连接失败仍按次数退避，避免重连中状态永久挂起', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('network'); } });
    const hook = useWebSocket('/logs', { reconnectDelay: 10, maxReconnectAttempts: 2 });
    hook.connect();
    vi.runAllTimers();
    expect(hook.reconnecting.value).toBe(false);
    expect(hook.reconnectAttempts.value).toBe(2);
    hook.close();
  });
  it('离线时不消耗重试次数，恢复网络只建一条流，主动断开后不再自动连接', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const hook = useWebSocket('/logs', { watchNetwork: true, onOpen });
    hook.connect(); TestSocket.instances[0].onopen();
    window.dispatchEvent(new Event('offline'));
    expect(hook.offline.value).toBe(true);
    expect(hook.connected.value).toBe(false);
    vi.advanceTimersByTime(120000);
    expect(TestSocket.instances).toHaveLength(1);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    expect(TestSocket.instances).toHaveLength(2);
    TestSocket.instances[1].onopen();
    expect(onOpen).toHaveBeenLastCalledWith({ resumed: true });
    hook.close();
    window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online'));
    expect(TestSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('终端禁用重连时握手超时不会自动开启新会话', () => {
    vi.useFakeTimers();
    const hook = useWebSocket('/exec', { maxReconnectAttempts: 0, connectTimeout: 100 });
    hook.connect(); vi.runAllTimers();
    expect(TestSocket.instances).toHaveLength(1);
    expect(hook.connecting.value).toBe(false);
    expect(hook.reconnecting.value).toBe(false);
    hook.close();
  });
  it('心跳丢失回收半开连接，pong 不作为日志，关闭时释放所有定时器', () => {
    vi.useFakeTimers();
    const onMessage = vi.fn();
    const hook = useWebSocket('/logs', { heartbeatInterval: 100, heartbeatTimeout: 50, reconnectDelay: 10, onMessage });
    hook.connect();
    const first = TestSocket.instances[0];
    first.send = vi.fn(); first.onopen();
    vi.advanceTimersByTime(100);
    expect(first.send).toHaveBeenCalledWith('{"type":"ping"}');
    first.onmessage({ data: '{"type":"pong"}' });
    expect(onMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(first.readyState).toBe(3);
    expect(hook.connected.value).toBe(false);
    vi.advanceTimersByTime(10);
    expect(TestSocket.instances).toHaveLength(2);
    hook.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
