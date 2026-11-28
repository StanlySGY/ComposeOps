import { test, expect } from '@playwright/test';
test.use({ timezoneId: 'Asia/Shanghai' });

async function install(page) {
  await page.goto('./#/dashboard'); await expect(page.locator('.app-header')).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    const f = window.timelineFixture = { calls: [], hold: false, failGitops: false, next: false, aborted: false };
    const recent = new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const older = new Date(Date.now() - 3 * 3600_000).toISOString();
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href), path = url.pathname;
      if (path === '/api/v1/personal/operations') {
        const next = f.next; f.calls.push(path);
        init.signal?.addEventListener('abort', () => { f.aborted = true; }, { once: true });
        if (f.hold) await new Promise(resolve => { f.release = resolve; });
        return json({ operations: [{ id: 1, action: next ? '新节点操作' : '近期 UTC 操作', status: 'success', createdAt: recent }] });
      }
      if (path === '/api/v1/ai/agent/executions') return json({ plans: [] });
      if (path === '/api/v1/ops/alert-events') return json({ events: [] });
      if (path === '/api/v1/cron/history') return json({ history: [] });
      if (path === '/api/v1/events/events' && url.searchParams.get('eventType') === 'gitops') {
        f.calls.push(path); if (f.failGitops) return json({ message: '历史服务不可用' }, 503);
        return json({ events: [
          { id: 11, title: 'GitOps 同步完成', severity: 'info', status: 'resolved', createdAt: recent },
          { id: 12, title: 'GitOps 回滚失败', severity: 'warning', status: 'open', createdAt: older, detail: '合成真实失败记录' },
        ] });
      }
      return original(input, init);
    };
  });
  await page.goto('./#/events?tab=timeline');
  await expect(page.getByRole('combobox', { name: '时间范围', exact: true })).toBeVisible();
}

test('真实 GitOps 多次操作都可见，UTC 时间和筛选摘要一致', async ({ page }, testInfo) => {
  await install(page);
  await expect(page.getByText('GitOps 同步完成', { exact: true })).toBeVisible(); await expect(page.getByText('GitOps 回滚失败', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '时间范围', exact: true }).selectOption('1h');
  await expect(page.getByText('近期 UTC 操作', { exact: true })).toBeVisible(); await expect(page.getByText('GitOps 回滚失败', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '显示 2 / 3' })).toBeVisible();
  await page.getByRole('combobox', { name: '来源筛选', exact: true }).selectOption('gitops');
  await expect(page.getByRole('status').filter({ hasText: '显示 1 / 3' })).toBeVisible();
  await expect(page.locator('.metric-tile').filter({ hasText: '事件总数' })).toContainText('1');
  await page.screenshot({ path: testInfo.outputPath('timeline-filtered.png'), fullPage: true });
});

test('局部失败保留成功来源，原位重试恢复历史', async ({ page }) => {
  await install(page); await page.evaluate(() => { window.timelineFixture.failGitops = true; window.dispatchEvent(new Event('composeops:refresh')); });
  const alert = page.getByRole('alert').filter({ hasText: '部分事件加载失败' }); await expect(alert).toContainText('GitOps 历史');
  await expect(page.getByText('近期 UTC 操作', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.timelineFixture.failGitops = false; }); await alert.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(alert).toHaveCount(0); await expect(page.getByText('GitOps 回滚失败', { exact: true })).toBeVisible();
});

test('切换节点时取消旧聚合，新记录不被旧结果覆盖', async ({ page }) => {
  await install(page); await page.evaluate(() => { window.timelineFixture.hold = true; window.dispatchEvent(new Event('composeops:refresh')); });
  await expect.poll(() => page.evaluate(() => typeof window.timelineFixture.release)).toBe('function');
  await page.evaluate(() => { window.timelineFixture.hold = false; window.timelineFixture.next = true; window.dispatchEvent(new Event('composeops:host-changed')); });
  await expect(page.getByText('新节点操作', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.timelineFixture.aborted)).toBe(true);
  await page.evaluate(async () => { window.timelineFixture.release(); await new Promise(resolve => setTimeout(resolve, 150)); });
  await expect(page.getByText('近期 UTC 操作', { exact: true })).toHaveCount(0);
});

test('离开时间线取消请求，返回只展示新请求结果', async ({ page }) => {
  await install(page); await page.evaluate(() => { window.timelineFixture.hold = true; window.dispatchEvent(new Event('composeops:refresh')); });
  await expect.poll(() => page.evaluate(() => typeof window.timelineFixture.release)).toBe('function');
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.timelineFixture.aborted)).toBe(true);
  await page.evaluate(() => { window.timelineFixture.hold = false; window.timelineFixture.next = true; window.timelineFixture.release(); });
  await page.goto('./#/events?tab=timeline'); await expect(page.getByText('新节点操作', { exact: true })).toBeVisible();
  await expect(page.getByText('近期 UTC 操作', { exact: true })).toHaveCount(0);
});
