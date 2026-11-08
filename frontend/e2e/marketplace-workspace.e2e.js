import { test, expect } from '@playwright/test';

async function install(page, options = {}) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.installMarketWorkspace = options => {
    const original = window.fetch;
    const compose = 'services:\n  app:\n    image: nginx:stable\n    ports:\n      - "8080:80"\n';
    const schema = [{ key: 'ADMIN_PASSWORD', label: '管理员密码', type: 'password', secret: true, default: '' }];
    const f = window.marketWorkspace = { compose, schema, queries: [], creates: [], updates: [], deletes: [], discoveries: [], saveFail: false, deleteFail: false, listFail: false,
      templates: [{ id: 'custom-a', name: '团队知识库', category: 'Web', description: '团队文档与协作空间的可复用配置。', defaultCompose: compose, envSchema: schema }, { id: 'custom-b', name: 'Redis 缓存', category: 'Database', description: '缓存与会话数据。', defaultCompose: compose, envSchema: [] }] };
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/v1/marketplace/stats') return json({ totalBuiltin: 0, totalCustom: f.templates.length, totalFavorites: 1, categories: ['Web', 'Database'], communityAvailable: false });
      if (url.pathname === '/api/v1/marketplace/templates/search') {
        f.queries.push(url.search); if (f.listFail) return json({ message: '列表暂时不可用' }, 503);
        const q = (url.searchParams.get('q') || '').toLowerCase(); const category = url.searchParams.get('category');
        return json({ results: f.templates.filter(t => (!q || t.name.toLowerCase().includes(q)) && (!category || t.category === category)) });
      }
      if (url.pathname === '/api/v1/marketplace/templates/ai-discover') {
        const query = JSON.parse(init.body).query; const request = { query, aborted: false };
        f.discoveries.push(request);
        if (options.manualAI) return new Promise(resolve => {
          request.finish = () => resolve(json({ template: { name: query + ' 草稿', defaultCompose: compose, category: 'Web', envSchema: schema } }));
          init.signal.addEventListener('abort', () => { request.aborted = true; });
        });
        return json({ template: { name: query + ' 草稿', defaultCompose: compose, category: 'Web', envSchema: schema } });
      }
      if (url.pathname === '/api/v1/marketplace/templates/custom' && init.method === 'POST') {
        const payload = JSON.parse(init.body); f.creates.push(payload);
        const finish = () => { if (f.saveFail) return json({ message: 'Compose 语义校验失败：请检查镜像配置' }, 422); const template = { ...payload, id: 'custom-new' }; f.templates.push(template); return json({ template }); };
        if (options.manualSave) return new Promise(resolve => { f.finishSave = () => resolve(finish()); });
        return finish();
      }
      if (url.pathname.startsWith('/api/v1/marketplace/templates/custom/') && init.method === 'PATCH') {
        const id = url.pathname.split('/').pop(); const payload = JSON.parse(init.body); f.updates.push({ id, payload });
        if (f.saveFail) return json({ message: 'Compose 语义校验失败：请检查镜像配置' }, 422);
        f.templates = f.templates.map(t => t.id === id ? { ...t, ...payload } : t); return json({ template: f.templates.find(t => t.id === id) });
      }
      if (url.pathname.startsWith('/api/v1/marketplace/templates/custom/') && init.method === 'DELETE') {
        const id = url.pathname.split('/').pop(); f.deletes.push(id);
        const finish = () => { if (f.deleteFail) return json({ message: '删除暂时失败，请重试' }, 503); f.templates = f.templates.filter(t => t.id !== id); return json({ ok: true }); };
        if (options.manualDelete) return new Promise(resolve => { f.finishDelete = () => resolve(finish()); });
        return finish();
      }
      return original(input, init);
    };
  }; });
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(options => { window.installMarketWorkspace(options); location.hash = '#/marketplace'; }, options);
  await expect(page.locator('.template-card')).toHaveCount(2);
  return errors;
}
const dialog = page => page.getByRole('dialog');
const card = (page, name) => page.locator('.template-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function create(page, name = '新草稿') {
  await page.getByRole('button', { name: /创建模板/ }).click();
  await dialog(page).getByLabel('模板名称', { exact: true }).fill(name);
  await dialog(page).getByLabel('Compose 内容', { exact: true }).fill('services:\n  app:\n    image: nginx:stable\n');
}

