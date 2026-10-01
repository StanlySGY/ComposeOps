import { test, expect } from '@playwright/test';

test('静态预览子路径可打开，审批前不改变状态，拒绝/确认/重置均生效', async ({ page }) => {
  const external = [], errors = [];
  page.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:4174/ComposeOps/')) external.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await expect(page.getByText('交互预览 · 全部为示例数据，不连接 Docker 或 AI 服务')).toBeVisible();
  await page.getByRole('button', { name: '让 AI 分析这个问题' }).click();
  await page.getByRole('button', { name: '开始演示排查' }).click();
  await expect(page.getByText('等待管理员确认')).toBeVisible();
  await page.getByRole('button', { name: '查看并确认模拟修复' }).click();
  const dialog = page.getByRole('dialog', { name: '确认模拟修复' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(page.getByText('已取消模拟操作，示例服务状态保持原样。')).toBeVisible();
  await page.getByRole('button', { name: '查看并确认模拟修复' }).click();
  await dialog.getByRole('button', { name: '确认模拟修复' }).click();
  await expect(page.getByText('模拟修复完成，检查通过')).toBeVisible();
  await page.getByRole('button', { name: '查看服务状态' }).click();
  const wiki = page.locator('.service-row').filter({ hasText: 'wiki-api' });
  await expect(wiki.getByText('运行中', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重置演示' }).click();
  await expect(wiki.getByText('异常退出')).toBeVisible();
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('服务搜索、日志、备份演练、安装弹窗和窄屏布局可用', async ({ page }) => {
  await page.goto('./#services');
  await page.getByRole('textbox', { name: '搜索示例服务' }).fill('missing-service');
  await expect(page.getByText('没有找到匹配的服务。试试搜索 redis 或 wiki。')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索示例服务' }).fill('redis');
  await expect(page.locator('.service-row')).toHaveCount(1);
  await page.getByRole('button', { name: '查看日志' }).click();
  await expect(page.getByRole('dialog')).toContainText('以下为预设示例，不是实时服务器日志。');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('navigation', { name: '演示导航' }).getByRole('link', { name: '备份演练' }).click();
  await page.getByRole('button', { name: '模拟还原演练', exact: true }).click();
  await expect(page.getByText('模拟演练通过 · 128 个文件')).toBeVisible();
  await page.getByRole('button', { name: '安装到我的服务器' }).click();
  await expect(page.getByRole('dialog')).toContainText('deploy/compose.yml');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
