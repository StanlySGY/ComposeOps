import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';

async function openDump(page, { failLoad = false } = {}) {
  await page.goto('./#/dashboard'); await expect(page.locator('.app-header')).toBeVisible();
  await page.evaluate(({ failLoad }) => {
    const original = window.fetch, f = window.dumpFixture = { failLoad, hold: false, failDump: false, calls: 0, aborted: false };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (!path.endsWith('/db-dump')) return original(input, init);
      if (!init.method || init.method === 'GET') return f.failLoad ? json({ message: '读取数据库失败' }, 503) : json({ containers: [{ containerId: 'synthetic-db', containerName: '合成测试数据库', type: 'postgres' }] });
      f.calls++; init.signal?.addEventListener('abort', () => { f.aborted = true; }, { once: true });
      if (f.hold) await new Promise(resolve => { f.release = resolve; });
      if (f.failDump) return json({ message: '导出暂时失败' }, 503);
      return new Response('synthetic database fixture', { headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="synthetic-test.sql.gz"' } });
    };
  }, { failLoad });
  await page.goto('./#/services?focus=cache');
  const card = page.locator('#project-cache');
  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('button', { name: '备份数据库', exact: true }).click();
  const modal = page.getByRole('dialog', { name: /备份数据库/ }); await expect(modal).toBeVisible();
  return modal;
}

test('容器读取失败原位重试，成功下载真实文件并关闭弹窗', async ({ page }) => {
  const modal = await openDump(page, { failLoad: true });
  await expect(modal.getByRole('alert')).toContainText('读取数据库失败');
  await page.evaluate(() => { window.dumpFixture.failLoad = false; });
  await modal.getByRole('button', { name: '重新读取数据库容器', exact: true }).click();
  await modal.getByLabel('目标容器', { exact: true }).selectOption('synthetic-db');
  const downloaded = page.waitForEvent('download');
  await modal.getByRole('button', { name: '开始导出并下载', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('synthetic-test.sql.gz');
  const stream = await download.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe('synthetic database fixture');
  await expect(modal).toHaveCount(0); expect(await page.evaluate(() => window.dumpFixture.calls)).toBe(1);
});

test('导出中锁定目标和关闭操作，失败保留库名且可重新下载', async ({ page }) => {
  const modal = await openDump(page); await modal.getByLabel('目标容器', { exact: true }).selectOption('synthetic-db');
  const name = modal.getByLabel('库名', { exact: true }); await name.fill('synthetic-db-name');
  await page.evaluate(() => { window.dumpFixture.hold = window.dumpFixture.failDump = true; });
  await modal.getByRole('button', { name: '开始导出并下载', exact: true }).click();
  await expect(modal.getByLabel('目标容器', { exact: true })).toBeDisabled(); await expect(name).toBeDisabled();
  await expect(modal.getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(modal).toBeVisible();
  await page.evaluate(() => { window.dumpFixture.hold = false; window.dumpFixture.release(); });
  await expect(modal.getByRole('alert')).toContainText('导出暂时失败'); await expect(name).toHaveValue('synthetic-db-name');
  await page.evaluate(() => { window.dumpFixture.failDump = false; }); const downloaded = page.waitForEvent('download');
  await modal.getByRole('button', { name: '开始导出并下载', exact: true }).click(); await downloaded; await expect(modal).toHaveCount(0);
});

for (const reason of ['host', 'leave', 'expire']) test(`${reason} 后迟到响应不再下载文件`, async ({ page }) => {
  const modal = await openDump(page), downloads = []; page.on('download', item => downloads.push(item));
  await modal.getByLabel('目标容器', { exact: true }).selectOption('synthetic-db');
  await page.evaluate(() => { window.dumpFixture.hold = true; });
  await modal.getByRole('button', { name: '开始导出并下载', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.dumpFixture.release)).toBe('function');
  if (reason === 'leave') await page.goto('./#/dashboard');
  else await page.evaluate(reason => window.dispatchEvent(new Event(reason === 'host' ? 'composeops:host-changed' : 'composeops:unauthorized')), reason);
  await expect(modal).toHaveCount(0); await expect.poll(() => page.evaluate(() => window.dumpFixture.aborted)).toBe(true);
  await page.evaluate(async () => { window.dumpFixture.release(); await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(downloads).toEqual([]); await expect(page.getByText(/数据库备份已下载/)).toHaveCount(0);
});
