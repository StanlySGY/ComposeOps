import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, ref } from 'vue';
import ForceGraph from '../src/components/ForceGraph.vue';
let wrapper, frames, observers, frameId;
const nodes = [{ key: 'one', label: '节点一', state: 'running' }, { key: 'two', label: '节点二', state: 'running' }];
beforeEach(() => {
  frameId = 0; frames = new Map(); observers = [];
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frames.set(++frameId, callback); return frameId; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn(id => frames.delete(id)));
  vi.stubGlobal('ResizeObserver', class {
    connected = false; constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.connected = true; } disconnect() { this.connected = false; }
  });
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 900, height: 560, left: 0, top: 0 });
});
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function cached() {
  const visible = ref(true), data = ref(nodes);
  const Other = defineComponent({ render: () => h('p', 'other') });
  wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => visible.value
    ? h(ForceGraph, { nodes: data.value, edges: [{ source: 'one', target: 'two' }], defaultLayout: 'force' }) : h(Other) }) }));
  await flushPromises(); return { visible, data };
}
function pointer(type, target, init = {}) {
  const event = new Event(type, { bubbles: true });
  for (const [key, value] of Object.entries({ button: 0, pointerType: 'touch', pointerId: 1, clientX: 80, clientY: 80, ...init })) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
}

describe('缓存图谱的动画、尺寸监听与拖动生命周期', () => {
  it('失活停止动画并解除尺寸观察，返回仅恢复一组资源', async () => {
    const { visible } = await cached(); expect(frames.size).toBe(1); expect(observers.filter(o => o.connected)).toHaveLength(1);
    visible.value = false; await flushPromises(); expect(frames.size).toBe(0); expect(observers.filter(o => o.connected)).toHaveLength(0);
    visible.value = true; await flushPromises(); expect(frames.size).toBe(1); expect(observers.filter(o => o.connected)).toHaveLength(1);
    visible.value = false; await flushPromises(); visible.value = true; await flushPromises();
    expect(frames.size).toBe(1); expect(observers.filter(o => o.connected)).toHaveLength(1);
  });
  it('失活后的数据更新和迟到尺寸回调不能重启动画或读取隐藏视口', async () => {
    const { visible, data } = await cached(); const lateResize = observers[0].callback;
    visible.value = false; await flushPromises();
    const count = SVGElement.prototype.getBoundingClientRect.mock.calls.length;
    data.value = [...nodes, { key: 'three', label: '新节点' }]; await flushPromises(); lateResize(); await flushPromises();
    expect(frames.size).toBe(0); expect(SVGElement.prototype.getBoundingClientRect).toHaveBeenCalledTimes(count);
  });
  it('切回分层布局立即停止尚未冷却的力导向帧', async () => {
    await cached(); const animation = [...frames.keys()][0];
    await wrapper.findAll('button').find(b => b.text() === '分层架构').trigger('click');
    expect(cancelAnimationFrame).toHaveBeenCalledWith(animation);
    expect(frames.size).toBe(1); // 单次视口适配仍允许执行。
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback());
    expect(frames.size).toBe(0);
  });
  it('触摸取消清理拖动且不能把后续 pointerup 当作节点点击', async () => {
    wrapper = mount(ForceGraph, { props: { nodes } }); await flushPromises();
    pointer('pointerdown', wrapper.find('[data-key="one"]').element); await flushPromises();
    expect(wrapper.find('[data-key="one"]').classes()).toContain('ios-grabbing');
    pointer('pointercancel', window); await flushPromises(); pointer('pointerup', window);
    expect(wrapper.find('[data-key="one"]').classes()).not.toContain('ios-grabbing');
    expect(wrapper.emitted('node-click')).toBeUndefined();
  });
  it('拖动期间离开缓存页后全局指针事件不触发旧节点操作', async () => {
    const { visible } = await cached(), graph = wrapper.findComponent(ForceGraph);
    pointer('pointerdown', graph.find('[data-key="one"]').element);
    visible.value = false; await flushPromises(); pointer('pointerup', window);
    expect(graph.emitted('node-click')).toBeUndefined();
    visible.value = true; await flushPromises(); expect(graph.find('[data-key="one"]').classes()).not.toContain('ios-grabbing');
  });
  it('拖动中卸载立即移除 window 监听，不等待用户抬手', async () => {
    wrapper = mount(ForceGraph, { props: { nodes } }); await flushPromises();
    const removed = vi.spyOn(window, 'removeEventListener');
    pointer('pointerdown', wrapper.find('[data-key="one"]').element); wrapper.unmount(); wrapper = null;
    expect(removed.mock.calls.some(([type]) => type === 'pointermove')).toBe(true);
    expect(removed.mock.calls.some(([type]) => type === 'pointerup')).toBe(true);
    expect(removed.mock.calls.some(([type]) => type === 'pointercancel')).toBe(true);
  });
  it('分层布局的单次适配帧也随失活取消，返回保留用户缩放', async () => {
    const { visible } = await cached();
    await wrapper.findAll('button').find(b => b.text() === '分层架构').trigger('click');
    expect(frames.size).toBe(1); visible.value = false; await flushPromises(); expect(frames.size).toBe(0);
    visible.value = true; await flushPromises(); const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback());
    await wrapper.find('[aria-label="放大"]').trigger('click');
    const transform = wrapper.find('svg > g').attributes('transform');
    visible.value = false; await flushPromises(); visible.value = true; await flushPromises();
    expect(wrapper.find('svg > g').attributes('transform')).toBe(transform);
  });

});
