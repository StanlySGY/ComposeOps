import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
const { getProjects } = vi.hoisted(() => ({ getProjects: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api: { getProjects } }));
import { useOperationVerification } from '../src/composables/useOperationVerification.js';
const Harness = { props: ['projectId', 'action', 'contextValid', 'running'], setup: props => useOperationVerification(props), template: '<div>{{ verification?.title }}</div>' };
let wrapper;
const start = (props = {}) => { wrapper = mount(Harness, { props: { projectId: 'a', action: 'up', contextValid: true, running: false, ...props } }); };
const snapshot = id => ({ projects: [{ id, containers: [{ id: 'c', state: 'running', health: 'healthy' }] }] });
beforeEach(() => getProjects.mockReset());
afterEach(() => wrapper?.unmount());
describe('状态核对请求时序', () => {
  it('运行时不读取完成状态，结束后强制读新数据', async () => {
    getProjects.mockResolvedValue(snapshot('a')); start({ running: true });
    expect(getProjects).not.toHaveBeenCalled();
    await wrapper.setProps({ running: false }); await flushPromises();
    expect(getProjects).toHaveBeenCalledWith(true);
    expect(wrapper.vm.verification.state).toBe('confirmed');
  });
  it('切换宿主立即丢弃在途结果；切回后重新读取', async () => {
    let finish;
    getProjects.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); start();
    await wrapper.setProps({ contextValid: false });
    finish(snapshot('a')); await flushPromises();
    expect(wrapper.vm.verification).toBe(null);
    getProjects.mockResolvedValue(snapshot('a'));
    await wrapper.setProps({ contextValid: true }); await flushPromises();
    expect(getProjects).toHaveBeenCalledTimes(2);
    expect(wrapper.vm.verification.state).toBe('confirmed');
  });
  it('旧项目的迟到响应不能覆盖新项目', async () => {
    let finish;
    getProjects.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ projects: [] }); start();
    await wrapper.setProps({ projectId: 'b' }); await flushPromises();
    finish(snapshot('a')); await flushPromises();
    expect(wrapper.vm.verification.title).toBe('未找到项目');
  });
  it('核对失败可重试，重试期间清空旧成功提示', async () => {
    getProjects.mockRejectedValueOnce(new Error('节点断开')).mockResolvedValueOnce(snapshot('a')); start(); await flushPromises();
    expect(wrapper.vm.verification.state).toBe('unknown');
    await wrapper.vm.verify(); await flushPromises();
    expect(wrapper.vm.verification.state).toBe('confirmed');
  });
  it('拉取镜像只展示下一步，不核对未应用的运行状态', async () => {
    start({ action: 'pull' }); await flushPromises();
    expect(getProjects).not.toHaveBeenCalled();
  });
  it('卸载后不提交迟到结果', async () => {
    let finish;
    getProjects.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); start();
    const state = wrapper.vm; wrapper.unmount(); wrapper = null;
    finish(snapshot('a')); await flushPromises();
    expect(state.verification).toBe(null);
  });
});
