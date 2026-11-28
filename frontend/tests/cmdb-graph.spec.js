import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
const { api, services } = vi.hoisted(() => ({
  api: { getCmdbTopology: vi.fn(), getHosts: vi.fn(), getAlertEvents: vi.fn(), getInspectionOverview: vi.fn() },
  services: { projects: [], refresh: vi.fn() },
}));
vi.mock('../src/api/client.js', () => ({ api }));
vi.mock('../src/stores/services.js', () => ({ useServicesStore: () => services }));
import KnowledgeGraphView from '../src/views/KnowledgeGraphView.vue';
import { useCmdbStore } from '../src/stores/cmdb.js';
import { advanceAuthEpoch } from '../src/lib/auth-context.js';
const fixtures = () => ({
  assets: [
    { id: 'host:local', kind: 'host', name: 'local', displayName: '本机节点', hostId: 'local' },
    { id: 'host:remote', kind: 'host', name: 'remote', displayName: '远端节点', hostId: 'remote' },
    { id: 'project:local-app', kind: 'project', name: 'local-app', displayName: '本机项目', hostId: 'local', status: 'stopped' },
    { id: 'project:remote-app', kind: 'project', name: 'remote-app', displayName: '远端项目', hostId: 'remote', status: 'running' },
    { id: 'container:local-c', kind: 'container', name: 'local-c', displayName: '本机容器', hostId: 'local', status: 'stopped' },
    { id: 'container:remote-c', kind: 'container', name: 'remote-c', displayName: '远端容器', hostId: 'remote', status: 'running' },
    { id: 'volume:local:data', kind: 'volume', name: 'data', hostId: 'local' },
    { id: 'volume:remote:data', kind: 'volume', name: 'data', hostId: 'remote' },
  ],
  relations: [
    { sourceId: 'project:local-app', targetId: 'host:local', relation: 'runs_on' },
    { sourceId: 'project:remote-app', targetId: 'host:remote', relation: 'runs_on' },
    { sourceId: 'container:local-c', targetId: 'project:local-app', relation: 'runs_on' },
    { sourceId: 'container:remote-c', targetId: 'project:remote-app', relation: 'runs_on' },
    { sourceId: 'container:local-c', targetId: 'volume:local:data', relation: 'mounts' },
    { sourceId: 'container:remote-c', targetId: 'volume:remote:data', relation: 'mounts' },
  ],
});
let pinia, wrapper;
const graph = () => wrapper.findComponent({ name: 'ForceGraph' });
const button = text => wrapper.findAll('button').find(b => b.text().includes(text));
async function render() {
  wrapper = mount(KnowledgeGraphView, { props: { embedded: true }, global: { plugins: [pinia], stubs: {
    ForceGraph: { name: 'ForceGraph', props: ['nodes', 'edges', 'showHealthSummary'], template: '<div data-graph></div>' },
    RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  } } });
  await flushPromises(); return wrapper;
}
beforeEach(() => {
  pinia = createPinia(); setActivePinia(pinia); services.refresh.mockResolvedValue(undefined);
  for (const method of Object.values(api)) method.mockReset();
  api.getCmdbTopology.mockResolvedValue(fixtures());
});
afterEach(() => { wrapper?.unmount(); disposePinia(pinia); });

describe('CMDB 多节点图谱的事实归属', () => {
  it('远端项目连接自己的宿主，不能统一连接本机', async () => {
    await render(); const { nodes, edges } = graph().props();
    const project = nodes.find(n => n.fullLabel === '远端项目'), host = nodes.find(n => n.fullLabel === '远端节点');
    expect(edges).toContainEqual(expect.objectContaining({ source: host.key, target: project.key }));
    expect(edges.some(e => e.target === project.key && e.source !== host.key)).toBe(false);
  });
  it('同名卷保留两个独立实体与各自挂载路径', async () => {
    await render(); const { nodes, edges } = graph().props();
    expect(nodes.filter(n => n.state === 'volume')).toHaveLength(2);
    expect(new Set(nodes.map(n => n.key)).size).toBe(nodes.length);
    const volumes = name => { const key = nodes.find(n => n.fullLabel === name).key; return edges.filter(e => e.source === key).map(e => e.target); };
    expect(volumes('本机项目')).toHaveLength(1); expect(volumes('远端项目')).toHaveLength(1);
    expect(volumes('本机项目')[0]).not.toBe(volumes('远端项目')[0]);
  });
  it('资产实际 ID 与 name 不同仍能恢复容器关系，不按名称猜 ID', async () => {
    const data = fixtures(); data.assets.find(a => a.id === 'project:local-app').id = 'custom-project-id';
    data.relations = data.relations.map(r => ({ ...r, sourceId: r.sourceId === 'project:local-app' ? 'custom-project-id' : r.sourceId, targetId: r.targetId === 'project:local-app' ? 'custom-project-id' : r.targetId }));
    api.getCmdbTopology.mockResolvedValue(data); await render();
    expect(graph().props('nodes').find(n => n.fullLabel === '本机项目').sub).toContain('1');
  });
  it('嵌入资产中心仍提供血缘树切换，并按宿主分组项目', async () => {
    await render(); expect(button('资产血缘树')).toBeTruthy(); await button('资产血缘树').trigger('click');
    const host = wrapper.find('[aria-label="节点 远端节点"]');
    expect(host.exists()).toBe(true); expect(host.text()).toContain('远端项目'); expect(host.text()).not.toContain('本机项目');
    expect(host.text()).toContain('1 个项目');
    expect(wrapper.find('[aria-label="节点 本机节点"]').text()).toContain('已停止');
  });
  it('没有读取的实时告警与巡检不能伪装成零告警和零巡检', async () => {
    await render(); expect(graph().props('showHealthSummary')).toBe(false); expect(wrapper.text()).not.toContain('暂无活动告警');
    expect(wrapper.text()).not.toContain('智能巡检'); expect(wrapper.text()).toContain('台账快照');
  });
  it('读取失败显示重试，不显示空项目成功态', async () => {
    api.getCmdbTopology.mockRejectedValue(new Error('合成台账读取失败')); await render();
    expect(wrapper.find('[role="alert"]').text()).toContain('合成台账读取失败');
    expect(wrapper.text()).not.toContain('暂无项目数据');
  });
  it('共享快照变化时节点名称同步更新，不保留加载时复制的旧主机', async () => {
    await render(); useCmdbStore().assets.find(a => a.id === 'host:remote').displayName = '远端改名'; await flushPromises();
    expect(graph().props('nodes').some(n => n.fullLabel === '远端改名')).toBe(true);
  });
  it('身份变化后不残留复制到视图的旧节点名字', async () => {
    await render(); advanceAuthEpoch(); await flushPromises(); expect(wrapper.text()).not.toContain('远端节点');
  });
  it('只剩主机或孤立卷时仍可显示图谱，不假装没有资产', async () => {
    api.getCmdbTopology.mockResolvedValue({ assets: fixtures().assets.filter(a => ['host', 'volume'].includes(a.kind)), relations: [] });
    await render(); expect(graph().exists()).toBe(true); expect(graph().props('nodes')).toHaveLength(4);
  });
});
