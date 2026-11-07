import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import StatusBadge from '../src/components/common/StatusBadge.vue';

describe('容器状态展示', () => {
  it.each([['exited', '已退出'], ['created', '已创建'], ['dead', '已失效'], ['removing', '删除中'], ['partial', '部分运行']])('%s 使用中文，并优先于已过期的健康检查', (status, label) => {
    const wrapper = mount(StatusBadge, { props: { status, health: 'healthy' } });
    expect(wrapper.text()).toBe(label);
    expect(wrapper.classes()).not.toContain('text-emerald-300');
  });
  it('运行容器展示健康检查，正常状态静止，执行中的状态保留反馈', async () => {
    const wrapper = mount(StatusBadge, { props: { status: 'running', health: 'healthy' } });
    expect(wrapper.text()).toBe('健康');
    expect(wrapper.find('.status-badge-pulse').exists()).toBe(false);
    await wrapper.setProps({ health: 'unhealthy' });
    expect(wrapper.text()).toBe('不健康');
    await wrapper.setProps({ status: 'restarting' });
    expect(wrapper.text()).toBe('重启中');
    expect(wrapper.find('.status-badge-pulse').exists()).toBe(true);
  });
});
