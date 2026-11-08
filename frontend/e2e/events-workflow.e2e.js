import { test, expect } from '@playwright/test';

async function installEventsFixture(page, { statsFailure = false } = {}) {
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(({ statsFailure }) => {
    const original = window.fetch;
    window.eventsFixture = {
      statsFailure, readFailure: false, failAfterWrite: false, blockedWrite: false, pruneFailure: false, blockedPrune: false,
      writes: [], reads: 0, statsReads: 0, releaseWrite: null, releasePrune: null,
      events: [
        { id: 701, title: '缓存连接失败', detail: '连接缓存时发生超时。'.repeat(80), status: 'open', severity: 'danger', eventType: 'alert', source: 'health-monitor', assetName: 'cache-service', createdAt: '2026-11-09T00:00:00Z', payload: { to: '/services?from=events' } },
        { id: 702, title: '应用部署完成', detail: '所有服务已通过检查', status: 'resolved', severity: 'info', eventType: 'deployment', source: 'compose', assetName: 'web-service', createdAt: '2026-11-08T23:00:00Z' },
      ],
    };
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const path = url.pathname;
      const method = init.method || 'GET';
      const f = window.eventsFixture;
      const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/v1/events/events/stats') {
        f.statsReads += 1;
        return f.statsFailure ? json({ message: '统计暂不可用' }, 503) : json({ stats: { total: f.events.length, open: f.events.filter(item => item.status === 'open').length, bySeverity: { danger: 1 }, byType: {} } });
      }
      if (path === '/api/v1/events/events' && method === 'GET') {
        f.reads += 1;
        if (f.readFailure) return json({ message: '刷新暂时失败' }, 503);
        const type = url.searchParams.get('eventType');
        const status = url.searchParams.get('status');
        return json({ events: f.events.filter(item => (!type || item.eventType === type) && (!status || item.status === status)) });
      }
      if (/\/api\/v1\/events\/events\/\d+$/.test(path) && method === 'PATCH') {
        const id = Number(path.split('/').pop());
        const body = JSON.parse(init.body);
        f.writes.push({ method, id, body });
        if (f.blockedWrite) await new Promise(resolve => { f.releaseWrite = resolve; });
        const event = f.events.find(item => item.id === id);
        Object.assign(event, body);
        if (f.failAfterWrite) f.readFailure = true;
        return json({ event });
      }
      if (path === '/api/v1/events/events/prune') {
        f.writes.push({ method, prune: true });
        if (f.blockedPrune) await new Promise(resolve => { f.releasePrune = resolve; });
        return f.pruneFailure ? json({ message: '清理暂不可用，请重试' }, 503) : json({ ok: true });
      }
      return original(input, init);
    };
  }, { statsFailure });
  await page.goto('./#/events');
  await expect(page.locator('.event-row')).toHaveCount(2);
}

test('刷新失败如实提示并保留记录，重试后恢复', async ({ page }) => {
  await installEventsFixture(page);
  await page.evaluate(() => { window.eventsFixture.readFailure = true; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('刷新暂时失败');
  await expect(page.locator('.event-row')).toHaveCount(2);
  await page.evaluate(() => { window.eventsFixture.readFailure = false; });
  await page.getByRole('button', { name: '重试加载', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('保存状态期间防重复，刷新失败也保留已确认结果并恢复键盘焦点', async ({ page }) => {
  await installEventsFixture(page);
  await page.getByRole('button', { name: '只看待处理' }).click();
  await expect(page.locator('.event-row')).toHaveCount(1);
  await page.evaluate(() => { window.eventsFixture.blockedWrite = true; window.eventsFixture.failAfterWrite = true; });
  const resolve = page.locator('.event-row').getByRole('button', { name: '解决', exact: true });
  await resolve.focus();
  await page.keyboard.press('Enter');
  await expect(resolve).toBeDisabled();
  await expect(page.locator('.event-row').getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
  await page.evaluate(() => window.eventsFixture.releaseWrite());
  await expect(page.locator('.event-feedback')).toContainText('已标记为已解决');
  await expect(page.locator('.event-feedback')).toBeFocused();
  await expect(page.locator('.event-feedback')).toBeInViewport();
  await expect(page.locator('.event-row')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('刷新暂时失败');
  expect(await page.evaluate(() => window.eventsFixture.writes)).toHaveLength(1);
});

test('历史清理等待完成且失败可在确认框重试', async ({ page }) => {
  await installEventsFixture(page);
  await page.evaluate(() => { window.eventsFixture.blockedPrune = true; window.eventsFixture.pruneFailure = true; });
  await page.getByRole('button', { name: '清理过期', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '清理过期事件' });
  await dialog.getByRole('button', { name: '清理', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '清理', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.eventsFixture.blockedPrune = false; window.eventsFixture.releasePrune(); });
  await expect(dialog.getByRole('alert')).toContainText('清理暂不可用');
  await page.evaluate(() => { window.eventsFixture.pruneFailure = false; });
  await dialog.getByRole('button', { name: '清理', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('搜索和返回保留上下文，长详情可键盘展开，统计失败可局部恢复', async ({ page }) => {
  await installEventsFixture(page, { statsFailure: true });
  await expect(page.locator('.event-stats-error')).toContainText('仍可处理下方事件');
  await page.evaluate(() => { window.eventsFixture.statsFailure = false; });
  await page.getByRole('button', { name: '重试统计', exact: true }).click();
  await expect(page.locator('.event-stats-error')).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: '搜索当前事件记录' });
  await search.fill('cache-service');
  await expect(page.locator('.event-row')).toHaveCount(1);
  const expand = page.getByRole('button', { name: '展开完整详情' });
  await expand.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '收起详情' })).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: '收起详情' }).click();
  await page.locator('.event-row').getByRole('link', { name: '查看来源' }).click();
  await expect(page).toHaveURL(/services\?from=events/);
  await page.getByRole('navigation', { name: '页面导航' }).getByRole('button', { name: '返回事件中心', exact: true }).click();
  await expect(search).toHaveValue('cache-service');
  await expect(page.locator('.event-row')).toHaveCount(1);
});

test('事件素材按屏幕加载，320px 可读可操作且支持减少动画', async ({ page, isMobile }) => {
  const requests = [];
  page.on('request', request => { if (/events-\d+.*\.webp/.test(request.url())) requests.push(request.url()); });
  await installEventsFixture(page);
  if (isMobile) {
    await expect(page.locator('.event-scene')).toBeHidden();
    expect(requests).toEqual([]);
  } else await expect(page.locator('.event-scene img')).toHaveClass('is-loaded');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const button = page.getByRole('button', { name: '展开完整详情' });
  expect(await button.locator('svg').evaluate(element => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(.001);
  await expect(button).toBeVisible();
  await expect(page.locator('.event-row').first().getByRole('button', { name: '解决', exact: true })).toBeVisible();
});
