import { test, expect } from '@playwright/test';

async function installBackups(page) {
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    window.backupsFixture = {
      listFailure: false, comparisonFailure: false, blockedComparison: false, releaseComparison: null,
      blockedRestore: false, restoreFailure: false, releaseRestore: null, hostChanged: false, writes: [],
      files: ['services:\n  redis:\n    image: redis:7-alpine\n', 'services:\n  worker:\n    image: worker:current\n'],
      versions: [
        { id: 501, filePath: '/srv/compose/cache/compose.yml', reason: 'save', createdAt: '2026-11-09T00:00:00Z', size: 100, content: 'services:\n  redis:\n    image: redis:6-alpine\n' },
        { id: 502, filePath: '/srv/compose/cache/override.yml', reason: 'restore', createdAt: '2026-11-08T23:00:00Z', size: 110, content: 'services:\n  worker:\n    image: worker:previous\n' },
      ],
    };
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const path = url.pathname;
      const method = init.method || 'GET';
      const f = window.backupsFixture;
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/v1/projects' && method === 'GET') {
        const data = await (await original(input, init)).json();
        if (f.hostChanged) data.projects = data.projects.filter(item => item.id === 'homepage');
        else data.projects.find(item => item.id === 'cache').composeFiles = f.versions.map(item => item.filePath);
        return json(data);
      }
      if (path === '/api/v1/projects/cache/compose' && method === 'GET') {
        const index = Number(url.searchParams.get('fileIndex') || 0);
        return json({ content: f.files[index], path: f.versions[index].filePath });
      }
      if (path === '/api/v1/projects/cache/backups') return f.listFailure ? json({ message: '版本列表暂不可用' }, 503) : json({ backups: f.versions.map(({ content: _content, ...item }) => item) });
      if (/\/api\/v1\/projects\/cache\/backups\/\d+$/.test(path)) {
        const version = f.versions.find(item => item.id === Number(path.split('/').pop()));
        if (f.blockedComparison) await new Promise(resolve => { f.releaseComparison = resolve; });
        return f.comparisonFailure ? json({ message: '比较暂不可用' }, 503) : json(version);
      }
      if (/\/api\/v1\/projects\/cache\/backups\/\d+\/restore$/.test(path) && method === 'POST') {
        const id = Number(path.split('/').at(-2));
        f.writes.push({ path, method });
        if (f.blockedRestore) await new Promise(resolve => { f.releaseRestore = resolve; });
        if (f.restoreFailure) return json({ message: '恢复暂不可用，请重试' }, 503);
        const index = f.versions.findIndex(item => item.id === id);
        f.files[index] = f.versions[index].content;
        return json({ ok: true });
      }
      return original(input, init);
    };
  });
  await page.goto('./#/compose?projectId=cache');
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect(page.getByRole('button', { name: '备份', exact: true })).toBeEnabled();
}
const versions = page => page.getByRole('dialog', { name: '配置备份（最近 20 份）', exact: true });
async function openVersions(page) {
  await page.getByRole('button', { name: '备份', exact: true }).click();
  await expect(versions(page).locator('[data-backup-id]')).toHaveCount(2);
}

test('版本读取和比较错误原地重试，日期和文件标识清楚', async ({ page }) => {
  await installBackups(page);
  await page.evaluate(() => { window.backupsFixture.listFailure = true; });
  await page.getByRole('button', { name: '备份', exact: true }).click();
  await expect(versions(page).getByRole('alert')).toContainText('版本列表暂不可用');
  await expect(versions(page).getByText('暂无配置备份', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.backupsFixture.listFailure = false; });
  await versions(page).getByRole('button', { name: '重新读取版本', exact: true }).click();
  await expect(versions(page).locator('[data-backup-id]')).toHaveCount(2);
  await expect(versions(page)).not.toContainText('Invalid Date');
  await expect(versions(page)).toContainText('保存前自动备份');
  await expect(versions(page)).toContainText('override.yml');
  await page.evaluate(() => { window.backupsFixture.comparisonFailure = true; });
  await versions(page).locator('[data-backup-id="501"]').getByRole('button', { name: '比较', exact: true }).click();
  await expect(versions(page).getByRole('alert')).toContainText('比较暂不可用');
  await page.evaluate(() => { window.backupsFixture.comparisonFailure = false; });
  await versions(page).locator('[data-backup-id="501"]').getByRole('button', { name: '比较', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '当前配置与备份比较' })).toBeVisible();
});

test('跨文件比较使用目标文件，关闭列表后迟到比较不再弹窗', async ({ page }) => {
  await installBackups(page); await openVersions(page);
  await versions(page).locator('[data-backup-id="502"]').getByRole('button', { name: '比较', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: '当前配置与备份比较' });
  await expect(comparison).toContainText('worker:current');
  await expect(comparison).toContainText('worker:previous');
  await expect(comparison).not.toContainText('redis:7-alpine');
  await comparison.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => { window.backupsFixture.blockedComparison = true; });
  await versions(page).locator('[data-backup-id="501"]').getByRole('button', { name: '比较', exact: true }).click();
  await versions(page).getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => window.backupsFixture.releaseComparison());
  await expect(comparison).toHaveCount(0);
  await expect(versions(page)).toHaveCount(0);
});

