import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import CommandPalette from '../src/components/common/CommandPalette.vue';

describe('命令面板键盘与焦点', () => {
  let wrapper;
  const commands = Array.from({ length: 30 }, (_, i) => ({ id: String(i), label: `命令 ${i}`, icon: 'span' }));
  async function start() {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
    await router.push('/');
    wrapper = mount(CommandPalette, { attachTo: document.body, props: { show: true, commands }, global: { plugins: [router] } });
    await flushPromises();
  }
  afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.restoreAllMocks(); });
  it('方向键更新无障碍选中状态并让选项滚入视野', async () => {
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scroll, configurable: true });
    await start();
    const input = document.querySelector('[role=combobox]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await flushPromises();
    expect(document.querySelector('[role=option][aria-selected=true]').textContent).toContain('命令 29');
    expect(input.getAttribute('aria-activedescendant')).toBe(document.querySelector('[role=option][aria-selected=true]').id);
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    delete Element.prototype.scrollIntoView;
  });
  it('中文输入法确认候选词时不误执行命令', async () => {
    await start();
    const input = document.querySelector('input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    expect(wrapper.emitted('execute')).toBeUndefined();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(wrapper.emitted('execute')[0][0].id).toBe('0');
  });
  it('关闭后焦点返回触发入口', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    await start();
    expect(document.activeElement.getAttribute('role')).toBe('combobox');
    await wrapper.setProps({ show: false });
    expect(document.activeElement).toBe(trigger);
  });
  it('Tab 焦点保持在面板内且快捷键由父组件统一处理', async () => {
    await start();
    const input = document.querySelector('input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement.getAttribute('aria-label')).toBe('关闭命令面板');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    expect(wrapper.emitted('close')).toBeUndefined();
  });
});
