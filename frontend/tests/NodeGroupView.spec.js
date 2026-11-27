import { createPinia } from 'pinia';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['getHosts', 'pingHost', 'getInspectionOverview', 'setHostGroup', 'runInspection'].map(k => [k, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api }));
import NodeGroupView from '../src/views/NodeGroupView.vue';
let wrapper; let router;
beforeEach(() => {
  vi.resetAllMocks();
  api.getHosts.mockResolvedValue({ hosts: [{ id: 'local', name: '本机', type: 'local', active: true, status: 'online', group: 'production' }] });
  api.pingHost.mockResolvedValue({ ok: true, host: { id: 'local', status: 'online', containerCount: null, runningCount: null } });
  api.getInspectionOverview.mockResolvedValue({ latest: { score: 82 } });
});
afterEach(() => wrapper?.unmount());
async function start() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/node-groups', component: NodeGroupView }] });
  await router.push('/node-groups');
  wrapper = mount(NodeGroupView, { global: { plugins: [router, createPinia()], stubs: { ImageUpdatePanel: true } } });
  await flushPromises();
}
it('未知容器数显示等待，空分组不占位，巡检不冒充节点专属报告', async () => {
  await start();
  expect(wrapper.findAll('.node-group')).toHaveLength(1);
  expect(wrapper.get('.node-card-stats').text()).toContain('—');
  expect(wrapper.text()).toContain('全局最近报告');
  expect(wrapper.text()).not.toContain('0 / 0');
  expect(wrapper.get('a[href*="/monitor?hostId=local"]').attributes('href')).toContain('from=node-groups');
});
it('筛选写入 URL，分组保存失败恢复原值', async () => {
  await start();
  await wrapper.get('input[type=search]').setValue('不存在'); await flushPromises();
  expect(router.currentRoute.value.query.q).toBe('不存在');
  expect(wrapper.text()).toContain('没有匹配的节点');
  await router.replace('/node-groups'); await flushPromises();
  api.setHostGroup.mockRejectedValue(new Error('未保存'));
  const select = wrapper.get('.node-card-footer select');
  await select.setValue('edge'); await flushPromises();
  expect(select.element.value).toBe('production');
  expect(wrapper.get('.node-group-heading').text()).toContain('生产组');
});
it('部分巡检仍是已有报告，运行时固定节点并读取实际报告响应', async () => {
  api.getInspectionOverview.mockResolvedValue({ latest: { score: null, grade: 'incomplete', hostName: '远端公司节点' } });
  api.runInspection.mockResolvedValue({ report: { score: 82, grade: 'attention', hostName: '本机' } });
  await start();
  expect(wrapper.text()).toContain('全局最近报告 · 远端公司节点 · 信息不完整');
  expect(wrapper.text()).not.toContain('尚无巡检报告');
  await wrapper.findAll('button').find(button => button.text().includes('运行巡检')).trigger('click');
  await flushPromises();
  expect(api.runInspection).toHaveBeenCalledWith('local');
  expect(wrapper.text()).toContain('全局最近报告 · 本机');
  expect(wrapper.text()).toContain('82');
});
