import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import FullBackupPlanPanel from '../src/components/resources/FullBackupPlanPanel.vue';

const api = vi.hoisted(() => ({ getProjects: vi.fn(), getFullBackupPlan: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
let wrapper;
const plan = (name = 'Alpha') => ({
  project: { name }, host: { name: '本机' }, resources: [{ kind: 'bind', source: '/srv/apps/data', containers: ['web'], verification: 'pending-host-check' }],
  blockers: [{ message: '共享数据需要协调停写' }], warnings: [{ message: '数据库一致性尚未验证' }],
  generatedAt: '2026-11-03T00:00:00Z', fingerprint: 'a'.repeat(64),
});
beforeEach(() => {
  vi.clearAllMocks();
  api.getProjects.mockResolvedValue({ projects: [{ id: 'p1', projectName: 'Alpha', managed: true }, { id: 'p2', projectName: 'Beta', managed: true }, { id: 'p3', projectName: 'Hidden', managed: false }] });
  api.getFullBackupPlan.mockResolvedValue(plan());
});
afterEach(() => { wrapper?.unmount(); wrapper = null; });

describe('完整备份范围预检', () => {
  it('显示中文范围与缺项，清楚区分清单和备份产物', async () => {
    wrapper = mount(FullBackupPlanPanel);
    await flushPromises();
    expect(wrapper.text()).toContain('Hidden');
    await wrapper.get('select').setValue('p1');
    await wrapper.findAll('button')[0].trigger('click');
    await flushPromises();
    expect(api.getFullBackupPlan).toHaveBeenCalledWith('p1');
    expect(wrapper.text()).toContain('宿主挂载');
    expect(wrapper.text()).toContain('共享数据需要协调停写');
    expect(wrapper.get('[role="status"]').text()).toContain('尚未生成备份');
    expect(wrapper.text()).not.toContain('备份成功');
  });

  it('切换项目后丢弃迟到响应', async () => {
    let resolve;
    api.getFullBackupPlan.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    wrapper = mount(FullBackupPlanPanel);
    await flushPromises();
    await wrapper.get('select').setValue('p1');
    await wrapper.findAll('button')[0].trigger('click');
    expect(wrapper.get('[aria-busy]').attributes('aria-busy')).toBe('true');
    await wrapper.get('select').setValue('p2');
    resolve(plan('Alpha stale'));
    await flushPromises();
    expect(wrapper.text()).not.toContain('Alpha stale');
    expect(wrapper.get('[aria-busy]').attributes('aria-busy')).toBe('false');
  });

  it('节点切换立即清空结果，刷新失败显示错误', async () => {
    wrapper = mount(FullBackupPlanPanel);
    await flushPromises();
    await wrapper.get('select').setValue('p1');
    await wrapper.findAll('button')[0].trigger('click');
    await flushPromises();
    api.getProjects.mockRejectedValueOnce(new Error('节点不可达'));
    window.dispatchEvent(new Event('composeops:host-changed'));
    await flushPromises();
    expect(wrapper.text()).not.toContain('/srv/apps/data');
    expect(wrapper.get('[role="alert"]').text()).toContain('节点不可达');
  });
});
