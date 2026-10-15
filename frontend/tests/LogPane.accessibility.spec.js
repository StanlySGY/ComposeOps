import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import LogPane from '../src/components/logs/LogPane.vue';
import LogLine from '../src/components/logs/LogLine.vue';

let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('实时日志阅读区域可访问性', () => {
  it('为虚拟滚动区域提供可访问名称和键盘焦点入口，并避免高频日志自动打断读屏', async () => {
    vi.stubGlobal('requestAnimationFrame', callback => { callback(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    wrapper = mount(LogPane, {
      props: {
        lines: [{ id: 'l1', data: 'service started', level: 'info' }],
        fallbackName: 'api-worker', connected: true, autoScroll: false,
      },
    });
    await flushPromises();
    const region = wrapper.get('[role="region"]');
    expect(region.attributes('aria-label')).toBe('api-worker实时日志');
    expect(region.attributes('tabindex')).toBe('0');
    expect(region.attributes('aria-live')).toBe('off');
    expect(wrapper.text()).toContain('service started');
  });

  it('分栏日志用容器名标识各自阅读区域', () => {
    wrapper = mount(LogPane, {
      props: { lines: [], heading: 'redis', containerId: 'c-1', emptyText: '等待日志' },
    });
    expect(wrapper.get('[role="region"]').attributes('aria-label')).toBe('redis实时日志');
  });

  it('JSON 日志的展开按钮公布展开状态和内容上下文', async () => {
    wrapper = mount(LogLine, {
      props: { line: { id: 'json-1', data: '{"service":"api","ok":true}', level: 'info' } },
    });
    const button = wrapper.get('button.json-toggle');
    expect(button.attributes('aria-expanded')).toBe('false');
    expect(button.attributes('aria-label')).toContain('展开 JSON 日志');
    expect(button.attributes('aria-label')).toContain('service');
    await button.trigger('click');
    expect(wrapper.get('button.json-toggle').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('pre.json-block').text()).toContain('"service": "api"');
  });
});
