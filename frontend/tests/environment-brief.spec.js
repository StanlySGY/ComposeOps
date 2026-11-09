import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import EnvironmentBrief from '../src/components/dashboard/EnvironmentBrief.vue';

function render(props) {
  return mount(EnvironmentBrief, { props, global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' } } } });
}
const project = (id, status = 'running', health = 'healthy') => ({ id, projectName: id, status, managed: true, containers: [{ id: `${id}-container`, state: status === 'stopped' ? 'exited' : 'running', health }] });

describe('环境简报的项目入口', () => {
  it('异常优先且不修改源数组，超过四项仍保留全部入口和真实汇总', () => {
    const projects = Array.from({ length: 38 }, (_, index) => project(`healthy-${index}`));
    projects.push(project('unhealthy', 'running', 'unhealthy'), project('stopped', 'stopped'));
    const wrapper = render({ projects });
    const links = wrapper.findAll('.brief-project');
    expect(links).toHaveLength(4);
    expect(links[0].attributes('href')).toBe('/services?focus=stopped&from=dashboard');
    expect(links[1].text()).toContain('健康检查异常');
    expect(wrapper.get('.brief-distribution-heading').text()).toContain('全部 40 个');
    expect(wrapper.findAll('.brief-count-value').map(item => item.text())).toEqual(['38', '2']);
    expect(projects[0].id).toBe('healthy-0');
    wrapper.unmount();
  });

  it('数据不完整时明确标注旧记录，主动作要求先确认状态', () => {
    const wrapper = render({ projects: [project('api')], incomplete: true });
    expect(wrapper.text()).toContain('上次项目记录');
    expect(wrapper.text()).not.toContain('运行正常');
    expect(wrapper.get('.brief-project').attributes('aria-label')).toContain('上次记录');
    expect(wrapper.get('.brief-actions a').attributes('href')).toBe('/services?from=dashboard');
    wrapper.unmount();
  });

  it('项目列表清空后切回引导，不残留项目快捷入口', async () => {
    const wrapper = render({ projects: [project('api')] });
    await wrapper.setProps({ projects: [] });
    expect(wrapper.find('.brief-projects').exists()).toBe(false);
    expect(wrapper.get('ol').text()).toContain('连接你的项目');
    expect(wrapper.get('.brief-actions a').attributes('href')).toBe('/marketplace?from=dashboard');
    wrapper.unmount();
  });
});
