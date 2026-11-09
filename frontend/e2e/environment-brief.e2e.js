import { test, expect } from '@playwright/test';

test('总览项目入口可键盘定位异常，返回后保留上下文', async ({ page }) => {
  await page.goto('./#/dashboard');
  const projects = page.getByRole('navigation', { name: '快速定位项目' });
  await expect(projects.getByRole('link')).toHaveCount(4);
  const first = projects.getByRole('link').first();
  await expect(first).toHaveAccessibleName('定位项目 knowledge-base：部分运行');
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/services\?focus=knowledge-base&from=dashboard/);
  await expect(page.locator('#project-knowledge-base .project-detail')).toBeVisible();
  await page.getByRole('navigation', { name: '页面导航' }).getByRole('button', { name: '返回运维总览' }).click();
  await expect(projects).toBeVisible();
  await expect(page).toHaveURL(/#\/dashboard$/);
});

test('手机、平板和桌面都有状态摘要及可触达的项目入口', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('./#/dashboard');
    const brief = page.locator('.environment-brief');
    await expect(brief.getByRole('link', { name: '全部 4 个' })).toBeVisible();
    await expect(brief.locator('.brief-counts')).toContainText('运行正常');
    const project = page.getByRole('link', { name: '定位项目 knowledge-base：部分运行' });
    await project.scrollIntoViewIfNeeded();
    await expect(project).toBeInViewport();
    const box = await project.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('总览指标在新标签打开后仍能返回来源页面', async ({ page }) => {
  await page.goto('./#/dashboard');
  const href = await page.getByRole('link', { name: '查看 CPU 实时监控' }).getAttribute('href');
  const tab = await page.context().newPage();
  await tab.goto(new URL(href, page.url()).href);
  await tab.getByRole('navigation', { name: '页面导航' }).getByRole('button', { name: '返回运维总览' }).click();
  await expect(tab).toHaveURL(/#\/dashboard$/);
  await tab.close();
});
