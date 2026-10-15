import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import MarketplaceView from '../src/views/MarketplaceView.vue';

const mocks = vi.hoisted(() => ({
  api: {
    getMarketplaceStats: vi.fn(),
    searchMarketplaceTemplates: vi.fn(),
    toggleMarketplaceFavorite: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  openAgent: vi.fn(),
  updateAgentContext: vi.fn(),
}));
vi.mock('../src/api/client.js', () => ({ api: mocks.api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => mocks.toast }));
vi.mock('../src/composables/useAgentConsole.js', () => ({ useAgentConsole: () => ({ openAgent: mocks.openAgent, updateAgentContext: mocks.updateAgentContext }) }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));

let wrapper;
const stats = { totalBuiltin: 1, totalCommunity: 0, totalCustom: 0, totalFavorites: 0, categories: ['Web'], communityAvailable: false, communityMessage: '' };
const deployable = { id: 'builtin-nginx', name: 'nginx', category: 'Web', description: 'Web server', defaultCompose: 'services: {}', envSchema: [{ key: 'PORT', label: 'HTTP 端口', type: 'text', default: '8080' }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.getMarketplaceStats.mockResolvedValue({ ...stats });
  mocks.api.searchMarketplaceTemplates.mockResolvedValue({ results: [] });
  mocks.api.toggleMarketplaceFavorite.mockResolvedValue(undefined);
});
afterEach(() => { wrapper?.unmount(); wrapper = null; });

async function start() {
  wrapper = mount(MarketplaceView, { global: { stubs: { ConfirmDialog: true, EmptyState: { template: '<div><slot /></div>', props: ['title', 'description', 'icon'] } } } });
  await flushPromises();
}

describe('应用市场表单可访问性', () => {
  it('搜索和筛选控件都有明确的可访问名称', async () => {
    await start();
    expect(wrapper.get('input[aria-label="搜索应用模板"]').exists()).toBe(true);
    expect(wrapper.get('select[aria-label="筛选模板来源"]').exists()).toBe(true);
    expect(wrapper.get('select[aria-label="筛选模板分类"]').exists()).toBe(true);
    expect(wrapper.get('input[type="checkbox"]').element.closest('label').textContent).toContain('仅收藏');
  });

  it('统计接口失败时说明数据不可用，并提供可访问的重试入口', async () => {
    mocks.api.getMarketplaceStats.mockRejectedValueOnce(new Error('stats service offline'));
    wrapper = mount(MarketplaceView, { global: { stubs: { ConfirmDialog: true, EmptyState: { template: '<div><slot /></div>', props: ['title', 'description', 'icon'] } } } });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('应用市场统计加载失败');
    expect(wrapper.get('[role="alert"]').text()).toContain('stats service offline');
    expect(wrapper.find('.stats-grid').exists()).toBe(false);
    await wrapper.get('[role="alert"] button').trigger('click');
    await flushPromises();

    expect(mocks.api.getMarketplaceStats).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('.stats-grid').exists()).toBe(true);
  });

  it('统计刷新失败时保留上次成功数据并明确提示可能过期', async () => {
    mocks.api.searchMarketplaceTemplates.mockResolvedValue({ results: [{ ...deployable, favorited: false }] });
    await start();
    mocks.api.getMarketplaceStats.mockRejectedValueOnce(new Error('temporary stats failure'));

    await wrapper.get('button.favorite-btn').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('temporary stats failure');
    expect(wrapper.get('[role="alert"]').text()).toContain('上次成功读取的数据');
    expect(wrapper.find('.stats-grid').exists()).toBe(true);
  });

  it('收藏按钮公布模板名称和当前按下状态', async () => {
    mocks.api.searchMarketplaceTemplates.mockResolvedValue({ results: [{ ...deployable, favorited: false }] });
    await start();

    const favorite = wrapper.get('button.favorite-btn');
    expect(favorite.attributes('aria-label')).toBe('收藏：nginx');
    expect(favorite.attributes('aria-pressed')).toBe('false');
  });

  it('模板列表加载失败通过 alert 播报并可重试', async () => {
    mocks.api.searchMarketplaceTemplates.mockRejectedValueOnce(new Error('template service offline'));
    await start();

    expect(wrapper.get('[role="alert"]').text()).toContain('template service offline');
    await wrapper.get('[role="alert"] button').trigger('click');
    await flushPromises();
    expect(mocks.api.searchMarketplaceTemplates).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('筛选请求并发返回时旧结果不能覆盖最新模板列表', async () => {
    let resolveInitial;
    mocks.api.searchMarketplaceTemplates
      .mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({ results: [{ ...deployable, name: 'latest template' }] });

    wrapper = mount(MarketplaceView, { global: { stubs: { ConfirmDialog: true, EmptyState: { template: '<div><slot /></div>', props: ['title', 'description', 'icon'] } } } });
    await vi.waitFor(() => expect(mocks.api.searchMarketplaceTemplates).toHaveBeenCalledTimes(1));
    await wrapper.get('select[aria-label="筛选模板来源"]').setValue('custom');
    await flushPromises();
    expect(wrapper.text()).toContain('latest template');

    resolveInitial({ results: [{ ...deployable, name: 'stale template' }] });
    await flushPromises();

    expect(wrapper.text()).toContain('latest template');
    expect(wrapper.text()).not.toContain('stale template');
  });

  it('创建模板和 AI 找应用弹窗中的可见标签与控件正确关联', async () => {
    await start();
    await wrapper.findAll('button').find(button => button.text().includes('创建模板')).trigger('click');
    for (const [id, label] of [
      ['market-template-name', '模板名称'],
      ['market-template-category', '分类'],
      ['market-template-description', '描述'],
      ['market-template-compose', 'Compose 内容'],
    ]) {
      expect(wrapper.get(`label[for="${id}"]`).text()).toContain(label);
      expect(wrapper.get(`#${id}`).exists()).toBe(true);
    }

    await wrapper.findAll('button').find(button => button.text().includes('取消')).trigger('click');
    await wrapper.findAll('button').find(button => button.text().includes('AI 找应用')).trigger('click');
    expect(wrapper.get('label[for="market-ai-query"]').text()).toBe('应用名称');
    expect(wrapper.get('#market-ai-query').exists()).toBe(true);
  });

  it('部署弹窗中的项目名称和动态环境变量标签正确关联', async () => {
    mocks.api.searchMarketplaceTemplates.mockResolvedValueOnce({ results: [deployable] });
    await start();
    await wrapper.get('.btn-deploy').trigger('click');
    expect(wrapper.get('label[for="market-deploy-project-name"]').text()).toBe('项目名称');
    expect(wrapper.get('#market-deploy-project-name').exists()).toBe(true);
    expect(wrapper.get('label[for="market-deploy-variable-PORT"]').text()).toBe('HTTP 端口');
    expect(wrapper.get('#market-deploy-variable-PORT').exists()).toBe(true);
  });
});
