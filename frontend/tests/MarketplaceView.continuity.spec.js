import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import { h } from 'vue';
import MarketplaceView from '../src/views/MarketplaceView.vue';

const mocks = vi.hoisted(() => ({ api: {
  getMarketplaceStats: vi.fn(), searchMarketplaceTemplates: vi.fn(), toggleMarketplaceFavorite: vi.fn(),
  createMarketplaceTemplate: vi.fn(), updateMarketplaceTemplate: vi.fn(), deleteMarketplaceTemplate: vi.fn(), discoverAiTemplate: vi.fn(),
}, toast: { success: vi.fn(), error: vi.fn() }, copy: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api: mocks.api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => mocks.toast }));
vi.mock('../src/composables/useAgentConsole.js', () => ({ useAgentConsole: () => ({ openAgent: vi.fn(), updateAgentContext: vi.fn() }) }));
vi.mock('../src/composables/usePullRefresh.js', () => ({ usePullRefresh: vi.fn() }));
vi.mock('../src/lib/clipboard.js', () => ({ copyText: mocks.copy }));
const compose = 'services:\n  app:\n    image: nginx:stable\n';
const envSchema = [{ key: 'APP_PASSWORD', label: '应用密码', type: 'password', secret: true, default: '' }];
const templates = [
  { id: 'custom-a', name: '缓存 A', category: 'Database', defaultCompose: compose, envSchema },
  { id: 'custom-b', name: '网站 B', category: 'Web', defaultCompose: compose, envSchema: [] },
];
let wrapper, router;
const body = () => new DOMWrapper(document.body);
const dialog = () => new DOMWrapper(document.querySelector('[role="dialog"]'));
const button = (text, root = body()) => root.findAll('button').find(item => item.text().trim() === text);
const card = name => wrapper.findAll('.template-card').find(item => item.text().includes(name));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; }
async function start(path = '/marketplace') {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/marketplace', name: 'marketplace', component: MarketplaceView }, { path: '/dashboard', name: 'dashboard', component: { render: () => h('h1', '总览') } }] });
  await router.push(path); await router.isReady();
  wrapper = mount({ template: '<RouterView v-slot="{ Component }"><KeepAlive><component :is="Component" /></KeepAlive></RouterView>' }, { attachTo: document.body, global: { plugins: [router], stubs: { SceneIllustration: true, BlueprintDeployModal: true } } });
  await flushPromises();
}
async function create() { await wrapper.get('.page-actions-market .btn-primary').trigger('click'); await flushPromises(); }
async function fillNew(name = '新草稿') { await dialog().get('#market-template-name').setValue(name); await dialog().get('#market-template-compose').setValue(compose); }
async function openAI() { await button('AI 找应用').trigger('click'); await flushPromises(); }
async function discover(query = 'umami') { await dialog().get('#market-ai-query').setValue(query); await button('生成模板', dialog()).trigger('click'); await flushPromises(); }
beforeEach(() => {
  vi.resetAllMocks();
  mocks.api.getMarketplaceStats.mockResolvedValue({ totalBuiltin: 0, totalCustom: 2, totalFavorites: 0, categories: ['Database', 'Web'], communityAvailable: false });
  mocks.api.searchMarketplaceTemplates.mockResolvedValue({ results: structuredClone(templates) });
  mocks.api.createMarketplaceTemplate.mockResolvedValue({ id: 'custom-new', name: '新草稿' });
  mocks.api.updateMarketplaceTemplate.mockResolvedValue({}); mocks.api.deleteMarketplaceTemplate.mockResolvedValue({});
  mocks.api.discoverAiTemplate.mockResolvedValue({ template: { name: 'Umami', category: 'Web', defaultCompose: compose, envSchema } });
  mocks.copy.mockResolvedValue();
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
});
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('市场工作区连续性', () => {
  it('关闭创建表单保留会话草稿，浏览器存储不写入配置', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    await start(); await create(); await fillNew();
    await button('取消', dialog()).trigger('click'); await create();
    expect(dialog().get('#market-template-name').element.value).toBe('新草稿');
    expect(dialog().get('#market-template-compose').element.value).toBe(compose);
    expect(storage).not.toHaveBeenCalled();
  });
  it('不同自定义模板各自恢复草稿，不混用编辑内容', async () => {
    await start(); await card('缓存 A').get('.btn-edit').trigger('click');
    await dialog().get('#market-template-name').setValue('缓存 A 的修改'); await button('取消', dialog()).trigger('click');
    await card('网站 B').get('.btn-edit').trigger('click'); expect(dialog().get('#market-template-name').element.value).toBe('网站 B');
    await dialog().get('#market-template-name').setValue('网站 B 的修改'); await button('取消', dialog()).trigger('click');
    await card('缓存 A').get('.btn-edit').trigger('click'); expect(dialog().get('#market-template-name').element.value).toBe('缓存 A 的修改');
  });
  it('保存失败原位保留草稿与错误，重试携带原有变量元数据', async () => {
    mocks.api.updateMarketplaceTemplate.mockRejectedValueOnce(new Error('保存服务不可用')).mockResolvedValueOnce({ id: 'custom-a' });
    await start(); await card('缓存 A').get('.btn-edit').trigger('click'); await button('保存', dialog()).trigger('click'); await flushPromises();
    expect(dialog().text()).toContain('保存服务不可用'); expect(dialog().get('#market-template-name').element.value).toBe('缓存 A');
    await button('保存', dialog()).trigger('click'); await flushPromises();
    expect(mocks.api.updateMarketplaceTemplate).toHaveBeenLastCalledWith('custom-a', expect.objectContaining({ envSchema }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('保存中禁用字段与重复保存，离页释放弹层，失败后可恢复原草稿', async () => {
    const pending = deferred(); mocks.api.createMarketplaceTemplate.mockReturnValue(pending.promise);
    await start(); await create(); await fillNew('保留中的项目'); await button('保存', dialog()).trigger('click');
    expect(dialog().get('#market-template-name').element.disabled).toBe(true);
    await button('保存中…', dialog()).trigger('click'); expect(mocks.api.createMarketplaceTemplate).toHaveBeenCalledTimes(1);
    await router.push('/dashboard'); await flushPromises(); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.body.style.overflow).not.toBe('hidden');
    pending.reject(new Error('离页期间保存失败')); await flushPromises(); await router.push('/marketplace'); await flushPromises(); await create();
    expect(dialog().get('#market-template-name').element.value).toBe('保留中的项目'); expect(dialog().text()).toContain('离页期间保存失败');
  });
  it('服务端保存成功与后续列表读取失败分开反馈，不诱导重复提交', async () => {
    await start(); await create(); await fillNew(); mocks.api.searchMarketplaceTemplates.mockRejectedValue(new Error('列表读取失败'));
    await button('保存', dialog()).trigger('click'); await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(mocks.toast.success).toHaveBeenCalled();
    expect(wrapper.text()).toContain('列表读取失败'); expect(wrapper.text()).not.toContain('找到 0 个模板');
    await create(); expect(dialog().get('#market-template-name').element.value).toBe('');
  });
  it('AI 关闭取消等待，迟到结果不能覆盖再次打开的窗口', async () => {
    const pending = deferred(); mocks.api.discoverAiTemplate.mockReturnValue(pending.promise);
    await start(); await openAI(); await discover(); const signal = mocks.api.discoverAiTemplate.mock.calls[0][1];
    await button('取消', dialog()).trigger('click'); expect(signal?.aborted).toBe(true); await openAI();
    pending.resolve({ template: { name: '过期结果', defaultCompose: compose } }); await flushPromises();
    expect(dialog().text()).not.toContain('过期结果'); expect(button('生成模板', dialog()).element.disabled).toBe(false);
  });
  it('修改 AI 应用名立即废弃旧预览，中文输入法回车不触发请求', async () => {
    await start(); await openAI(); await discover(); expect(dialog().text()).toContain('Umami');
    await dialog().get('#market-ai-query').setValue('gitea'); expect(dialog().text()).not.toContain('Umami');
    await dialog().get('#market-ai-query').trigger('keydown', { key: 'Enter', isComposing: true }); await flushPromises();
    expect(mocks.api.discoverAiTemplate).toHaveBeenCalledTimes(1);
  });
  it('AI 失败在窗口中说明且可重试，生成结果保存时保留 envSchema', async () => {
    mocks.api.discoverAiTemplate.mockRejectedValueOnce(new Error('模型暂不可用')).mockResolvedValueOnce({ template: { name: 'Umami', defaultCompose: compose, envSchema } });
    await start(); await openAI(); await discover(); expect(dialog().text()).toContain('模型暂不可用');
    await button('生成模板', dialog()).trigger('click'); await flushPromises(); await button('填入创建表单', dialog()).trigger('click');
    await button('保存', dialog()).trigger('click'); await flushPromises();
    expect(mocks.api.createMarketplaceTemplate).toHaveBeenCalledWith(expect.objectContaining({ envSchema }));
  });
  it('删除失败保留固定目标与错误，忙时禁止重复，重试成功才关闭', async () => {
    const pending = deferred(); mocks.api.deleteMarketplaceTemplate.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({});
    await start(); await card('缓存 A').get('.btn-delete').trigger('click'); expect(dialog().text()).toContain('缓存 A');
    await button('删除', dialog()).trigger('click'); expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await button('删除中…', dialog()).trigger('click'); expect(mocks.api.deleteMarketplaceTemplate).toHaveBeenCalledTimes(1);
    pending.reject(new Error('模板正在使用')); await flushPromises(); expect(dialog().text()).toContain('模板正在使用');
    await button('删除', dialog()).trigger('click'); await flushPromises(); expect(mocks.api.deleteMarketplaceTemplate).toHaveBeenLastCalledWith('custom-a');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('详情可复制 Compose，失败原位反馈，关闭后回到触发按钮', async () => {
    mocks.copy.mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce();
    await start(); const trigger = card('缓存 A').get('.btn-view'); trigger.element.focus(); await trigger.trigger('click');
    await button('复制配置', dialog()).trigger('click'); await flushPromises(); expect(dialog().text()).toContain('复制失败');
    await button('复制配置', dialog()).trigger('click'); await flushPromises(); expect(mocks.copy).toHaveBeenLastCalledWith(compose);
    await button('返回列表', dialog()).trigger('click'); await flushPromises(); expect(document.activeElement).toBe(trigger.element);
  });
  it('URL 恢复搜索来源分类收藏，筛选变化使用替换，离页不改写其它路由', async () => {
    await start('/marketplace?q=redis&source=custom&category=Database&favorites=1');
    expect(wrapper.get('[aria-label="搜索应用模板"]').element.value).toBe('redis');
    expect(wrapper.get('[aria-label="筛选模板分类"]').element.value).toBe('Database'); expect(wrapper.get('.favorites-filter').attributes('aria-pressed')).toBe('true');
    expect(mocks.api.searchMarketplaceTemplates.mock.calls[0][0].get('onlyFavorites')).toBe('true');
    await wrapper.get('[aria-label="搜索应用模板"]').setValue('cache'); await flushPromises(); expect(router.currentRoute.value.query.q).toBe('cache');
    await router.push('/dashboard?unrelated=keep'); await flushPromises(); await new Promise(resolve => setTimeout(resolve, 350));
    expect(router.currentRoute.value.fullPath).toBe('/dashboard?unrelated=keep');
  });
  it('草稿清空可立即撤销，重新打开仍保留恢复后的内容', async () => {
    await start(); await create(); await fillNew('保留到撤销');
    await button('清空表单', dialog()).trigger('click'); expect(dialog().get('#market-template-name').element.value).toBe('');
    await button('撤销', dialog()).trigger('click'); expect(dialog().get('#market-template-name').element.value).toBe('保留到撤销');
    await button('取消', dialog()).trigger('click'); await create(); expect(dialog().get('#market-template-name').element.value).toBe('保留到撤销');
  });
  it('AI 新请求完成后旧请求的 finally 不能清理新预览或忙态', async () => {
    const old = deferred(), current = deferred(); mocks.api.discoverAiTemplate.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await start(); await openAI(); await discover('old'); await dialog().get('#market-ai-query').setValue('new');
    await button('生成模板', dialog()).trigger('click'); old.resolve({ template: { name: '旧结果', defaultCompose: compose } }); await flushPromises();
    expect(button('生成中…', dialog()).element.disabled).toBe(true); expect(dialog().text()).not.toContain('旧结果');
    current.resolve({ template: { name: '新结果', defaultCompose: compose } }); await flushPromises(); expect(dialog().text()).toContain('新结果');
  });
  it('离页时删除等待不会留下滚动锁，失败回到列表可重新发起原目标', async () => {
    const pending = deferred(); mocks.api.deleteMarketplaceTemplate.mockReturnValueOnce(pending.promise);
    await start(); await card('缓存 A').get('.btn-delete').trigger('click'); await button('删除', dialog()).trigger('click');
    await router.push('/dashboard'); await flushPromises(); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.body.style.overflow).not.toBe('hidden');
    pending.reject(new Error('后台删除失败')); await flushPromises(); await router.push('/marketplace'); await flushPromises();
    expect(wrapper.text()).toContain('缓存 A'); expect(wrapper.text()).toContain('后台删除失败');
    await card('缓存 A').get('.btn-delete').trigger('click'); expect(dialog().text()).toContain('缓存 A');
  });
  it('复制期间关闭详情，迟到成功不在下次详情显示旧反馈', async () => {
    const pending = deferred(); mocks.copy.mockReturnValueOnce(pending.promise);
    await start(); await card('缓存 A').get('.btn-view').trigger('click'); await button('复制配置', dialog()).trigger('click');
    await button('返回列表', dialog()).trigger('click'); await card('网站 B').get('.btn-view').trigger('click'); pending.resolve(); await flushPromises();
    expect(dialog().text()).not.toContain('已复制'); expect(button('复制配置', dialog()).element.disabled).toBe(false);
  });

});
