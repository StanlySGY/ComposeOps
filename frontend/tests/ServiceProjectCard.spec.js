import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
const { api, streamProjectStats } = vi.hoisted(() => ({
  api: Object.fromEntries(['getProjectUpdates', 'getProjectWebUi', 'getComposeFile', 'getProjectEnv', 'saveProjectPreference'].map(key => [key, vi.fn()])),
  streamProjectStats: vi.fn(() => new Promise(() => {})),
}));
vi.mock('../src/api/client.js', () => ({ api, streamProjectStats }));
import Card from '../src/components/services/ServiceProjectCard.vue';
import ConfirmDialog from '../src/components/common/ConfirmDialog.vue';
let wrapper;
let project;
async function start(overrides = {}, expanded = true) {
  project = { id: 'p', projectName: 'web', managed: true, editable: true, status: 'partial', note: '原备注', containers: [{ id: 'stopped', name: 'web', state: 'exited', health: 'healthy', image: 'nginx', ports: [] }, { id: 'running', name: 'worker', state: 'running', image: 'nginx', ports: [] }], ...overrides };
  const router = createRouter({ history: createMemoryHistory(), routes: ['/services', '/logs', '/shell', '/compose', '/agent'].map(path => ({ path, component: {} })) });
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
  it('未纳管项目所有控制和工具链接真正不可激活', async () => {
    await start({ managed: false, editable: false });
    expect(wrapper.findAll('a[href*="/logs"], a[href*="/shell"], a[href*="/compose"], a[href*="/agent"]')).toHaveLength(0);
    await button('更多操作').trigger('click');
    expect(button('启动容器').attributes('disabled')).toBeDefined();
  });
  it('应用配置/重启/停止必须确认，取消不发出动作', async () => {
    await start();
    for (const [label, action] of [['应用配置 / 启动', 'up'], ['重启项目', 'restart'], ['停止项目', 'stop']]) {
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
