import { test, expect } from '@playwright/test';

test('市场插画按屏幕加载，筛选空态与清空操作连贯', async ({ page, isMobile }) => {
  const requests = [];
  page.on('request', request => { if (/applications-\d+.*\.webp/.test(request.url())) requests.push(request.url()); });
  await page.goto('./#/marketplace');
  await expect(page.locator('.template-card')).toHaveCount(4);
  if (isMobile) {
    await expect(page.locator('.market-intro-art')).toBeHidden();
    expect(requests).toEqual([]);
  } else {
    await expect(page.locator('.market-intro-art img')).toHaveClass('is-loaded');
    expect(requests).toHaveLength(1);
  }
  await page.getByRole('textbox', { name: '搜索应用模板' }).fill('no-such-application');
  await expect(page.getByText('没有匹配的模板')).toBeVisible();
  await expect(page.locator('.empty-state img')).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选条件' }).click();
  await expect(page.locator('.template-card')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('插画失败时起步卡仍可用，只预填草稿并保留键盘焦点', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/*assistant-*.webp', route => route.abort());
  await page.goto('./#/agent');
  await expect(page.locator('.agent-welcome-art .scene-fallback')).toBeVisible();
  const start = page.getByRole('button', { name: '排查服务异常 先读状态与日志，再给出建议' });
  await start.click();
  const input = page.getByRole('textbox', { name: '向 Agent 发送消息', exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(/不要执行修改/);
  await expect(page.locator('.agent-message')).toHaveCount(0);
  expect(await start.evaluate(element => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThan(0.01);
  await page.setViewportSize({ width: 360, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(input).toBeInViewport();
});

test('首次引导素材加载，入口跳转与关闭后返回保持连续', async ({ page, isMobile }) => {
  await page.goto('./#/dashboard');
  if (isMobile) await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByRole('button', { name: '入门指南', exact: true }).click();
  const guide = page.getByRole('dialog', { name: '从这里开始使用 ComposeOps' });
  await expect(guide.locator('img.is-loaded')).toBeVisible();
  await expect(guide).toContainText('AI 是可选能力');
  await guide.getByRole('link', { name: '设置项目权限' }).click();
  await expect(page).toHaveURL(/settings\?tab=mounts/);
  await expect(guide).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/dashboard/);
  await expect(guide).toHaveCount(0);
});

test('拓扑选择空态使用观测插画，选择项目后让位给实际数据', async ({ page }) => {
  await page.goto('./#/topology');
  const select = page.getByRole('combobox', { name: '选择项目', exact: true });
  await expect(select.locator('option')).toHaveCount(4);
  await select.selectOption('');
  const illustration = page.locator('.empty-state [data-illustration="observability"]');
  await expect(illustration.locator('img')).toHaveClass('is-loaded');
  await expect(illustration).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByText('选择项目查看拓扑', { exact: true })).toBeVisible();
  await select.selectOption({ label: 'knowledge-base' });
  await expect(illustration).toHaveCount(0);
  await expect(page.getByText('服务架构图谱', { exact: true })).toBeVisible();
});