test('恢复失败保留确认门可重试，完成后明确只恢复文件', async ({ page }) => {
  await installBackups(page); await openVersions(page);
  await page.evaluate(() => { window.backupsFixture.blockedRestore = true; window.backupsFixture.restoreFailure = true; });
  await versions(page).locator('[data-backup-id="501"]').getByRole('button', { name: '恢复', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '恢复配置备份', exact: true });
  await dialog.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '恢复', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.backupsFixture.blockedRestore = false; window.backupsFixture.releaseRestore(); });
  await expect(dialog.getByRole('alert')).toContainText('恢复暂不可用');
  await page.evaluate(() => { window.backupsFixture.restoreFailure = false; });
  await dialog.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.page-shell > .alert-success')).toContainText('尚未应用到容器');
  await expect(page.locator('.compose-saved-next')).toContainText('应用配置');
  await page.getByRole('button', { name: '可视化', exact: true }).click();
  await expect(page.getByText('redis:6-alpine', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.backupsFixture.writes)).toHaveLength(2);
  await page.locator('.compose-saved-next').getByRole('link', { name: '返回项目' }).click();
  await expect(page).toHaveURL(/#\/services\?focus=cache/);
});

test('比较尚未完成时选择恢复，迟到比较不打断确认', async ({ page }) => {
  await installBackups(page); await openVersions(page);
  await page.evaluate(() => { window.backupsFixture.blockedComparison = true; });
  const version = versions(page).locator('[data-backup-id="501"]');
  await version.getByRole('button', { name: '比较', exact: true }).click();
  await version.getByRole('button', { name: '恢复', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '恢复配置备份', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.backupsFixture.releaseComparison());
  await expect(page.getByRole('dialog', { name: '当前配置与备份比较' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(versions(page)).toBeVisible();
});

test('恢复另一配置文件后选中并展示该文件', async ({ page }) => {
  await installBackups(page); await openVersions(page);
  await versions(page).locator('[data-backup-id="502"]').getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByRole('dialog', { name: '恢复配置备份', exact: true }).getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByLabel('选择 Compose 配置文件')).toHaveValue('1');
  await expect(page.locator('.compose-saved-next')).toBeVisible();
  await page.getByRole('button', { name: '可视化', exact: true }).click();
  await expect(page.getByText('worker:previous', { exact: true })).toBeVisible();
});

test('恢复确认说明未保存草稿的影响，取消后草稿继续可用', async ({ page }) => {
  await installBackups(page);
  await page.getByRole('button', { name: '可视化', exact: true }).click();
  await page.getByRole('button', { name: '编辑服务 redis', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑服务', exact: true });
  await edit.getByLabel('镜像', { exact: true }).fill('redis:7.4');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await openVersions(page);
  await versions(page).locator('[data-backup-id="501"]').getByRole('button', { name: '恢复', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '恢复配置备份', exact: true });
  await expect(dialog).toContainText('未保存的修改将丢弃');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await versions(page).getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText('redis:7.4', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.backupsFixture.writes)).toEqual([]);
});

test('切换节点后迟到的恢复不覆盖新项目或显示旧成功提示', async ({ page }) => {
  await installBackups(page); await openVersions(page);
  await page.evaluate(() => { window.backupsFixture.blockedRestore = true; });
  await versions(page).locator('[data-backup-id="501"]').getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByRole('dialog', { name: '恢复配置备份', exact: true }).getByRole('button', { name: '恢复', exact: true }).click();
  await page.evaluate(() => { window.backupsFixture.hostChanged = true; window.dispatchEvent(new CustomEvent('composeops:host-changed')); });
  await expect(page.getByLabel('选择 Compose 项目')).toHaveValue('homepage');
  await page.evaluate(() => window.backupsFixture.releaseRestore());
  await expect(page.getByLabel('选择 Compose 项目')).toBeEnabled();
  await expect(page.getByLabel('选择 Compose 项目')).toHaveValue('homepage');
  await expect(page.locator('.compose-saved-next')).toHaveCount(0);
});

test('320px 配置版本卡和比较弹窗均可阅读操作', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await installBackups(page); await openVersions(page);
  await expect(versions(page).locator('[data-backup-id="501"]').getByRole('button', { name: '恢复', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('compose-versions-mobile.png') });
  await versions(page).locator('[data-backup-id="502"]').getByRole('button', { name: '比较', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: '当前配置与备份比较' });
  await expect(comparison).toContainText('目标文件当前版本');
  const bounds = await comparison.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(321);
  await comparison.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(versions(page)).toBeVisible();
});
