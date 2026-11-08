import { test, expect } from '@playwright/test';

async function installBackupFixture(page) {
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    window.backupFixture = { writes: [], blocked: false, failVolume: '', deleteFailure: false, host: 'alpha', release: null, verified: false, deleted: false };
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const path = url.pathname;
      const method = init.method || 'GET';
      const f = window.backupFixture;
      const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/v1/projects' && method === 'GET') return json({ projects: [
        { id: `backup-${f.host}`, projectName: f.host === 'alpha' ? '备份测试项目' : '新节点项目', managed: true, containers: [], services: [] },
      ] });
      if (path === '/api/v1/ops/storage/volume-volumes') return json({ volumes: [{ name: 'alpha-data' }, { name: 'alpha-cache' }] });
      if (path === '/api/v1/ops/storage/volume-backups' && method === 'GET') return json({ backups: f.deleted ? [] : [
        { id: 901, projectId: 'backup-alpha', projectName: '备份测试项目', volume: 'alpha-data', file: 'alpha-data-20261108.tar.gz', bytes: 2048, host: 'local', createdAt: '2026-11-08T14:00:00Z', verifyStatus: f.verified ? 'verified' : '', verifyFiles: f.verified ? 6 : null },
      ] });
      if (path.startsWith('/api/v1/ops/storage/volume-backups') && method !== 'GET') {
        const body = init.body ? JSON.parse(init.body) : null;
        f.writes.push({ path, method, body });
        if (path === '/api/v1/ops/storage/volume-backups') {
          if (f.blocked) await new Promise(resolve => { f.release = () => { f.blocked = false; resolve(); }; });
          if (body.volume === f.failVolume) return json({ error: '测试卷空间暂不足' }, 503);
          return json({ ok: true });
        }
        if (path.endsWith('/verify')) { f.verified = true; return json({ status: 'verified', files: 6, durationMs: 120 }); }
        if (method === 'DELETE') {
          if (f.deleteFailure) return json({ error: '删除服务暂不可用，请重试' }, 503);
          f.deleted = true;
        }
        return json({ ok: true });
      }
      return original(input, init);
    };
  });
  await page.goto('./#/resources?tab=backups');
  await expect(page.getByRole('heading', { name: '留存快照，验证恢复' })).toBeVisible();
}

