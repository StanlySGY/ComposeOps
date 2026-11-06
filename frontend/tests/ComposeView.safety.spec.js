import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';

const mocks = vi.hoisted(() => ({
  api: Object.fromEntries(['getProjects', 'getComposeFile', 'validateCompose', 'previewCompose', 'saveComposeFile', 'searchMarketplaceTemplates', 'getBackups'].map(key => [key, vi.fn()])),
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
const latestDraft = original.replace('stable', 'latest');
const emptyPreview = () => ({ added: [], changed: [], restarted: [], removed: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let wrapper;
let router;
const editor = () => mocks.editors.at(-1);
const view = () => wrapper.findComponent(ComposeView);
const button = text => view().findAll('button').find(item => item.text().trim() === text);
const leaveDialog = () => view().findAllComponents(ConfirmDialog).find(item => item.props('title') === '配置尚未保存');
async function edit(value = draft) { editor().setValue(value); await flushPromises(); }
async function open() {
  router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/compose', name: 'compose', component: ComposeView },
    { path: '/services', name: 'services', component: { template: '<div>services</div>' } },
  ] });
  await router.push('/compose?projectId=one');
  wrapper = mount(RouterView, { global: {
    plugins: [router, createPinia()],
    stubs: {
      ConfirmDialog: true, ServiceEditor: true, DockerRunConverter: true,
      BaseModal: { props: ['show'], template: '<section v-if="show"><slot/><slot name="footer"/></section>' },
    },
  } });
  await flushPromises();
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.editors.length = 0;
  mocks.api.getProjects.mockResolvedValue({ projects: ['one', 'two'].map(id => ({ id, projectName: id, editable: true, composeFiles: ['compose.yml', 'override.yml'] })) });
  mocks.api.getComposeFile.mockImplementation(async (id, index) => ({ path: `/${id}/${index}.yml`, content: original }));
  mocks.api.searchMarketplaceTemplates.mockResolvedValue({ templates: [] });
  mocks.api.validateCompose.mockResolvedValue({ issues: [] });
  mocks.api.previewCompose.mockResolvedValue(emptyPreview());
  mocks.api.saveComposeFile.mockResolvedValue({ ok: true });
  mocks.api.getBackups.mockResolvedValue({ backups: [] });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

describe('Compose 草稿与保存事务', () => {
  it('保存成功明确区分文件保存与应用，提供返回项目的下一步', async () => {
    await open(); await edit();
    await button('保存').trigger('click'); await flushPromises();
    expect(view().text()).toContain('保存文件不会自动更新容器');
    expect(view().get('a.btn-secondary[href*="focus=one"]').text()).toContain('返回项目');
    await edit(latestDraft);
    expect(view().text()).not.toContain('保存文件不会自动更新容器');
  });
  it('切换文件清除上一个文件的保存提示', async () => {
    await open(); await edit();
    await button('保存').trigger('click'); await flushPromises();
    expect(view().text()).toContain('保存文件不会自动更新容器');
    await view().get('select[aria-label="选择 Compose 配置文件"]').setValue('1'); await flushPromises();
    expect(view().text()).not.toContain('保存文件不会自动更新容器');
  });
  it('切换项目取消时保留选择与草稿，确认后才加载新项目', async () => {
    await open(); await edit();
    await view().get('select[aria-label="选择 Compose 项目"]').setValue('two');
    await flushPromises();
    expect(leaveDialog().props('show')).toBe(true);
    leaveDialog().vm.$emit('cancel'); await flushPromises();
    expect(router.currentRoute.value.query.projectId).toBe('one');
    expect(editor().getValue()).toBe(draft);
    expect(view().get('select[aria-label="选择 Compose 项目"]').element.value).toBe('one');
    await view().get('select[aria-label="选择 Compose 项目"]').setValue('two');
    await flushPromises(); leaveDialog().vm.$emit('confirm'); await flushPromises();
    expect(router.currentRoute.value.query.projectId).toBe('two');
    expect(editor().getValue()).toBe(original);
  });

  it('切换文件取消保留草稿，确认才读取目标文件', async () => {
    await open(); await edit();
    await view().get('select[aria-label="选择 Compose 配置文件"]').setValue('1');
    expect(leaveDialog().props('show')).toBe(true);
    leaveDialog().vm.$emit('cancel'); await flushPromises();
    expect(editor().getValue()).toBe(draft);
    expect(mocks.api.getComposeFile).toHaveBeenCalledTimes(1);
    await view().get('select[aria-label="选择 Compose 配置文件"]').setValue('1');
    leaveDialog().vm.$emit('confirm'); await flushPromises();
    expect(mocks.api.getComposeFile).toHaveBeenLastCalledWith('one', 1);
  });

  it('取消路由离开会结束导航，之后仍可正常导航', async () => {
    await open(); await edit();
    const first = router.push('/services'); await flushPromises();
    leaveDialog().vm.$emit('cancel'); await first;
    expect(router.currentRoute.value.name).toBe('compose');
    const second = router.push('/services'); await flushPromises();
    leaveDialog().vm.$emit('confirm'); await second;
    expect(router.currentRoute.value.name).toBe('services');
  });

  it('连续保存在校验完成前只发一次请求', async () => {
    await open(); await edit();
    const validation = deferred(); mocks.api.validateCompose.mockReturnValue(validation.promise);
    const save = button('保存'); await save.trigger('click'); await save.trigger('click');
    expect(mocks.api.validateCompose).toHaveBeenCalledTimes(1);
    validation.resolve({ issues: [] }); await flushPromises();
    expect(mocks.api.saveComposeFile).toHaveBeenCalledExactlyOnceWith('one', 0, draft, original);
  });

  it('校验中继续编辑必须重新保存，不能跳过新内容的校验', async () => {
    await open(); await edit();
    const validation = deferred(); mocks.api.validateCompose.mockReturnValue(validation.promise);
    await button('保存').trigger('click'); await edit(latestDraft);
    validation.resolve({ issues: [] }); await flushPromises();
    expect(mocks.api.previewCompose).not.toHaveBeenCalled();
    expect(mocks.api.saveComposeFile).not.toHaveBeenCalled();
    expect(view().text()).toContain('校验期间配置已变化');
  });

  it('预览中继续编辑不能保存未预览的内容', async () => {
    await open(); await edit();
    const preview = deferred(); mocks.api.previewCompose.mockReturnValue(preview.promise);
    await button('保存').trigger('click'); await flushPromises(); await edit(latestDraft);
    preview.resolve(emptyPreview()); await flushPromises();
    expect(mocks.api.saveComposeFile).not.toHaveBeenCalled();
    expect(view().text()).toContain('预览期间配置已变化');
  });

  it('保存期间新增编辑保持未保存状态，下一次使用已提交版本作基线', async () => {
    await open(); await edit();
    const saving = deferred(); mocks.api.saveComposeFile.mockReturnValueOnce(saving.promise);
    await button('保存').trigger('click'); await flushPromises(); await edit(latestDraft);
    saving.resolve({ ok: true }); await flushPromises();
    expect(editor().getValue()).toBe(latestDraft);
    expect(view().text()).toContain('后续修改仍未保存');
    expect(button('保存').attributes('disabled')).toBeUndefined();
    await button('保存').trigger('click'); await flushPromises();
    expect(mocks.api.saveComposeFile).toHaveBeenLastCalledWith('one', 0, latestDraft, draft);
  });

  it('确认预览后内容发生变化会拒绝旧确认', async () => {
    await open(); await edit();
    mocks.api.previewCompose.mockResolvedValue({ ...emptyPreview(), changed: [{ service: 'web', reasons: ['镜像'], container: 'one-web-1' }] });
    await button('保存').trigger('click'); await flushPromises(); await edit(latestDraft);
    await button('确认保存').trigger('click'); await flushPromises();
    expect(mocks.api.saveComposeFile).not.toHaveBeenCalled();
    expect(view().text()).toContain('请重新校验并预览后保存');
  });

  it('切换节点保留草稿但禁止保存，旧校验不能写入新节点', async () => {
    await open(); await edit();
    const validation = deferred(); mocks.api.validateCompose.mockReturnValue(validation.promise);
    await button('保存').trigger('click');
    window.dispatchEvent(new CustomEvent('composeops:host-changed'));
    validation.resolve({ issues: [] }); await flushPromises();
    expect(mocks.api.saveComposeFile).not.toHaveBeenCalled();
    expect(editor().getValue()).toBe(draft);
    expect(button('保存').attributes('disabled')).toBeDefined();
    expect(view().text()).toContain('当前草稿属于原节点');
  });

  it('预览使用当前文件索引', async () => {
    await open();
    await view().get('select[aria-label="选择 Compose 配置文件"]').setValue('1'); await flushPromises();
    await edit(); await button('保存').trigger('click'); await flushPromises();
    expect(mocks.api.previewCompose).toHaveBeenCalledWith('one', draft, 1);
  });

  it('存在备份时不显示空态，读取失败可见且保留编辑内容', async () => {
    await open();
    mocks.api.getBackups.mockResolvedValueOnce({ backups: [{ id: 1, createdAt: '2026-11-05 10:00:00', reason: 'save', size: 12 }] });
    await button('备份').trigger('click'); await flushPromises();
    expect(view().text()).not.toContain('暂无配置备份');
    mocks.api.getBackups.mockRejectedValueOnce(new Error('读取备份失败'));
    await button('备份').trigger('click'); await flushPromises();
    expect(view().get('[role="alert"]').text()).toBe('读取备份失败');
    expect(editor().getValue()).toBe(original);
  });
});
