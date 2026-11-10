import { test, expect } from '@playwright/test';
test('可靠变更评审、固定目标审批和镜像回退结果', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/reliability?tab=changes');
  await page.getByRole('button', { name: '评审镜像变更', exact: true }).click();
  await page.getByRole('textbox', { name: '已准备的新镜像' }).fill('wiki:v2');
  await page.getByRole('button', { name: '生成变更评审' }).click();
  await page.getByRole('button', { name: '审阅并批准变更' }).click();
  const dialog = page.getByRole('dialog', { name: '批准固定镜像变更' });
  await expect(dialog).toContainText('knowledge-base / wiki-api'); await expect(dialog).toContainText('sha256:');
  await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: '批准并执行' }).click();
  await expect(page.getByText('原镜像已恢复并验收', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]);
});
test('应用恢复计划创建、隔离演练证据和暂停', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/reliability?tab=recovery');
  await page.getByRole('button', { name: '新建恢复计划', exact: true }).click();
  await page.getByRole('combobox', { name: '纳管应用' }).selectOption('local:knowledge-base');
  await page.getByRole('checkbox', { name: 'knowledge-base_data' }).check();
  await page.getByRole('button', { name: '保存恢复计划' }).click();
  await page.getByRole('button', { name: '运行隔离演练' }).click();
  await expect(page.getByText('隔离演练达标', { exact: true })).toBeVisible();
  await expect(page.getByText('归档解包已验证', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '暂停计划' }).click();
  await expect(page.getByRole('button', { name: '运行隔离演练' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]);
});
test('效果复盘保留证据来源且解释验证局限', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/reliability?tab=reports');
  await page.getByRole('button', { name: '生成 AI 复盘' }).click();
  await expect(page.getByText('复盘已生成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看证据 summary' }).click();
  const dialog = page.getByRole('dialog', { name: '复盘引用的原始证据' });
  await expect(dialog).toContainText('incidents');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]);
});
