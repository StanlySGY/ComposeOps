import { afterEach, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import CommandPalette from '../CommandPalette.vue';

let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

it('shows common destinations first and keeps the rest searchable', async () => {
  const commands = Array.from({ length: 12 }, (_, index) => ({
    id: `route-${index}`,
    label: `入口 ${index}`,
    description: `页面 ${index}`,
    category: `页面 导航 ${index}`,
    to: `/page-${index}`,
  }));

  wrapper = mount(CommandPalette, {
    attachTo: document.body,
    props: { show: true, commands },
  });
  await flushPromises();

  expect(document.querySelectorAll('[role="option"]')).toHaveLength(10);
  expect(document.body.textContent).toContain('10 个常用入口 · 共 12 个命令');

  const input = document.querySelector('input[role="combobox"]');
  input.value = '入口 11';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();

  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(document.body.textContent).toContain('入口 11');
});
