import { test, expect } from '@playwright/test';

test('事件状态、筛选、回退与来源构成可回看的处理过程', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/events');
  const row = page.locator('.event-row');
  await expect(row).toContainText('待处理');
  await expect(row).toContainText('knowledge-base');
  await row.getByRole('button', { name: '解决', exact: true }).click();
  await expect(row).toContainText('已解决');
  await expect(row.getByRole('button', { name: '解决', exact: true })).toHaveCount(0);
  await page.getByLabel('筛选事件状态').selectOption('open');
  await expect(page.getByText('没有匹配的事件')).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('筛选事件状态')).toHaveValue('');
  await expect(row).toContainText('已解决');
  await row.getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(row).toContainText('待处理');
  await page.getByRole('group', { name: '筛选事件类型' }).getByRole('button', { name: '定时任务', exact: true }).click();
  await expect(page).toHaveURL(/type=cron/);
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选', exact: true }).first().click();
  await expect(row).toHaveCount(1);
  await row.getByRole('link', { name: '日志', exact: true }).click();
  await expect(page).toHaveURL(/from=events/);
  await expect(page.getByRole('heading', { name: '实时日志', exact: true })).toBeVisible();
  await page.goBack();
  await expect(row).toContainText('待处理');
  expect(errors).toEqual([]);
});

test('事件窄屏正文可读，统计与 Agent 历史没有缺失字段', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('./#/events');
  const row = page.locator('.event-row');
  await expect(row).toContainText('wiki-api');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const content = await row.locator('.event-detail').boundingBox();
  expect(content.width).toBeGreaterThan(180);
  await expect(row.locator('.event-actions')).toBeVisible();
  await page.goto('./#/agent/history');
  await expect(page.locator('main')).toContainText('最近 30 天');
  await expect(page.locator('main')).not.toContainText('undefined');
  await page.goto('./#/ops-center');
  await expect(page.locator('main')).not.toContainText('Agent 审计轨迹读取失败');
});
