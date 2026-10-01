import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import OnboardingGuide from '../common/OnboardingGuide.vue';
import { api } from '../../api/client.js';
vi.mock('../../api/client.js', () => ({ api: { getProjects: vi.fn(), getAiConfig: vi.fn() } }));
let wrapper;
beforeEach(() => {
  localStorage.clear();
  api.getProjects.mockReset().mockResolvedValue([{ managed: false }]);
  api.getAiConfig.mockReset().mockResolvedValue({ channels: [] });
});
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; });
function render() { wrapper = mount(OnboardingGuide, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } }); }
it('发现未纳管项目仍显示入门，并明确 AI 可选', async () => {
  render(); await flushPromises();
  expect(document.body.textContent).toContain('自动发现不会自动授权');
  expect(document.body.textContent).toContain('AI 是可选能力');
});
it('关闭后可从导航重新打开并刷新进度', async () => {
  render(); await flushPromises();
  document.querySelector('[aria-label="关闭"]').click(); await flushPromises();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(localStorage.getItem('composeops:onboarding-dismissed')).toBe('1');
  api.getProjects.mockResolvedValue([{ managed: true }]);
  window.dispatchEvent(new CustomEvent('composeops:show-onboarding')); await flushPromises();
  expect(document.body.textContent).toContain('已有 1 个纳管项目');
});
it('部分配置读取失败仍保留导航，已关闭的指南不自动弹出', async () => {
  localStorage.setItem('composeops:onboarding-dismissed', '1');
  render(); await flushPromises();
  expect(api.getProjects).not.toHaveBeenCalled();
  api.getAiConfig.mockRejectedValue(new Error('offline'));
  window.dispatchEvent(new CustomEvent('composeops:show-onboarding')); await flushPromises();
  expect(document.body.textContent).toContain('暂时无法检查全部配置');
  expect(document.body.textContent).toContain('设置项目权限');
});
it('卸载后解除事件监听，未完成请求不会重新打开指南', async () => {
  let resolve;
  api.getProjects.mockReturnValue(new Promise(done => { resolve = done; }));
  render(); wrapper.unmount(); wrapper = null;
  resolve([]); await flushPromises();
  window.dispatchEvent(new CustomEvent('composeops:show-onboarding')); await flushPromises();
  expect(api.getProjects).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
