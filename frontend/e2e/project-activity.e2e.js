import { test, expect } from '@playwright/test';

const drawer = page => page.getByRole('dialog', { name: 'cache', exact: true });
const gate = page => page.getByRole('dialog', { name: '恢复配置版本', exact: true });
async function install(page) {
  await page.goto('./#/services');
  await expect(page.locator('#project-cache')).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    window.activityFixture = { failure: false, restoreFailure: false, blocked: false, release: null, writes: [],
      operations: [
        { id: 'succeeded', action: 'up', status: 'success', detail: 'Container cache-redis Started', createdAt: '2026-11-09T00:00:00Z' },
        { id: 'failed', action: 'pull', status: 'failed', detail: 'registry unavailable\n镜像源暂不可用', createdAt: '2026-11-08T23:00:00Z' },
      ],
      backups: [{ id: 501, filePath: '/srv/compose/cache/compose.yml', reason: 'save', createdAt: '2026-11-09T00:00:00Z', size: 100 }],
    };
    window.fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const f = window.activityFixture;
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/v1/projects/cache/activity') return f.failure ? json({ message: '活动读取暂不可用' }, 503) : json({ operations: f.operations, backups: f.backups });
      if (path === '/api/v1/projects/cache/backups/501/restore' && init.method === 'POST') {
        f.writes.push(path);
        if (f.blocked) await new Promise(resolve => { f.release = resolve; });
        return f.restoreFailure ? json({ message: '恢复暂不可用，请重试' }, 503) : json({ ok: true });
      }
      return original(input, init);
    };
  });
  const card = page.locator('#project-cache');
  if (await card.locator('.service-project-card__toggle').getAttribute('aria-expanded') !== 'true') await card.locator('.service-project-card__toggle').click();
}
async function open(page) { await page.locator('#project-cache').getByRole('button', { name: '活动', exact: true }).click(); await expect(drawer(page)).toBeVisible(); }
async function chooseRestore(page) {
  await drawer(page).getByRole('tab', { name: /配置版本/ }).click();
  await drawer(page).locator('.version-card').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(gate(page)).toBeVisible();
}

