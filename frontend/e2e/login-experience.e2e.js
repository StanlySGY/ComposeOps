import { test, expect } from '@playwright/test';

// Auth stays inside the fictional preview transport, including submitted passwords.
async function loginFixture(page, { setup = false, failFirst = false, pauseLogin = false, missingPrincipal = false, holdOldRequest = false } = {}) {
  await page.addInitScript(({ setup, failFirst, pauseLogin, missingPrincipal, holdOldRequest }) => {
    let transport = window.fetch;
    let authenticated = false;
    window.loginAttempts = 0;
    window.confirmIdentity = !missingPrincipal;
    const loginRelease = pauseLogin ? new Promise(resolve => { window.releaseLogin = resolve; }) : Promise.resolve();
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const intercepted = async (input, options) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/system/infrastructure' && holdOldRequest && !window.releaseOldRequest) {
        await new Promise(resolve => { window.releaseOldRequest = resolve; });
        return json({ message: '上一次会话已经过期' }, 401);
      }
      if (path === '/api/v1/auth/status') return json({
        authenticated, setupRequired: setup && !authenticated,
        principal: authenticated && window.confirmIdentity ? { id: 'admin', username: 'admin', displayName: '预览管理员', role: 'admin', enabled: true } : null,
      });
      if (path === '/api/v1/auth/login' || path === '/api/v1/auth/setup') {
        window.loginAttempts += 1;
        if (failFirst && window.loginAttempts === 1) return json({ message: '密码不正确，请重新输入' }, 401);
        await loginRelease;
        authenticated = true;
        return json({ ok: true });
      }
      return transport(input, options);
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => intercepted, set: next => { transport = next; } });
  }, { setup, failFirst, pauseLogin, missingPrincipal, holdOldRequest });
}

test('登录视觉按屏幕加载，密码显示与失败后键盘重试连贯', async ({ page, isMobile }) => {
  const artRequests = [];
  page.on('request', request => { if (request.url().includes('login-control-plane-')) artRequests.push(request.url()); });
  await loginFixture(page, { failFirst: true });
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('欢迎回来');
  await expect(page.getByLabel('账号', { exact: true })).toHaveValue('admin');
  await page.screenshot({ path: test.info().outputPath('login.png'), animations: 'disabled' });
  const password = page.getByLabel('密码', { exact: true });
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
  await page.getByLabel('密码', { exact: true }).fill('fictional-password-123');
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
  const password = page.getByLabel('密码', { exact: true });
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

test('验证期间重复提交不重复请求，返回缺少身份时可重试确认', async ({ page }) => {
  await loginFixture(page, { pauseLogin: true, missingPrincipal: true });
  await page.goto('./#/dashboard');
  await page.getByLabel('密码', { exact: true }).fill('fictional-password-123');
  await page.getByRole('button', { name: '安全登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '正在验证…', exact: true })).toBeDisabled();
  await page.locator('form').evaluate(form => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(await page.evaluate(() => window.loginAttempts)).toBe(1);
  await page.evaluate(() => window.releaseLogin());
  await expect(page.getByRole('heading', { name: '暂时无法连接 ComposeOps' })).toBeVisible();
  await expect(page.locator('.app-header')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '我的服务' })).toHaveCount(0);
  await page.evaluate(() => { window.confirmIdentity = true; });
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.locator('.app-header')).toBeVisible();
  expect(await page.evaluate(() => window.loginAttempts)).toBe(1);
});

test('会话失效后迟到的初始化身份不会重新打开工作台', async ({ page }) => {
  await page.addInitScript(() => {
    let transport = window.fetch;
    const intercepted = async (input, options) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/auth/status') {
        await new Promise(resolve => { window.releaseStatus = resolve; });
        return new Response(JSON.stringify({ authenticated: true, setupRequired: false, principal: { id: 'admin', role: 'admin', enabled: true } }), { headers: { 'Content-Type': 'application/json' } });
      }
      return transport(input, options);
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => intercepted, set: next => { transport = next; } });
  });
  await page.goto('./#/dashboard');
  await expect.poll(() => page.evaluate(() => typeof window.releaseStatus)).toBe('function');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('composeops:unauthorized')));
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await page.evaluate(async () => { window.releaseStatus(); await new Promise(resolve => setTimeout(resolve, 100)); });
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.locator('.app-header')).toHaveCount(0);
});

test('重新登录后旧页面的迟到 401 不会再次退出新会话', async ({ page }) => {
  await loginFixture(page, { holdOldRequest: true });
  await page.goto('./#/dashboard');
  await page.getByLabel('密码', { exact: true }).fill('fictional-password-123');
  await page.getByRole('button', { name: '安全登录', exact: true }).click();
  await expect(page.locator('.app-header')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.releaseOldRequest)).toBe('function');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('composeops:unauthorized')));
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill('new-fictional-password');
  await page.getByRole('button', { name: '安全登录', exact: true }).click();
  await expect(page.locator('.app-header')).toBeVisible();
  await page.evaluate(async () => { window.releaseOldRequest(); await new Promise(resolve => setTimeout(resolve, 100)); });
  await expect(page.locator('.app-header')).toBeVisible();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toHaveCount(0);
  expect(await page.evaluate(() => window.loginAttempts)).toBe(2);
});
