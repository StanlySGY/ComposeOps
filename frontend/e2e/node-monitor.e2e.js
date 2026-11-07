import { test, expect } from '@playwright/test';

test('节点筛选、分组反馈及监控返回保留上下文', async ({ page }) => {
  await page.goto('./#/node-groups');
  const card = page.getByRole('article', { name: '节点 本机 · 示例' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('4 / 5');
  await page.getByRole('searchbox', { name: '搜索节点' }).fill('不存在');
  await expect(page.getByText('没有匹配的节点')).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索节点' }).fill('本机');
  await card.getByRole('combobox', { name: '设置节点 本机 · 示例 的分组' }).selectOption('edge');
  await expect(page.getByRole('region', { name: '边缘组' })).toContainText('本机 · 示例');
  await card.getByRole('link', { name: '监控', exact: true }).click();
  await expect(page).toHaveURL(/hostId=local/);
  await expect(page.getByRole('heading', { name: '面板运行环境', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '页面导航' }).getByRole('button', { name: '返回节点组管理' }).click();
  await expect(page.getByRole('searchbox', { name: '搜索节点' })).toHaveValue('本机');
  await expect(card.getByRole('combobox')).toHaveValue('edge');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('监控搜索排序、日志返回与历史定位连续可用', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/monitor?hostId=local&from=node-groups');
  await expect(page.getByRole('heading', { name: '面板运行环境', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索容器' }).fill('postgres');
  await expect(page.locator('.monitor-table tbody tr')).toHaveCount(1);
  await page.getByRole('combobox', { name: '容器排序' }).selectOption('cpu');
  await expect(page).toHaveURL(/sort=cpu/);
  await page.getByRole('link', { name: '查看 postgres 日志' }).click();
  await expect(page).toHaveURL(/containerId=demo-postgres/);
  await page.getByRole('navigation', { name: '页面导航' }).getByRole('button', { name: '返回实时监控' }).click();
  await expect(page.getByRole('searchbox', { name: '搜索容器' })).toHaveValue('postgres');
  await page.getByRole('button', { name: '查看 postgres 历史指标' }).click();
  await expect(page.getByRole('combobox', { name: '选择监控项目' })).toHaveValue('knowledge-base');
  await expect(page.getByRole('combobox', { name: '选择监控容器' })).toHaveValue('demo-postgres');
  await page.getByRole('tab', { name: '实时', exact: true }).click();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.locator('.monitor-table tbody tr')).toHaveCount(5);
  await expect(page.locator('main')).not.toContainText('undefined%');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('全部节点的历史页明确要求选择具体节点，键盘可以返回实时', async ({ page }) => {
  await page.goto('./#/monitor?hostId=all&tab=history');
  await expect(page.getByText('选择一个节点查看历史', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '选择监控项目' })).toHaveCount(0);
  const history = page.getByRole('tab', { name: '历史指标', exact: true });
  await history.focus(); await history.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: '实时', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: '实时', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  await expect(page.locator('#panel-environment-metrics')).toBeVisible();
  await page.getByRole('button', { name: '收起指标', exact: true }).click();
  await expect(page.locator('#panel-environment-metrics')).toBeHidden();
  await page.getByRole('checkbox', { name: '自动刷新' }).uncheck();
  await expect(page.getByText('已暂停自动刷新')).toBeVisible();
});
