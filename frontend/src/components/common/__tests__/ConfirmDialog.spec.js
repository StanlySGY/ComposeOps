import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ConfirmDialog from '../ConfirmDialog.vue';

describe('ConfirmDialog busy state', () => {
  it('disables cancellation and confirmation while an operation is in progress', () => {
    const wrapper = mount(ConfirmDialog, {
      props: { show: true, busy: true, title: '删除资源', message: '确认删除？' },
      global: {
        stubs: {
          BaseModal: {
            props: ['show', 'closeDisabled'],
            template: '<div v-if="show"><button aria-label="关闭" :disabled="closeDisabled" @click="(\'close\')">关闭</button><slot /><slot name="footer" /></div>',
          },
        },
      },
    });

    expect(wrapper.find('button[aria-label="关闭"]').element.disabled).toBe(true);
    expect(wrapper.find('.btn-ghost').element.disabled).toBe(true);
    expect(wrapper.find('.btn:not(.btn-ghost)').element.disabled).toBe(true);
    wrapper.find('button[aria-label="关闭"]').trigger('click');
    wrapper.find('.btn-ghost').trigger('click');
    expect(wrapper.emitted('cancel')).toBeUndefined();
  });

  it('keeps cancellation available before the operation starts', () => {
    const wrapper = mount(ConfirmDialog, {
      props: { show: true, busy: false },
      global: { stubs: { BaseModal: { template: '<div><slot /><slot name="footer" /></div>' } } },
    });

    expect(wrapper.find('.btn-ghost').element.disabled).toBe(false);
    expect(wrapper.find('.btn:not(.btn-ghost)').element.disabled).toBe(false);
  });
});
