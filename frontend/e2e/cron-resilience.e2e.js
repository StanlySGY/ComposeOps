import { test, expect } from '@playwright/test';

async function installCronFixture(page, { historyFailure = false } = {}) {
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(({ historyFailure }) => {
    const original = window.fetch;
    window.cronFixture = {
      historyFailure, listFailure: false, failAfterWrite: false, blockedWrite: false, writeFailure: false,
      blockedDelete: false, deleteFailure: false, blockedRun: false, releaseWrite: null, releaseDelete: null, releaseRun: null,
      writes: [], listReads: 0, historyReads: 0,
      jobs: [
        { id: 'nightly', name: '夜间镜像检查', type: 'images-check', typeLabel: '镜像更新检查', cron: '*/15 * * * *', enabled: true, nextRunAt: 1794171600000, lastRunAt: 1794080000000, lastStatus: 'failed', lastError: '远端仓库连接超时。'.repeat(30) },
        { id: 'backup', name: '数据库归档', type: 'db-backup', typeLabel: '数据库自动备份', cron: '0 3 * * *', enabled: false, nextRunAt: null },
      ],
      history: [
        { id: 'old', jobId: 'backup', jobName: '旧执行记录', at: 1794000000000, durationMs: 1200, status: 'success' },
        { id: 'recent', jobId: 'nightly', jobName: '最新失败记录', at: 1794080000000, durationMs: 1600, status: 'failed', error: '远端仓库连接超时' },
      ],
    };
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const path = url.pathname;
      const method = init.method || 'GET';
      const f = window.cronFixture;
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/v1/cron' && method === 'GET') {
        f.listReads++;
        return f.listFailure ? json({ message: '任务列表暂不可用' }, 503) : json({ jobs: f.jobs, types: { 'images-check': { label: '镜像更新检查', description: '只读检查纳管项目的镜像更新' }, 'db-backup': { label: '数据库自动备份', description: '备份纳管项目中的数据库' } } });
      }
      if (path === '/api/v1/cron/history') {
        f.historyReads++;
        return f.historyFailure ? json({ message: '执行历史暂不可用' }, 503) : json({ history: f.history });
      }
      if (/\/api\/v1\/cron\/[^/]+$/.test(path) && method === 'PUT') {
        const id = path.split('/').pop();
        const body = JSON.parse(init.body);
        f.writes.push({ id, method, body });
        if (f.blockedWrite) await new Promise(resolve => { f.releaseWrite = resolve; });
        if (f.writeFailure) return json({ message: '保存暂不可用' }, 503);
        const job = f.jobs.find(item => item.id === id);
        Object.assign(job, body);
        if (!job.enabled) job.nextRunAt = null;
        if (f.failAfterWrite) f.listFailure = true;
        return json(job);
      }
      if (/\/api\/v1\/cron\/[^/]+$/.test(path) && method === 'DELETE') {
        const id = path.split('/').pop();
        f.writes.push({ id, method });
        if (f.blockedDelete) await new Promise(resolve => { f.releaseDelete = resolve; });
        if (f.deleteFailure) return json({ message: '删除暂不可用，请重试' }, 503);
        f.jobs = f.jobs.filter(item => item.id !== id);
        if (f.failAfterWrite) f.listFailure = true;
        return json({ ok: true });
      }
      if (/\/api\/v1\/cron\/[^/]+\/run$/.test(path) && method === 'POST') {
        f.writes.push({ method, run: true });
        if (f.blockedRun) await new Promise(resolve => { f.releaseRun = resolve; });
        f.history.unshift({ id: 'manual', jobId: 'nightly', jobName: '夜间镜像检查', at: Date.now(), status: 'failed', error: '本次执行连接超时', durationMs: 2333 });
        return json({ message: '本次执行连接超时' }, 502);
      }
      return original(input, init);
    };
  }, { historyFailure });
  await page.goto('./#/cron');
  await expect(page.locator('[data-job-id]')).toHaveCount(2);
}

