import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';

const mocks = vi.hoisted(() => ({
  api: Object.fromEntries(['getProjects', 'getComposeFile', 'validateCompose', 'previewCompose', 'saveComposeFile', 'searchMarketplaceTemplates', 'getBackups', 'getBackup', 'restoreBackup'].map(key => [key, vi.fn()])),
  editors: [],
}));
vi.mock('../src/api/client.js', () => ({ api: mocks.api }));
vi.mock('monaco-yaml', () => ({ configureMonacoYaml: vi.fn() }));
vi.mock('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js', () => ({}));
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-yaml/yaml.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/editor/editor.api', () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  languages: { registerCompletionItemProvider: () => ({ dispose() {} }) },
  editor: {
    setModelMarkers() {},
    create: (_element, options) => {
      let value = options.value;
      let changed = () => {};
      const editor = {
        getValue: () => value,
        setValue: next => { value = next; changed(); },
        getModel: () => ({ getValue: () => value, dispose() {} }),
        onDidChangeModelContent: callback => { changed = callback; return { dispose() {} }; },
        dispose() {},
      };
      mocks.editors.push(editor);
      return editor;
    },
  },
}));
import ComposeView from '../src/views/ComposeView.vue';
import ConfirmDialog from '../src/components/common/ConfirmDialog.vue';

const original = 'services:\n  web:\n    image: nginx:stable\n';
const draft = original.replace('stable', 'alpine');
const emptyPreview = () => ({ added: [], changed: [], restarted: [], removed: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let wrapper;
let router;
const editor = () => mocks.editors.at(-1);
const view = () => wrapper.findComponent(ComposeView);
const button = text => view().findAll('button').find(item => item.text().trim() === text);
const restoreDialog = () => view().findAllComponents(ConfirmDialog).find(item => item.props('title') === '恢复配置备份');
async function edit(value = draft) { editor().setValue(value); await flushPromises(); }
async function open() {
  router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/compose', name: 'compose', component: ComposeView },
    { path: '/services', name: 'services', component: { template: '<div>services</div>' } },
  ] });
  await router.push('/compose?projectId=one');
  wrapper = mount(RouterView, { global: {
    renderStubDefaultSlot: true, plugins: [router, createPinia()],
    stubs: {
      ConfirmDialog: true, ServiceEditor: true, DockerRunConverter: true,
      BaseModal: { name: 'BaseModal', props: ['show', 'title'], template: '<section v-if="show" :data-title="title"><slot/><slot name="footer"/></section>' },
    },
  } });
  await flushPromises();
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.editors.length = 0;
  mocks.api.getProjects.mockResolvedValue({ projects: ['one', 'two'].map(id => ({ id, projectName: id, editable: true, composeFiles: [`/${id}/0.yml`, `/${id}/1.yml`] })) });
  mocks.api.getComposeFile.mockImplementation(async (id, index) => ({ path: `/${id}/${index}.yml`, content: original }));
  mocks.api.searchMarketplaceTemplates.mockResolvedValue({ templates: [] });
  mocks.api.validateCompose.mockResolvedValue({ issues: [] });
  mocks.api.previewCompose.mockResolvedValue(emptyPreview());
  mocks.api.saveComposeFile.mockResolvedValue({ ok: true });
  mocks.api.getBackups.mockResolvedValue({ backups: [backup()] });
  mocks.api.getBackup.mockResolvedValue({ ...backup(), content: draft });
  mocks.api.restoreBackup.mockResolvedValue({ ok: true });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

const backup = (overrides = {}) => ({ id: 1, filePath: '/one/0.yml', reason: 'save', createdAt: '2026-11-09T00:00:00Z', size: 120, ...overrides });
async function showBackups() { await button('备份').trigger('click'); await flushPromises(); }
async function chooseRestore() { await showBackups(); await button('恢复').trigger('click'); await flushPromises(); }