test('活动读取失败可重试，刷新失败保留已加载时间线', async ({ page }) => {
  await install(page);
  await page.evaluate(() => { window.activityFixture.failure = true; });
  await open(page);
  await expect(drawer(page).getByRole('alert')).toContainText('活动读取暂不可用');
  await expect(drawer(page).getByText('该项目暂无操作记录', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.activityFixture.failure = false; });
  await drawer(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect(drawer(page).locator('.activity-item')).toHaveCount(2);
  await page.evaluate(() => { window.activityFixture.failure = true; });
  await drawer(page).getByRole('button', { name: '刷新', exact: true }).click();
  await expect(drawer(page).getByRole('alert')).toContainText('活动读取暂不可用');
  await expect(drawer(page).locator('.activity-item')).toHaveCount(2);
});

test('标签键盘切换，详情和恢复取消遵循逐层返回及焦点恢复', async ({ page }) => {
  await install(page); await open(page);
  const activity = drawer(page).getByRole('tab', { name: /活动/ });
  const versions = drawer(page).getByRole('tab', { name: /配置版本/ });
  await activity.focus(); await page.keyboard.press('ArrowRight');
  await expect(versions).toBeFocused(); await expect(versions).toHaveAttribute('aria-selected', 'true');
  await drawer(page).locator('.version-card').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(gate(page)).toBeVisible(); await page.keyboard.press('Escape');
  await expect(gate(page)).toHaveCount(0); await expect(drawer(page)).toBeVisible();
  await versions.focus(); await page.keyboard.press('Home');
  await expect(activity).toBeFocused();
  await drawer(page).locator('.activity-item').first().click();
  await expect(page.getByRole('dialog', { name: /启动项目 ·/ })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(drawer(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator('#project-cache').getByRole('button', { name: '活动', exact: true })).toBeFocused();
});

test('恢复错误保留确认并可重试，成功保留文件状态与下一步', async ({ page }) => {
  await install(page); await open(page);
  await page.evaluate(() => { window.activityFixture.blocked = true; window.activityFixture.restoreFailure = true; });
  await chooseRestore(page);
  await expect(gate(page)).toContainText('不会自动更新容器');
  await gate(page).getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(gate(page).getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(gate(page)).toBeVisible();
  await page.evaluate(() => { window.activityFixture.blocked = false; window.activityFixture.release(); });
  await expect(gate(page).getByRole('alert')).toContainText('恢复暂不可用');
  await page.evaluate(() => { window.activityFixture.restoreFailure = false; window.activityFixture.failure = true; });
  await gate(page).getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(gate(page)).toHaveCount(0);
  await expect(drawer(page)).toContainText('尚未应用到容器');
  await expect(drawer(page).locator('.activity-restore-result')).toBeInViewport();
  await expect(drawer(page).getByRole('alert')).toContainText('活动读取暂不可用');
  expect(await page.evaluate(() => window.activityFixture.writes)).toHaveLength(2);
  await expect(page.getByText('配置版本已成功回滚并生效', { exact: true })).toHaveCount(0);
  await drawer(page).getByRole('button', { name: '返回项目应用配置', exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator('#project-cache .service-project-card__toggle')).toHaveAttribute('aria-expanded', 'true');
});

test('换节点关闭旧活动抽屉，迟到恢复不在新上下文报成功', async ({ page }) => {
  await install(page); await open(page);
  await page.evaluate(() => { window.activityFixture.blocked = true; });
  await chooseRestore(page); await gate(page).getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(gate(page).getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('composeops:host-changed')));
  await expect(drawer(page)).toHaveCount(0);
  await page.evaluate(() => window.activityFixture.release());
  await expect(page.getByText('配置版本已成功回滚并生效', { exact: true })).toHaveCount(0);
  await expect(page.locator('.activity-restore-result')).toHaveCount(0);
});

test('320px 活动状态与版本动作清晰，减少动画下布局仍稳定', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await install(page); await open(page);
  await expect(drawer(page)).toContainText('执行成功');
  await expect(drawer(page)).toContainText('执行失败');
  await expect(drawer(page)).not.toContainText('Invalid Date');
  await page.screenshot({ path: testInfo.outputPath('activity-mobile.png') });
  await drawer(page).getByRole('tab', { name: /配置版本/ }).click();
  await expect(drawer(page).getByText('compose.yml', { exact: true })).toBeVisible();
  await drawer(page).locator('.activity-version-path summary').click();
  await expect(drawer(page).getByText('/srv/compose/cache/compose.yml', { exact: true })).toBeVisible();
  await drawer(page).locator('.activity-version-path summary').click();
  await expect(drawer(page).locator('.version-card').getByRole('button', { name: '恢复', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('versions-mobile.png') });
  await drawer(page).getByRole('link', { name: '打开编辑器', exact: true }).click();
  await expect(page).toHaveURL(/#\/compose\?projectId=cache/);
  await page.getByRole('navigation', { name: '页面导航' }).getByRole('button', { name: '返回服务总览' }).click();
  await expect(page.locator('#project-cache')).toBeVisible();
});

test('离开缓存页面释放抽屉和滚动锁，迟到恢复不污染返回状态', async ({ page }) => {
  await install(page); await open(page);
  await page.evaluate(() => { window.activityFixture.blocked = true; });
  await chooseRestore(page); await gate(page).getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(gate(page).getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.evaluate(() => { location.hash = '#/events'; });
  await expect(page.getByRole('heading', { name: '事件中心', exact: true })).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  await page.evaluate(() => window.activityFixture.release());
  await page.goBack();
  await expect(page.getByRole('heading', { name: '服务总览', exact: true })).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator('.activity-restore-result')).toHaveCount(0);
});
