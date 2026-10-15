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
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

async function start() {
  wrapper = mount(MarketplaceView, { attachTo: document.body, global: { stubs: { ConfirmDialog: true, EmptyState: { template: '<div><slot /></div>', props: ['title', 'description', 'icon'] } } } });
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
    wrapper = mount(MarketplaceView, { attachTo: document.body, global: { stubs: { ConfirmDialog: true, EmptyState: { template: '<div><slot /></div>', props: ['title', 'description', 'icon'] } } } });
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

    wrapper = mount(MarketplaceView, { attachTo: document.body, global: { stubs: { ConfirmDialog: true, EmptyState: { template: '<div><slot /></div>', props: ['title', 'description', 'icon'] } } } });
    await vi.waitFor(() => expect(mocks.api.searchMarketplaceTemplates).toHaveBeenCalledTimes(1));
    await wrapper.get('select[aria-label="筛选模板来源"]').setValue('custom');
    await flushPromises();
    expect(wrapper.text()).toContain('latest template');

    resolveInitial({ results: [{ ...deployable, name: 'stale template' }] });
    await flushPromises();

    expect(wrapper.text()).toContain('latest template');
    expect(wrapper.text()).not.toContain('stale template');
  });

  it('创建与 AI 弹窗提供对话框语义、可见标签、初始焦点、焦点循环和 Escape 关闭', async () => {
    await start();
    const createTrigger = wrapper.findAll('button').find(button => button.text().includes('创建模板'));
    createTrigger.element.focus();
    await createTrigger.trigger('click');
    await flushPromises();

    const createDialog = wrapper.get('[role="dialog"][aria-labelledby="market-create-dialog-title"]');
    expect(createDialog.attributes('aria-modal')).toBe('true');
    expect(createDialog.get('h2').text()).toBe('创建模板');
    await vi.waitFor(() => expect(document.activeElement).toBe(createDialog.get('button[aria-label="关闭创建或编辑模板弹窗"]').element));

    for (const [id, label] of [
      ['market-template-name', '模板名称'],
      ['market-template-category', '分类'],
      ['market-template-description', '描述'],
      ['market-template-compose', 'Compose 内容'],
    ]) {
      expect(wrapper.get(`label[for="${id}"]`).text()).toContain(label);
      expect(wrapper.get(`#${id}`).exists()).toBe(true);
    }

    const focusables = [...createDialog.element.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    await last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.focus();
    await first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(last);

    await first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(createTrigger.element));

    const aiTrigger = wrapper.findAll('button').find(button => button.text().includes('AI 找应用'));
    aiTrigger.element.focus();
    await aiTrigger.trigger('click');
    await flushPromises();
    const aiDialog = wrapper.get('[role="dialog"][aria-labelledby="market-ai-dialog-title"]');
    expect(aiDialog.attributes('aria-modal')).toBe('true');
    expect(aiDialog.get('h2').text()).toBe('AI 找应用');
    await vi.waitFor(() => expect(document.activeElement).toBe(aiDialog.get('button[aria-label="关闭 AI 找应用弹窗"]').element));
    expect(wrapper.get('label[for="market-ai-query"]').text()).toBe('应用名称');
    expect(wrapper.get('#market-ai-query').exists()).toBe(true);
    await aiDialog.get('button[aria-label="关闭 AI 找应用弹窗"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(aiTrigger.element));
  });

  it('模板详情与部署弹窗可被读屏器识别并可用 Escape 关闭', async () => {
    mocks.api.searchMarketplaceTemplates.mockResolvedValue({ results: [deployable] });
    await start();

    const viewTrigger = wrapper.get('.btn-view');
    viewTrigger.element.focus();
    await viewTrigger.trigger('click');
    await flushPromises();
    const viewDialog = wrapper.get('[role="dialog"][aria-labelledby="market-view-dialog-title"]');
    expect(viewDialog.attributes('aria-modal')).toBe('true');
    expect(viewDialog.get('h2').text()).toBe('nginx');
    await vi.waitFor(() => expect(document.activeElement).toBe(viewDialog.get('button[aria-label="关闭模板详情"]').element));
    await viewDialog.get('button[aria-label="关闭模板详情"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(viewTrigger.element));

    const deployTrigger = wrapper.get('.btn-deploy');
    deployTrigger.element.focus();
    await deployTrigger.trigger('click');
    await flushPromises();
    const deployDialog = wrapper.get('[role="dialog"][aria-labelledby="market-deploy-dialog-title"]');
    expect(deployDialog.attributes('aria-modal')).toBe('true');
    expect(deployDialog.get('h2').text()).toContain('部署应用: nginx');
    await vi.waitFor(() => expect(document.activeElement).toBe(deployDialog.get('button[aria-label="关闭部署弹窗"]').element));
    expect(wrapper.get('label[for="market-deploy-project-name"]').text()).toBe('项目名称');
    expect(wrapper.get('#market-deploy-project-name').exists()).toBe(true);
    expect(wrapper.get('label[for="market-deploy-variable-PORT"]').text()).toBe('HTTP 端口');
    expect(wrapper.get('#market-deploy-variable-PORT').exists()).toBe(true);
    await deployDialog.get('button[aria-label="关闭部署弹窗"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(deployTrigger.element));
  });
});
