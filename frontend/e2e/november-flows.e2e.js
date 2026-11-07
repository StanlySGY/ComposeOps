import { expect, test } from '@playwright/test';

test('折叠服务卡快捷入口与返回来源连续可用', async ({ page }) => {
  await page.goto('./#/services');
  const actions = page.getByRole('navigation', { name: 'knowledge-base 快捷操作' });
  await expect(actions).toBeVisible();
  await actions.getByRole('link', { name: '聚合日志' }).click();
  await expect(page.getByRole('heading', { name: '实时日志', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回服务列表' }).click();
  await expect(actions).toBeVisible();
  await actions.getByRole('link', { name: 'AI 诊断' }).click();
  await expect(page.getByRole('button', { name: '返回服务列表' })).toBeVisible();
  await page.getByRole('button', { name: '返回服务列表' }).click();
  await expect(actions).toBeVisible();
});

test('统一 Agent 预填会自动打开并在抽屉与工作台保留草稿', async ({ page }) => {
  await page.goto('./#/services');
  await expect(page.getByRole('heading', { name: '服务总览', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('composeops:agent-prompt', { detail: { prompt: '从服务页检查数据库' } })));
  await expect(page.locator('.agent-drawer-composer textarea')).toHaveValue('从服务页检查数据库');
  await page.locator('.agent-drawer-head').getByRole('button', { name: '关闭 Agent', exact: true }).click();
  await page.evaluate(() => { location.hash = '/agent'; });
  await expect(page.locator('.agent-composer textarea')).toHaveValue('从服务页检查数据库');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('composeops:agent-prompt', { detail: { prompt: '在工作台继续排查' } })));
  await expect(page.locator('.agent-composer textarea')).toHaveValue('在工作台继续排查');
  await expect(page.locator('.agent-drawer-layer')).toHaveCount(0);
  await expect(page.locator('.agent-composer textarea')).toBeFocused();
});

test('旧操作地址进入正确标签，事件来源可返回', async ({ page }) => {
  await page.goto('./#/operations?tab=jobs');
  await expect(page.locator('#event-tab-operations')).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => { location.hash = '/services?focus=knowledge-base&from=events'; });
  await page.getByRole('button', { name: '返回事件中心' }).click();
  await expect(page.getByRole('heading', { name: '事件中心', exact: true })).toBeVisible();
});
