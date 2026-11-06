import { test, expect } from '@playwright/test';

test('首页异常可直达失败容器日志，并原路返回', async ({ page }) => {
  await page.goto('./#/dashboard');
  const attention = page.getByRole('region', { name: '需要处理' });
  await expect(attention).toContainText('部分运行');
  await attention.getByRole('link', { name: '查看 knowledge-base 异常日志' }).click();
  await expect(page).toHaveURL(/containerId=demo-wiki-api.*from=dashboard/);
  await expect(page.getByRole('heading', { name: '实时日志', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '页面导航' }).getByRole('button', { name: '返回运维总览' }).click();
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  // Opening the same destination in a new tab still knows where to return.
  const tab = await page.context().newPage();
  await tab.goto('./#/logs?projectId=knowledge-base&containerId=demo-wiki-api&from=dashboard');
  await tab.getByRole('navigation', { name: '页面导航' }).getByRole('button', { name: '返回运维总览' }).click();
  await expect(tab).toHaveURL(/#\/dashboard$/);
  await tab.close();
});

test('异常总览与服务筛选相连，筛选支持刷新、详情返回和前进', async ({ page }) => {
  await page.goto('./#/dashboard');
  await page.getByRole('region', { name: '需要处理' }).getByRole('link', { name: '查看全部' }).click();
  await expect(page.getByLabel('状态筛选', { exact: true })).toHaveValue('attention');
  await expect(page.locator('article[id^="project-"]')).toHaveCount(1);
  await page.getByRole('group', { name: '常用服务筛选' }).getByRole('button', { name: /全部项目/ }).click();
  await page.getByLabel('搜索服务项目').fill('redis');
  await page.getByLabel('状态筛选', { exact: true }).selectOption('managed');
  await page.getByLabel('项目排序').selectOption('name');
  await expect(page).toHaveURL(/q=redis.*filter=managed.*sort=name/);
  await page.reload();
  await expect(page.getByLabel('搜索服务项目')).toHaveValue('redis');
  await expect(page.locator('article[id^="project-"]')).toHaveCount(1);
  const card = page.locator('#project-cache');
  await card.locator('.service-project-card__toggle').click();
  await card.getByRole('link', { name: '实时日志', exact: true }).first().click();
  const nav = page.getByRole('navigation', { name: '页面导航' });
  await nav.getByRole('button', { name: '返回服务总览' }).click();
  await expect(page.getByLabel('搜索服务项目')).toHaveValue('redis');
  await expect(page.getByLabel('状态筛选', { exact: true })).toHaveValue('managed');
  await expect(page.getByLabel('项目排序')).toHaveValue('name');
  await nav.getByRole('button', { name: '前进到实时日志' }).click();
  await expect(page.getByRole('heading', { name: '实时日志', exact: true })).toBeVisible();
});

test('首次服务视图优先展示项目，概况可展开并记住偏好', async ({ page }) => {
  await page.goto('./#/services');
  const summary = page.getByRole('button', { name: /项目指标/ });
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await page.reload();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await summary.click();
  await page.getByRole('group', { name: '常用服务筛选' }).getByRole('button', { name: /我的收藏/ }).click();
  await expect(page.locator('article[id^="project-"]')).toHaveCount(1);
  await expect(page.locator('#project-knowledge-base')).toBeVisible();
});

test('最近事件进入对应记录页面，键盘可跳过全站导航', async ({ page, isMobile }) => {
  await page.goto('./#/dashboard');
  await page.getByRole('link', { name: '查看操作记录：保存配置' }).click();
  await expect(page).toHaveURL(/#\/events\?tab=operations$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/dashboard$/);
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  // The route's after-enter hook restores its saved scroll position. Clicking
  // during that restoration can move the target between pointerdown/up in WebKit.
  await expect(page.locator('.page-fade-enter-active,.page-fade-leave-active')).toHaveCount(0);
  await page.getByRole('link', { name: '查看告警记录：wiki-api 异常退出' }).click();
  await expect(page).toHaveURL(/#\/events$/);
  if (!isMobile) {
    await page.goto('./#/dashboard');
    // The app shell appears before the lazy route; Tab cannot land on a refresh
    // control until the dashboard has mounted and completed its initial load.
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await expect(page.locator('.page-fade-enter-active,.page-fade-leave-active')).toHaveCount(0);
    // The preview has its own banner, so focus the actual app's first control.
    const skip = page.getByRole('button', { name: '跳到主要内容' });
    await skip.focus();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeFocused();
  }
});

test('总览在窄屏、平板和宽屏下保持可操作，减少动态效果生效', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 768, 1024, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('./#/dashboard');
    await expect(page.getByRole('link', { name: '查看全部项目', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const logLink = page.getByRole('link', { name: '查看 knowledge-base 异常日志' });
    await logLink.scrollIntoViewIfNeeded();
    await expect(logLink).toBeInViewport();
    const transition = await page.locator('.overview-metric').first().evaluate(el => getComputedStyle(el).transitionDuration);
    expect(parseFloat(transition)).toBeLessThanOrEqual(0.001);
  }
});
