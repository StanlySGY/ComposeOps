import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StatusBadge from '../common/StatusBadge.vue';

describe('StatusBadge.vue', () => {
  describe('status rendering', () => {
    it('renders running status with pulse animation', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'running' }
      });
      expect(wrapper.text()).toContain('运行中');
      expect(wrapper.find('[data-pulse="true"]').exists()).toBe(true);
      expect(wrapper.find('.status-badge-pulse').exists()).toBe(true);
      expect(wrapper.classes()).toContain('text-status-ok');
    });

    it('renders stopped status without pulse', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'stopped' }
      });
      expect(wrapper.text()).toContain('已停止');
      expect(wrapper.find('[data-pulse="false"]').exists()).toBe(true);
      expect(wrapper.find('.status-badge-pulse').exists()).toBe(false);
    });

    it('renders error status', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'error' }
      });
      expect(wrapper.text()).toContain('异常');
      expect(wrapper.classes()).toContain('text-status-error');
      expect(wrapper.attributes('title')).toContain('运行异常');
    });

    it('renders success status', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'success' }
      });
      expect(wrapper.text()).toContain('成功');
      expect(wrapper.classes()).toContain('text-status-ok');
    });

    it('renders unknown status with fallback', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'unknown-status' }
      });
      expect(wrapper.text()).toContain('unknown-status');
      expect(wrapper.attributes('title')).toBe('未知状态');
    });
  });

  describe('health status priority', () => {
    it('renders healthy status when health prop is set', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'stopped', health: 'healthy' }
      });
      expect(wrapper.text()).toContain('健康');
      expect(wrapper.classes()).toContain('text-status-ok');
    });

    it('renders unhealthy status when health prop is set', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'running', health: 'unhealthy' }
      });
      expect(wrapper.text()).toContain('不健康');
      expect(wrapper.classes()).toContain('text-status-error');
    });
  });

  describe('size variants', () => {
    it('renders small size by default', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'running' }
      });
      expect(wrapper.classes()).toContain('px-2');
      expect(wrapper.classes()).toContain('text-[11px]');
    });

    it('renders medium size', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'running', size: 'md' }
      });
      expect(wrapper.classes()).toContain('px-2.5');
      expect(wrapper.classes()).toContain('text-xs');
    });

    it('renders large size', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'running', size: 'lg' }
      });
      expect(wrapper.classes()).toContain('px-3');
      expect(wrapper.classes()).toContain('text-sm');
    });
  });

  describe('label and icon display', () => {
    it('shows label by default', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'running' }
      });
      expect(wrapper.find('span.truncate').exists()).toBe(true);
      expect(wrapper.text()).toContain('运行中');
    });

    it('hides label when showLabel is false', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'running', showLabel: false }
      });
      expect(wrapper.find('span.truncate').exists()).toBe(false);
    });

    it('shows icon when showIcon is true', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'running', showIcon: true }
      });
      expect(wrapper.find('svg').exists()).toBe(true);
    });

    it('hides icon by default', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'running' }
      });
      expect(wrapper.find('svg').exists()).toBe(false);
    });

    it('shows spinning icon for restarting status', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'restarting', showIcon: true }
      });
      const svg = wrapper.find('svg');
      expect(svg.exists()).toBe(true);
      expect(svg.classes()).toContain('animate-spin');
    });
  });

  describe('accessibility', () => {
    it('has aria-label attribute', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'running' }
      });
      expect(wrapper.attributes('aria-label')).toBe('服务运行正常');
    });

    it('has title tooltip', () => {
      const wrapper = mount(StatusBadge, {
        props: { status: 'error' }
      });
      expect(wrapper.attributes('title')).toBe('运行异常,请检查日志');
    });
  });
});
