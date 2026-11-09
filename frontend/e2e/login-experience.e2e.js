import { test, expect } from '@playwright/test';

// Auth stays inside the fictional preview transport, including submitted passwords.
async function loginFixture(page, { setup = false, failFirst = false } = {}) {
  await page.addInitScript(({ setup, failFirst }) => {
    let transport = window.fetch;
    let authenticated = false;
    window.loginAttempts = 0;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const intercepted = async (input, options) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/auth/status') return json({ authenticated, setupRequired: setup && !authenticated });
      if (path === '/api/v1/auth/login' || path === '/api/v1/auth/setup') {
        window.loginAttempts += 1;
        if (failFirst && window.loginAttempts === 1) return json({ message: '密码不正确，请重新输入' }, 400);
        authenticated = true;
        return json({ ok: true });
      }
      return transport(input, options);
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => intercepted, set: next => { transport = next; } });
  }, { setup, failFirst });
}

test('登录视觉按屏幕加载，密码显示与失败后键盘重试连贯', async ({ page, isMobile }) => {
  const artRequests = [];
  page.on('request', request => { if (request.url().includes('login-control-plane-')) artRequests.push(request.url()); });
  await loginFixture(page, { failFirst: true });
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('欢迎回来');
  await page.screenshot({ path: test.info().outputPath('login.png'), animations: 'disabled' });
  const password = page.getByLabel('管理员密码', { exact: true });
  await password.fill('fictional-password-123');
  await page.getByRole('button', { name: '显示密码', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'password');
  await password.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '显示密码', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '安全登录', exact: true })).toBeFocused();
  if (isMobile) {
    await expect(page.locator('.login-intro')).toBeHidden();
    expect(artRequests).toEqual([]);
  } else {
    await expect(page.locator('.login-illustration img')).toBeVisible();
    await expect.poll(() => page.locator('.login-illustration img').evaluate(image => image.naturalWidth)).toBeGreaterThan(1);
    expect(artRequests).toHaveLength(1);
  }
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('密码不正确');
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await password.fill('correct-fictional-password');
  await password.press('Enter');
  await expect(page.locator('.app-header')).toBeVisible();
  expect(await page.evaluate(() => window.loginAttempts)).toBe(2);
});

test('初始化校验保留表单，匹配密码后可进入工作台', async ({ page }) => {
  await loginFixture(page, { setup: true });
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('创建管理员');
  await page.getByLabel('管理员密码', { exact: true }).fill('fictional-password-123');
  await page.getByLabel('再次输入管理员密码', { exact: true }).fill('different-password-123');
  await page.getByRole('button', { name: '完成初始化', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('两次输入的密码不一致');
  expect(await page.evaluate(() => window.loginAttempts)).toBe(0);
  await page.getByLabel('再次输入管理员密码', { exact: true }).fill('fictional-password-123');
  await page.getByRole('button', { name: '完成初始化', exact: true }).click();
  await expect(page.locator('.app-header')).toBeVisible();
});

test('装饰素材不可用时仍能登录，减少动态效果与窄屏布局生效', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/*login-control-plane-*.webp', route => route.abort());
  await loginFixture(page);
  await page.goto('./#/dashboard');
  const password = page.getByLabel('管理员密码', { exact: true });
  if ((await page.viewportSize()).width >= 1024) {
    await expect(page.locator('.login-art-fallback')).toBeVisible();
    await expect(page.locator('.login-illustration')).toHaveCount(0);
  }
  await password.fill('fictional-password-123');
  expect(await page.locator('.login-card').evaluate(card => parseFloat(getComputedStyle(card).transitionDuration))).toBeLessThan(0.01);
  await page.setViewportSize({ width: 360, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '安全登录', exact: true })).toBeInViewport();
  await password.press('Enter');
  await expect(page.locator('.app-header')).toBeVisible();
});
