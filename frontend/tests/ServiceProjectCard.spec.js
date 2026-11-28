import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { KeepAlive, h, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
const { api, streamProjectStats } = vi.hoisted(() => ({
  api: Object.fromEntries(['getProjectUpdates', 'getProjectWebUi', 'getComposeFile', 'getProjectEnv', 'saveProjectPreference', 'runComposeServiceAction'].map(key => [key, vi.fn()])),
  streamProjectStats: vi.fn(() => new Promise(() => {})),
}));
vi.mock('../src/api/client.js', () => ({ api, streamProjectStats }));
import Card from '../src/components/services/ServiceProjectCard.vue';
import ConfirmDialog from '../src/components/common/ConfirmDialog.vue';
let wrapper;
let project;
async function start(overrides = {}, expanded = true) {
  project = { id: 'p', projectName: 'web', managed: true, editable: true, status: 'partial', note: '原备注', containers: [{ id: 'stopped', name: 'web', state: 'exited', health: 'healthy', image: 'nginx', ports: [] }, { id: 'running', name: 'worker', state: 'running', image: 'nginx', ports: [] }], ...overrides };
  const router = createRouter({ history: createMemoryHistory(), routes: ['/services', '/logs', '/shell', '/compose', '/agent', '/review'].map(path => ({ path, component: {} })) });
  await router.push('/services?q=web&sort=name');
  wrapper = mount(Card, { props: { project, expanded }, global: { plugins: [router, createPinia()], stubs: { ConfirmDialog: true, SparklineChart: true } } });
  await flushPromises();
}
beforeEach(() => {
  vi.clearAllMocks();
  api.getProjectUpdates.mockResolvedValue({});
  api.getProjectWebUi.mockResolvedValue({ links: [] });
  api.getComposeFile.mockResolvedValue({ content: 'services: {}' });
  api.saveProjectPreference.mockResolvedValue({});
});
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; });
const button = name => wrapper.findAll('button').find(item => item.text() === name);

