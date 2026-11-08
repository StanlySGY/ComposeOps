import { test, expect } from '@playwright/test';

async function installSettingsFixture(page) {
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    window.settingsFixture = { aiFailure: false, updatesBlocked: false, mcpFailure: false, mcpSaveFailure: false, calls: [], writes: [], releaseUpdates: null };
    window.fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const f = window.settingsFixture;
      const method = init.method || 'GET';
      f.calls.push({ path, method });
      if (method !== 'GET') f.writes.push({ path, body: init.body });
      const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/v1/ai/config' && f.aiFailure) return json({ error: 'AI 配置暂时不可用' }, 503);
      if (path === '/api/v1/personal/notifications' && method === 'GET') return json({ enabled: true, intervalSeconds: 60, memoryThreshold: 85, dockerStorageThresholdGb: 15, channels: [] });
      if (path === '/api/v1/ops/notifications/events') return json({ events: ['exit', 'oom'] });
      if (path === '/api/v1/personal/updates' && method === 'GET') {
        if (f.updatesBlocked) await new Promise(resolve => { f.releaseUpdates = resolve; });
        return json({ autoEnabled: true, intervalHours: 72 });
      }
      if (path === '/api/v1/system/mcp' && method === 'GET') {
        if (f.mcpFailure) return json({ error: 'MCP 配置读取超时' }, 503);
        return json({ enabled: true, mode: 'all', toolsExported: 12, httpUrl: '/mcp', sseUrl: '/mcp/sse', sessionCount: 0 });
      }
      if (path === '/api/v1/system/mcp' && method === 'POST' && f.mcpSaveFailure) return json({ error: 'MCP 设置保存失败，请重试' }, 503);
      if (path === '/api/v1/system/mcp/reveal-token') return json({ token: 'fixture-only-not-a-real-secret' });
      return original(input, init);
    };
  });
}

test('AI 配置失败只影响本面板，通知与维护仍可操作且草稿不会被刷新覆盖', async ({ page }) => {
  await installSettingsFixture(page);
  await page.evaluate(() => { window.settingsFixture.aiFailure = true; });
  await page.goto('./#/settings?tab=notifications');
  await expect(page.getByRole('spinbutton', { name: '通知轮询间隔（秒）' })).toHaveValue('60');
  const exit = page.getByRole('checkbox', { name: '容器崩溃退出' });
  await exit.uncheck();
  await page.evaluate(() => window.dispatchEvent(new Event('composeops:refresh')));
  await page.getByRole('button', { name: '维护', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '镜像更新检查间隔（小时）' })).toHaveValue('72');
  await page.getByRole('button', { name: '通知', exact: true }).click();
  await expect(exit).not.toBeChecked();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.locator('[data-settings-load="ai"]')).toContainText('AI 配置暂时不可用');
  await expect(page.getByText('还没有 AI 渠道', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存通用设置', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.settingsFixture.aiFailure = false; });
  await page.getByRole('button', { name: '重新读取AI 设置' }).click();
  await expect(page.getByRole('button', { name: '保存通用设置', exact: true })).toBeEnabled();
});

test('慢更新策略不开放默认值，完成后显示服务器设置', async ({ page }) => {
  await installSettingsFixture(page);
  await page.evaluate(() => { window.settingsFixture.updatesBlocked = true; });
  await page.goto('./#/settings?tab=maintenance');
  const save = page.getByRole('button', { name: '保存更新策略', exact: true });
  await expect(page.locator('[data-settings-load="updates"]')).toContainText('正在读取');
  await expect(save).toBeDisabled();
  await expect(page.getByRole('spinbutton', { name: '镜像更新检查间隔（小时）' })).toBeDisabled();
  await page.evaluate(() => window.settingsFixture.releaseUpdates());
  await expect(save).toBeEnabled();
  await expect(page.getByRole('spinbutton', { name: '镜像更新检查间隔（小时）' })).toHaveValue('72');
  expect(await page.evaluate(() => window.settingsFixture.writes)).toEqual([]);
});

test('MCP 深链直接加载，错误可重试，复制失败如实反馈且窄屏不溢出', async ({ page }) => {
  await installSettingsFixture(page);
  await page.evaluate(() => { window.settingsFixture.mcpFailure = true; });
  await page.goto('./#/settings?tab=mcp');
  await expect(page.locator('[data-settings-load="mcp"]')).toContainText('读取超时');
  await expect(page.getByRole('checkbox', { name: '启用 MCP 服务' })).toBeDisabled();
  await page.evaluate(() => { window.settingsFixture.mcpFailure = false; });
  await page.getByRole('button', { name: '重新读取MCP 配置' }).click();
  await expect(page.getByRole('checkbox', { name: '启用 MCP 服务' })).toBeChecked();
  await expect(page.getByRole('combobox', { name: '暴露范围' })).toHaveValue('all');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('剪贴板权限未开放'); } } }));
  await page.getByRole('button', { name: '复制 Token', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('剪贴板权限未开放');
  await expect(page.getByText('Token 已复制到剪贴板', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 360, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('MCP 即时设置保存失败后恢复已确认值', async ({ page }) => {
  await installSettingsFixture(page);
  await page.evaluate(() => { window.settingsFixture.mcpSaveFailure = true; });
  await page.goto('./#/settings?tab=mcp');
  const enabled = page.getByRole('checkbox', { name: '启用 MCP 服务' });
  await expect(enabled).toBeChecked();
  // 点击后预期因保存失败立即回滚；uncheck 自带的“必须变为未勾选”断言与此相反。
  await enabled.click();
  await expect(page.getByRole('alert')).toContainText('MCP 设置保存失败');
  await expect(enabled).toBeChecked();
  const mode = page.getByRole('combobox', { name: '暴露范围' });
  await mode.selectOption('readonly');
  await expect(mode).toHaveValue('all');
  expect(await page.evaluate(() => window.settingsFixture.writes.filter(call => call.path === '/api/v1/system/mcp').map(call => JSON.parse(call.body)))).toEqual([
    { enabled: false, mode: 'all' }, { enabled: true, mode: 'readonly' },
  ]);
});
