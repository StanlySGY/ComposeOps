import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { useWebSocket } from '../src/composables/useWebSocket.js';

class TestSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];
  readyState = 0;
  constructor() { TestSocket.instances.push(this); }
  close() { this.readyState = 3; }
  send() {}
}
describe('WebSocket 连接代际与卸载', () => {
  beforeEach(() => { TestSocket.instances = []; vi.stubGlobal('WebSocket', TestSocket); });
  afterEach(() => vi.unstubAllGlobals());
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
});
