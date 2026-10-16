import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ProjectEnvModal from '../src/components/services/ProjectEnvModal.vue';

vi.mock('../src/api/client.js', () => ({
  api: {
    getProjectEnv: vi.fn(async () => ({
      path: '.env.example', file: '.env.example', raw: 'API_TOKEN=secret\nPUBLIC_URL=https://example.test',
      entries: [
        { key: 'API_TOKEN', value: 'secret', comment: '', isSecret: true },
        { key: 'PUBLIC_URL', value: 'https://example.test', comment: '', isSecret: false },
      ],
    })),
    getProjectEnvFiles: vi.fn(async () => ({ files: [{ name: '.env', exists: true }, { name: '.env.example', exists: true }] })),
    getProjectEnvBackups: vi.fn(async () => ({ backups: [] })),
    getComposeFile: vi.fn(async () => ({ content: 'services: {}' })),
    previewCompose: vi.fn(async () => ({ added: [], changed: [], restarted: [], removed: [], portConflicts: [] })),
  },
}));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));

let wrapper;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('环境变量编辑器可访问名称', () => {
  it('为动态变量名、值、注释、搜索框和文件选择器提供可访问名称', async () => {
    wrapper = mount(ProjectEnvModal, {
      attachTo: document.body,
      props: { project: { id: 'project-1', projectName: '测试项目' } },
      global: {
        stubs: {
          BaseModal: { template: '<div v-if="show" class="modal"><slot name="header-actions"/><slot/><slot name="footer"/></div>', props: ['show', 'title', 'sizeClass', 'bodyClass'] },
          ChangePreviewModal: true,
          ConfirmDialog: true,        },
      },
    });
    await flushPromises();

    expect(wrapper.get('input[placeholder="按 Key 快速过滤变量"]').attributes('aria-label')).toBe('按 Key 快速过滤变量');
    expect(wrapper.get('input[placeholder="KEY"]').attributes('aria-label')).toBe('API_TOKEN 变量名');
    expect(wrapper.get('input[type="password"]').attributes('aria-label')).toBe('API_TOKEN 变量值');
    expect(wrapper.get('input[placeholder="说明注释(可选)"]').attributes('aria-label')).toBe('API_TOKEN 说明注释');
    expect(wrapper.get('select[aria-label="选择环境变量文件"]').exists()).toBe(true);
    const rawTab = wrapper.findAll('button').find((button) => button.text().includes('原始文本'));
    await rawTab.trigger('click');
    expect(wrapper.get('textarea[aria-label="环境变量原始文本"]').exists()).toBe(true);
  });

  it('空变量行也有稳定的行号标签，避免仅依赖 placeholder', async () => {
    wrapper = mount(ProjectEnvModal, {
      attachTo: document.body,
      props: { project: { id: 'project-2', projectName: '测试项目' } },
      global: {
        stubs: {
          BaseModal: { template: '<div v-if="show" class="modal"><slot name="header-actions"/><slot/><slot name="footer"/></div>', props: ['show', 'title', 'sizeClass', 'bodyClass'] },
          ChangePreviewModal: true,
          ConfirmDialog: true,        },
      },
    });
    await flushPromises();
    const addButton = wrapper.findAll('button').find((button) => button.text().includes('新增变量'));
    await addButton.trigger('click');
    await flushPromises();
    const emptyKey = wrapper.findAll('input').find((input) => input.attributes('placeholder') === 'KEY' && input.element.value === '');
    expect(emptyKey?.attributes('aria-label')).toBe('第 3 行变量名');
  });

  it('确认弹窗关闭后，预览加载状态仍会播报，直到预览完成', async () => {
    const { api } = await import('../src/api/client.js');
    let finishPreview;
    api.getComposeFile.mockResolvedValue({ content: 'services: {}' });
    api.previewCompose.mockImplementation(() => new Promise((resolve) => { finishPreview = resolve; }));

    wrapper = mount(ProjectEnvModal, {
      attachTo: document.body,
      props: { project: { id: 'project-preview', projectName: '预览测试项目' } },
      global: {
        stubs: {
          BaseModal: { template: '<div v-if="show" class="modal"><slot name="header-actions"/><slot/><slot name="footer"/></div>', props: ['show', 'title', 'sizeClass', 'bodyClass'] },
          ChangePreviewModal: true,
          ConfirmDialog: true,
        },
      },
    });
    await flushPromises();

    const saveAndApply = wrapper.findAll('button').find((button) => button.text().includes('保存并应用'));
    await saveAndApply.trigger('click');
    await flushPromises();
    const confirmApply = wrapper.findAll('button').find((button) => button.text().includes('保存并平滑重建容器'));
    await confirmApply.trigger('click');

    await vi.waitFor(() => expect(api.previewCompose).toHaveBeenCalledWith('project-preview', 'services: {}'));
    expect(wrapper.findAll('.modal')).toHaveLength(1);
    expect(wrapper.get('.modal [role="status"][aria-live="polite"]').text()).toBe('正在生成环境变量变更预览');

    finishPreview({ added: [], changed: [], restarted: [], removed: [], portConflicts: [] });
    await flushPromises();
    expect(wrapper.find('.modal [role="status"][aria-live="polite"]').exists()).toBe(false);
  });
});
