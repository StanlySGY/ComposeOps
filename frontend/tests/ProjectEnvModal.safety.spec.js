import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ProjectEnvModal from '../src/components/services/ProjectEnvModal.vue';
const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['getProjectEnv', 'getProjectEnvFiles', 'getProjectEnvBackups', 'saveProjectEnv', 'restoreProjectEnvBackup'].map(k => [k, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));
const payload = (raw = 'MODE=original\n', file = '.env') => ({ raw, file, exists: true, version: 'a'.repeat(64) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let wrapper;
const button = label => wrapper.findAll('button').find(b => b.text() === label);
async function start() {
  wrapper = mount(ProjectEnvModal, { props: { project: { id: 'p', projectName: '项目' } }, global: { stubs: {
    BaseModal: { props: ['show'], template: '<div v-if="show"><slot name="header-actions"/><slot/></div>' },
    ChangePreviewModal: true, ConfirmDialog: true,
  } } });
  await flushPromises();
}
beforeEach(() => {
  vi.resetAllMocks();
  api.getProjectEnv.mockImplementation(async (_id, file) => payload('MODE=original\n', file));
  api.getProjectEnvFiles.mockResolvedValue({ files: [{ name: '.env', exists: true }, { name: '.env.production', exists: true }] });
  api.getProjectEnvBackups.mockResolvedValue({ backups: [] });
  api.saveProjectEnv.mockResolvedValue({ ok: true, version: 'b'.repeat(64) });
});
afterEach(() => { wrapper?.unmount(); });

describe('环境变量草稿与版本保护', () => {
  it('表格编辑切原文再回表格不会丢失；未编辑的格式、注释和尾部换行保留', async () => {
    const original = '# leading comment\n\nMODE=original\n\n';
    api.getProjectEnv.mockResolvedValue(payload(original));
    await start();
    await button('原始文本').trigger('click');
    expect(wrapper.get('textarea').element.value).toBe(original);
    await button('键值表格').trigger('click');
    await wrapper.get('[aria-label="MODE 变量值"]').setValue('table-edit');
    await button('原始文本').trigger('click');
    expect(wrapper.get('textarea').element.value).toContain('MODE=table-edit');
    await wrapper.get('textarea').setValue('MODE=raw-edit\n\n');
    await button('键值表格').trigger('click');
    expect(wrapper.get('[aria-label="MODE 变量值"]').element.value).toBe('raw-edit');
    await button('原始文本').trigger('click');
    expect(wrapper.get('textarea').element.value).toBe('MODE=raw-edit\n\n');
    await button('仅保存文件').trigger('click'); await flushPromises();
    expect(api.saveProjectEnv).toHaveBeenCalledWith('p', { file: '.env', raw: 'MODE=raw-edit\n\n', expectedVersion: 'a'.repeat(64) });
    expect(wrapper.text()).not.toContain('有未保存修改');
  });
  it('首次读取失败禁用保存，显式重试成功才允许编辑', async () => {
    api.getProjectEnv.mockRejectedValueOnce(new Error('断线'));
    await start();
    expect(wrapper.get('[role="alert"]').text()).toContain('断线');
    expect(button('仅保存文件').attributes('disabled')).toBeDefined();
    await button('仅保存文件').trigger('click'); expect(api.saveProjectEnv).not.toHaveBeenCalled();
    await button('重试读取').trigger('click'); await flushPromises();
    expect(button('仅保存文件').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
  it('快速切文件后迟到内容和备份不能覆盖新文件', async () => {
    const old = deferred(); api.getProjectEnv.mockReturnValueOnce(old.promise);
    await start();
    await wrapper.get('select').setValue('.env.production'); await flushPromises();
    expect(wrapper.get('select').element.value).toBe('.env.production');
    old.resolve(payload('MODE=stale\n')); await flushPromises();
    expect(wrapper.get('[aria-label="MODE 变量值"]').element.value).toBe('original');
    await button('仅保存文件').trigger('click'); await flushPromises();
    expect(api.saveProjectEnv.mock.calls[0][1].file).toBe('.env.production');
  });
  it('版本冲突保留草稿，不触发应用或误报保存成功', async () => {
    api.saveProjectEnv.mockRejectedValue(Object.assign(new Error('文件已被修改'), { code: 'ENV_VERSION_CONFLICT' }));
    await start(); await wrapper.get('[aria-label="MODE 变量值"]').setValue('mine');
    await button('仅保存文件').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('文件已被修改');
    expect(button('复制当前草稿')).toBeDefined();
    expect(wrapper.get('[aria-label="MODE 变量值"]').element.value).toBe('mine');
    expect(wrapper.text()).toContain('有未保存修改');
    expect(wrapper.emitted('apply')).toBeUndefined();
    expect(wrapper.emitted('refresh')).toBeUndefined();
  });
  it('保存期间防重复提交并锁住编辑，成功后使用新版本继续保存', async () => {
    const save = deferred(); api.saveProjectEnv.mockReturnValueOnce(save.promise);
    await start(); await button('仅保存文件').trigger('click');
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();
    await button('仅保存文件').trigger('click'); expect(api.saveProjectEnv).toHaveBeenCalledTimes(1);
    save.resolve({ ok: true, version: 'b'.repeat(64) }); await flushPromises();
    await button('仅保存文件').trigger('click'); await flushPromises();
    expect(api.saveProjectEnv.mock.calls.at(-1)[1].expectedVersion).toBe('b'.repeat(64));
  });
  it('更换项目后旧保存完成不能重置新草稿或应用新项目', async () => {
    const save = deferred(); api.saveProjectEnv.mockReturnValueOnce(save.promise);
    await start(); await button('仅保存文件').trigger('click');
    await wrapper.setProps({ project: { id: 'new', projectName: '新项目' } }); await flushPromises();
    await wrapper.get('[aria-label="MODE 变量值"]').setValue('new-draft');
    save.resolve({ version: 'old' }); await flushPromises();
    expect(wrapper.get('[aria-label="MODE 变量值"]').element.value).toBe('new-draft');
    expect(wrapper.emitted('refresh')).toBeUndefined();
  });
  it('文件列表失败明确呈现，草稿阻止页面卸载且卸载后释放监听', async () => {
    api.getProjectEnvFiles.mockRejectedValue(new Error('列表断线'));
    await start(); expect(wrapper.text()).toContain('列表断线');
    await wrapper.get('[aria-label="MODE 变量值"]').setValue('mine');
    const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    wrapper.unmount(); wrapper = null;
    const after = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
  });
});
