import { test, expect } from '@playwright/test';
test.use({ timezoneId: 'Asia/Shanghai' });
async function install(page, flags = {}) {
  await page.goto('./#/dashboard'); await expect(page.locator('.app-header')).toBeVisible();
  await page.evaluate(flags => {
    const original = window.fetch;
    const f = window.historyFixture = { calls: [], failHistory: false, failUsage: false, failDetail: false, holdHistory: false, holdDetail: false, version: 1, aborted: 0, ...flags };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const plan = version => ({ id: version, user_message: `审计任务 ${version}`, status: 'failed', created_at: '2026-11-28 20:00:00', plan_json: '{}', result_json: '{}' });
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/v1/ai/agent/usage') {
        return f.failUsage ? json({ message: '用量服务暂不可用' }, 503) : json({ days: 30, totals: { calls: 7, total_tokens: 345 }, byModel: [] });
      }
      if (url.pathname === '/api/v1/ai/agent/executions') {
        const id = url.searchParams.get('planId'), version = id ? Number(id) : f.version;
        f.calls.push(id || 'list'); init.signal?.addEventListener('abort', () => f.aborted++, { once: true });
        if (id && f.holdDetail) await new Promise(resolve => { f.releaseDetail = resolve; });
        if (!id && f.holdHistory) await new Promise(resolve => { f.releaseHistory = resolve; });
        if (id && f.failDetail || !id && f.failHistory) return json({ message: id ? '工具详情读取失败' : '历史服务暂不可用' }, 503);
        if (id) return json({ plan: plan(version), executions: [{ id: 11, tool_name: 'container.inspect-' + 'long-name-'.repeat(8), status: 'failed', error: '真实工具失败仍然保留', result: 'false', duration_ms: 0 }] });
        return json({ plans: [plan(version)], executions: [] });
      }
      return original(input, init);
    };
  }, flags);
  await page.goto('./#/agent/history');
  await expect(page.getByRole('heading', { name: 'Agent 执行历史', exact: true })).toBeVisible();
}

test('详情独立读取、失败与零值可见，UTC 和窄屏布局正确', async ({ page }, testInfo) => {
  await install(page); await page.setViewportSize({ width: 320, height: 900 });
  await expect(page.getByText('创建: 2026/11/29 04:00:00', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '详情', exact: true }).click();
  await expect(page.getByText('真实工具失败仍然保留', { exact: true })).toBeVisible();
  await expect(page.getByText('false', { exact: true })).toBeVisible(); await expect(page.getByText('0ms', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '收起', exact: true })).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => window.historyFixture.calls.includes('1'))).toBe(true);
  expect(await page.locator('.app-main').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.getByText('真实工具失败仍然保留', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('agent-history-320.png'), fullPage: true });
});

test('首轮失败不假装空历史，重试可恢复且用量保留', async ({ page }) => {
  await install(page, { failHistory: true });
  await expect(page.getByRole('alert').filter({ hasText: '历史服务暂不可用' })).toBeVisible();
  await expect(page.getByText('暂无执行记录', { exact: true })).toHaveCount(0);
  await expect(page.getByText('LLM 调用', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.historyFixture.failHistory = false; });
  await page.getByRole('button', { name: '重新读取历史', exact: true }).click();
  await expect(page.getByRole('heading', { name: '审计任务 1', exact: true })).toBeVisible();
});

test('部分用量失败和详情失败均可原位重试', async ({ page }) => {
  await install(page, { failUsage: true, failDetail: true });
  await expect(page.getByRole('heading', { name: '审计任务 1', exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '用量读取失败' })).toBeVisible();
  await page.evaluate(() => { window.historyFixture.failUsage = false; });
  await page.getByRole('button', { name: '重新读取用量', exact: true }).click();
  await expect(page.getByText('LLM 调用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '详情', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '工具详情读取失败' })).toBeVisible();
  await page.evaluate(() => { window.historyFixture.failDetail = false; }); await page.getByRole('button', { name: '重试详情', exact: true }).click();
  await expect(page.getByText('真实工具失败仍然保留', { exact: true })).toBeVisible();
});

test('缓存页离开取消历史读取，返回忽略旧结果', async ({ page }) => {
  await install(page); await expect(page.getByRole('heading', { name: '审计任务 1', exact: true })).toBeVisible();
  await page.evaluate(() => { window.historyFixture.holdHistory = true; window.dispatchEvent(new Event('composeops:refresh')); });
  await expect.poll(() => page.evaluate(() => typeof window.historyFixture.releaseHistory)).toBe('function');
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.historyFixture.aborted)).toBeGreaterThan(0);
  await page.evaluate(() => { window.historyFixture.holdHistory = false; window.historyFixture.version = 2; });
  await page.goto('./#/agent/history'); await expect(page.getByRole('heading', { name: '审计任务 2', exact: true })).toBeVisible();
  await page.evaluate(async () => { window.historyFixture.releaseHistory(); await new Promise(resolve => setTimeout(resolve, 100)); });
  await expect(page.getByRole('heading', { name: '审计任务 1', exact: true })).toHaveCount(0);
});

test('关闭详情取消加载，迟到结果不展开；切节点清除旧详情', async ({ page }) => {
  await install(page, { holdDetail: true }); await page.getByRole('button', { name: '详情', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.historyFixture.releaseDetail)).toBe('function');
  await page.getByRole('button', { name: '收起', exact: true }).click();
  expect(await page.evaluate(() => window.historyFixture.aborted)).toBeGreaterThan(0);
  await page.evaluate(async () => { window.historyFixture.releaseDetail(); window.historyFixture.holdDetail = false; await new Promise(resolve => setTimeout(resolve, 100)); });
  await expect(page.getByText('真实工具失败仍然保留', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '详情', exact: true }).click(); await expect(page.getByText('真实工具失败仍然保留', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.historyFixture.version = 2; window.dispatchEvent(new Event('composeops:host-changed')); });
  await expect(page.getByRole('heading', { name: '审计任务 2', exact: true })).toBeVisible();
  await expect(page.getByText('真实工具失败仍然保留', { exact: true })).toHaveCount(0);
});
