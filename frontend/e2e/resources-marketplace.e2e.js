import { test, expect } from '@playwright/test';

function errorsOn(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

test('资源筛选、隐藏选择、精确确认与删除结果形成完整流程', async ({ page }) => {
  const errors = errorsOn(page);
  await page.goto('./#/resources');
  await page.getByRole('checkbox', { name: '选择资源 example/wiki-api:2.2', exact: true }).check();
  await page.getByRole('searchbox', { name: '搜索存储资源' }).fill('worker');
  await expect(page.getByText('含 1 项被筛选隐藏')).toBeVisible();
  const selectAll = page.getByRole('checkbox', { name: '全选可删除资源' });
  await expect(selectAll).not.toBeChecked();
  await selectAll.check();
  await page.getByRole('button', { name: '批量删除 (2)', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('list', { name: '待删除资源' })).toContainText('example/wiki-api:2.2');
  await expect(dialog).toContainText('example/worker:0.9');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByText('已选择 2 项', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '批量删除 (2)', exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByText(/已删除 2 项资源/)).toBeVisible();
  await page.getByRole('button', { name: '重置筛选', exact: true }).first().click();
  await expect(page.getByRole('checkbox', { name: '选择资源 example/wiki-api:2.2', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看资源 example/wiki-api:2.3', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('资源详情、键盘标签、返回导航与窄屏触控均可用', async ({ page }) => {
  const errors = errorsOn(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('./#/resources?tab=networks');
  await page.getByRole('button', { name: '查看资源 sandbox_previous', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('demo-net-sandbox');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: /网络/ }).focus();
  await page.keyboard.press('End');
  await expect(page).toHaveURL(/tab=backups/);
  await expect(page.getByRole('searchbox', { name: '搜索存储资源' })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('tab', { name: /网络/ })).toHaveAttribute('aria-selected', 'true');
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await page.getByRole('searchbox', { name: '搜索存储资源' }).boundingBox();
    expect(bounds.width).toBeGreaterThan(120);
  }
  expect(errors).toEqual([]);
});

test('应用市场收藏筛选与详情到部署再返回的上下文连贯', async ({ page }) => {
  const errors = errorsOn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/marketplace');
  await expect(page.locator('.template-card')).toHaveCount(4);
  await page.getByRole('button', { name: /我的收藏/ }).click();
  await expect(page.locator('.template-card')).toHaveCount(1);
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索应用模板' }).fill('Nginx');
  await expect(page.locator('.template-card')).toHaveCount(1);
  await page.getByRole('button', { name: '查看', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Compose 配置');
  await page.getByRole('button', { name: '配置并部署', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'HTTP 端口' })).toBeVisible();
  await page.getByRole('button', { name: '返回详情', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('Compose 配置');
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索应用模板' })).toHaveValue('Nginx');
  await expect(page.locator('.template-card')).toHaveCount(1);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
