import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./#/dashboard');
  await expect(page.locator('.app-header')).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/cmdb/topology') return new Response(JSON.stringify({
        assets: [
          { id: 'host:local', kind: 'host', name: 'local', displayName: '生命周期验收节点', hostId: 'local' },
          { id: 'project:app', kind: 'project', name: 'app', displayName: '生命周期验收项目', hostId: 'local', status: 'running' },
          { id: 'volume:local:data', kind: 'volume', name: 'data', hostId: 'local' },
        ],
        relations: [{ sourceId: 'project:app', targetId: 'host:local', relation: 'runs_on' }],
      }), { headers: { 'content-type': 'application/json' } });
      return original(input, init);
    };
  });
});

async function openGraph(page) {
  await page.goto('./#/cmdb?tab=graph');
  const graph = page.getByRole('img', { name: '运维资产关系图谱' });
  await expect(graph.locator('[data-key]').first()).toBeVisible();
  return graph;
}
async function pointer(page, type) {
  if (type === 'pointerdown') {
    await page.locator('.ios-card-node').first().hover();
    await page.mouse.down();
  } else if (type === 'pointerup') await page.mouse.up();
  else await page.evaluate(type => window.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse' })), type);
}

test('指针取消与窗口失焦均立即结束拖动，后续抬手不残留抓取状态', async ({ page }) => {
  const graph = await openGraph(page);
  await pointer(page, 'pointerdown'); await expect(graph.locator('.ios-grabbing')).toHaveCount(1);
  await pointer(page, 'pointercancel'); await expect(graph.locator('.ios-grabbing')).toHaveCount(0);
  await pointer(page, 'pointerup'); await expect(graph.locator('.ios-grabbing')).toHaveCount(0);
  await pointer(page, 'pointerdown'); await expect(graph.locator('.ios-grabbing')).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await expect(graph.locator('.ios-grabbing')).toHaveCount(0);
});

test('拖动中离开缓存页清理资源，返回后画布仍能正常缩放', async ({ page }) => {
  let graph = await openGraph(page); await pointer(page, 'pointerdown'); await expect(graph.locator('.ios-grabbing')).toHaveCount(1);
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, pointerType: 'touch', clientX: 150, clientY: 150 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'touch' }));
  });
  await expect(page.locator('.runtime-error-bar')).toHaveCount(0);
  graph = await openGraph(page); await expect(graph.locator('.ios-grabbing')).toHaveCount(0);
  const before = await graph.locator(':scope > g').first().getAttribute('transform');
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect(graph.locator(':scope > g').first()).not.toHaveAttribute('transform', before);
  await page.getByRole('button', { name: '自由拓扑', exact: true }).click();
  await page.getByRole('button', { name: '分层架构', exact: true }).click();
  await expect(graph.locator('[data-key]').first()).toBeVisible(); await expect(page.locator('.runtime-error-bar')).toHaveCount(0);
});