test('创建草稿关闭与浏览器返回后可恢复，移动表单和保存动作可达', async ({ page }) => {
  const errors = await install(page); await page.setViewportSize({ width: 320, height: 740 }); await create(page, '手机上的草稿');
  await expect(dialog(page).getByRole('button', { name: '保存', exact: true })).toBeInViewport();
  expect(await dialog(page).getByLabel('Compose 内容', { exact: true }).evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await dialog(page).getByRole('button', { name: '取消', exact: true }).click(); await page.getByRole('button', { name: /创建模板/ }).click();
  await expect(dialog(page).getByLabel('模板名称', { exact: true })).toHaveValue('手机上的草稿');
  await page.goBack(); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible(); await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  await page.goForward(); await page.getByRole('button', { name: /创建模板/ }).click();
  await expect(dialog(page).getByLabel('模板名称', { exact: true })).toHaveValue('手机上的草稿'); expect(errors).toEqual([]);
});

test('编辑失败保留配置与变量，修正后保存并刷新列表', async ({ page }) => {
  const errors = await install(page); await card(page, '团队知识库').getByRole('button', { name: '编辑', exact: true }).click();
  await dialog(page).getByLabel('模板名称', { exact: true }).fill('团队知识库 v2'); await page.evaluate(() => { window.marketWorkspace.saveFail = true; });
  await dialog(page).getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog(page).getByRole('alert')).toContainText('Compose 语义校验失败');
  await expect(dialog(page).getByLabel('模板名称', { exact: true })).toHaveValue('团队知识库 v2');
  await dialog(page).getByText('随模板保留的配置项 · 1').click(); await expect(dialog(page)).toContainText('ADMIN_PASSWORD');
  await page.evaluate(() => { window.marketWorkspace.saveFail = false; }); await dialog(page).getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0); await expect(card(page, '团队知识库 v2')).toBeVisible();
  expect(await page.evaluate(() => window.marketWorkspace.updates[1].payload.envSchema)).toEqual([{ key: 'ADMIN_PASSWORD', label: '管理员密码', type: 'password', secret: true, default: '' }]); expect(errors).toEqual([]);
});

test('保存等待期间离页释放窗口，确认成功后不保留已保存草稿', async ({ page }) => {
  const errors = await install(page, { manualSave: true }); await create(page, '等待确认的草稿');
  await dialog(page).getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog(page).getByLabel('模板名称', { exact: true })).toBeDisabled();
  await page.goBack(); await expect(dialog(page)).toHaveCount(0); await page.evaluate(() => window.marketWorkspace.finishSave());
  await page.goForward(); await expect(card(page, '等待确认的草稿')).toBeVisible(); await page.getByRole('button', { name: /创建模板/ }).click();
  await expect(dialog(page).getByLabel('模板名称', { exact: true })).toHaveValue(''); expect(await page.evaluate(() => window.marketWorkspace.creates.length)).toBe(1); expect(errors).toEqual([]);
});

test('AI 请求关闭与查询变化均隔离迟到结果，草稿经审核再保存', async ({ page }) => {
  const errors = await install(page, { manualAI: true }); await page.getByRole('button', { name: 'AI 找应用', exact: true }).click();
  await dialog(page).getByLabel('应用名称', { exact: true }).fill('umami'); await dialog(page).getByRole('button', { name: '生成模板', exact: true }).click();
  await expect(dialog(page)).toContainText('正在整理部署草稿'); await dialog(page).getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => window.marketWorkspace.discoveries[0].aborted)).toBe(true);
  await page.getByRole('button', { name: 'AI 找应用', exact: true }).click(); await page.evaluate(() => window.marketWorkspace.discoveries[0].finish());
  await expect(dialog(page).getByRole('button', { name: '填入创建表单', exact: true })).toHaveCount(0);
  await dialog(page).getByLabel('应用名称', { exact: true }).fill('gitea'); await dialog(page).getByRole('button', { name: '生成模板', exact: true }).click();
  await page.evaluate(() => window.marketWorkspace.discoveries[1].finish()); await expect(dialog(page)).toContainText('gitea 草稿');
  await expect(dialog(page)).toContainText('自定义模板暂不提供直接部署');
  await dialog(page).getByRole('button', { name: '填入创建表单', exact: true }).click(); await expect(dialog(page).getByLabel('模板名称', { exact: true })).toHaveValue('gitea 草稿');
  await dialog(page).getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.marketWorkspace.creates[0].envSchema.length)).toBe(1); expect(errors).toEqual([]);
});

test('已有创建草稿时 AI 填入明确提示替换，查询改变清除旧结果', async ({ page }) => {
  const errors = await install(page); await create(page, '原创建草稿'); await dialog(page).getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: 'AI 找应用', exact: true }).click(); await dialog(page).getByLabel('应用名称', { exact: true }).fill('umami'); await dialog(page).getByRole('button', { name: '生成模板', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: '替换草稿并填入', exact: true })).toBeVisible();
  await dialog(page).getByLabel('应用名称', { exact: true }).fill('gitea'); await expect(dialog(page).getByRole('button', { name: '替换草稿并填入', exact: true })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: '取消', exact: true }).click(); await page.getByRole('button', { name: /创建模板/ }).click();
  await expect(dialog(page).getByLabel('模板名称', { exact: true })).toHaveValue('原创建草稿'); expect(errors).toEqual([]);
});

