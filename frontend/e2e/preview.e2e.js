import { test, expect } from '@playwright/test';

const previewBase = process.env.PREVIEW_BASE_URL || 'http://127.0.0.1:4174/ComposeOps/';
function observe(page) {
  const errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (!request.url().startsWith(previewBase) && url.protocol !== 'data:') network.push(request.url());
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') network.push(request.url());
  });
  return { errors, network };
}
const routes = {
  dashboard: '运维总览', services: '服务总览', compose: 'Compose 配置', logs: '实时日志', agent: 'AI 智能运维 Agent',
  shell: '容器终端', monitor: '实时监控', resources: '存储清理', settings: '设置', topology: '服务拓扑中心', events: '事件中心',
  inspection: 'AI 巡检中心', 'agent/history': 'Agent 执行历史', 'ops-center': 'Autonomous Ops', workflows: '工作流中心',
  cron: '定时任务', gitops: 'GitOps 集成', review: '变更与回滚', cmdb: '资产中心 (CMDB)', 'node-groups': '节点组管理',
  marketplace: '应用市场', cost: '成本分析', tickets: '长期运维任务',
};
test('真实应用导航和全部页面可访问，没有后端流量或渲染错误', async ({ page }) => {
  test.setTimeout(60000);
  const observed = observe(page);
  await page.goto('./#/dashboard');
  for (const [route, title] of Object.entries(routes)) {
    // Exercise the real single-page router instead of restarting the Preview shell for every route.
    if (route !== 'dashboard') {
      await page.evaluate((nextRoute) => { window.location.hash = '/' + nextRoute; }, route);
      await page.waitForURL((url) => url.hash === '#/' + route);
    }
    await expect(page.locator('.app-header')).toBeVisible();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.locator('.loading-mark')).toHaveCount(0);
    await expect(page.locator('.alert-error,.runtime-error-bar')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const unnamedControls = await page.locator('button:visible, a:visible').evaluateAll((elements) => elements
      .filter((element) => ![
        element.getAttribute('aria-label'), element.getAttribute('aria-labelledby'), element.getAttribute('title'),
        element.innerText, element.textContent,
      ].some((value) => String(value || '').trim()))
      .map((element) => ({ tag: element.tagName.toLowerCase(), className: String(element.className || '').slice(0, 80), html: element.outerHTML.slice(0, 180) })));
    expect(unnamedControls, `存在缺少可识别名称的按钮/链接：${route}`).toEqual([]);
  }
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('宽屏内容区铺满工作区，设置页保留可读宽度，手机端无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();

  const wideLayout = await page.evaluate(() => {
    const main = document.querySelector('.app-main');
    const outer = document.querySelector('.content-outer');
    return {
      viewport: window.innerWidth,
      mainWidth: main?.clientWidth ?? 0,
      contentWidth: outer?.getBoundingClientRect().width ?? 0,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(wideLayout.contentWidth).toBeGreaterThan(wideLayout.mainWidth * 0.9);
  expect(wideLayout.documentWidth).toBeLessThanOrEqual(wideLayout.viewport);

  await page.evaluate(() => { window.location.hash = '/settings'; });
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  const readableWidth = await page.locator('.page-shell-readable').evaluate(element => element.getBoundingClientRect().width);
  expect(readableWidth).toBeLessThanOrEqual(1440);
  expect(readableWidth).toBeGreaterThan(1300);

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  const tabletLayout = await page.evaluate(() => {
    const main = document.querySelector('.app-main');
    const outer = document.querySelector('.content-outer');
    return {
      viewport: window.innerWidth,
      mainWidth: main?.clientWidth ?? 0,
      contentWidth: outer?.getBoundingClientRect().width ?? 0,
      readableWidth: document.querySelector('.page-shell-readable')?.getBoundingClientRect().width ?? 0,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(tabletLayout.contentWidth).toBeGreaterThan(tabletLayout.mainWidth * 0.9);
  expect(tabletLayout.readableWidth).toBeLessThanOrEqual(tabletLayout.contentWidth);
  expect(tabletLayout.documentWidth).toBeLessThanOrEqual(tabletLayout.viewport);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  const mobileLayout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    contentWidth: document.querySelector('.content-outer')?.getBoundingClientRect().width ?? 0,
    readableWidth: document.querySelector('.page-shell-readable')?.getBoundingClientRect().width ?? 0,
  }));
  expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewport);
  expect(mobileLayout.contentWidth).toBeLessThanOrEqual(mobileLayout.viewport);
  expect(mobileLayout.readableWidth).toBeLessThanOrEqual(mobileLayout.contentWidth);
});

test('真实 Agent 审批门可拒绝、确认，刷新后重置示例', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/agent');
  const input = page.locator('.agent-composer textarea');
  await input.fill('排查 wiki-api');
  await input.press('Enter');
  await expect(page.getByText('需要确认后执行')).toBeVisible();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByText('已拒绝模拟操作，配置与服务状态保持原样。', { exact: false })).toBeVisible();
  await input.fill('继续排查 wiki-api');
  await input.press('Enter');
  await expect(page.getByText('需要确认后执行')).toBeVisible();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.getByText('模拟修复完成：wiki-api 已恢复运行，数据库连接检查通过。', { exact: false })).toBeVisible();
  await page.evaluate(() => { location.hash = '/services'; });
  await expect(page.locator('#project-knowledge-base')).toContainText('运行中');
  await page.getByRole('button', { name: '重置演示', exact: true }).click();
  await expect(page.locator('#project-knowledge-base')).toContainText('部分运行');
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('真实多渠道表单支持独立保存、显隐示例密钥与顺序调整', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/settings?tab=ai');
  const channel = page.locator('[data-channel-id="primary-demo"]');
  await channel.locator('[data-field="name"]').fill('我的示例主渠道');
  await channel.getByRole('button', { name: '保存此渠道' }).click();
  await expect(channel.getByText('此渠道已保存')).toBeVisible();
  await channel.locator('[data-action="reveal"]').click();
  await expect(channel.getByRole('textbox', { name: '已保存的 API Key' })).toHaveValue('demo-key-not-a-real-credential');
  await channel.locator('[data-action="reveal"]').click();
  await expect(channel.getByRole('textbox', { name: '已保存的 API Key' })).toHaveCount(0);
  await channel.getByRole('button', { name: '降低优先级' }).click();
  await expect(page.locator('[data-channel-id]').first()).toHaveAttribute('data-channel-id', 'backup-demo');
  await page.reload();
  await expect(page.locator('[data-channel-id]').first()).toHaveAttribute('data-channel-id', 'primary-demo');
  await expect(channel.locator('[data-field="name"]')).toHaveValue('主渠道（示例）');
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('真实服务搜索、日志与卷备份界面可交互', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/services');
  await page.getByPlaceholder('搜索项目、容器、镜像或路径').fill('missing');
  await expect(page.getByText('没有匹配当前条件的项目')).toBeVisible();
  await page.getByPlaceholder('搜索项目、容器、镜像或路径').fill('redis');
  await expect(page.locator('article[id^="project-"]')).toHaveCount(1);
  await page.goto('./#/logs?projectId=knowledge-base&containerId=demo-wiki-api');
  await expect(page.getByText(/ENOTFOUND db-old/)).toBeVisible();
  await page.goto('./#/resources');
  await page.getByRole('button', { name: '卷备份' }).click();
  await expect(page.getByText('cache-data-demo.tar.gz')).toBeVisible();
  await page.getByRole('button', { name: '验证备份 cache-data-demo.tar.gz' }).click();
  await expect(page.getByText('✓ 128 文件')).toBeVisible();
  await page.getByRole('button', { name: '安装部署', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '安装 ComposeOps' })).toContainText('releases/latest/download/compose.yml');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('配置页直达项目、切换视图和重新选择项目后编辑器仍显示内容', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/compose?projectId=knowledge-base');
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect(page.locator('.monaco-editor')).toContainText('db-old');
  await page.getByRole('button', { name: '可视化', exact: true }).click();
  await expect(page.getByText('服务列表', { exact: true })).toBeVisible();
  const editService = page.getByRole('button', { name: '编辑服务 postgres', exact: true });
  await expect(editService).toBeVisible();
  await expect(page.getByRole('button', { name: '删除服务 postgres', exact: true })).toBeVisible();
  await editService.click();
  const serviceDialog = page.getByRole('dialog', { name: '编辑服务' });
  await expect(serviceDialog).toBeVisible();
  await expect(serviceDialog.getByText('编辑服务', { exact: true })).toHaveCount(1);
  await expect(serviceDialog.getByLabel('服务名称')).toHaveValue('postgres');
  await expect(serviceDialog.getByRole('button', { name: '关闭' })).toBeVisible();
  await expect(serviceDialog.getByRole('textbox', { name: '第 1 行卷挂载 · 宿主机路径或命名卷' })).toHaveValue('data');
  await expect(serviceDialog.getByRole('button', { name: '删除第 1 行卷挂载' })).toBeVisible();
  await serviceDialog.getByRole('button', { name: '关闭' }).click();
  await expect(serviceDialog).toHaveCount(0);
  await page.getByRole('button', { name: '代码', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toContainText('db-old');
  await page.getByTitle('清除当前选择,回到引导页').click();
  await expect(page.getByText('请先选择一个已挂载的项目')).toBeVisible();
  await page.locator('main select').first().selectOption('cache');
  await expect(page.locator('.monaco-editor')).toContainText('redis:7.4-alpine');
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

// A configured channel URL must never become an actual outbound request.
test('未知与外部请求在离线适配器中失败，不回退到真实网络', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览' })).toBeVisible();
  const responses = await page.evaluate(async () => {
    const external = await fetch('https://must-not-contact.example.invalid/v1/chat/completions', { method: 'POST' });
    const unknown = await fetch('/api/v1/preview-unknown', { method: 'DELETE' });
    return [external.status, unknown.status];
  });
  expect(responses).toEqual([501, 501]);
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('快速跳转支持键盘搜索、执行与 Escape 关闭', async ({ page }) => {
  const trigger = page.getByRole('button', { name: '打开快速跳转' });
  await page.goto('./#/dashboard');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '快速跳转与操作' });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole('combobox', { name: '搜索命令' });
  await expect(search).toBeFocused();
  await search.fill('设置');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await expect(dialog.getByRole('option').first()).toContainText('系统设置');
  await search.press('Enter');
  await page.waitForURL((url) => url.hash === '#/settings', { timeout: 15000 });
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible({ timeout: 15000 });
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('移动端更多功能抽屉可访问、焦点受限、Escape 可关闭且页面不横向溢出', async ({ page, isMobile }) => {
  test.skip(!isMobile, '仅在移动设备项目中验证移动端导航抽屉');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/dashboard');
  const more = page.getByRole('button', { name: '更多功能', exact: true });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  const drawer = page.getByRole('dialog', { name: '更多功能' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('aria-labelledby', 'mobile-more-dialog-title');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  const guide = drawer.getByRole('button', { name: '入门指南' });
  await expect(guide).toBeFocused();
  await expect(drawer.getByRole('link', { name: '设置' })).toBeVisible();

  // Tab 顺序在抽屉内部循环，不允许键盘焦点落到背景页面。
  const lastLink = drawer.getByRole('link', { name: '设置' });
  await page.keyboard.press('Shift+Tab');
  await expect(lastLink).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(guide).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();

  await more.click();
  await drawer.getByRole('button', { name: '关闭更多功能' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(more).toBeFocused();

  await more.click();
  await drawer.getByRole('link', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(drawer).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('数据卷恢复和删除均先展示明确的确认门，取消后不执行破坏性操作', async ({ page }) => {
  await page.goto('./#/resources');
  await page.getByRole('button', { name: '卷备份' }).click();
  await expect(page.getByText('cache-data-demo.tar.gz')).toBeVisible();
  await page.getByRole('button', { name: '恢复卷 cache_data 的备份' }).click();
  const restoreDialog = page.getByRole('dialog', { name: '恢复数据卷' });
  await expect(restoreDialog).toContainText('仅演练通过后才会');
  await restoreDialog.getByRole('button', { name: '取消' }).click();
  await expect(restoreDialog).toHaveCount(0);
  await page.getByRole('button', { name: '删除备份 cache-data-demo.tar.gz' }).click();
  const deleteDialog = page.getByRole('dialog', { name: '删除备份' });
  await expect(deleteDialog).toContainText('该操作不可恢复');
  await deleteDialog.getByRole('button', { name: '取消' }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(page.getByText('cache-data-demo.tar.gz')).toBeVisible();
});

test('定时任务创建表单先做本地校验，离线不支持的提交会明确报错且保留草稿', async ({ page }) => {
  await page.goto('./#/cron');
  await page.getByRole('button', { name: '新建定时任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建定时任务' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '创建任务' }).click();
  await expect(dialog.getByText('请填写任务名称')).toBeVisible();
  const name = dialog.getByPlaceholder('例如:每天凌晨自动备份数据库');
  await name.fill('回归测试任务');
  await dialog.getByRole('button', { name: '创建任务' }).click();
  await expect(dialog.getByText(/未在离线预览中模拟/)).toBeVisible();
  await expect(name).toHaveValue('回归测试任务');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('工作流编辑器能拦截空名称和重复节点 ID', async ({ page }) => {
  await page.goto('./#/workflows');
  await page.getByRole('button', { name: '新建工作流' }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作流' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await dialog.locator('input, select, button').evaluateAll(elements => elements.every(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.x >= 0 && bounds.right <= innerWidth;
  }))).toBe(true);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('请填写工作流名称');
  await expect(dialog.getByLabel('名称', { exact: true })).toBeFocused();
  await dialog.getByPlaceholder('如:故障自动处理').fill('回归测试工作流');
  const nodeIds = dialog.getByPlaceholder('节点 ID');
  await nodeIds.nth(1).fill('trigger');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('节点 ID 重复:trigger');
  await expect(nodeIds.nth(1)).toBeFocused();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('应用市场创建弹窗支持读屏语义、焦点循环、Escape 关闭和焦点恢复', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/marketplace');
  const trigger = page.getByRole('button', { name: /创建模板/ }).first();
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: '创建模板' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('heading', { name: '创建模板' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '关闭创建或编辑模板弹窗' })).toBeFocused();

  const focusable = dialog.locator('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
  const first = focusable.first();
  const last = focusable.last();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('移动端 Agent 会话列表支持对话框语义、焦点循环、Escape 关闭和焦点恢复', async ({ page }) => {
  test.skip((page.viewportSize()?.width || 0) >= 760, '移动端专用会话抽屉测试');
  const observed = observe(page);
  await page.goto('./#/agent');

  const trigger = page.getByRole('button', { name: '打开会话列表' });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: '会话', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  await expect(dialog).toBeFocused();

  const focusable = dialog.locator('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
  const first = focusable.first();
  const last = focusable.last();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('Agent 富内容放大预览提供模态语义、焦点循环、Escape 关闭和焦点恢复', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/agent');
  await page.locator('.agent-messages').waitFor();

  await page.evaluate(() => {
    const container = document.querySelector('.agent-messages');
    if (!container) throw new Error('Agent 消息容器不存在');
    container.insertAdjacentHTML('beforeend', '<div class="rich-block"><button type="button" class="rich-zoom-btn">打开图表预览</button><div class="rich-block-body"><svg role="img" aria-label="示例图表" viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="8"></circle></svg><p>用于验证键盘可访问性的放大预览内容。</p></div></div>');
  });

  const trigger = page.getByRole('button', { name: '打开图表预览' });
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: '放大预览' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('button', { name: '关闭放大预览' })).toBeFocused();

  const focusable = dialog.locator('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])');
  const first = focusable.first();
  const last = focusable.last();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Clicking the media itself should focus the accessible zoom control as the return target.
  await page.locator('.rich-block-body svg').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '关闭放大预览' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('核心页面标签页支持方向键切换、面板关联和单一 Tab 停靠点', async ({ page }) => {
  const observed = observe(page);
  const cases = [
    { path: './#/review', list: '变更与回滚视图', from: '变更评审', to: '自动回滚' },
    { path: './#/events', list: '事件中心视图', from: '告警事件', to: '时间线' },
    { path: './#/cmdb', list: '资产中心视图', from: '资产清单', to: '知识图谱' },
    { path: './#/monitor', list: '监控视图', from: '实时', to: '历史指标' },
    { path: './#/events?tab=operations', list: '操作中心视图', from: /操作记录/, to: /后台任务/ },
  ];

  for (const item of cases) {
    await page.goto(item.path);
    const tablist = page.getByRole('tablist', { name: item.list });
    await expect(tablist).toBeVisible();
    const firstTab = tablist.getByRole('tab', { name: item.from });
    const secondTab = tablist.getByRole('tab', { name: item.to });
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await expect(firstTab).toHaveAttribute('tabindex', '0');
    await expect(secondTab).toHaveAttribute('tabindex', '-1');

    await firstTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
    await expect(secondTab).toHaveAttribute('tabindex', '0');
    await expect(firstTab).toHaveAttribute('tabindex', '-1');
    await expect(secondTab).toBeFocused();

    const panelId = await secondTab.getAttribute('aria-controls');
    const tabId = await secondTab.getAttribute('id');
    const panel = page.locator(`#${panelId}`);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', tabId);
  }

  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('GitOps 添加仓库表单阻止缺少必填字段的提交', async ({ page }) => {
  await page.goto('./#/gitops');
  await page.getByRole('button', { name: '添加仓库' }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加仓库' });
  await expect(dialog).toBeVisible();
  const required = dialog.locator('form input[required], form select[required]');
  expect(await required.count()).toBeGreaterThanOrEqual(4);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await required.evaluateAll((fields) => fields.some((field) => !field.checkValidity()))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('服务页进入日志再返回，筛选、展开、滚动与日志上下文保持一致', async ({ page }) => {
  await page.goto('./#/services');
  await expect(page.getByRole('heading', { name: '服务总览', exact: true })).toBeVisible();
  const search = page.getByPlaceholder('搜索项目、容器、镜像或路径');
  await search.fill('wiki-api');
  const card = page.locator('#project-knowledge-base');
  await expect(card).toBeVisible();
  await expect(page.locator('article[id^="project-"]')).toHaveCount(1);
  await card.locator('.service-project-card__toggle').click();
  await expect(card.locator('.service-project-card__toggle')).toHaveAttribute('aria-expanded', 'true');
  const logLink = card.locator('[data-container="demo-wiki-api"]').getByRole('link', { name: '实时日志', exact: true });
  await expect(logLink).toBeVisible();
  // 移动端的卡片日志入口位于展开内容下方;先让真实入口进入视口,再记录离开时的位置。
  await logLink.scrollIntoViewIfNeeded();
  const scrollTop = await page.locator('.app-main').evaluate(el => el.scrollTop);
  await logLink.click();
  await expect(page.getByRole('heading', { name: '实时日志', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回服务总览' })).toBeVisible();
  await expect(page.getByText(/ENOTFOUND db-old/)).toBeVisible();
  await page.getByRole('textbox', { name: '搜索和过滤实时日志' }).fill('ENOTFOUND');
  await page.getByRole('button', { name: '返回服务总览' }).click();
  await expect(page.getByRole('heading', { name: '服务总览', exact: true })).toBeVisible();
  await expect(search).toHaveValue('wiki-api');
  await expect(card.locator('.service-project-card__toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.app-main')).toHaveJSProperty('scrollTop', scrollTop);

  // 通过侧栏普通“日志”入口不带 query 重进,应保留项目上下文和原始来源。
  await page.getByRole('link', { name: '日志', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '实时日志', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回服务总览' })).toBeVisible();
  const options = page.getByRole('button', { name: '日志选项', exact: true });
  if (await options.isVisible()) await options.click();
  await expect(page.getByRole('combobox', { name: '选择日志项目' })).toHaveValue('knowledge-base');
  await expect(page.getByRole('textbox', { name: '搜索和过滤实时日志' })).toHaveValue('ENOTFOUND');
  await page.getByRole('button', { name: '返回服务总览' }).click();
  await expect(search).toHaveValue('wiki-api');
  await expect(card.locator('.service-project-card__toggle')).toHaveAttribute('aria-expanded', 'true');
});

test('手机窄屏日志搜索框保持完整宽度并可实际过滤', async ({ page, isMobile }) => {
  test.skip(!isMobile, '仅在移动设备项目验证窄屏工具栏');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/logs?projectId=knowledge-base&containerId=demo-wiki-api&from=services');
  await expect(page.getByRole('heading', { name: '实时日志', exact: true })).toBeVisible();
  const search = page.getByRole('textbox', { name: '搜索和过滤实时日志' });
  await expect(search).toBeVisible();
  const width = await search.evaluate(element => element.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(250);
  await expect(page.getByText(/ENOTFOUND db-old/)).toBeVisible();
  const logBox = await page.locator('.log-pane-body').boundingBox();
  expect(logBox.y).toBeLessThan(500);
  await expect(page.getByRole('combobox', { name: '选择日志项目' })).toBeHidden();
  await page.getByRole('button', { name: '日志选项', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '选择日志项目' })).toBeVisible();
  await page.getByRole('combobox', { name: '按日志级别过滤' }).selectOption('error');
  await page.getByRole('button', { name: '收起选项', exact: true }).click();
  await expect(page.getByRole('group', { name: '当前日志级别筛选' })).toContainText('ERROR');
  await page.getByRole('button', { name: '清除级别筛选' }).click();
  await expect(page.getByRole('group', { name: '当前日志级别筛选' })).toHaveCount(0);
  await search.fill('ENOTFOUND');
  await expect(page.getByText(/ENOTFOUND db-old/)).toBeVisible();
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
});

test('筛选外的批量选择明确提示，确认列出实际项目，取消不执行', async ({ page }) => {
  await page.goto('./#/services');
  await page.getByRole('checkbox', { name: '选择 knowledge-base', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: '选择当前', exact: true })).toHaveJSProperty('indeterminate', true);
  await page.getByRole('checkbox', { name: '选择 cache', exact: true }).check();
  await page.getByRole('searchbox', { name: '搜索服务项目' }).fill('wiki-api');
  const bar = page.getByRole('region', { name: '批量项目操作' });
  await expect(bar).toContainText('已选择 2 个项目');
  await expect(bar).toContainText('其中 1 个不在当前筛选中');
  await expect(page.locator('article[id^="project-"]')).toHaveCount(1);
  await page.evaluate(() => {
    window.__batchRequests = 0;
    const fetch = window.fetch;
    window.fetch = (...args) => { if (String(args[0]).endsWith('/jobs') && args[1]?.method === 'POST') window.__batchRequests++; return fetch(...args); };
  });
  await bar.getByRole('button', { name: '重启', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量重启' });
  await expect(dialog).toContainText('knowledge-base');
  await expect(dialog).toContainText('cache');
  await expect(dialog).toContainText('重启不会应用配置或新镜像');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => window.__batchRequests)).toBe(0);
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: '取消选择' }).click();
  await expect(bar).toHaveCount(0);
});

test('平板服务搜索保留可输入宽度，筛选和批量选择可同时使用', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('./#/services');
  const search = page.getByRole('searchbox', { name: '搜索服务项目' });
  await expect(search).toBeVisible();
  expect((await search.boundingBox()).width).toBeGreaterThanOrEqual(250);
  await page.getByRole('checkbox', { name: '选择 knowledge-base', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 cache', exact: true }).check();
  await search.fill('wiki-api');
  await expect(page.locator('article[id^="project-"]')).toHaveCount(1);
  await expect(page.getByRole('region', { name: '批量项目操作' })).toContainText('其中 1 个不在当前筛选中');
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 768);
});

test('手动刷新等待最新响应，显示忙碌状态且阻止重复提交', async ({ page }) => {
  await page.goto('./#/services');
  await expect(page.locator('#project-knowledge-base')).toBeVisible();
  await page.getByRole('checkbox', { name: '自动刷新', exact: true }).uncheck();
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.__refreshRequests = 0;
    window.fetch = async (...args) => {
      if (!String(args[0]).endsWith('/projects')) return fetch(...args);
      window.__refreshRequests++;
      await new Promise(resolve => { window.__releaseRefresh = resolve; });
      const response = await fetch(...args);
      const body = await response.json();
      body.projects.find(project => project.id === 'knowledge-base').note = '已取得本次刷新数据';
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const refreshing = page.getByRole('button', { name: '刷新中', exact: true });
  await expect(refreshing).toBeDisabled();
  await expect(refreshing).toHaveAttribute('aria-busy', 'true');
  await refreshing.evaluate(element => element.click());
  expect(await page.evaluate(() => window.__refreshRequests)).toBe(1);
  await page.evaluate(() => window.__releaseRefresh());
  await expect(page.locator('#project-knowledge-base')).toContainText('已取得本次刷新数据');
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
});

test('持续日志流保持历史阅读位置，点击新日志提示才回到底部', async ({ page }) => {
  await page.goto('./#/services');
  await expect(page.locator('#project-knowledge-base')).toBeVisible();
  await page.evaluate(() => {
    const message = WebSocket.prototype.message;
    WebSocket.prototype.message = function (value) { if (this.url.includes('/ws/logs')) window.__logSocket = this; return message.call(this, value); };
    location.hash = '/logs?projectId=knowledge-base&containerId=demo-wiki-api';
  });
  const region = page.getByRole('region', { name: 'wiki-api实时日志' });
  await expect(region).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!window.__logSocket)).toBe(true);
  await page.evaluate(() => { for (let i = 0; i < 180; i++) window.__logSocket.message({ type: 'stdout', data: `reading-line-${i}` }); });
  // scrollHeight/clientHeight are rounded integers; allow a few pixels after font/layout settling.
  await expect.poll(() => region.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(3);
  await expect(page.getByText('reading-line-179', { exact: true })).toBeVisible();
  await region.scrollIntoViewIfNeeded();
  await region.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => region.evaluate(el => el.scrollTop)).toBe(0);
  await region.hover();
  await page.mouse.wheel(0, 48);
  await expect.poll(() => region.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  const top = await region.evaluate(el => el.scrollTop);
  await page.evaluate(() => window.__logSocket.message({ type: 'stdout', data: 'arrived-while-reading' }));
  const resume = page.getByRole('button', { name: '1 条新日志 · 回到最新' });
  await expect(resume).toBeVisible();
  await expect(region).toHaveJSProperty('scrollTop', top);
  const chip = await resume.boundingBox(), pane = await page.locator('.log-pane').boundingBox();
  expect(chip.x).toBeGreaterThanOrEqual(pane.x);
  expect(chip.y + chip.height).toBeLessThanOrEqual(pane.y + pane.height);
  await resume.click();
  await expect(resume).toHaveCount(0);
  await expect.poll(() => region.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(3);
  await expect(page.getByText('arrived-while-reading', { exact: true })).toBeVisible();
});
