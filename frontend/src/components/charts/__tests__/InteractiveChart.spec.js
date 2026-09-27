import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import InteractiveChart from '../InteractiveChart.vue';

describe('InteractiveChart.vue', () => {
  let wrapper;
  
  const defaultProps = {
    data: [
      { timestamp: new Date('2024-01-01T00:00:00'), value: 50 },
      { timestamp: new Date('2024-01-01T01:00:00'), value: 60 },
      { timestamp: new Date('2024-01-01T02:00:00'), value: 55 },
      { timestamp: new Date('2024-01-01T03:00:00'), value: 70 },
      { timestamp: new Date('2024-01-01T04:00:00'), value: 65 },
    ],
    unit: 'MB',
    color: '#38BDF8',
  };

  beforeEach(() => {
    wrapper = mount(InteractiveChart, {
      props: defaultProps,
    });
  });

  describe('component initialization', () => {
    it('renders chart wrapper', () => {
      expect(wrapper.find('.interactive-chart-wrapper').exists()).toBe(true);
    });

    it('renders chart toolbar', () => {
      expect(wrapper.find('.chart-toolbar').exists()).toBe(true);
    });

    it('renders SVG canvas', () => {
      expect(wrapper.find('.chart-canvas').exists()).toBe(true);
    });
  });

  describe('chart type switching', () => {
    it('starts with line chart by default', () => {
      const activeBtn = wrapper.find('.chart-type-btn.active');
      expect(activeBtn.exists()).toBe(true);
    });

    it('switches chart types when buttons are clicked', async () => {
      const buttons = wrapper.findAll('.chart-type-btn');
      expect(buttons.length).toBeGreaterThan(1);
      
      await buttons[1].trigger('click');
      expect(buttons[1].classes()).toContain('active');
    });
  });

  describe('statistics calculation', () => {
    it('displays minimum value', async () => {
      await wrapper.vm.$nextTick();
      const stats = wrapper.find('.chart-stats');
      expect(stats.text()).toContain('最小');
      expect(stats.text()).toContain('50.0MB');
    });

    it('displays maximum value', async () => {
      await wrapper.vm.$nextTick();
      const stats = wrapper.find('.chart-stats');
      expect(stats.text()).toContain('最大');
      expect(stats.text()).toContain('70.0MB');
    });

    it('displays average value', async () => {
      await wrapper.vm.$nextTick();
      const stats = wrapper.find('.chart-stats');
      expect(stats.text()).toContain('平均');
      expect(stats.text()).toContain('60.0MB');
    });

    it('displays current value', async () => {
      await wrapper.vm.$nextTick();
      const stats = wrapper.find('.chart-stats');
      expect(stats.text()).toContain('当前');
      expect(stats.text()).toContain('65.0MB');
    });
  });

  describe('export functionality', () => {
    it('shows export dropdown button', () => {
      expect(wrapper.find('.export-btn').exists()).toBe(true);
    });

    it('toggles export menu on button click', async () => {
      expect(wrapper.find('.export-menu').exists()).toBe(false);
      
      await wrapper.find('.export-btn').trigger('click');
      expect(wrapper.find('.export-menu').exists()).toBe(true);
      
      await wrapper.find('.export-btn').trigger('click');
      expect(wrapper.find('.export-menu').exists()).toBe(false);
    });

    it('shows CSV and PNG export options', async () => {
      await wrapper.find('.export-btn').trigger('click');
      
      const menuItems = wrapper.findAll('.export-menu-item');
      expect(menuItems.length).toBe(2);
      expect(menuItems[0].text()).toContain('CSV');
      expect(menuItems[1].text()).toContain('PNG');
    });
  });

  describe('props validation', () => {
    it('accepts data array prop', () => {
      expect(wrapper.props('data')).toEqual(defaultProps.data);
    });

    it('accepts unit prop', () => {
      expect(wrapper.props('unit')).toBe('MB');
    });

    it('accepts color prop', () => {
      expect(wrapper.props('color')).toBe('#38BDF8');
    });

    it('handles empty data gracefully', async () => {
      await wrapper.setProps({ data: [] });
      expect(wrapper.find('.chart-canvas').exists()).toBe(true);
    });
  });

  describe('multi-metric comparison mode', () => {
    it('accepts datasets prop for multi-metric mode', async () => {
      const datasets = [
        {
          label: 'CPU',
          data: defaultProps.data,
          color: '#38BDF8',
          unit: '%',
        },
        {
          label: 'Memory',
          data: defaultProps.data,
          color: '#6EE7B7',
          unit: 'MB',
        },
      ];
      
      await wrapper.setProps({ datasets, compareMode: true });
      expect(wrapper.props('compareMode')).toBe(true);
      expect(wrapper.props('datasets')).toEqual(datasets);
    });
  });

  describe('thresholds rendering', () => {
    it('renders threshold lines when provided', async () => {
      await wrapper.setProps({
        thresholds: [
          { value: 80, label: 'Warning', color: '#FCD34D' },
          { value: 90, label: 'Critical', color: '#F87171' },
        ],
      });
      
      // Threshold lines should be rendered in SVG
      const svg = wrapper.find('svg');
      expect(svg.exists()).toBe(true);
    });
  });

  describe('anomaly detection', () => {
    it('renders anomaly bands when provided', async () => {
      await wrapper.setProps({
        anomalies: [
          {
            start: new Date('2024-01-01T01:00:00'),
            end: new Date('2024-01-01T02:00:00'),
            severity: 'high',
          },
        ],
      });
      
      // Anomaly pattern should be defined in defs
      const defs = wrapper.find('defs');
      expect(defs.html()).toContain('anomaly-pattern');
    });
  });

  describe('accessibility', () => {
    it('has proper ARIA attributes', async () => {
      const wrapperWithLabel = mount(InteractiveChart, {
        props: { ...defaultProps, ariaLabel: 'Test Chart' },
      });
      await wrapperWithLabel.vm.$nextTick();
      await wrapperWithLabel.vm.$nextTick();
      const svg = wrapperWithLabel.find('svg.chart-canvas');
      expect(svg.attributes('role')).toBe('img');
      expect(svg.attributes('aria-label')).toBe('Test Chart');
      expect(svg.attributes('tabindex')).toBe('0');
    });

    it('accepts ariaLabel prop', async () => {
      const wrapperWithLabel = mount(InteractiveChart, {
        props: { ...defaultProps, ariaLabel: 'CPU Usage Chart' },
      });
      await wrapperWithLabel.vm.$nextTick();
      await wrapperWithLabel.vm.$nextTick();
      const svg = wrapperWithLabel.find('svg.chart-canvas');
      expect(svg.attributes('role')).toBe('img');
      expect(svg.attributes('aria-label')).toBe('CPU Usage Chart');
    });
  });
});
