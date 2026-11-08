import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, DOMWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import BlueprintDeployModal from '../src/components/marketplace/BlueprintDeployModal.vue';

const mocks = vi.hoisted(() => ({
  api: { streamBlueprintDeploy: vi.fn(), getProjects: vi.fn() },
  hosts: { activeHostId: 'local', active: { id: 'local', name: '本地节点', type: 'local' }, loading: false },
  push: vi.fn(), copy: vi.fn(), changed: vi.fn(),
}));
vi.mock('../src/api/client.js', () => ({ api: mocks.api }));
vi.mock('../src/stores/hosts.js', () => ({ useHostsStore: () => reactive(mocks.hosts) }));
vi.mock('vue-router', () => ({ useRoute: () => ({ fullPath: '/marketplace' }), useRouter: () => ({ push: mocks.push }) }));
vi.mock('../src/lib/clipboard.js', () => ({ copyText: mocks.copy }));
vi.mock('../src/lib/data-changes.js', () => ({ notifyDataChanged: mocks.changed }));
let wrapper;
const template = { id: 'minio', name: 'MinIO', description: '对象存储', envSchema: [{ key: 'CONTAINER_NAME', default: 'minio' }, { key: 'API_PORT', type: 'port', default: '9000', label: 'API 端口' }, { key: 'CONSOLE_PORT', type: 'port', default: '9001', label: '控制台端口' }, { key: 'PASSWORD', secret: true, label: '管理员密码' }] };
const done = { ok: true, code: 0, projectId: 'new-project', projectName: 'minio', hostId: 'local', filesCreated: true, directoryCreated: true };
const dialog = () => new DOMWrapper(document.querySelector('[role="dialog"]'));
const button = text => dialog().findAll('button').find(item => item.text() === text);
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; }
async function start() { wrapper = mount(BlueprintDeployModal, { props: { template }, attachTo: document.body }); await flushPromises(); }
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.hosts, { activeHostId: 'local', active: { id: 'local', name: '本地节点', type: 'local' }, loading: false });
  mocks.api.getProjects.mockResolvedValue({ projects: [] }); mocks.copy.mockResolvedValue();
  mocks.api.streamBlueprintDeploy.mockResolvedValue();
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
});
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('应用部署的目标与结果隔离', () => {
  it('重排先触发scroll时仍跟随尾部，手动回看后重排保持阅读位置', async () => {
    const pending = deferred(); let frame;
    mocks.api.streamBlueprintDeploy.mockImplementation((id, values, callback) => { frame = callback; return pending.promise; });
    await start(); await button('部署').trigger('click'); frame({ type: 'stdout', data: 'line\n'.repeat(100) }); await flushPromises();
    const output = dialog().get('[aria-label="部署输出内容"]');
    let width = 300, height = 200, total = 1000, top = 800;
    Object.defineProperties(output.element, {
      clientWidth: { configurable: true, get: () => width }, clientHeight: { configurable: true, get: () => height },
      scrollHeight: { configurable: true, get: () => total }, scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(value, total - height)); } },
    });
    await output.trigger('scroll');
    width = 240; height = 160; total = 1400;
    await output.trigger('scroll');
    expect(top).toBe(1240);
    total = 1800;
    frame({ type: 'stdout', data: 'another line\n' }); await flushPromises();
    expect(top).toBe(1640);
    output.element.scrollTop = 0; await output.trigger('scroll');
    width = 320; height = 220; total = 1000;
    await output.trigger('scroll');
    expect(top).toBe(0);
    expect(dialog().text()).toContain('跟随最新');
    pending.resolve(); await flushPromises();
  });
  it('前端校验非法项目名/空秘密/重复端口，不发起写入', async () => {
    await start();
    await dialog().get('#market-deploy-project-name').setValue('../bad');
    await dialog().get('#market-deploy-variable-PASSWORD').setValue('');
    await dialog().get('#market-deploy-variable-CONSOLE_PORT').setValue('9000');
    await button('部署').trigger('click'); await flushPromises();
    expect(mocks.api.streamBlueprintDeploy).not.toHaveBeenCalled();
    expect(dialog().findAll('[aria-invalid="true"]')).toHaveLength(3);
    expect(document.activeElement.id).toBe('market-deploy-project-name');
    expect(dialog().find('#market-deploy-variable-CONTAINER_NAME').exists()).toBe(false);
  });
  it('秘密显示/隐藏、随机生成与复制不改变字段语义，也不持久化', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    await start(); const secret = dialog().get('#market-deploy-variable-PASSWORD'); const initial = secret.element.value;
    await dialog().get('[aria-label="显示管理员密码"]').trigger('click'); expect(secret.attributes('type')).toBe('text');
    await dialog().get('[aria-label="隐藏管理员密码"]').trigger('click'); expect(secret.attributes('type')).toBe('password');
    await button('重新生成').trigger('click'); expect(secret.element.value).not.toBe(initial);
    await button('复制').trigger('click'); await flushPromises(); expect(mocks.copy).toHaveBeenCalledWith(secret.element.value);
    expect(storage).not.toHaveBeenCalled();
  });
  it('忙时防重复提交，携带真实目标节点与 AbortSignal', async () => {
    const pending = deferred(); mocks.api.streamBlueprintDeploy.mockReturnValue(pending.promise);
    await start(); await button('部署').trigger('click');
    await dialog().get('.btn-save').trigger('click');
    expect(mocks.api.streamBlueprintDeploy).toHaveBeenCalledTimes(1);
    const call = mocks.api.streamBlueprintDeploy.mock.calls[0]; expect(call[0]).toBe('minio'); expect(call[3]).toBeInstanceOf(AbortSignal); expect(call[4]).toBe('local');
    expect(dialog().get('[aria-label="关闭"]').element.disabled).toBe(true);
    pending.resolve(); await flushPromises();
  });
  it('停止等待后旧结果不能报成功，保留输出并阻止重复部署', async () => {
    const pending = deferred(); let frame;
    mocks.api.streamBlueprintDeploy.mockImplementation((id, values, onFrame) => { frame = onFrame; return pending.promise; });
    await start(); await button('部署').trigger('click'); frame({ type: 'stdout', data: 'already written\n' }); await flushPromises();
    await button('停止等待').trigger('click'); frame({ type: 'result', data: done }); pending.resolve(); await flushPromises();
    expect(dialog().text()).toContain('结果待核对'); expect(dialog().text()).toContain('already written'); expect(dialog().find('.btn-save').exists()).toBe(false);
    expect(mocks.changed).not.toHaveBeenCalled(); expect(wrapper.emitted('deployed')).toBeUndefined();
    expect(mocks.api.streamBlueprintDeploy.mock.calls[0][3].aborted).toBe(true);
  });
  it('切换节点中断当前等待并保留原目标，迟到响应不污染新节点', async () => {
    const pending = deferred(); let frame;
    mocks.api.streamBlueprintDeploy.mockImplementation((id, values, onFrame) => { frame = onFrame; return pending.promise; });
    await start(); await button('部署').trigger('click');
    reactive(mocks.hosts).activeHostId = 'remote'; await flushPromises();
    frame({ type: 'result', data: done }); pending.resolve(); await flushPromises();
    expect(dialog().text()).toContain('本地节点'); expect(dialog().text()).toContain('结果待核对'); expect(mocks.changed).not.toHaveBeenCalled();
  });
  it('尚未部署时切换节点需明确重新配置，不能静默改目标', async () => {
    await start(); reactive(mocks.hosts).activeHostId = 'remote'; reactive(mocks.hosts).active = { id: 'remote', name: '测试节点', type: 'ssh' }; await flushPromises();
    expect(button('部署').element.disabled).toBe(true);
    await button('改用当前节点').trigger('click'); expect(dialog().text()).toContain('测试节点'); expect(button('部署').element.disabled).toBe(false);
  });
  it('TCP 节点给出原因并禁用部署', async () => {
    mocks.hosts.active.type = 'tcp'; await start(); expect(dialog().text()).toContain('TCP 节点不能创建应用配置'); expect(button('部署').element.disabled).toBe(true);
  });
  it('成功后网络清理异常不反转已确认结果，状态读取失败可独立重试', async () => {
    mocks.api.streamBlueprintDeploy.mockImplementation(async (id, values, frame) => { frame({ type: 'result', data: done }); throw new Error('connection closed after result'); });
    mocks.api.getProjects.mockRejectedValueOnce(new Error('scan failed')).mockResolvedValueOnce({ projects: [{ id: done.projectId, editable: true, containers: [{ id: 'c', service: 'app', state: 'running', health: 'healthy' }] }] });
    await start(); await button('部署').trigger('click'); await flushPromises();
    expect(dialog().text()).toContain('启动命令已完成'); expect(dialog().text()).toContain('scan failed');
    await button('重新核对').trigger('click'); await flushPromises();
    expect(dialog().text()).toContain('健康检查通过'); expect(button('查看配置').element.disabled).toBe(false);
  });
  it('未配置健康检查不冒称健康，成功后仍可复制生成凭据', async () => {
    mocks.api.streamBlueprintDeploy.mockImplementation(async (id, values, frame) => frame({ type: 'result', data: done }));
    mocks.api.getProjects.mockResolvedValue({ projects: [{ id: done.projectId, containers: [{ id: 'c', state: 'running' }] }] });
    await start(); const secret = dialog().get('#market-deploy-variable-PASSWORD').element.value;
    await button('部署').trigger('click'); await flushPromises();
    expect(dialog().text()).toContain('未配置健康检查'); expect(dialog().text()).not.toContain('均运行，且健康检查通过');
    await dialog().get('[aria-label="复制管理员密码"]').trigger('click'); expect(mocks.copy).toHaveBeenCalledWith(secret);
  });
  it('离页后迟到部署/核对不触发成功事件或回写界面', async () => {
    const pending = deferred(); let frame;
    mocks.api.streamBlueprintDeploy.mockImplementation((id, values, onFrame) => { frame = onFrame; return pending.promise; });
    await start(); await button('部署').trigger('click'); wrapper.unmount(); wrapper = null;
    frame({ type: 'result', data: done }); pending.resolve(); await flushPromises();
    expect(mocks.changed).not.toHaveBeenCalled(); expect(mocks.api.getProjects).not.toHaveBeenCalled();
  });
  it('输出有界，复制失败原位反馈并可重试', async () => {
    mocks.api.streamBlueprintDeploy.mockImplementation(async (id, values, frame) => { frame({ type: 'stdout', data: 'x'.repeat(70000) + 'TAIL' }); frame({ type: 'result', data: { ...done, ok: false, code: 1 } }); });
    mocks.copy.mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce();
    await start(); await button('部署').trigger('click'); await flushPromises();
    expect(dialog().get('pre').text()).toHaveLength(65536); expect(dialog().text()).toContain('较早输出已省略');
    await button('复制输出').trigger('click'); await flushPromises(); expect(dialog().text()).toContain('复制失败');
    await button('复制输出').trigger('click'); await flushPromises(); expect(dialog().text()).toContain('部署输出已复制');
  });
  it('前置检查失败仍允许修正值重试，后置失败不允许覆盖重试', async () => {
    mocks.api.streamBlueprintDeploy.mockImplementationOnce(async (id, values, frame) => frame({ type: 'result', data: { ok: false, message: '端口冲突' } })).mockImplementationOnce(async (id, values, frame) => frame({ type: 'result', data: { ...done, ok: false, code: 1 } }));
    await start(); await button('部署').trigger('click'); await flushPromises();
    expect(dialog().text()).toContain('端口冲突'); expect(dialog().findAll('.deploy-steps .complete')).toHaveLength(1); await dialog().get('#market-deploy-variable-API_PORT').setValue('19000');
    await button('重新检查并部署').trigger('click'); await flushPromises(); expect(dialog().find('.btn-save').exists()).toBe(false);
  });
  it('终帧立即释放忙态和连接，重复帧不能再次通知或反转结果', async () => {
    const pending = deferred(); let frame;
    mocks.api.streamBlueprintDeploy.mockImplementation((id, values, callback) => { frame = callback; return pending.promise; });
    await start(); await button('部署').trigger('click');
    frame({ type: 'result', data: done }); await flushPromises();
    expect(dialog().text()).toContain('启动命令已完成'); expect(dialog().get('[aria-label="关闭"]').element.disabled).toBe(false);
    expect(mocks.api.streamBlueprintDeploy.mock.calls[0][3].aborted).toBe(true); expect(mocks.api.getProjects).toHaveBeenCalledTimes(1);
    frame({ type: 'result', data: { ok: false, code: 1 } }); pending.resolve(); await flushPromises();
    expect(mocks.changed).toHaveBeenCalledTimes(1); expect(dialog().text()).toContain('启动命令已完成');
  });
  it('后续导航使用正确项目 ID 和可识别返回来源', async () => {
    mocks.api.streamBlueprintDeploy.mockImplementation(async (id, values, frame) => frame({ type: 'result', data: done }));
    mocks.api.getProjects.mockResolvedValue({ projects: [{ id: done.projectId, editable: true, containers: [] }] });
    await start(); await button('部署').trigger('click'); await flushPromises();
    await button('查看日志').trigger('click'); expect(mocks.push).toHaveBeenLastCalledWith('/logs?projectId=new-project&from=marketplace');
    await button('查看服务').trigger('click'); expect(mocks.push).toHaveBeenLastCalledWith('/services?focus=new-project&from=marketplace');
  });
  it('关闭后的会话记录排除密码、提交变量及结果中的额外字段，恢复不重新部署', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    mocks.api.streamBlueprintDeploy.mockImplementation(async (id, values, frame) => {
      frame({ type: 'stdout', data: `password=${values.PASSWORD}\nretained output` });
      frame({ type: 'result', data: { ...done, extra: values } });
    });
    await start(); const password = dialog().get('#market-deploy-variable-PASSWORD').element.value;
    await button('部署').trigger('click'); await flushPromises();
    await button('返回市场').trigger('click');
    const record = wrapper.emitted('record')[0][0];
    expect(JSON.stringify(record)).not.toContain(password); expect(record.output).toContain('[REDACTED]');
    expect(record).not.toHaveProperty('values'); expect(record.result).not.toHaveProperty('extra');
    wrapper.unmount();
    wrapper = mount(BlueprintDeployModal, { props: { template, record }, attachTo: document.body }); await flushPromises();
    expect(dialog().text()).toContain('retained output'); expect(dialog().text()).toContain('上次部署记录');
    expect(dialog().find('.btn-save').exists()).toBe(false); expect(dialog().find('.deployment-credentials').exists()).toBe(false);
    expect(mocks.api.streamBlueprintDeploy).toHaveBeenCalledTimes(1); expect(storage).not.toHaveBeenCalled();
  });
  it('中断后卸载仍保存待核对记录，迟到结果不能把记录改成成功', async () => {
    const pending = deferred(); let frame; const records = [];
    mocks.api.streamBlueprintDeploy.mockImplementation((id, values, callback) => { frame = callback; return pending.promise; });
    wrapper = mount(BlueprintDeployModal, { props: { template, onRecord: value => records.push(value) }, attachTo: document.body }); await flushPromises();
    await button('部署').trigger('click'); frame({ type: 'stdout', data: 'before leaving' });
    wrapper.unmount(); wrapper = null;
    frame({ type: 'result', data: done }); pending.resolve(); await flushPromises();
    expect(records).toHaveLength(1); expect(records[0].status).toBe('unknown'); expect(records[0].output).toBe('before leaving');
    expect(mocks.changed).not.toHaveBeenCalled();
  });
});