test('删除确认锁定目标，失败原位重试成功后移除卡片', async ({ page }) => {
  const errors = await install(page, { manualDelete: true }); await card(page, '团队知识库').getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog(page)).toContainText('团队知识库'); await page.evaluate(() => { window.marketWorkspace.deleteFail = true; });
  await dialog(page).getByRole('button', { name: '删除', exact: true }).click(); await expect(dialog(page).getByRole('button', { name: '删除中…', exact: true })).toBeDisabled();
  await page.evaluate(() => window.marketWorkspace.finishDelete()); await expect(dialog(page).getByRole('alert')).toContainText('删除暂时失败');
  await page.evaluate(() => { window.marketWorkspace.deleteFail = false; }); await dialog(page).getByRole('button', { name: '删除', exact: true }).click();
  await page.evaluate(() => window.marketWorkspace.finishDelete()); await expect(dialog(page)).toHaveCount(0); await expect(card(page, '团队知识库')).toHaveCount(0);
  expect(await page.evaluate(() => window.marketWorkspace.deletes)).toEqual(['custom-a', 'custom-a']); expect(errors).toEqual([]);
});

test('详情配置复制有反馈，键盘关闭后恢复触发焦点', async ({ page }) => {
  const errors = await install(page); const trigger = card(page, '团队知识库').getByRole('button', { name: '查看', exact: true }); await trigger.focus(); await trigger.press('Enter');
  await dialog(page).getByRole('button', { name: '复制配置', exact: true }).click(); await expect(dialog(page)).toContainText('Compose 配置已复制');
  await expect(dialog(page)).toContainText('可复制 Compose'); await page.keyboard.press('Escape'); await expect(dialog(page)).toHaveCount(0); await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
});

test('筛选写入 URL，刷新与浏览器前后退恢复相同列表', async ({ page }) => {
  const errors = await install(page); await page.getByRole('textbox', { name: '搜索应用模板' }).fill('Redis'); await page.getByRole('combobox', { name: '筛选模板分类' }).selectOption('Database');
  await page.getByRole('button', { name: /自定义模板/ }).click(); await page.getByRole('button', { name: /我的收藏/ }).click();
  await expect(page).toHaveURL(/q=Redis/); await expect(page).toHaveURL(/favorites=1/); await expect(page.locator('.template-card')).toHaveCount(1);
  const current = page.url(); await page.reload(); await page.evaluate(() => window.installMarketWorkspace({})); await expect(page.getByRole('textbox', { name: '搜索应用模板' })).toHaveValue('Redis'); await expect(page.getByRole('combobox', { name: '筛选模板分类' })).toHaveValue('Database');
  await expect(page.getByRole('button', { name: /我的收藏/ })).toHaveAttribute('aria-pressed', 'true');
  await page.goBack(); await expect(page).toHaveURL(/dashboard/); await page.goForward(); await expect(page).toHaveURL(current); await expect(page.locator('.template-card')).toHaveCount(1); expect(errors).toEqual([]);
});

test('读取错误不伪装成空结果，重试保留筛选', async ({ page }) => {
  const errors = await install(page); await page.evaluate(() => { window.marketWorkspace.listFail = true; }); await page.getByRole('textbox', { name: '搜索应用模板' }).fill('Redis');
  await expect(page.getByRole('alert')).toContainText('列表暂时不可用'); await expect(page.locator('.market-results')).toContainText('模板列表暂不可用');
  await page.evaluate(() => { window.marketWorkspace.listFail = false; }); await page.getByRole('button', { name: '重试', exact: true }).click(); await expect(page.locator('.template-card')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '搜索应用模板' })).toHaveValue('Redis'); expect(errors).toEqual([]);
});

test('清空表单提供撤销，键盘校验先聚焦缺失字段', async ({ page }) => {
  const errors = await install(page); await page.getByRole('button', { name: /创建模板/ }).click();
  await dialog(page).getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog(page).getByLabel('模板名称', { exact: true })).toBeFocused();
  await dialog(page).getByLabel('模板名称', { exact: true }).fill('可撤销的草稿'); await dialog(page).getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog(page).getByLabel('Compose 内容', { exact: true })).toBeFocused();
  await dialog(page).getByRole('button', { name: '清空表单', exact: true }).click(); await expect(dialog(page).getByLabel('模板名称', { exact: true })).toHaveValue('');
  await dialog(page).getByRole('button', { name: '撤销', exact: true }).click(); await expect(dialog(page).getByLabel('模板名称', { exact: true })).toHaveValue('可撤销的草稿');
  expect(await page.evaluate(() => window.marketWorkspace.creates.length)).toBe(0); expect(errors).toEqual([]);
});
