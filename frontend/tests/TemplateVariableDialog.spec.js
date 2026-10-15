import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import TemplateVariableDialog from '../src/components/TemplateVariableDialog.vue';

let wrapper;
let router;

async function mountDialog(props) {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<main />' } }] });
  await router.push('/');
  await router.isReady();
  wrapper = mount(TemplateVariableDialog, { attachTo: document.body, props, global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('模板变量弹窗表单可访问性', () => {
  it('每个字段标签都关联输入框，说明文本通过 aria-describedby 关联', async () => {
    await mountDialog({
        template: {
          variables: [
            { name: 'app_name', label: '应用名称', required: true, description: '显示在页面上的名称' },
            { name: 'api_token', label: 'API 令牌', type: 'password', description: '用于认证的密钥' },
          ],
        },
      });

    const labels = [...document.querySelectorAll('.modal label[for]')];
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      const input = document.getElementById(label.htmlFor);
      expect(input).not.toBeNull();
      expect(input.tagName).toBe('INPUT');
      const descriptionId = input.getAttribute('aria-describedby');
      expect(descriptionId).toBeTruthy();
      expect(document.getElementById(descriptionId)?.textContent).toMatch(/名称|认证/);
    }
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('必填项填写前禁止确认，填写后发出变量值', async () => {
    await mountDialog({ template: { variables: [{ name: 'service', label: '服务名', required: true }] } });
    const confirm = document.querySelector('.modal button.btn-primary');
    expect(confirm.disabled).toBe(true);
    const input = document.querySelector('.modal input');
    input.value = 'web';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect(document.querySelector('.modal button.btn-primary').disabled).toBe(false);
    document.querySelector('.modal button.btn-primary').click();
    await flushPromises();
    expect(wrapper.emitted('confirm')?.[0]?.[0]).toEqual({ service: 'web' });
  });
});
