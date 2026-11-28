import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ResourceTrend from '../src/components/dashboard/ResourceTrend.vue';

const props = { label: 'CPU 趋势', start: 1000, end: 3000, interval: 1000, points: [
  { timestamp: 1000, value: 10, max: 15 }, { timestamp: 2000, value: 50, max: 70 }, { timestamp: 3000, value: 25, max: 30 },
] };
let wrapper, resize, observer, frames, serial;
function measure(width) { resize([{ target: wrapper.element, contentRect: { width } }]); }
async function frame() { const pending = [...frames.values()]; frames.clear(); for (const run of pending) run(); await nextTick(); }
beforeEach(() => {
  frames = new Map(); serial = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn(run => { frames.set(++serial, run); return serial; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn(id => frames.delete(id)));
  vi.stubGlobal('ResizeObserver', class { constructor(callback) { resize = callback; observer = this; } observe = vi.fn(); disconnect = vi.fn(); });
});
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });

describe('资源趋势尺寸与选中点', () => {
  it('尺寸监听只安排下一帧更新并合并连续尺寸，避免回调内改变观察目标高度', async () => {
    wrapper = mount(ResourceTrend, { props });
    measure(700); await nextTick();
    expect(wrapper.get('svg').attributes('viewBox')).toBe('0 0 640 180');
    measure(800); expect(frames.size).toBe(1);
    await frame(); expect(wrapper.get('svg').attributes('viewBox')).toBe('0 0 800 180');
    measure(800); expect(frames.size).toBe(0);
    measure(0); measure(Number.NaN); expect(frames.size).toBe(0);
  });

  it('卸载取消尚未执行的布局更新，迟到观察回调不能再排帧', async () => {
    wrapper = mount(ResourceTrend, { props }); measure(800);
    wrapper.unmount(); expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    resize([{ contentRect: { width: 900 } }]); expect(frames.size).toBe(0);
  });

  it('窄屏点击按屏幕与 SVG 坐标比例选择正确采样，尺寸变化清除旧光标', async () => {
    wrapper = mount(ResourceTrend, { props }); measure(240); await frame();
    wrapper.get('svg').element.getBoundingClientRect = () => ({ left: 10, width: 120 });
    // Last point is at x=228 in the 240px viewBox, displayed at 114px.
    await wrapper.get('rect').trigger('click', { clientX: 124 });
    expect(wrapper.get('.trend-summary').text()).toContain('25.0%');
    expect(wrapper.find('.trend-cursor').exists()).toBe(true);
    measure(300); await frame(); expect(wrapper.find('.trend-cursor').exists()).toBe(false);
  });

  it('新数据到达清除已不属于当前曲线的采样详情', async () => {
    wrapper = mount(ResourceTrend, { props });
    wrapper.get('svg').element.getBoundingClientRect = () => ({ left: 0, width: 640 });
    await wrapper.get('rect').trigger('click', { clientX: 300 });
    expect(wrapper.find('.trend-cursor').exists()).toBe(true);
    await wrapper.setProps({ points: [{ timestamp: 1000, value: 0, max: 0 }] });
    expect(wrapper.find('.trend-cursor').exists()).toBe(false);
    expect(wrapper.get('.trend-summary').text()).toContain('曲线为采样均值');
  });
});
