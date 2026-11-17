import { test, expect } from '@playwright/test';

test('AI 值守展示证据、固定目标审批与未通过的恢复验收', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/oncall?incident=demo-incident');
  await expect(page.getByRole('heading', { name: 'AI 值守', exact: true })).toBeVisible();
  await expect(page.getByText('容器异常退出（离线示例）', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'AI 分析证据' }).click();
  await expect(page.locator('.agent-markdown')).toContainText('单纯重启未必解决配置错误');
  await page.getByRole('button', { name: '生成重启处置' }).click();
  await page.getByRole('button', { name: '审阅并批准' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('demo-wiki-api');
  await expect(dialog).toContainText('仅重启此容器一次');
  await dialog.getByRole('button', { name: '批准并入队' }).click();
  await expect(page.getByText('模拟重启已完成，但数据库连接仍失败；不能标记恢复。', { exact: true })).toBeVisible();
  await expect(page.getByText('0 / 3 次连续健康观测', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