describe('配置版本比较与恢复', () => {
  it('ISO 日期不变成 Invalid Date，版本卡明确标出文件和中文备份原因', async () => {
    await open(); await showBackups();
    const modal = view().get('[data-title="配置备份（最近 20 份）"]');
    expect(modal.text()).not.toContain('Invalid Date');
    expect(modal.text()).toContain('0.yml');
    expect(modal.text()).toContain('保存前自动备份');
  });

  it('比较失败留在版本列表并允许重试，不产生未处理拒绝', async () => {
    await open(); await showBackups();
    mocks.api.getBackup.mockRejectedValueOnce(new Error('备份内容读取失败'));
    await button('比较').trigger('click'); await flushPromises();
    expect(view().text()).toContain('备份内容读取失败');
    await button('比较').trigger('click'); await flushPromises();
    expect(view().find('[data-title="当前配置与备份比较"]').exists()).toBe(true);
  });

  it('关闭版本列表会取消未完成的比较展示，不在用户离开后重新弹窗', async () => {
    await open(); await showBackups();
    const response = deferred(); mocks.api.getBackup.mockReturnValueOnce(response.promise);
    await button('比较').trigger('click');
    view().findAllComponents({ name: 'BaseModal' }).find(item => item.props('title') === '配置备份（最近 20 份）').vm.$emit('close');
    response.resolve({ ...backup(), content: draft }); await flushPromises();
    expect(view().find('[data-title="当前配置与备份比较"]').exists()).toBe(false);
  });

  it('切换项目后迟到的比较结果不会弹出到新项目', async () => {
    await open(); await showBackups();
    const response = deferred(); mocks.api.getBackup.mockReturnValueOnce(response.promise);
    await button('比较').trigger('click');
    await router.push('/compose?projectId=two'); await flushPromises();
    response.resolve({ ...backup(), content: draft }); await flushPromises();
    expect(view().find('[data-title="当前配置与备份比较"]').exists()).toBe(false);
    expect(editor().getValue()).toBe(original);
  });

  it('其它文件的备份与其自身文件比较，不拿当前主文件做基线', async () => {
    mocks.api.getBackups.mockResolvedValue({ backups: [backup({ filePath: '/one/1.yml' })] });
    mocks.api.getBackup.mockResolvedValue({ ...backup({ filePath: '/one/1.yml' }), content: 'services:\n  worker:\n    image: worker:old\n' });
    await open(); await showBackups();
    mocks.api.getComposeFile.mockResolvedValueOnce({ path: '/one/1.yml', content: 'services:\n  worker:\n    image: worker:current\n' });
    await button('比较').trigger('click'); await flushPromises();
    expect(mocks.api.getComposeFile).toHaveBeenLastCalledWith('one', 1);
    const modal = view().get('[data-title="当前配置与备份比较"]');
    expect(modal.text()).toContain('worker:current');
    expect(modal.text()).not.toContain('nginx:stable');
  });

  it('恢复期间防重复并保留确认门，失败后原地重试', async () => {
    let fail;
    mocks.api.restoreBackup.mockReturnValueOnce(new Promise((resolve, reject) => { fail = reject; }));
    await open(); await chooseRestore();
    restoreDialog().vm.$emit('confirm'); restoreDialog().vm.$emit('confirm'); await flushPromises();
    expect(mocks.api.restoreBackup).toHaveBeenCalledExactlyOnceWith('one', 1);
    expect(restoreDialog().props('show')).toBe(true);
    expect(restoreDialog().props('busy')).toBe(true);
    fail(new Error('恢复暂不可用')); await flushPromises();
    expect(restoreDialog().props('show')).toBe(true);
    expect(view().text()).toContain('恢复暂不可用');
    expect(restoreDialog().props('busy')).toBe(false);
  });

  it('选择恢复后迟到的比较不会覆盖恢复确认门', async () => {
    const response = deferred(); mocks.api.getBackup.mockReturnValueOnce(response.promise);
    await open(); await showBackups(); await button('比较').trigger('click');
    await button('恢复').trigger('click'); await flushPromises();
    response.resolve({ ...backup(), content: draft }); await flushPromises();
    expect(restoreDialog().props('show')).toBe(true);
    expect(view().find('[data-title="当前配置与备份比较"]').exists()).toBe(false);
  });

  it('恢复前说明未保存草稿会丢弃，取消保留编辑内容', async () => {
    await open(); await edit(); await chooseRestore();
    expect(restoreDialog().props('message')).toContain('未保存');
    restoreDialog().vm.$emit('cancel'); await flushPromises();
    expect(editor().getValue()).toBe(draft);
    expect(mocks.api.restoreBackup).not.toHaveBeenCalled();
  });

  it('恢复成功明确仅改文件，载入目标文件并给出应用配置的下一步', async () => {
    mocks.api.getBackups.mockResolvedValue({ backups: [backup({ filePath: '/one/1.yml' })] });
    await open(); await chooseRestore();
    restoreDialog().vm.$emit('confirm'); await flushPromises();
    expect(mocks.api.getComposeFile).toHaveBeenLastCalledWith('one', 1);
    expect(view().text()).toContain('尚未应用到容器');
    expect(view().get('a.btn-secondary[href*="focus=one"]').text()).toContain('返回项目');
    expect(view().get('select[aria-label="选择 Compose 配置文件"]').element.value).toBe('1');
  });

  it('节点切换后的旧恢复响应不重新读取或覆盖新节点编辑器', async () => {
    const response = deferred(); mocks.api.restoreBackup.mockReturnValueOnce(response.promise);
    await open(); await chooseRestore(); restoreDialog().vm.$emit('confirm'); await flushPromises();
    mocks.api.getProjects.mockResolvedValue({ projects: [{ id: 'two', projectName: 'two', editable: true, composeFiles: ['/two/0.yml'] }] });
    window.dispatchEvent(new CustomEvent('composeops:host-changed')); await flushPromises();
    expect(view().get('select[aria-label="选择 Compose 项目"]').element.value).toBe('two');
    expect(view().get('select[aria-label="选择 Compose 项目"]').attributes('disabled')).toBeUndefined();
    const calls = mocks.api.getComposeFile.mock.calls.length;
    response.resolve({ ok: true }); await flushPromises();
    expect(mocks.api.getComposeFile).toHaveBeenCalledTimes(calls);
    expect(view().text()).not.toContain('尚未应用到容器');
  });

  it('旧节点恢复结束不会释放新节点正在进行的恢复确认门', async () => {
    const oldResponse = deferred(); const newResponse = deferred();
    mocks.api.restoreBackup.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    await open(); await chooseRestore(); restoreDialog().vm.$emit('confirm'); await flushPromises();
    mocks.api.getProjects.mockResolvedValue({ projects: [{ id: 'two', projectName: 'two', editable: true, composeFiles: ['/two/0.yml'] }] });
    mocks.api.getBackups.mockResolvedValue({ backups: [backup({ id: 2, filePath: '/two/0.yml' })] });
    window.dispatchEvent(new CustomEvent('composeops:host-changed')); await flushPromises();
    await chooseRestore(); restoreDialog().vm.$emit('confirm'); await flushPromises();
    expect(mocks.api.restoreBackup).toHaveBeenLastCalledWith('two', 2);
    oldResponse.resolve({ ok: true }); await flushPromises();
    expect(restoreDialog().props('busy')).toBe(true);
    expect(restoreDialog().props('show')).toBe(true);
    newResponse.resolve({ ok: true }); await flushPromises();
    expect(restoreDialog().props('busy')).toBe(false);
  });
});

