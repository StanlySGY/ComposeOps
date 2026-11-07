import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, DOMWrapper } from '@vue/test-utils';
import MarketplaceView from '../src/views/MarketplaceView.vue';

const mocks = vi.hoisted(() => ({
  api: {
    getMarketplaceStats: vi.fn(),
    searchMarketplaceTemplates: vi.fn(),
    toggleMarketplaceFavorite: vi.fn(),
    createMarketplaceTemplate: vi.fn(),
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
const stats = { totalBuiltin: 1, totalCommunity: 0, totalCustom: 0, totalFavorites: 0, categories: ['Network'], communityAvailable: false, communityMessage: '' };
const deployable = { id: 'builtin-nginx', name: 'nginx', category: 'Network', description: 'Web server', defaultCompose: 'services: {}', envSchema: [{ key: 'PORT', label: 'HTTP 端口', type: 'text', default: '8080' }] };

vi.mock('vue-router', () => ({ useRoute: () => ({ fullPath: '/marketplace' }) }));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
  vi.clearAllMocks();
  mocks.api.getMarketplaceStats.mockResolvedValue({ ...stats });
  mocks.api.searchMarketplaceTemplates.mockResolvedValue({ results: [] });
  mocks.api.toggleMarketplaceFavorite.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

async function start() {
  wrapper = mount(MarketplaceView, { attachTo: document.body, global: { stubs: { ConfirmDialog: true, EmptyState: { template: '<div><slot /></div>', props: ['title', 'description', 'icon'] } } } });
  await flushPromises();
}

describe('应用市场表单可访问性', () => {
  it('搜索和筛选控件都有明确的可访问名称', async () => {
    await start();
    expect(wrapper.get('input[aria-label="搜索应用模板"]').exists()).toBe(true);
    expect(wrapper.get('[role="group"][aria-label="筛选模板来源"]').exists()).toBe(true);
    expect(wrapper.get('select[aria-label="筛选模板分类"]').exists()).toBe(true);
    expect(wrapper.get('option[value="Network"]').text()).toBe('网络与代理');
    expect(wrapper.get('.favorites-filter').attributes('aria-pressed')).toBe('false');
  });

  it('统计接口失败时说明数据不可用，并提供可访问的重试入口', async () => {
    mocks.api.getMarketplaceStats.mockRejectedValueOnce(new Error('stats service offline'));
    wrapper = mount(MarketplaceView, { attachTo: document.body, global: { stubs: { ConfirmDialog: true, EmptyState: { template: '<div><slot /></div>', props: ['title', 'description', 'icon'] } } } });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('应用市场统计加载失败');
    expect(wrapper.get('[role="alert"]').text()).toContain('stats service offline');
    expect(wrapper.find('.scope-chip span').exists()).toBe(false);
    await wrapper.get('[role="alert"] button').trigger('click');
    await flushPromises();

    expect(mocks.api.getMarketplaceStats).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('.scope-chip span').exists()).toBe(true);
  });

  it('统计刷新失败时保留上次成功数据并明确提示可能过期', async () => {
    mocks.api.searchMarketplaceTemplates.mockResolvedValue({ results: [{ ...deployable, favorited: false }] });
    await start();
    mocks.api.getMarketplaceStats.mockRejectedValueOnce(new Error('temporary stats failure'));

    await wrapper.get('button.favorite-btn').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('temporary stats failure');
    expect(wrapper.get('[role="alert"]').text()).toContain('上次成功读取的数据');
    expect(wrapper.find('.scope-chip span').exists()).toBe(true);
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
    await wrapper.findAll('.source-filters button').find(button => button.text().includes('自定义模板')).trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('latest template');

    resolveInitial({ results: [{ ...deployable, name: 'stale template' }] });
    await flushPromises();

    expect(wrapper.text()).toContain('latest template');
    expect(wrapper.text()).not.toContain('stale template');
  });

  it('输入后的等待窗口隔离旧结果，清空搜索取消尚未发送的请求', async () => {
    let resolveOld;
    mocks.api.searchMarketplaceTemplates.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await start();
    await wrapper.get('[aria-label="搜索应用模板"]').setValue('redis');
    resolveOld({ results: [{ ...deployable, name: '过期模板' }] });
    await flushPromises();
    expect(wrapper.text()).not.toContain('过期模板');
    await wrapper.get('[aria-label="清空模板搜索"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[aria-label="搜索应用模板"]').element.value).toBe('');
    expect(mocks.api.searchMarketplaceTemplates).toHaveBeenCalledTimes(2);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(mocks.api.searchMarketplaceTemplates).toHaveBeenCalledTimes(2);
  });

  it('创建与 AI 弹窗提供对话框语义、可见标签、初始焦点、焦点循环和 Escape 关闭', async () => {
    await start();
    const createTrigger = wrapper.findAll('button').find(button => button.text().includes('创建模板'));
    createTrigger.element.focus();
    await createTrigger.trigger('click');
    await flushPromises();

    const createDialog = new DOMWrapper(document.querySelector('[role="dialog"][aria-label="创建模板"]'));
    expect(createDialog.attributes('aria-modal')).toBe('true');
    expect(createDialog.get('.modal-header').text()).toContain('创建模板');
    await vi.waitFor(() => expect(document.activeElement).toBe(createDialog.get('button[aria-label="关闭"]').element));

    for (const [id, label] of [
      ['market-template-name', '模板名称'],
      ['market-template-category', '分类'],
      ['market-template-description', '描述'],
      ['market-template-compose', 'Compose 内容'],
    ]) {
      expect(new DOMWrapper(document.querySelector(`label[for="${id}"]`)).text()).toContain(label);
      expect(document.getElementById(id)).not.toBeNull();
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
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(createTrigger.element));

    const aiTrigger = wrapper.findAll('button').find(button => button.text().includes('AI 找应用'));
    aiTrigger.element.focus();
    await aiTrigger.trigger('click');
    await flushPromises();
    const aiDialog = new DOMWrapper(document.querySelector('[role="dialog"][aria-label="AI 找应用"]'));
    expect(aiDialog.attributes('aria-modal')).toBe('true');
    expect(aiDialog.get('.modal-header').text()).toContain('AI 找应用');
    await vi.waitFor(() => expect(document.activeElement).toBe(aiDialog.get('button[aria-label="关闭"]').element));
    expect(aiDialog.get('label[for="market-ai-query"]').text()).toBe('应用名称');
    expect(aiDialog.get('#market-ai-query').exists()).toBe(true);
    await aiDialog.get('button[aria-label="关闭"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(aiTrigger.element));
  });

  it('模板详情与部署弹窗可被读屏器识别并可用 Escape 关闭', async () => {
    mocks.api.searchMarketplaceTemplates.mockResolvedValue({ results: [deployable] });
    await start();

    const viewTrigger = wrapper.get('.btn-view');
    viewTrigger.element.focus();
    await viewTrigger.trigger('click');
    await flushPromises();
    const viewDialog = new DOMWrapper(document.querySelector('[role="dialog"][aria-label="nginx"]'));
    expect(viewDialog.attributes('aria-modal')).toBe('true');
    expect(viewDialog.get('.modal-header').text()).toContain('nginx');
    await vi.waitFor(() => expect(document.activeElement).toBe(viewDialog.get('button[aria-label="关闭"]').element));
    await viewDialog.get('button[aria-label="关闭"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(viewTrigger.element));

    const deployTrigger = wrapper.get('.btn-deploy');
    deployTrigger.element.focus();
    await deployTrigger.trigger('click');
    await flushPromises();
    const deployDialog = new DOMWrapper(document.querySelector('[role="dialog"][aria-label="部署应用：nginx"]'));
    expect(deployDialog.attributes('aria-modal')).toBe('true');
    expect(deployDialog.get('.modal-header').text()).toContain('部署应用：nginx');
    await vi.waitFor(() => expect(document.activeElement).toBe(deployDialog.get('button[aria-label="关闭"]').element));
    expect(deployDialog.get('label[for="market-deploy-project-name"]').text()).toBe('项目名称');
    expect(deployDialog.get('#market-deploy-project-name').exists()).toBe(true);
    expect(deployDialog.get('label[for="market-deploy-variable-PORT"]').text()).toBe('HTTP 端口');
    expect(deployDialog.get('#market-deploy-variable-PORT').exists()).toBe(true);
    await deployDialog.get('button[aria-label="关闭"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(deployTrigger.element));
  });
});

describe('应用市场连续操作', () => {
  it('收藏请求未返回时禁用同一模板的重复点击', async () => {
    let resolve;
    mocks.api.searchMarketplaceTemplates.mockResolvedValue({ results: [{ ...deployable, favorited: false }] });
    mocks.api.toggleMarketplaceFavorite.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await start();
    const favorite = wrapper.get('.favorite-btn');
    await favorite.trigger('click');
    expect(favorite.element.disabled).toBe(true);
    await favorite.trigger('click');
    expect(mocks.api.toggleMarketplaceFavorite).toHaveBeenCalledTimes(1);
    resolve(); await flushPromises();
    expect(wrapper.get('.favorite-btn').element.disabled).toBe(false);
  });
  it('详情进入配置并返回时保留列表筛选，仅显示一个弹窗', async () => {
    mocks.api.searchMarketplaceTemplates.mockResolvedValue({ results: [deployable] });
    await start();
    await wrapper.get('[aria-label="搜索应用模板"]').setValue('nginx');
    await wrapper.get('.btn-view').trigger('click');
    await new DOMWrapper(document.querySelector('[role="dialog"]')).get('footer .btn-primary').trigger('click');
    await flushPromises();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(new DOMWrapper(document.querySelector('[role="dialog"]')).get('.btn-cancel').text()).toBe('返回详情');
    await new DOMWrapper(document.querySelector('[role="dialog"]')).get('.btn-cancel').trigger('click');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await flushPromises();
    expect(document.querySelector('[role="dialog"]').getAttribute('aria-label')).toBe('nginx');
    await new DOMWrapper(document.querySelector('[role="dialog"]')).get('footer .btn-secondary').trigger('click');
    expect(wrapper.get('[aria-label="搜索应用模板"]').element.value).toBe('nginx');
  });
  it('创建模板在保存完成前防止重复提交', async () => {
    let resolve;
    mocks.api.createMarketplaceTemplate.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await start();
    await wrapper.findAll('button').find(b => b.text().includes('创建模板')).trigger('click');
    await new DOMWrapper(document.querySelector('#market-template-name')).setValue('My app');
    await new DOMWrapper(document.querySelector('#market-template-compose')).setValue('services: {}');
    const save = new DOMWrapper(document.querySelector('.btn-save'));
    await save.trigger('click');
    expect(save.element.disabled).toBe(true);
    await save.trigger('click');
    expect(mocks.api.createMarketplaceTemplate).toHaveBeenCalledTimes(1);
    resolve({}); await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
