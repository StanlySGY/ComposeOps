import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import InteractiveChart from '../src/components/charts/InteractiveChart.vue';
const data = Array.from({ length: 30 }, (_, index) => ({ timestamp: 1000 + index * 1000, value: index }));
let wrapper;
function open(props = {}) {
  wrapper = mount(InteractiveChart, { attachTo: document.body, props: { data, ...props } });
  wrapper.get('svg.chart-canvas').element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 150, right: 400, bottom: 150 });
  return wrapper.get('svg.chart-canvas');
}
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; });

describe('图表真实交互契约', () => {
  it('切换折线、柱状和面积会改变实际绘制，而不是只检查默认激活按钮', async () => {
    open();
    await wrapper.get('button[aria-label="柱状图"]').trigger('click');
    expect(wrapper.findAll('.chart-bar')).toHaveLength(30);
    expect(wrapper.find('.chart-area').exists()).toBe(false);
    await wrapper.get('button[aria-label="折线图"]').trigger('click');
    expect(wrapper.findAll('.chart-bar')).toHaveLength(0);
    expect(wrapper.find('.chart-line').exists()).toBe(true);
    expect(wrapper.find('.chart-area').exists()).toBe(false);
    await wrapper.get('button[aria-label="面积图"]').trigger('click');
    expect(wrapper.find('.chart-area').exists()).toBe(true);
  });

  it('响应式缩小后的鼠标坐标仍指向正确的末端样本', async () => {
    const svg = open();
    await svg.trigger('mousemove', { clientX: 389, clientY: 50 });
    expect(wrapper.get('.tooltip-value').text()).toBe('29.0');
  });

  it('焦点离开图表后普通输入的左右键不被截获', async () => {
    const svg = open(); await svg.trigger('focus');
    const input = document.createElement('input'); document.body.appendChild(input); input.focus();
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('鼠标悬停后数据缩短不会越界或保留失效提示', async () => {
    const svg = open(); await svg.trigger('mousemove', { clientX: 389, clientY: 50 });
    await wrapper.setProps({ data: [data[0]] });
    expect(wrapper.find('.chart-tooltip').exists()).toBe(false);
    expect(wrapper.find('.crosshair').exists()).toBe(false);
  });

  it('只有一个样本时所有网格坐标仍有限', () => {
    const svg = open({ data: [data[0]] });
    expect(svg.html()).not.toMatch(/Infinity|NaN/);
    expect(svg.find('.chart-single-point').exists()).toBe(true);
  });

  it('悬停后连续缩放不保留越界样本', async () => {
    const svg = open(); await svg.trigger('mousemove', { clientX: 389, clientY: 50 });
    for (let i = 0; i < 4; i++) await wrapper.get('[aria-label="放大图表"]').trigger('click');
    expect(wrapper.find('.chart-tooltip').exists()).toBe(false);
    await wrapper.get('[aria-label="重置图表缩放"]').trigger('click');
    expect(wrapper.get('.chart-stats').text()).toContain('29.0');
  });

  it('仅提供比较数据集时仍能选点、显示正确单位并切换柱状图', async () => {
    const svg = open({ data: [], compareMode: true, unit: '%', datasets: [
      { label: 'CPU', unit: '%', color: '#06b6d4', data },
      { label: '内存', unit: 'MB', color: '#10b981', data: data.map(item => ({ ...item, value: item.value * 10 })) },
    ] });
    await svg.trigger('mousemove', { clientX: 389, clientY: 50 });
    const rows = wrapper.findAll('.tooltip-metric-value').map(item => item.text());
    expect(rows).toEqual(['29.0 %', '290.0 MB']);
    await wrapper.get('[aria-label="柱状图"]').trigger('click');
    expect(wrapper.findAll('.chart-bar')).toHaveLength(60);
  });

  it('无障碍图表描述指向真实的描述节点', () => {
    const svg = open({ ariaDescription: '最近五分钟的 CPU 趋势' });
    expect(document.getElementById(svg.attributes('aria-describedby'))?.textContent).toContain('最近五分钟的 CPU 趋势');
  });

  it('普通滚轮允许页面继续滚动，Ctrl 滚轮才缩放', async () => {
    const svg = open();
    const event = new WheelEvent('wheel', { deltaY: 100, clientX: 200, bubbles: true, cancelable: true });
    svg.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    const zoom = new WheelEvent('wheel', { deltaY: -100, clientX: 200, ctrlKey: true, bubbles: true, cancelable: true });
    svg.element.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(true);
  });

  it('导出菜单可通过 Escape 退出并回到触发按钮', async () => {
    open(); const button = wrapper.get('button[aria-label="导出数据"]');
    await button.trigger('click');
    expect(button.attributes('aria-expanded')).toBe('true');
    await wrapper.get('.export-menu button').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.export-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(button.element);
  });
});
