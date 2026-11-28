import { test, expect } from '@playwright/test';

for (const scenario of [
  { route: 'services', selector: '.service-project-card', prefix: '/api/v1/projects' },
  { route: 'workflows', selector: '.workflow-definition', prefix: '/api/v1/workflows' },
]) {
  test(`${scenario.route} 退出再登录且读取失败时不展示旧账号缓存`, async ({ page }) => {
    await page.goto('./#/dashboard');
    await expect(page.locator('.app-header')).toBeVisible();
    await page.evaluate(({ prefix }) => {
      const original = window.fetch;
      const state = window.storeAuthFixture = { authenticated: true, nextIdentity: false, failRead: false };
      const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        if (path === '/api/v1/auth/logout') { state.authenticated = false; return json({ ok: true }); }
        if (path === '/api/v1/auth/login') { state.authenticated = state.nextIdentity = state.failRead = true; return json({ ok: true }); }
        if (path === '/api/v1/auth/status') return json({ authenticated: state.authenticated, setupRequired: false,
          principal: state.authenticated ? { id: state.nextIdentity ? 'second' : 'first', role: 'admin', enabled: true } : null });
        if (path.startsWith(prefix) && state.failRead) return json({ message: '新账号读取暂时失败' }, 503);
        if (path === '/api/v1/workflows/definitions') return json({ definitions: [{ id: 'private-workflow', name: '旧账号专属工作流', enabled: true, nodes: [], triggerType: 'manual' }] });
        if (path === '/api/v1/workflows/instances') return json({ instances: [] });
        return original(input, init);
      };
      // Keep the same no-network preview, but suppress its canned snapshots;
      // this scenario verifies a real request failure, not a successful WS reload.
      const OriginalSocket = window.WebSocket;
      window.WebSocket = class extends OriginalSocket {
        message(value) { if (!this.url.includes('/ws/containers')) super.message(value); }
      };
    }, scenario);
    await page.goto(`./#/${scenario.route}`);
    const rows = page.locator(scenario.selector);
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible();
    await page.getByLabel('账号', { exact: true }).fill('second');
    await page.getByLabel('密码', { exact: true }).fill('fictional-second-password');
    await page.getByRole('button', { name: '安全登录', exact: true }).click();
    await expect(page.locator('.app-header')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: '新账号读取暂时失败' }).first()).toBeVisible();
    await expect(rows).toHaveCount(0);
    await page.evaluate(() => { window.storeAuthFixture.failRead = false; });
    await page.getByRole('button', { name: scenario.route === 'services' ? '刷新' : '重试工作流', exact: true }).first().click();
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
  });
}

test('服务页首次读取完成前离开，迟到初始化不能开启后台实时连接', async ({ page }) => {
  await page.goto('./#/dashboard'); await expect(page.locator('.app-header')).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch, OriginalSocket = window.WebSocket;
    const f = window.initialServiceFixture = { connections: 0 };
    window.fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/projects' && !f.release) await new Promise(resolve => { f.release = resolve; });
      return original(input, init);
    };
    window.WebSocket = class extends OriginalSocket {
      constructor(url, ...args) { super(url, ...args); if (String(url).includes('/ws/containers')) f.connections++; }
    };
  });
  await page.goto('./#/services');
  await expect.poll(() => page.evaluate(() => typeof window.initialServiceFixture.release)).toBe('function');
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(async () => { window.initialServiceFixture.release(); await new Promise(resolve => setTimeout(resolve, 200)); });
  expect(await page.evaluate(() => window.initialServiceFixture.connections)).toBe(0);
  await page.goto('./#/services'); await expect(page.locator('.service-project-card').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.initialServiceFixture.connections)).toBe(1);
});

test('本人修改密码后保留当前远程节点和已确认列表', async ({ page }) => {
  await page.goto('./#/dashboard'); await expect(page.locator('.app-header')).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/hosts' && (!init.method || init.method === 'GET')) return json({ hosts: [{ id: 'remote', name: '当前远程节点', type: 'ssh', status: 'connected', active: true }] });
      if (path === '/api/v1/auth/password') return json({ ok: true });
      return original(input, init);
    };
  });
  await page.goto('./#/settings?tab=personal');
  await expect(page.getByRole('button', { name: '切换 Docker 节点', exact: true })).toContainText('当前远程节点');
  await page.getByLabel('当前密码', { exact: true }).fill('fictional-current-password');
  await page.getByLabel('新密码', { exact: true }).fill('fictional-next-password');
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(page.getByText('管理员密码已修改，其他会话已退出', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '切换 Docker 节点', exact: true })).toContainText('当前远程节点');
  await expect(page.getByLabel('当前密码', { exact: true })).toHaveValue('');
});
