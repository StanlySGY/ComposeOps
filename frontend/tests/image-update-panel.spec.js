import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ImageUpdatePanel from '../src/components/services/ImageUpdatePanel.vue';
const mocks = vi.hoisted(() => ({ project: vi.fn(), all: vi.fn(), push: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api: { getProjectUpdates: mocks.project, checkAllUpdates: mocks.all } }));
vi.mock('vue-router', () => ({ useRoute: () => ({ name: 'settings' }), useRouter: () => ({ push: mocks.push }) }));
const updates = { hasUpdate: true, images: [{ hasUpdate: true }, { hasUpdate: false }, { hasUpdate: true }] };
describe('统一镜像更新入口', () => {
  beforeEach(() => vi.clearAllMocks());
  it('服务卡与全局检查显示同一升级数量，并保留来源进入确认流程', async () => {
    mocks.project.mockResolvedValue(updates);
    mocks.all.mockResolvedValue({ projects: [{ ...updates, projectId: 'p1', projectName: '项目一' }] });
    const card = mount(ImageUpdatePanel, { props: { project: { id: 'p1', managed: true }, compact: true } });
    const panel = mount(ImageUpdatePanel);
    await flushPromises();
    expect(card.text()).toContain('可升级 2 项');
    await card.get('button').trigger('click');
    expect(card.emitted('open')).toHaveLength(1);
    await panel.get('button').trigger('click'); await flushPromises();
    expect(panel.text()).toContain('有 2 项可升级');
    await panel.findAll('button')[1].trigger('click');
    expect(mocks.push).toHaveBeenCalledWith('/services?projectId=p1&upgrade=p1&from=settings');
    card.unmount(); panel.unmount();
  });
  it('切换项目后忽略旧检查结果', async () => {
    let finishOld;
    mocks.project.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValueOnce({ hasUpdate: false, images: [] });
    const panel = mount(ImageUpdatePanel, { props: { project: { id: 'p1', managed: true }, compact: true } });
    await panel.setProps({ project: { id: 'p2', managed: true } }); await flushPromises();
    finishOld(updates); await flushPromises();
    expect(panel.text()).not.toContain('可升级');
    panel.unmount();
  });
});
