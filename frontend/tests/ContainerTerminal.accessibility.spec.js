import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ContainerTerminal from '../src/components/ContainerTerminal.vue';

const terminalInstances = vi.hoisted(() => []);
const sockets = vi.hoisted(() => []);
vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; terminalInstances.push(this); }
    loadAddon() {}
    open() {}
    fit() {}
    write() {}
    clear() {}
    dispose() {}
    onData() { return { dispose() {} }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class MockFitAddon { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class MockWebLinksAddon {} }));

let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  terminalInstances.length = 0;
  sockets.length = 0;
  vi.unstubAllGlobals();
});

describe('容器终端可访问性', () => {
  it('启用 xterm 屏幕阅读器模式，并为终端区域命名', () => {
    wrapper = mount(ContainerTerminal, {
      props: { projectId: 'p1', containerId: 'c1', containerName: 'api-worker', shell: 'bash' },
    });
    expect(terminalInstances[0].options.screenReaderMode).toBe(true);
    expect(wrapper.get('[role="region"]').attributes('aria-label')).toBe('容器终端：api-worker，Shell bash');
    expect(wrapper.get('[role="region"]').attributes('aria-busy')).toBe('false');
    expect(wrapper.get('[role="status"][aria-live="polite"]').text()).toBe('终端未连接');
    expect(wrapper.get('button').text()).toContain('连接终端');
  });

  it('终端连接错误作为可及时感知的 alert 呈现', async () => {
    class MockWebSocket {
      constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
      send() {}
      close() { this.readyState = 3; this.onclose?.(); }
    }
    vi.stubGlobal('WebSocket', MockWebSocket);
    wrapper = mount(ContainerTerminal, {
      props: { projectId: 'p1', containerId: 'c1', containerName: 'api-worker' },
    });
    await wrapper.get('button').trigger('click');
    expect(wrapper.get('[role="region"]').attributes('aria-busy')).toBe('true');
    // WebSocket 创建由浏览器提供；在测试环境中使用一个可控的最小实现。
    const socket = sockets.at(-1);
    expect(socket).toBeDefined();
    socket.onerror();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('连接失败');
    expect(wrapper.get('[role="status"]').text()).toBe('容器终端连接失败');
  });
});
