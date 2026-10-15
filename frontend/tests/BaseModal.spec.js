import { afterEach, describe, expect, it } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import BaseModal from '../src/components/common/BaseModal.vue';

let wrapper;
let router;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

async function mountModal() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<main />' } }] });
  await router.push('/');
  await router.isReady();
  wrapper = mount(BaseModal, {
    attachTo: document.body,
    props: { show: true, title: '键盘焦点测试' },
    slots: { default: '<button id="first">第一个</button><button id="last">最后一个</button>' },
    global: { plugins: [router] },
  });
  await flushPromises();
  const modal = document.querySelector('.modal');
  for (const element of modal.querySelectorAll('button')) {
    Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => modal });
  }
}

describe('BaseModal 键盘焦点循环', () => {
  it('当焦点位于对话框容器时，Shift+Tab 回到最后一个可聚焦控件', async () => {
    await mountModal();
    const modal = document.querySelector('.modal');
    const last = document.querySelector('#last');
    modal.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    modal.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('首个控件 Shift+Tab 循环到末尾，末尾 Tab 循环到开头', async () => {
    await mountModal();
    const first = document.querySelector('.modal button[aria-label="关闭"]');
    const last = document.querySelector('#last');
    first.focus();
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });
});