describe('项目卡片操作契约', () => {
  it('单容器展开后只保留一组日志、终端和诊断入口，折叠后保留快捷操作', async () => {
    await start({ status: 'running', containers: [{ id: 'single', name: 'single', service: 'web', state: 'running', image: 'nginx', ports: [] }] });
    expect(wrapper.find('nav[aria-label="web 快捷操作"]').exists()).toBe(false);
    for (const path of ['/logs', '/shell', '/agent']) expect(wrapper.findAll(`a[href*="${path}"]`)).toHaveLength(1);
    await wrapper.setProps({ expanded: false });
    expect(wrapper.find('.project-detail').exists()).toBe(false);
    expect(wrapper.get('nav[aria-label="web 快捷操作"]').exists()).toBe(true);
  });
  it('正常计划停机不渲染异常提示，意图保存失败保留原意图', async () => {
    await start({ operationalIntent: 'stopped', status: 'stopped', containers: [{ id: 'single', name: 'single', service: 'web', state: 'exited', exitCode: 0, image: 'nginx', ports: [] }] });
    expect(wrapper.find('.project-attention-summary').exists()).toBe(false);
    expect(wrapper.get('.service-group').classes()).not.toContain('service-group--attention');
    api.saveProjectPreference.mockRejectedValueOnce(new Error('offline'));
    await wrapper.get('select').setValue('running'); await flushPromises();
    expect(project.operationalIntent).toBe('stopped');
    expect(wrapper.get('select').element.value).toBe('stopped');
    api.saveProjectPreference.mockResolvedValueOnce({ operationalIntent: 'running' });
    await wrapper.get('select').setValue('running'); await flushPromises();
    expect(project.operationalIntent).toBe('running');
    expect(wrapper.find('.project-attention-summary').exists()).toBe(true);
  });
  it('停止容器的终端没有 href，日志仍可访问且携带原筛选', async () => {
    await start();
    const row = wrapper.get('[data-container="stopped"]');
    expect(row.get('[aria-label="容器终端"]').attributes('aria-disabled')).toBe('true');
    expect(row.get('[aria-label="容器终端"]').attributes('href')).toBeUndefined();
    expect(row.get('[aria-label="实时日志"]').attributes('href')).toContain('containerId=stopped');
    expect(row.get('[aria-label="实时日志"]').attributes('href')).toContain('returnTo=');
    expect(row.text()).toContain('已退出');
    expect(row.text()).not.toContain('健康');
  });
  it('Compose 服务分组清楚区分服务级与容器级操作，并支持独立折叠', async () => {
    await start({ containers: [
      { id: 'api-1', name: 'web-api-1', service: 'api', state: 'running', health: 'healthy', image: 'nginx:latest', ports: [{ public: 8080, private: 80 }] },
      { id: 'api-2', name: 'web-api-2', service: 'api', state: 'exited', health: '', image: 'nginx:latest', ports: [] },
      { id: 'db-1', name: 'web-db-1', service: 'db', state: 'running', health: 'unhealthy', image: 'postgres:16', ports: [] },
    ] });
    const apiGroup = wrapper.findAll('.service-group').find(group => group.get('.service-group__identity').text().includes('api'));
    expect(apiGroup.get('.service-group__health').text()).toContain('1/2 运行');
    const dbGroup = wrapper.findAll('.service-group').find(group => group.get('.service-group__identity').text().includes('db'));
    expect(dbGroup.classes()).toContain('service-group--attention');
    expect(dbGroup.get('.service-group__health').classes()).toContain('is-warning');
    expect(dbGroup.get('.service-group__health').text()).toContain('1 异常');
    expect(apiGroup.get('[aria-label="api 服务级操作（作用于全部副本）"]').exists()).toBe(true);
    expect(apiGroup.get('[data-container="api-1"] [aria-label="web-api-1 容器级操作"]').exists()).toBe(true);
    const toggle = apiGroup.get('.service-group__summary');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(apiGroup.find('[data-container="api-1"]').exists()).toBe(false);
    await toggle.trigger('click');
    expect(apiGroup.find('[data-container="api-1"]').exists()).toBe(true);
    expect(wrapper.findAll('.service-group')).toHaveLength(2);
    await wrapper.get('.service-view-toggle').trigger('click');
    expect(wrapper.findAll('.service-group__body')).toHaveLength(0);
    expect(wrapper.get('.service-view-toggle').text()).toBe('全部展开');
    await wrapper.get('.service-view-toggle').trigger('click');
    expect(wrapper.findAll('.service-group__body')).toHaveLength(2);
  });
  it('未纳管项目所有控制和工具链接真正不可激活', async () => {
    await start({ managed: false, editable: false });
    expect(wrapper.findAll('a[href*="/logs"], a[href*="/shell"], a[href*="/compose"], a[href*="/agent"]')).toHaveLength(0);
    await button('更多操作').trigger('click');
    expect(button('启动容器').attributes('disabled')).toBeDefined();
  });
  it('应用配置/重启/停止必须确认，取消不发出动作', async () => {
    await start();
    for (const [label, action] of [['应用配置 / 启动', 'up'], ['重启项目', 'restart'], ['停止项目', 'stop'], ['拉取源码并重建', 'source-deploy']]) {
      await button('更多操作').trigger('click'); await button(label).trigger('click');
      const dialog = wrapper.getComponent(ConfirmDialog);
      expect(dialog.props('show')).toBe(true);
      dialog.vm.$emit('cancel'); await flushPromises();
      expect(wrapper.emitted('action')).toBeUndefined();
      await button('更多操作').trigger('click'); await button(label).trigger('click');
      dialog.vm.$emit('confirm'); await flushPromises();
      expect(wrapper.emitted('action').at(-1)).toEqual([action]);
      wrapper.unmount(); await start();
    }
  });
  it('备注写入失败保留原值和草稿，可重试保存', async () => {
    await start();
    api.saveProjectPreference.mockRejectedValueOnce(new Error('网络中断'));
    await wrapper.get('[aria-label="编辑备注"]').trigger('click'); await flushPromises();
    const textarea = document.querySelector('[aria-label="项目备注"]');
    textarea.value = '新备注'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#project-note-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises();
    expect(project.note).toBe('原备注');
    expect(document.querySelector('[role="alert"]').textContent).toContain('网络中断');
    expect(textarea.value).toBe('新备注');
    document.querySelector('#project-note-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises();
    expect(wrapper.emitted('note-saved')).toEqual([['新备注']]);
    expect(wrapper.emitted('refresh')).toBeTruthy();
  });
  it('折叠项目不读取 Compose 或环境变量，收起时释放指标流', async () => {
    await start({}, false);
    expect(api.getComposeFile).not.toHaveBeenCalled();
    expect(api.getProjectEnv).not.toHaveBeenCalled();
    expect(streamProjectStats).not.toHaveBeenCalled();
    await wrapper.setProps({ expanded: true }); await flushPromises();
    const signal = streamProjectStats.mock.calls[0][2];
    expect(signal.aborted).toBe(false);
    await wrapper.setProps({ expanded: false });
    expect(signal.aborted).toBe(true);
  });
});

it('指标首帧前展示等待，收到数据后展示指标，断线不保留陈旧值', async () => {
  await start();
  const row = () => wrapper.get('[data-container="running"]');
  expect(row().text()).toContain('等待指标采样');
  const onFrame = streamProjectStats.mock.calls.at(-1)[1];
  onFrame({ type: 'stats', data: [{ containerId: 'running', cpuPercent: 12, memUsageMB: 64 }] });
  await flushPromises();
  expect(row().text()).toContain('CPU 12.0%');
  onFrame({ type: 'error', data: 'disconnected' }); await flushPromises();
  expect(row().text()).toContain('正在重连'); expect(row().text()).not.toContain('CPU 12.0%');
});

it('容器从停止恢复运行或首次纳管时，展开卡片开始订阅指标', async () => {
  await start({ containers: [{ id: 'one', service: 'web', name: 'web', state: 'exited', image: 'nginx', ports: [] }] });
  expect(streamProjectStats).not.toHaveBeenCalled();
  await wrapper.setProps({ project: { ...project, containers: [{ ...project.containers[0], state: 'running' }] } });
  expect(streamProjectStats).toHaveBeenCalledOnce();
  const signal = streamProjectStats.mock.calls[0][2];
  await wrapper.setProps({ project: { ...project, managed: false } });
  expect(signal.aborted).toBe(true);
  await wrapper.setProps({ project: { ...project, managed: true, containers: [{ ...project.containers[0], state: 'running' }] } });
  expect(streamProjectStats).toHaveBeenCalledTimes(2);
});

it('旧订阅迟到帧不能覆盖收起后重新打开的指标，CPU 未就绪不显示零值', async () => {
  await start();
  const old = streamProjectStats.mock.calls[0][1];
  await wrapper.setProps({ expanded: false });
  await wrapper.setProps({ expanded: true });
  const current = streamProjectStats.mock.calls.at(-1)[1];
  current({ type: 'stats', data: [{ containerId: 'running', cpuPercent: 12, cpuReady: true, memUsageMB: 64 }] });
  old({ type: 'stats', data: [{ containerId: 'running', cpuPercent: 99, cpuReady: true, memUsageMB: 99 }] });
  await flushPromises();
  expect(wrapper.get('[data-container="running"]').text()).toContain('CPU 12.0%');
  current({ type: 'stats', data: [{ containerId: 'running', cpuPercent: 0, cpuReady: false, memUsageMB: 64 }] });
  await flushPromises();
  expect(wrapper.get('[data-container="running"]').text()).not.toContain('CPU 0.0%');
  expect(wrapper.get('[data-container="running"]').text()).toContain('内存 64 MB');
});


it('缓存失活期间容器状态变化不重开指标，返回后只订阅一次', async () => {
  const visible = ref(true);
  const state = ref({ id: 'kept', projectName: '缓存项目', managed: true, editable: true, status: 'running', containers: [{ id: 'c', name: 'web', service: 'web', state: 'running', image: 'nginx', ports: [] }] });
  const router = createRouter({ history: createMemoryHistory(), routes: ['/', '/services', '/logs', '/shell', '/compose', '/agent', '/review'].map(path => ({ path, component: {} })) });
  await router.push('/');
  wrapper = mount({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(Card, { project: state.value, expanded: true }) : null }) }, { global: { plugins: [router, createPinia()], stubs: { SparklineChart: true } } });
  await flushPromises();
  expect(streamProjectStats).toHaveBeenCalledOnce();
  const signal = streamProjectStats.mock.calls[0][2];
  visible.value = false; await flushPromises();
  expect(signal.aborted).toBe(true);
  state.value = { ...state.value, containers: [{ ...state.value.containers[0], id: 'replacement' }] };
  await flushPromises();
  expect(streamProjectStats).toHaveBeenCalledOnce();
  visible.value = true; await flushPromises();
  expect(streamProjectStats).toHaveBeenCalledTimes(2);
});