test('任务清单和历史独立恢复，手动刷新显示真实错误', async ({ page }) => {
  await installCronFixture(page, { historyFailure: true });
  await expect(page.getByRole('alert')).toContainText('执行历史暂不可用');
  const reads = await page.evaluate(() => window.cronFixture.listReads);
  await page.evaluate(() => { window.cronFixture.historyFailure = false; });
  await page.getByRole('button', { name: '重试历史', exact: true }).click();
  await expect(page.locator('.cron-history tbody tr')).toHaveCount(2);
  expect(await page.evaluate(() => window.cronFixture.listReads)).toBe(reads);
  await page.evaluate(() => { window.cronFixture.listFailure = true; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('任务列表暂不可用');
  await expect(page.locator('[data-job-id]')).toHaveCount(2);
  await page.evaluate(() => { window.cronFixture.listFailure = false; });
  await page.getByRole('button', { name: '重试加载', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('开关等待确认、失败恢复，成功后刷新失败仍保留确认状态', async ({ page }) => {
  await installCronFixture(page);
  const row = page.locator('[data-job-id=nightly]');
  const toggle = row.getByRole('checkbox');
  await page.evaluate(() => { window.cronFixture.blockedWrite = true; window.cronFixture.writeFailure = true; });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(row.getByRole('button', { name: '编辑定时任务 夜间镜像检查' })).toBeDisabled();
  await page.evaluate(() => window.cronFixture.releaseWrite());
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await page.evaluate(() => { window.cronFixture.blockedWrite = false; window.cronFixture.writeFailure = false; window.cronFixture.failAfterWrite = true; });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('alert')).toContainText('任务列表暂不可用');
  await expect(row).toContainText('已停用');
  expect(await page.evaluate(() => window.cronFixture.writes)).toHaveLength(2);
});

test('删除确认忙碌与错误留在原位，成功后历史可回看且焦点可用', async ({ page }) => {
  await installCronFixture(page);
  await page.evaluate(() => { window.cronFixture.blockedDelete = true; window.cronFixture.deleteFailure = true; });
  await page.locator('[data-job-id=nightly]').getByRole('button', { name: '删除定时任务 夜间镜像检查' }).click();
  const dialog = page.getByRole('dialog', { name: '删除定时任务' });
  await dialog.getByRole('button', { name: '删除任务', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '删除任务', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.cronFixture.blockedDelete = false; window.cronFixture.releaseDelete(); });
  await expect(dialog.getByRole('alert')).toContainText('删除暂不可用');
  await page.evaluate(() => { window.cronFixture.deleteFailure = false; window.cronFixture.failAfterWrite = true; });
  await dialog.getByRole('button', { name: '删除任务', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('[data-job-id=nightly]')).toHaveCount(0);
  await expect(page.locator('.cron-feedback')).toBeFocused();
  await expect(page.locator('.cron-feedback')).toBeInViewport();
  await expect(page.locator('.cron-history tbody tr')).toHaveCount(2);
});

test('编辑自定义周期、取消和保存连贯，刷新失败不丢确认的改名', async ({ page }) => {
  await installCronFixture(page);
  const row = page.locator('[data-job-id=nightly]');
  await row.getByRole('button', { name: '编辑定时任务 夜间镜像检查' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑定时任务' });
  await expect(dialog.getByLabel('Cron 表达式', { exact: true })).toHaveValue('*/15 * * * *');
  await dialog.getByLabel('任务名称', { exact: true }).fill('取消的改名');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(row).toContainText('夜间镜像检查');
  await row.getByRole('button', { name: '编辑定时任务 夜间镜像检查' }).click();
  await expect(dialog.getByLabel('任务名称', { exact: true })).toHaveValue('夜间镜像检查');
  await dialog.getByLabel('任务名称', { exact: true }).fill('新的检查计划');
  await expect(dialog.locator('.cron-preview time')).toHaveCount(3);
  await page.evaluate(() => { window.cronFixture.blockedWrite = true; window.cronFixture.failAfterWrite = true; });
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  await page.evaluate(() => window.cronFixture.releaseWrite());
  await expect(dialog).not.toBeVisible();
  await expect(row).toContainText('新的检查计划');
  await expect(page.getByRole('alert')).toContainText('任务列表暂不可用');
  expect(await page.evaluate(() => window.cronFixture.writes)).toHaveLength(1);
});

test('手动执行失败后即时出现失败记录，可排序且恢复操作', async ({ page }) => {
  await installCronFixture(page);
  const row = page.locator('[data-job-id=nightly]');
  await page.evaluate(() => { window.cronFixture.blockedRun = true; });
  await row.getByRole('button', { name: '立即执行', exact: true }).click();
  await expect(row.getByRole('button', { name: '执行中', exact: true })).toBeDisabled();
  await expect(row.getByRole('checkbox')).toBeDisabled();
  await page.evaluate(() => window.cronFixture.releaseRun());
  await expect(page.locator('.cron-history tbody tr')).toHaveCount(3);
  await expect(page.locator('.cron-history tbody tr').first()).toContainText('夜间镜像检查');
  await expect(page.getByRole('alert')).toContainText('本次执行连接超时');
  await expect(row.getByRole('button', { name: '立即执行', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '定时执行历史：降序，点击升序', exact: true }).click();
  await expect(page.locator('.cron-history tbody tr').first()).toContainText('旧执行记录');
});

test('窄屏任务与历史可读，失败详情键盘展开，素材按需加载', async ({ page, isMobile }, testInfo) => {
  const images = [];
  page.on('request', request => { if (/schedule-\d+.*\.webp/.test(request.url())) images.push(request.url()); });
  await installCronFixture(page);
  if (isMobile) { await expect(page.locator('.cron-scene')).toBeHidden(); expect(images).toEqual([]); }
  else await expect(page.locator('.cron-scene img')).toHaveClass('is-loaded');
  const summary = page.locator('.cron-last-error summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cron-last-error')).toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await page.screenshot({ path: testInfo.outputPath('cron-workspace.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const row = page.locator('.cron-history tbody tr').first();
  await row.scrollIntoViewIfNeeded();
  const bounds = await row.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(321);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await summary.locator('svg').evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThanOrEqual(.001);
});
