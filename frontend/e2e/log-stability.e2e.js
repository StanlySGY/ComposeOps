import { test, expect } from '@playwright/test';

async function openLogs(page, aggregate = false) {
  await page.goto('./#/services');
  await expect(page.locator('#project-knowledge-base')).toBeVisible();
  await page.evaluate((aggregate) => {
    const message = WebSocket.prototype.message;
    window.__logSockets = [];
    WebSocket.prototype.message = function (value) {
      if (/\/ws\/(logs|aggregated-logs)/.test(this.url) && !window.__logSockets.includes(this)) window.__logSockets.push(this);
      return message.call(this, value);
    };
    location.hash = '/logs?projectId=knowledge-base' + (aggregate ? '' : '&containerId=demo-wiki-api');
  }, aggregate);
  await expect.poll(() => page.evaluate(() => window.__logSockets.length)).toBeGreaterThan(0);
  return page.locator('.log-pane-body').first();
}
async function send(page, start, count, json = false) {
  await page.evaluate(({ start, count, json }) => {
    for (let i = start; i < start + count; i++) window.__logSockets.at(-1).message({ type: 'stdout', data: json && i === 100 ? JSON.stringify({ marker: 'expanded-reading-target', rows: Array.from({ length: 35 }, (_, n) => `detail-${n}`) }) : `stable-line-${i}` });
  }, { start, count, json });
}
async function anchor(region) {
  return region.evaluate(el => {
    const top = el.getBoundingClientRect().top + el.clientTop;
    const row = [...el.querySelectorAll('[data-log-id]')].find(row => row.getBoundingClientRect().bottom > top);
    return row ? { id: row.dataset.logId, offset: Math.round(row.getBoundingClientRect().top - top) } : null;
  });
}
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

