import { test, expect } from '@playwright/test';

async function install(page, flags = {}) {
  await page.goto('./#/dashboard'); await expect(page.locator('.app-header')).toBeVisible();
  await page.evaluate(flags => {
    const original = window.fetch;
    const f = window.cmdbFixture = {
      failRead: false, holdRead: false, holdDelete: false, failDelete: false, failRefreshAfterSync: false,
      writes: [], syncs: 0,
      assets: [{ id: 'host:synthetic', kind: 'host', name: '验收主机', source: 'docker', status: 'online' }, { id: 'project:synthetic', kind: 'project', name: '验收项目', source: 'scanner', status: 'running' }],
      relations: [{ id: 1, sourceId: 'project:synthetic', targetId: 'host:synthetic', relation: 'runs_on' }], ...flags,
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    window.fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/cmdb/topology' || path === '/api/v1/cmdb/assets') {
        const snapshot = structuredClone({ assets: f.assets, relations: f.relations });
        if (f.holdRead) await new Promise(resolve => { f.releaseRead = resolve; });
        return f.failRead ? json({ message: '合成资产读取失败' }, 503) : json(snapshot);
      }
      if (path === '/api/v1/cmdb/assets/sync') {
        f.syncs++;
        f.assets.push({ id: 'container:synthetic', kind: 'container', name: '验收容器', source: 'scanner', status: 'running' });
        f.relations.push({ id: 2, sourceId: 'container:synthetic', targetId: 'project:synthetic', relation: 'runs_on' });
        if (f.failRefreshAfterSync) f.failRead = true;
        return json({ hosts: 1, projects: 1 });
      }
      if (path.startsWith('/api/v1/cmdb/assets/') && init.method === 'DELETE') {
        const id = decodeURIComponent(path.slice('/api/v1/cmdb/assets/'.length)); f.writes.push(id);
        if (f.holdDelete) await new Promise(resolve => { f.releaseDelete = resolve; });
        if (f.failDelete) return json({ message: '合成删除失败，目标仍保留' }, 409);
        f.assets = f.assets.filter(a => a.id !== id); f.relations = f.relations.filter(r => r.sourceId !== id && r.targetId !== id);
        return json({ ok: true });
      }
      return original(input, init);
    };
  }, flags);
  await page.goto('./#/cmdb');
  await expect(page.getByRole('heading', { name: '资产中心 (CMDB)', exact: true })).toBeVisible();
}
const dialog = page => page.getByRole('dialog', { name: '删除资产', exact: true });
const remove = page => page.getByRole('button', { name: '删除资产 验收项目', exact: true });
const relationCount = page => page.getByText('依赖关系', { exact: true }).locator('..').locator('p').first();

test('读取失败原位重试，类型空态不误导同步，更新包含关系', async ({ page }) => {
  await install(page, { failRead: true });
  await expect(page.getByRole('alert').filter({ hasText: '合成资产读取失败' })).toBeVisible();
  await expect(page.getByText('暂无资产', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.cmdbFixture.failRead = false; });
  await page.getByRole('button', { name: '重新读取资产' }).click(); await expect(remove(page)).toBeVisible();
  await page.getByRole('button', { name: '卷', exact: true }).click();
  await expect(page.getByText('此类型下暂无资产', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看全部资产' }).click(); await expect(relationCount(page)).toHaveText('1');
  await page.getByRole('button', { name: '同步资产', exact: true }).click();
  await expect(relationCount(page)).toHaveText('2'); await expect(page.getByRole('button', { name: '删除资产 验收容器', exact: true })).toBeVisible();
});

test('删除锁定、失败保留目标并原位重试，窄屏确认可见', async ({ page }, testInfo) => {
  await install(page); await page.setViewportSize({ width: 320, height: 740 }); await remove(page).click();
  await expect(dialog(page)).toContainText('Docker 资源仍会保留');
  await page.evaluate(() => { window.cmdbFixture.holdDelete = window.cmdbFixture.failDelete = true; });
  await dialog(page).getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: '删除中…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(dialog(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.cmdbFixture.releaseDelete)).toBe('function');
  await page.evaluate(() => { window.cmdbFixture.holdDelete = false; window.cmdbFixture.releaseDelete(); });
  await expect(dialog(page).getByRole('alert')).toContainText('合成删除失败');
  await expect(dialog(page).getByRole('alert')).toBeInViewport();
  expect(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cmdb-delete-320-retry.png') });
  await page.evaluate(() => { window.cmdbFixture.failDelete = false; });
  await dialog(page).getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0); await expect(remove(page)).toHaveCount(0); await expect(relationCount(page)).toHaveText('0');
  expect(await page.evaluate(() => window.cmdbFixture.writes)).toEqual(['project:synthetic', 'project:synthetic']);
});

test('删除前的慢刷新不能复活已删除资产或关系', async ({ page }) => {
  await install(page); await expect(remove(page)).toBeVisible();
  await page.evaluate(() => { window.cmdbFixture.holdRead = true; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.cmdbFixture.releaseRead)).toBe('function');
  await remove(page).click(); await dialog(page).getByRole('button', { name: '删除', exact: true }).click();
  await expect(remove(page)).toHaveCount(0); await expect(relationCount(page)).toHaveText('0');
  await page.evaluate(async () => { window.cmdbFixture.releaseRead(); await new Promise(resolve => setTimeout(resolve, 100)); });
  await expect(remove(page)).toHaveCount(0); await expect(relationCount(page)).toHaveText('0');
});

for (const context of ['navigate', 'host', 'expire']) test(`${context} 后关闭确认框且迟到写入不跨页面提示`, async ({ page }) => {
  await install(page); await remove(page).click();
  await page.evaluate(() => { window.cmdbFixture.holdDelete = true; });
  await dialog(page).getByRole('button', { name: '删除', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.cmdbFixture.releaseDelete)).toBe('function');
  if (context === 'navigate') { await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible(); }
  else await page.evaluate(context => window.dispatchEvent(new Event(context === 'host' ? 'composeops:host-changed' : 'composeops:unauthorized')), context);
  await expect(dialog(page)).toHaveCount(0);
  await page.evaluate(async () => { window.cmdbFixture.releaseDelete(); await new Promise(resolve => setTimeout(resolve, 100)); });
  await expect(page.getByText('资产记录与关联关系已删除', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.cmdbFixture.writes)).toHaveLength(1);
});

test('同步已执行但刷新失败时保留旧数据，重试仅重新读取', async ({ page }) => {
  await install(page, { failRefreshAfterSync: true }); await expect(remove(page)).toBeVisible();
  await page.getByRole('button', { name: '同步资产', exact: true }).click();
  await expect(page.getByText(/资产同步已完成，但清单刷新失败/)).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '以下保留上次读取' })).toBeVisible();
  await expect(page.getByText('资产与关系同步完成', { exact: true })).toHaveCount(0);
  // 写入通知会触发一次延迟刷新；只在实际点击重试时恢复接口，避免后台刷新先消掉按钮。
  const retry = page.getByRole('button', { name: '重新读取资产' });
  await page.evaluate(() => document.addEventListener('click', event => {
    if (event.target.closest('button')?.textContent === '重新读取资产') window.cmdbFixture.failRead = false;
  }, { capture: true }));
  await retry.click(); await expect(relationCount(page)).toHaveText('2');
  expect(await page.evaluate(() => window.cmdbFixture.syncs)).toBe(1);
});
