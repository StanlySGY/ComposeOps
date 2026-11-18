import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AgentStructuredUI from '../src/components/agent/AgentStructuredUI.vue';

describe('Agent structured UI catalog', () => {
  it('renders status, metrics, comparison tables, steps and notices from trusted blocks', () => {
    const wrapper = mount(AgentStructuredUI, {
      props: {
        blocks: [
          { type: 'status', title: 'API 服务', status: 'healthy', detail: '健康检查通过' },
          { type: 'metrics', title: '资源指标', items: [{ label: 'CPU', value: '42', unit: '%' }] },
          { type: 'table', title: '服务列表', columns: ['名称', '状态'], rows: [['api', '运行中']] },
          { type: 'steps', title: '执行进度', items: [{ title: '检查', status: 'done' }, { title: '发布', status: 'active' }] },
          { type: 'notice', title: '提示', text: '请先确认变更窗口', tone: 'warning' },
        ],
      },
    });
    expect(wrapper.text()).toContain('API 服务');
    expect(wrapper.text()).toContain('正常');
    expect(wrapper.text()).toContain('42%');
    expect(wrapper.text()).toContain('运行中');
    expect(wrapper.text()).toContain('进行中');
    expect(wrapper.text()).toContain('请先确认变更窗口');
  });

  it('renders untrusted text as text and never interprets it as markup', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const wrapper = mount(AgentStructuredUI, {
      props: { blocks: [{ type: 'notice', title: '网页标题', text: payload, tone: 'info' }] },
    });
    expect(wrapper.text()).toContain(payload);
    expect(wrapper.find('img').exists()).toBe(false);
  });
});