test('展开 JSON 后滚出再返回仍保持展开，滚动不留白且能回到最新', async ({ page }) => {
  const region = await openLogs(page);
  await send(page, 0, 400, true);
  await expect(page.getByText('stable-line-399', { exact: true })).toBeVisible();
  await region.focus(); await page.keyboard.press('Home');
  await region.evaluate(el => { el.scrollTop = 2500; el.dispatchEvent(new Event('scroll')); });
  const toggle = page.getByRole('button', { name: /展开 JSON 日志：.*expanded-reading-target/ });
  await expect(toggle).toBeAttached();
  await toggle.scrollIntoViewIfNeeded(); await toggle.click();
  await expect(page.locator('.json-block.open')).toContainText('detail-34');
  await region.evaluate(el => { el.scrollTop = 8000; el.dispatchEvent(new Event('scroll')); });
  await expect(page.locator('.json-block.open')).toHaveCount(0);
  await region.evaluate(el => { el.scrollTop = 2500; el.dispatchEvent(new Event('scroll')); });
  await expect(page.locator('.json-block.open')).toHaveCount(1);
  await page.locator('.json-toggle[aria-expanded="true"]').scrollIntoViewIfNeeded();
  await expect(page.locator('.json-block.open')).toBeVisible();
  await settle(page);
  const before = await anchor(region);
  await send(page, 400, 200);
  await expect(page.getByRole('button', { name: '200 条新日志 · 回到最新' })).toBeVisible();
  expect(await anchor(region)).toEqual(before);
  await page.screenshot({ path: `/tmp/composeops-stability-json-${test.info().project.name}.png` });
  await page.getByRole('button', { name: /条新日志 · 回到最新/ }).click();
  await expect.poll(() => region.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(3);
  await expect(page.getByText('stable-line-599', { exact: true })).toBeVisible();
  const search = page.getByRole('textbox', { name: '搜索和过滤实时日志' });
  await search.fill('stable-line');
  await expect(page.locator('.json-block.open')).toHaveCount(0);
  await search.fill('expanded-reading-target');
  await expect(page.locator('.json-block.open')).toBeVisible();
  const button = page.locator('.json-toggle');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('聚合选择与全选清空使用新连接，分栏与合并保留 JSON 展开状态', async ({ page }) => {
  await openLogs(page, true);
  const options = page.getByRole('button', { name: '日志选项', exact: true });
  if (await options.isVisible()) await options.click();
  await page.locator('.container-chip').first().click();
  await expect.poll(() => page.evaluate(() => window.__logSockets.length)).toBe(2);
  expect(await page.evaluate(() => new URL(window.__logSockets.at(-1).url).searchParams.get('containers'))).toBeTruthy();
  await page.getByRole('button', { name: '全选可见', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__logSockets.length)).toBe(3);
  await page.getByRole('button', { name: '清空', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__logSockets.length)).toBe(4);
  expect(await page.evaluate(() => new URL(window.__logSockets.at(-1).url).searchParams.get('containers'))).toBe('');
  expect(await page.evaluate(() => window.__logSockets.filter(socket => socket.readyState === 1).length)).toBe(1);
  await page.evaluate(() => window.__logSockets.at(-1).message({ type: 'line', data: { containerId: 'demo-wiki-api', containerName: 'wiki-api', type: 'stdout', data: '{"detail":"split-preserved"}' } }));
  await page.getByRole('button', { name: /展开 JSON 日志：.*split-preserved/ }).click();
  await page.getByRole('button', { name: '按容器分栏显示(快捷键 s)', exact: true }).click();
  await expect(page.locator('.json-block.open')).toContainText('split-preserved');
  await page.getByRole('button', { name: '合并为单列(快捷键 s)', exact: true }).click();
  await expect(page.locator('.json-block.open')).toContainText('split-preserved');
});

test('持续高吞吐与5000条淘汰保持阅读行，过期后给出提示', async ({ page }) => {
  test.setTimeout(60000);
  const region = await openLogs(page);
  await send(page, 0, 5000);
  await expect(page.getByText('stable-line-4999', { exact: true })).toBeVisible();
  await region.focus(); await page.keyboard.press('Home');
  await region.evaluate(el => { el.scrollTop = 50000; el.dispatchEvent(new Event('scroll')); });
  await settle(page);
  const before = await anchor(region);
  expect(before).not.toBeNull();
  // 1000 lines per second over two seconds, crossing the bounded-buffer limit.
  await page.evaluate(async () => {
    for (let batch = 0; batch < 40; batch++) {
      for (let i = 0; i < 50; i++) window.__logSockets.at(-1).message({ type: 'stdout', data: `burst-${batch * 50 + i}` });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });
  await expect(page.getByText('仅保留最近 5000 条', { exact: true })).toBeVisible();
  // The chosen row expired after 2000 arrivals; never silently jump to unrelated history.
  await expect(page.getByText('正在阅读的日志已超出保留范围，已定位到最早保留的日志。', { exact: false })).toBeVisible();
  await region.evaluate(el => { el.scrollTop = 30000; el.dispatchEvent(new Event('scroll')); });
  await settle(page);
  const retained = await anchor(region);
  await send(page, 7000, 200);
  await expect(page.getByRole('button', { name: /2200 条新日志/ })).toBeVisible();
  expect(await anchor(region)).toEqual(retained);
  expect(await region.locator('[data-log-id]').count()).toBeLessThan(100);
  await page.getByRole('button', { name: /条新日志 · 回到最新/ }).click();
  await expect(page.getByText('stable-line-7199', { exact: true })).toBeVisible();
  await expect(page.locator('.log-history-notice')).toHaveCount(0);
});

test('断线保留搜索和内容，网络恢复重连，主动断开与离开页面不复活', async ({ page }) => {
  await openLogs(page);
  const search = page.getByRole('textbox', { name: '搜索和过滤实时日志' });
  await send(page, 0, 5);
  await search.fill('stable-line');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.getByText('网络离线', { exact: true })).toBeVisible();
  await expect(page.getByText('stable-line-4', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await expect(page.locator('.log-reconnect-notice')).toContainText('可能重复');
  await expect(search).toHaveValue('stable-line');
  expect(await page.evaluate(() => window.__logSockets.length)).toBe(2);
  // A server-side disconnect uses backoff; immediate retry is usable without losing history.
  await page.evaluate(() => window.__logSockets.at(-1).close());
  await expect(page.getByRole('button', { name: '立即重试', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '立即重试', exact: true }).click();
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '断开', exact: true }).click();
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
  expect(await page.evaluate(() => window.__logSockets.filter(socket => socket.readyState === 1).length)).toBe(0);
  await page.evaluate(() => { location.hash = '/services'; });
  await expect(page.locator('#project-knowledge-base')).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
  expect(await page.evaluate(() => window.__logSockets.filter(socket => socket.readyState === 1).length)).toBe(0);
});
