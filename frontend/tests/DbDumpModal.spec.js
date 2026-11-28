import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DbDumpModal from '../src/components/services/DbDumpModal.vue';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';
const { api, toast } = vi.hoisted(() => ({ api: { listDbDumpTargets: vi.fn(), streamDbDump: vi.fn() }, toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => toast }));
let wrapper, click, createUrl;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const result = blob => ({ ok: true, headers: new Headers({ 'content-disposition': 'attachment; filename="synthetic-db.sql.gz"' }), blob: async () => blob });
beforeEach(() => {
  vi.clearAllMocks();
  api.listDbDumpTargets.mockResolvedValue({ containers: [{ containerId: 'db', containerName: '数据库', type: 'postgres' }] });
  api.streamDbDump.mockResolvedValue(result(new Blob(['synthetic dump'])));
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  createUrl = vi.fn(() => 'blob:synthetic'); vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }));
});
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render() {
  wrapper = mount(DbDumpModal, { props: { project: { id: 'project', projectName: '项目' } }, global: { stubs: { BaseModal: { template: '<div><slot/><slot name="footer"/></div>' } } } });
  await flushPromises(); await wrapper.get('select').setValue('db');
}
async function start() { await wrapper.findAll('button').find(item => item.text().includes('开始导出')).trigger('click'); await flushPromises(); }

it('导出成功触发一次下载、关闭弹窗并清理对象 URL', async () => {
  await render(); await start();
  expect(click).toHaveBeenCalledOnce(); expect(wrapper.emitted('close')).toEqual([[]]);
  expect(toast.success).toHaveBeenCalledOnce(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
});

it.each(['unmount', 'host', 'auth'])('%s 发生在响应体读取时，迟到内容不得触发下载或成功提示', async reason => {
  const blob = deferred(); api.streamDbDump.mockResolvedValue({ ...result(null), blob: () => blob.promise });
  await render(); await start(); const signal = api.streamDbDump.mock.calls[0][3];
  if (reason === 'unmount') wrapper.unmount();
  else if (reason === 'host') window.dispatchEvent(new Event('composeops:host-changed'));
  else advanceAuthEpoch();
  blob.resolve(new Blob(['private-old-dump'])); await flushPromises();
  expect(click).not.toHaveBeenCalled(); expect(createUrl).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled(); expect(signal.aborted).toBe(true);
});

it('下载失败保留选择可重试，成功不重复提交', async () => {
  api.streamDbDump.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ message: '导出暂时失败' }) });
  await render(); await start(); expect(wrapper.get('[role="alert"]').text()).toContain('导出暂时失败'); expect(wrapper.get('select').element.value).toBe('db');
  api.streamDbDump.mockResolvedValueOnce(result(new Blob(['synthetic dump']))); await start();
  expect(click).toHaveBeenCalledOnce(); expect(api.streamDbDump).toHaveBeenCalledTimes(2);
});

it('当前导出 401 通知登录失效，旧 401 不退出新会话', async () => {
  const unauthorized = vi.fn(); window.addEventListener('composeops:unauthorized', unauthorized);
  try {
    api.streamDbDump.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ message: '请登录' }) });
    await render(); await start(); expect(unauthorized).toHaveBeenCalledOnce();
    wrapper.unmount(); const old = deferred(); api.streamDbDump.mockReturnValueOnce(old.promise);
    await render(); await start(); advanceAuthEpoch(); old.resolve({ ok: false, status: 401, json: async () => ({ message: '旧登录失效' }) }); await flushPromises();
    expect(unauthorized).toHaveBeenCalledOnce(); expect(click).not.toHaveBeenCalled();
  } finally { window.removeEventListener('composeops:unauthorized', unauthorized); }
});