async function selectVolumes(page) {
  await page.getByRole('combobox', { name: '选择要备份卷的项目' }).selectOption('backup-alpha');
  await page.getByRole('checkbox', { name: '选择数据卷 alpha-data', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择数据卷 alpha-cache', exact: true }).check();
}

test('批量备份固定目标、显示进度，部分失败仅重试失败项', async ({ page }) => {
  await installBackupFixture(page);
  await selectVolumes(page);
  await page.evaluate(() => { window.backupFixture.blocked = true; window.backupFixture.failVolume = 'alpha-cache'; });
  await page.getByRole('button', { name: '备份选中 2 个卷' }).click();
  await expect(page.getByRole('combobox', { name: '选择要备份卷的项目' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: '选择数据卷 alpha-cache', exact: true })).toBeDisabled();
  await expect(page.getByRole('progressbar', { name: '批量卷备份进度' })).toHaveAttribute('aria-valuemax', '2');
  await page.evaluate(() => window.backupFixture.release());
  await expect(page.locator('.backup-feedback')).toContainText('成功 1 个，失败 1 个');
  await expect(page.getByRole('checkbox', { name: '选择数据卷 alpha-data', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: '选择数据卷 alpha-cache', exact: true })).toBeChecked();
  await page.evaluate(() => { window.backupFixture.failVolume = ''; });
  await page.getByRole('button', { name: '备份选中 1 个卷' }).click();
  await expect(page.locator('.backup-feedback')).toContainText('备份完成：已备份 1 个卷');
  expect(await page.evaluate(() => window.backupFixture.writes.map(call => call.body))).toEqual([
    { projectId: 'backup-alpha', volume: 'alpha-data' },
    { projectId: 'backup-alpha', volume: 'alpha-cache' },
    { projectId: 'backup-alpha', volume: 'alpha-cache' },
  ]);
});

test('批次中切节点会停止未发送请求并清空旧选择', async ({ page }) => {
  await installBackupFixture(page);
  await selectVolumes(page);
  await page.evaluate(() => { window.backupFixture.blocked = true; });
  await page.getByRole('button', { name: '备份选中 2 个卷' }).click();
  await expect(page.getByRole('progressbar', { name: '批量卷备份进度' })).toBeVisible();
  await page.evaluate(() => {
    window.backupFixture.host = 'beta';
    window.dispatchEvent(new CustomEvent('composeops:host-changed'));
    window.backupFixture.release();
  });
  await expect(page.locator('.backup-feedback')).toContainText('节点已变化');
  const project = page.getByRole('combobox', { name: '选择要备份卷的项目' });
  await expect(project).toBeEnabled();
  await expect(project).toHaveValue('');
  await expect(project).toContainText('新节点项目');
  expect(await page.evaluate(() => window.backupFixture.writes)).toHaveLength(1);
});

test('离开备份页会停止剩余批次，返回后可重新选择数据卷', async ({ page }) => {
  await installBackupFixture(page);
  await selectVolumes(page);
  await page.evaluate(() => { window.backupFixture.blocked = true; });
  await page.getByRole('button', { name: '备份选中 2 个卷' }).click();
  await expect(page.getByRole('progressbar', { name: '批量卷备份进度' })).toBeVisible();
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(() => window.backupFixture.release());
  await page.goBack();
  await expect(page.getByRole('heading', { name: '留存快照，验证恢复' })).toBeVisible();
  const volume = page.getByRole('checkbox', { name: '选择数据卷 alpha-data', exact: true });
  await expect(volume).toBeEnabled();
  await expect(volume).not.toBeChecked();
  expect(await page.evaluate(() => window.backupFixture.writes)).toHaveLength(1);
});

test('验证反馈与恢复取消连贯，删除失败可在确认门内重试', async ({ page }) => {
  await installBackupFixture(page);
  await page.getByRole('button', { name: '验证备份 alpha-data-20261108.tar.gz', exact: true }).click();
  await expect(page.locator('.backup-feedback')).toContainText('还原出 6 个文件');
  await expect(page.locator('.backup-table')).toContainText('6 文件');
  await expect(page.locator('.backup-table')).not.toContainText('Invalid Date');
  await page.getByRole('button', { name: '恢复卷 alpha-data 的备份', exact: true }).click();
  const restore = page.getByRole('dialog', { name: '完整恢复数据卷' });
  await expect(restore).toBeVisible();
  await restore.getByRole('button', { name: '取消', exact: true }).click();
  await expect(restore).not.toBeVisible();
  expect(await page.evaluate(() => window.backupFixture.writes.some(call => call.path.endsWith('/restore')))).toBe(false);
  await page.evaluate(() => { window.backupFixture.deleteFailure = true; });
  await page.getByRole('button', { name: '删除备份 alpha-data-20261108.tar.gz', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除备份', exact: true });
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('.backup-feedback')).toContainText('删除服务暂不可用');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => { window.backupFixture.deleteFailure = false; });
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('还没有备份记录', { exact: true })).toBeVisible();
});

test('窄屏记录保留完整操作、规则可键盘展开，插画加载正常', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await installBackupFixture(page);
  const picture = page.locator('[data-illustration="recovery"] img');
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate(img => img.complete && img.naturalWidth > 1)).toBe(true);
  const summary = page.locator('.backup-notes summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.backup-notes')).toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: '恢复卷 alpha-data 的备份', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await picture.evaluate(img => Number.parseFloat(getComputedStyle(img).transitionDuration))).toBeLessThanOrEqual(.001);
});
