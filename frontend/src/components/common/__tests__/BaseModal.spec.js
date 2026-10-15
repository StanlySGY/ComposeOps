import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import BaseModal from '../BaseModal.vue';

let wrapper;
let router;
const offsetParentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');

beforeEach(async () => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<main>测试路由</main>' } }],
  });
  await router.push('/');
  await router.isReady();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  if (offsetParentDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDescriptor);
  } else {
    delete HTMLElement.prototype.offsetParent;
  }
});

describe('BaseModal 键盘焦点行为', () => {
  it('首次以 show=true 挂载时聚焦弹窗，并循环 Tab/Shift+Tab，关闭后恢复焦点', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = '打开弹窗';
    document.body.appendChild(trigger);
    trigger.focus();

    wrapper = mount(BaseModal, {
      attachTo: document.body,
      props: { show: true, title: '测试弹窗' },
      slots: {
        default: '<button data-test="first-action">第一项</button><button data-test="last-action">最后一项</button>',
      },
      global: { plugins: [router] },
    });
    await flushPromises();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('测试弹窗');
    const focusable = [...dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )].filter((element) => !element.disabled && element.offsetParent !== null);
    expect(focusable.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(focusable[0]);

    const backdrop = document.querySelector('.modal-backdrop');
    const last = focusable.at(-1);
    last.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    backdrop.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusable[0]);

    focusable[0].focus();
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    backdrop.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    await wrapper.setProps({ show: false });
    await flushPromises();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape 触发关闭事件，且 closeDisabled 时不允许关闭', async () => {
    wrapper = mount(BaseModal, {
      attachTo: document.body,
      props: { show: true, title: '受保护弹窗' },
      global: { plugins: [router] },
    });
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);

    await wrapper.setProps({ closeDisabled: true });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('嵌套弹窗打开时初始化子弹窗自己的焦点', async () => {
    wrapper = mount({
      components: { BaseModal },
      template: `
        <div>
          <BaseModal :show="true" title="父级弹窗">
            <button>父级操作</button>
          </BaseModal>
          <BaseModal :show="true" title="子级弹窗">
            <button>子级操作</button>
          </BaseModal>
        </div>
      `,
    }, {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    await flushPromises();

    const dialogs = [...document.querySelectorAll('.modal-backdrop .modal')];
    expect(dialogs).toHaveLength(2);
    expect(dialogs[0].getAttribute('aria-label')).toBe('父级弹窗');
    expect(dialogs[1].getAttribute('aria-label')).toBe('子级弹窗');
    const childFocusable = [...dialogs[1].querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )].filter((element) => !element.disabled && element.offsetParent !== null);
    expect(childFocusable.length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(childFocusable[0]);
  });
});
