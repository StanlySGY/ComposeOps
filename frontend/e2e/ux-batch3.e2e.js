import { test, expect } from '@playwright/test';

// Install before the preview adapter. Requests still stay entirely in the offline fixture transport.
async function patchFixtureFetch(page, mode) {
  await page.addInitScript((mode) => {
    let transport = window.fetch;
    const intercepted = async (input, options) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const response = await transport(input, options);
      if (mode === 'slow' && path === '/api/v1/system/metrics') await new Promise(resolve => setTimeout(resolve, 2500));
      if (mode === 'slow' && path === '/api/v1/personal/maintenance/usage') await new Promise(resolve => setTimeout(resolve, 7000));
      if (mode === 'single' && path === '/api/v1/projects') {
        const body = await response.json(); return new Response(JSON.stringify({ ...body, projects: body.projects.filter(p => p.id === 'homepage') }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (mode === 'history' && path === '/api/v1/ai/agent/executions') {
        return new Response(JSON.stringify({ plans: Array.from({ length: 123 }, (_, n) => ({ id: `history-${n + 1}`, user_message: `历史任务 ${n + 1}`, status: 'completed', created_at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString() })), executions: [] }), { headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => intercepted, set: next => { transport = next; } });
  }, mode);
}

test('监控冷进入 3 秒内显示静态容器，慢存储不阻塞实时指标', async ({ page }) => {
  await patchFixtureFetch(page, 'slow');
  const start = Date.now();
  await page.goto('./#/monitor');
  await expect(page.getByRole('heading', { name: '容器资源', exact: true })).toBeVisible();
  await expect(page.locator('tbody').getByText('wiki-api', { exact: true })).toBeVisible({ timeout: 3000 });
  const firstPaint = Date.now() - start;
  expect(firstPaint).toBeLessThanOrEqual(3000);
  console.log(`monitor static first paint: ${firstPaint}ms`);
  await expect(page.getByText('等待指标').first()).toBeVisible();
  await expect(page.locator('.metric-tile').filter({ hasText: '环境 CPU' })).toContainText('18%', { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Docker 存储', exact: true })).toHaveCount(0);
});

test('单项目自动选择，手动清除后刷新仍尊重用户选择', async ({ page }) => {
  await patchFixtureFetch(page, 'single');
  await page.goto('./#/compose?from=services');
  await expect(page.getByLabel('选择 Compose 项目')).toHaveValue('homepage');
  await expect(page).toHaveURL(/from=services/);
  await expect(page.locator('.monaco-editor')).toContainText('nginx');
  await page.getByRole('button', { name: '清除当前 Compose 项目' }).click();
  await expect(page.getByText('请先选择一个已挂载的项目')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('选择 Compose 项目')).toHaveValue('');
  await expect(page.getByText('请先选择一个已挂载的项目')).toBeVisible();
});

test('多项目恢复本次会话选择并保留来源返回', async ({ page }) => {
  await page.goto('./#/compose?from=events');
  await page.getByLabel('选择 Compose 项目').selectOption('cache');
  await expect(page.locator('.monaco-editor')).toContainText('redis');
  await page.goto('./#/compose?from=events');
  await expect(page.getByLabel('选择 Compose 项目')).toHaveValue('cache');
  await expect(page).toHaveURL(/from=events/);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.getByRole('heading', { name: '事件中心', exact: true })).toBeVisible();
});

test('执行历史 123 条可翻页、升序和检索', async ({ page }) => {
  await patchFixtureFetch(page, 'history');
  await page.goto('./#/agent/history');
  await expect(page.locator('main h3')).toHaveCount(20);
  await expect(page.locator('main h3').first()).toHaveText('历史任务 123');
  await page.getByRole('button', { name: '执行历史下一页' }).click();
  await expect(page.locator('main h3').first()).toHaveText('历史任务 103');
  await page.getByRole('button', { name: /执行历史：降序/ }).click();
  await expect(page.locator('main h3').first()).toHaveText('历史任务 1');
  await page.getByRole('button', { name: '执行历史下一页' }).click();
  await page.getByLabel('搜索 Agent 执行历史').fill('历史任务 123');
  await expect(page.locator('main h3')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '执行历史上一页' })).toBeDisabled();
});

test('设置全部分类与卷备份表单均有可访问名称', async ({ page }) => {
  for (const target of ['settings?tab=ai', 'settings?tab=agent-policy', 'settings?tab=personal', 'settings?tab=notifications', 'settings?tab=maintenance', 'settings?tab=mounts', 'settings?tab=hosts', 'settings?tab=mcp', 'settings?tab=about', 'resources?tab=backups']) {
    await page.goto('./#/' + target);
    await expect(page.locator('main h1')).toBeVisible();
    const unnamed = await page.locator('main input:visible, main textarea:visible, main select:visible').evaluateAll(elements => elements
      .filter(element => !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby') && ![...(element.labels || [])].some(label => label.textContent.trim()))
      .map(element => element.outerHTML.slice(0, 220)));
    expect(unnamed, target).toEqual([]);
  }
});

test('成本趋势显示独立曲线，记录快照后立即更新', async ({ page }) => {
  await page.goto('./#/cost');
  await expect(page.getByText('7 个快照 · 各图独立刻度')).toBeVisible();
  await expect(page.locator('figure .sparkline')).toHaveCount(2);
  await page.getByRole('button', { name: '记录快照', exact: true }).first().click();
  await expect(page.getByText('8 个快照 · 各图独立刻度')).toBeVisible();
  await expect(page.locator('.toast-container')).toContainText('成本快照已记录');
});


test('任务导航和来源返回不会挤走首屏标题', async ({ page }) => {
  for (const [route, name] of Object.entries({ 'ops-center': '任务中心', cron: '定时任务', workflows: '工作流中心', 'services?from=events': '服务总览', 'resources?from=cost': '存储资源' })) {
    await page.goto('./#/' + route);
    const title = page.getByRole('heading', { name, exact: true }); await expect(title).toBeVisible();
    const box = await title.boundingBox(); expect(box.y, route).toBeLessThan(300);
  }
});
