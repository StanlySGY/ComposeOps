import { test, expect } from '@playwright/test';

async function openCommands(page) {
  await page.getByRole('button', { name: '打开快速跳转' }).click();
  return page.getByRole('dialog', { name: '快速跳转与操作' });
}

async function navigate(page, label) {
  const dialog = await openCommands(page);
  await dialog.getByRole('combobox').fill(label);
  await dialog.getByRole('option').filter({ hasText: label }).first().click();
}

async function failFavorites(page) {
  await page.goto('./#/services');
  await expect(page.locator('#project-cache')).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    let sequence = 0;
    window.fetch = (...args) => String(args[0]).includes('/preferences') && args[1]?.method === 'PATCH'
      ? Promise.resolve(new Response(JSON.stringify({ message: `交互测试错误 ${++sequence}` }), { status: 503 }))
      : original(...args);
  });
  return page.locator('#project-cache').getByRole('button', { name: '收藏项目', exact: true });
}

test('最近页面按成功使用排序，刷新保留，清空后继续键盘搜索', async ({ page }) => {
  await page.goto('./#/dashboard');
  await navigate(page, '应用市场');
  await expect(page).toHaveURL(/#\/marketplace$/);
  await navigate(page, '项目纳管');
  await expect(page).toHaveURL(/#\/settings\?tab=mounts$/);
  await page.reload();
  const dialog = await openCommands(page);
  const recent = dialog.getByRole('group', { name: '最近使用', exact: true });
  await expect(recent.getByRole('option')).toHaveCount(2);
  await expect(recent.getByRole('option').first()).toContainText('项目纳管');
  await expect(dialog.getByRole('option')).toHaveCount(10);
  await dialog.getByRole('button', { name: '清空最近使用的页面' }).click();
  await expect(recent).toHaveCount(0);
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('长期任务');
  await input.press('Enter');
  await expect(page).toHaveURL(/#\/tickets$/);
});

test('消息焦点暂停计时，关闭后返回原操作入口', async ({ page }) => {
  const favorite = await failFavorites(page);
  await page.clock.install();
  await favorite.click();
  const card = page.locator('.toast-card');
  await expect(card).toContainText('交互测试错误 1');
  await card.getByRole('button', { name: '关闭提示' }).focus();
  await expect(card.locator('.toast-progress')).toHaveCSS('animation-play-state', 'paused');
  await page.clock.fastForward(10000);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '关闭提示' }).press('Enter');
  await page.clock.runFor(300);
  await expect(card).toHaveCount(0);
  await expect(favorite).toBeFocused();
});

test('排队消息逐批显示，手动关闭可以提前查看下一条', async ({ page, isMobile }) => {
  const favorite = await failFavorites(page);
  await page.clock.install();
  for (let i = 0; i < 6; i++) {
    await favorite.click();
    await expect(favorite).toBeEnabled();
  }
  await expect(page.locator('.toast-card')).toHaveCount(isMobile ? 1 : 3);
  await expect(page.locator('.toast-card').last()).toContainText(`交互测试错误 ${isMobile ? 1 : 3}`);
  await page.locator('.toast-card').first().getByRole('button').click();
  await page.clock.runFor(300);
  await expect(page.locator('.toast-card').last()).toContainText(`交互测试错误 ${isMobile ? 2 : 4}`);
  // Move focus and pointer away before allowing the remaining messages to expire.
  await favorite.focus(); await page.mouse.move(0, 0);
  await page.clock.runFor(8000);
  await expect(page.locator('.toast-card')).toHaveCount(isMobile ? 1 : 2);
  await expect(page.locator('.toast-card').first()).toContainText(`交互测试错误 ${isMobile ? 3 : 5}`);
  await page.clock.runFor(isMobile ? 32300 : 8300);
  await expect(page.locator('.toast-card')).toHaveCount(0);
});

test('窄屏最近页面面板没有横向溢出，减少动画设置隐藏倒计时动效', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const favorite = await failFavorites(page);
  await favorite.click();
  await expect(page.locator('.toast-progress')).toBeHidden();
  await navigate(page, '应用市场');
  const dialog = await openCommands(page);
  await expect(dialog.getByRole('group', { name: '最近使用', exact: true })).toBeVisible();
  await expect(dialog).not.toHaveClass(/modal-pop-enter/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  // Landscape/keyboard-sized viewport: controls remain accessible and only the
  // results list scrolls, regardless of how many recent commands are present.
  await page.setViewportSize({ width: 568, height: 320 });
  await expect.poll(async () => {
    const bounds = await dialog.boundingBox();
    return bounds.y >= 0 && bounds.y + bounds.height <= 320;
  }).toBe(true);
  await expect(dialog.getByRole('combobox')).toBeVisible();
  const closeBox = await dialog.getByRole('button', { name: '关闭命令面板' }).boundingBox();
  expect(closeBox.width).toBeGreaterThanOrEqual(44);
  expect(closeBox.height).toBeGreaterThanOrEqual(44);
  await dialog.getByRole('combobox').press('End');
  await dialog.getByRole('combobox').press('ArrowUp');
  await expect(dialog.locator('[aria-selected="true"]')).toBeInViewport();
  await dialog.getByRole('button', { name: '关闭命令面板' }).click();
  await expect(dialog).toHaveCount(0);
});
