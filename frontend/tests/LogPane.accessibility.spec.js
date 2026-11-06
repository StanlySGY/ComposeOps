import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
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

  it('历史阅读支持滚轮、触摸滚动和新日志计数，到底后才恢复跟随', async () => {
    const frames = new Map(); let serial = 0;
    vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++serial, callback); return serial; });
    vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const flushFrames = async () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); } await flushPromises(); };
    const lines = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, data: `line ${i}` }));
    wrapper = mount(LogPane, { props: { lines, connected: true } });
    const region = wrapper.get('[role="region"]');
    Object.defineProperties(region.element, { clientHeight: { value: 240 }, scrollHeight: { get: () => wrapper.props('lines').length * 24 } });
    await flushPromises(); await flushFrames();
    await region.trigger('wheel', { deltaY: -100 });
    region.element.scrollTop = 120;
    await region.trigger('scroll');
    await region.trigger('wheel', { deltaY: 24 });
    await wrapper.setProps({ lines: [...lines, { id: 101, data: 'new' }], revision: 1 });
    await flushFrames();
    expect(region.element.scrollTop).toBe(120);
    expect(wrapper.get('.scroll-resume-chip').text()).toContain('1 条新日志');
    await wrapper.get('.scroll-resume-chip').trigger('click');
    await flushFrames();
    expect(region.element.scrollTop).toBe(2424);
    expect(wrapper.find('.scroll-resume-chip').exists()).toBe(false);
    // Touch/scrollbar/keyboard paths have no wheel event.
    region.element.scrollTop = 50;
    await region.trigger('scroll');
    await wrapper.setProps({ revision: 2 });
    await flushFrames();
    expect(region.element.scrollTop).toBe(50);
    expect(wrapper.find('.scroll-resume-chip').exists()).toBe(true);
    region.element.scrollTop = 2184;
    await region.trigger('scroll');
    expect(wrapper.find('.scroll-resume-chip').exists()).toBe(false);
    // A live frame arriving while the finger is down must not move the viewport.
    await region.trigger('touchstart');
    await wrapper.setProps({ lines: [...lines, { id: 101, data: 'new' }, { id: 102, data: 'touch update' }], revision: 3 });
    await flushFrames();
    expect(region.element.scrollTop).toBe(2184);
    region.element.scrollTop = 2000;
    await region.trigger('scroll');
    await region.trigger('touchend');
    await flushFrames();
    expect(region.element.scrollTop).toBe(2000);
    expect(wrapper.find('.scroll-resume-chip').exists()).toBe(true);
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
  it('缓存页面失活后停止测量和滚底，返回后重新订阅可见行', async () => {
    const observers = [];
    const frames = new Map(); let serial = 0;
    vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++serial, callback); return serial; });
    vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
      constructor() { observers.push(this); }
    });
    const visible = ref(true);
    wrapper = mount({ components: { LogPane }, setup: () => ({ visible }), template: '<KeepAlive><LogPane v-if="visible" :lines="[{id: 1, data: \'cached log\'}]" /></KeepAlive>' });
    await flushPromises();
    expect(observers).toHaveLength(1);
    expect(observers[0].observe.mock.calls.length).toBeGreaterThan(1);
    visible.value = false;
    await flushPromises();
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    visible.value = true;
    await flushPromises();
    expect(observers).toHaveLength(2);
    expect(observers[1].observe.mock.calls.length).toBeGreaterThan(1);
  });
});
