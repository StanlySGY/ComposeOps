import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
const { auth } = vi.hoisted(() => ({ auth: { setupRequired: false, submit: vi.fn() } }));
vi.mock('../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
import LoginView from '../src/views/LoginView.vue';
let wrapper;
afterEach(() => { wrapper?.unmount(); auth.setupRequired = false; vi.clearAllMocks(); });
describe('登录密码输入体验', () => {
  it('显示密码不提交表单、不丢输入，保留密码管理器语义', async () => {
    wrapper = mount(LoginView);
    const input = wrapper.get('#admin-password');
    await input.setValue('example-password');
    await wrapper.get('[aria-label="显示密码"]').trigger('click');
    expect(input.attributes('type')).toBe('text');
    expect(input.element.value).toBe('example-password');
    expect(input.attributes('autocomplete')).toBe('current-password');
    expect(auth.submit).not.toHaveBeenCalled();
    await wrapper.get('[aria-label="隐藏密码"]').trigger('click');
    expect(input.attributes('type')).toBe('password');
  });
  it('验证失败保留输入并给出错误，初始化仍校验两次密码', async () => {
    auth.setupRequired = true; wrapper = mount(LoginView);
    await wrapper.get('#admin-password').setValue('example-password');
    await wrapper.get('input[aria-label="再次输入管理员密码"]').setValue('different-password');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('两次输入的密码不一致');
    expect(auth.submit).not.toHaveBeenCalled();
    expect(wrapper.get('#admin-password').attributes('autocomplete')).toBe('new-password');
  });
});
