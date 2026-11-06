import { test, expect } from '@playwright/test';

async function command(page, label) {
  await page.getByRole('button', { name: '打开快速跳转' }).click();
  const dialog = page.getByRole('dialog', { name: '快速跳转与操作' });
  await dialog.getByRole('combobox', { name: '搜索命令' }).fill(label);
  await dialog.getByRole('option').filter({ hasText: label }).first().click();
}

test('统一返回与前进保留来源标签页，浏览器后退与界面按钮一致', async ({ page }) => {
  await page.goto('./#/settings?tab=mounts');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await command(page, '实时日志');
  const nav = page.getByRole('navigation', { name: '页面导航' });
  await expect(nav.getByRole('button', { name: '返回系统设置' })).toBeVisible();
  await command(page, '应用市场');
  await nav.getByRole('button', { name: '返回实时日志' }).click();
  await expect(page).toHaveURL(/#\/logs$/);
  await nav.getByRole('button', { name: '返回系统设置' }).click();
  await expect(page).toHaveURL(/#\/settings\?tab=mounts$/);
  await nav.getByRole('button', { name: '前进到实时日志' }).click();
  await expect(page).toHaveURL(/#\/logs$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/settings\?tab=mounts$/);
  await expect(page).toHaveTitle('系统设置 · ComposeOps');
});

test('直达日志返回明确来源，未知来源不会离开应用', async ({ page }) => {
  await page.goto('./#/logs?projectId=knowledge-base&from=topology');
  const nav = page.getByRole('navigation', { name: '页面导航' });
  await nav.getByRole('button', { name: '返回服务拓扑' }).click();
  await expect(page.getByRole('heading', { name: '服务拓扑中心', exact: true })).toBeVisible();
  // A new tab has no in-app back entry.
  const tab = await page.context().newPage();
  await tab.goto('./#/compose?projectId=cache&from=https://example.invalid');
  await expect(tab.locator('.monaco-editor')).toBeVisible({ timeout: 15000 });
  await tab.getByRole('navigation', { name: '页面导航' }).getByRole('button', { name: '返回服务总览' }).click();
  await expect(tab).toHaveURL(/#\/services\?focus=cache$/);
  await expect(tab.locator('#project-cache .service-project-card__toggle')).toHaveAttribute('aria-expanded', 'true');
  await tab.close();
});

test('配置草稿拦截统一返回，取消后可继续编辑且不会锁死导航', async ({ page }) => {
  await page.goto('./#/services');
  const card = page.locator('#project-cache');
  await card.locator('.service-project-card__toggle').click();
  await card.getByRole('link', { name: '配置', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.getByRole('button', { name: '可视化', exact: true }).click();
  await page.getByRole('button', { name: '编辑服务 redis', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑服务' });
  await dialog.getByLabel('镜像').fill('redis:7.4');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '页面导航' });
  await nav.getByRole('button', { name: '返回服务总览' }).click();
  const confirm = page.getByRole('dialog', { name: '配置尚未保存' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(/#\/compose\?projectId=cache(?:&|$)/);
  await expect(page.getByText('redis:7.4', { exact: true })).toBeVisible();
  await nav.getByRole('button', { name: '返回服务总览' }).click();
  await confirm.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '服务总览', exact: true })).toBeVisible();
});

test('服务筛选可独立清除并保留另一个条件，收藏状态立即反馈', async ({ page }) => {
  await page.goto('./#/services');
  await page.getByLabel('搜索服务项目').fill('redis');
  await page.getByLabel('状态筛选', { exact: true }).selectOption('managed');
  const filters = page.getByRole('group', { name: '当前服务筛选' });
  await expect(filters).toContainText('redis');
  await filters.getByRole('button', { name: '清除搜索关键词' }).click();
  await expect(page.getByLabel('状态筛选', { exact: true })).toHaveValue('managed');
  await expect(page.locator('article[id^="project-"]')).toHaveCount(3);
  await filters.getByRole('button', { name: '清除状态筛选' }).click();
  await expect(filters).toHaveCount(0);
  const cache = page.locator('#project-cache');
  await cache.getByRole('button', { name: '收藏项目', exact: true }).click();
  await expect(cache.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
  await page.getByLabel('状态筛选', { exact: true }).selectOption('favorites');
  await expect(page.locator('article[id^="project-"]')).toHaveCount(2);
});

test('手机更多功能包含配置入口，可搜索、清空和显示当前位置', async ({ page, isMobile }) => {
  test.skip(!isMobile, '移动导航');
  await page.goto('./#/dashboard');
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '更多功能', exact: true });
  await expect(drawer.getByRole('link', { name: '配置', exact: true })).toBeVisible();
  const search = drawer.getByRole('searchbox', { name: '查找功能' });
  await search.fill('not-a-feature');
  await expect(drawer.getByRole('status')).toContainText('没有匹配');
  await search.fill('yaml');
  await expect(drawer.getByRole('link')).toHaveCount(1);
  await drawer.getByRole('link', { name: '配置', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Compose 配置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '更多功能', exact: true })).toHaveClass(/nav-link-active/);
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(drawer.getByRole('link', { name: '配置', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('收藏请求失败保留原状态，显示错误且可以重试', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/services');
  await expect(page.locator('#project-cache')).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    window.__restoreFavoriteFetch = () => { window.fetch = original; };
    window.fetch = (...args) => String(args[0]).includes('/preferences') && args[1]?.method === 'PATCH'
      ? Promise.resolve(new Response(JSON.stringify({ message: '测试保存失败' }), { status: 503 })) : original(...args);
  });
  const star = page.locator('#project-cache').getByRole('button', { name: '收藏项目', exact: true });
  await star.click();
  await expect(page.getByText('收藏未保存：测试保存失败', { exact: true })).toBeVisible();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await expect(star).toBeEnabled();
  await page.evaluate(() => { window.__restoreFavoriteFetch(); delete window.__restoreFavoriteFetch; });
  await star.click();
  await expect(page.locator('#project-cache').getByRole('button', { name: '取消收藏', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('320px 窄屏、缩放和减少动态效果下导航仍可用', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('./#/agent/history');
  const nav = page.getByRole('navigation', { name: '页面导航' });
  await expect(nav.getByRole('button', { name: '返回AI 智能运维 Agent' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await nav.getByRole('button', { name: '返回AI 智能运维 Agent' }).click();
  await expect(page.getByRole('heading', { name: 'AI 智能运维 Agent', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 768, height: 1024 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
