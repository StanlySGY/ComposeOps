import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { computed } from 'vue';
import { groupProjects } from '../src/lib/project-groups.js';
import { resourceTotals, containerLimit, rankProjects } from '../src/lib/infrastructure.js';
import { useResourceTree } from '../src/composables/useResourceTree.js';
import ResourceHierarchy from '../src/components/dashboard/ResourceHierarchy.vue';
import ProjectGroupPicker from '../src/components/services/ProjectGroupPicker.vue';
import ProjectGroupsModal from '../src/components/services/ProjectGroupsModal.vue';
const { api } = vi.hoisted(() => ({ api: { getProjectGroups: vi.fn(), createProjectGroup: vi.fn(), updateProjectGroup: vi.fn(), deleteProjectGroup: vi.fn(), assignProjectGroups: vi.fn() } }));
vi.mock('../src/api/client.js', () => ({ api }));
let wrapper;
beforeEach(() => { setActivePinia(createPinia()); localStorage.clear(); vi.clearAllMocks(); api.getProjectGroups.mockResolvedValue({ groups: [{ id: 'mine', name: '我的业务', pinned: false }] }); });
afterEach(() => wrapper?.unmount());
async function router() { const r = createRouter({ history: createMemoryHistory(), routes: [{ path: '/services', component: { template: '<div />' } }] }); await r.push('/services'); return r; }

it('多层资源小计缺项时保持未知，搜索分组可命中，不累加容器与服务两遍', () => {
  const services = [{ projectId: 'a', projectName: 'a', name: 'web', groupId: 'mine', groupName: '我的业务', memUsage: 10, cpuHostPercent: 0, containers: [{ memUsage: 10 }] }, { projectId: 'b', projectName: 'b', name: 'db', groupId: 'mine', groupName: '我的业务', memUsage: 20, cpuHostPercent: null, containers: [{ memUsage: 20 }] }];
  const projects = rankProjects(services, 'memory', '我的业务');
  expect(projects).toHaveLength(2);
  expect(resourceTotals(projects).memUsage).toBe(30);
  expect(resourceTotals(projects).cpuHostPercent).toBe(null);
  expect(groupProjects(projects)[0].projects).toHaveLength(2);
  expect(containerLimit({ detailsReady: false }, 'memory')).toBe('限额待确认');
  expect(containerLimit({ detailsReady: true, configuredMemory: null }, 'memory')).toBe('未设置内存限额');
});

it('搜索临时展开祖先，清空搜索恢复折叠且不隐藏异常数量', async () => {
  const r = await router();
  const service = { name: 'web', key: 'service:p:web', cpuHostPercent: 0, containers: [{ id: 'c', name: 'web-1', health: 'unhealthy', state: 'running', detailsReady: false }], running: 1, total: 1 };
  const props = { projects: [{ id: 'p', name: 'app', groupId: 'mine', groupName: '我的业务', services: [service] }], expanded: new Set(), collapsedGroups: new Set(['mine']), searching: false, focusLink: () => '/services', logLink: () => '/services' };
  wrapper = mount(ResourceHierarchy, { props, global: { plugins: [r] } });
  expect(wrapper.text()).toContain('1 服务需关注'); expect(wrapper.find('.cockpit-service-name').exists()).toBe(false);
  await wrapper.setProps({ searching: true }); expect(wrapper.get('.cockpit-service-name').text()).toBe('web');
  expect(wrapper.text()).toContain('限额待确认');
  await wrapper.setProps({ searching: false }); expect(wrapper.find('.cockpit-service-name').exists()).toBe(false);
  expect(wrapper.emitted('toggle-group')).toBeUndefined();
});

it('每个节点保存独立展开状态，离开返回不覆盖另一个节点', async () => {
  let tree;
  wrapper = mount({ props: ['host'], setup(props) { tree = useResourceTree(computed(() => props.host), 'test'); return {}; }, template: '<div />' }, { props: { host: 'a' } });
  tree.toggleProject('p-a'); tree.toggleGroup('mine');
  await wrapper.setProps({ host: 'b' }); expect(tree.expanded.value.size).toBe(0); tree.toggleProject('p-b');
  await wrapper.setProps({ host: 'a' }); expect([...tree.expanded.value]).toEqual(['p-a']); expect(tree.collapsedGroups.value.has('mine')).toBe(true);
});

it('就地新建组提交期间禁用重复操作，失败保留名字和原分组', async () => {
  let reject;
  api.createProjectGroup.mockReturnValue(new Promise((_, no) => { reject = no; }));
  wrapper = mount(ProjectGroupPicker, { props: { modelValue: 'mine', suggestion: '研发' } });
  await wrapper.get('select').setValue('__new'); expect(wrapper.get('input').element.value).toBe('研发');
  await wrapper.findAll('button')[0].trigger('click'); expect(wrapper.findAll('button')[0].attributes('disabled')).toBeDefined();
  reject(new Error('保存失败')); await flushPromises(); expect(wrapper.text()).toContain('保存失败'); expect(wrapper.get('input').element.value).toBe('研发'); expect(wrapper.emitted('update:modelValue')).toBeUndefined();
});

it('批量归组携带捕获的节点 ID，修改失败不能宣布成功', async () => {
  const r = await router(); api.assignProjectGroups.mockRejectedValue(new Error('节点已切换'));
  wrapper = mount(ProjectGroupsModal, { props: { show: false, hostId: 'local', projects: [{ id: 'p', projectName: 'app', managed: true }], selectedIds: ['p'] }, global: { plugins: [r], stubs: { BaseModal: { template: '<div><slot /></div>' } } } });
  await wrapper.setProps({ show: true }); await flushPromises();
  await wrapper.get('select').setValue('mine');
  await wrapper.findAll('button').find(b => b.text().includes('将 1')).trigger('click'); await flushPromises();
  expect(api.assignProjectGroups).toHaveBeenCalledWith('local', [{ projectId: 'p', groupId: 'mine' }]);
  expect(wrapper.text()).toContain('节点已切换'); expect(wrapper.emitted('close')).toBeUndefined();
});
