import { test, expect } from '@playwright/test';

async function install(page, query = '') {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    const f = window.gitopsFixture = {
      repos: [{ id: 'repo-a', name: '缓存基础设施', url: 'https://example.invalid/team/cache-infrastructure.git', branch: 'main', projectId: 'cache', localPath: '/srv/compose/infrastructure/production/cache-platform/compose-repository', autoSync: false, sshKey: null, status: 'synced', lastCommit: 'aaaaaaaa', lastSync: '2026-11-08T09:00:00Z' }],
      failRead: false, failWrite: false, hold: false, calls: [], driftCalls: 0,
    };
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const path = url.pathname, method = init.method || 'GET';
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (!path.startsWith('/api/v1/gitops')) return original(input, init);
      f.calls.push({ path, method, search: url.search, body: init.body ? JSON.parse(init.body) : null });
      if (path.endsWith('/drift')) {
        f.driftCalls++;
        if (f.failDrift) return json({ message: '漂移扫描暂不可用' }, 503);
        return json([{ repoId: 'repo-a', status: f.diverged ? 'diverged' : 'clean', summary: f.diverged ? '1 处文件与 Git 不一致' : '工作区与当前提交一致', drifts: f.diverged ? [{ type: 'modified', file: 'compose.yml' }] : [], repairs: f.diverged ? [{ action: 'commit-or-restore', description: '提交或恢复本地修改' }] : [], scannedAt: '2026-11-08T09:00:00Z' }]);
      }
      if (method === 'GET' && path === '/api/v1/gitops') return f.failRead ? json({ message: '仓库列表暂时离线' }, 503) : json({ repositories: f.repos });
      if (path.endsWith('/history')) {
        if (Number(url.searchParams.get('limit')) > 100) return json({ message: 'limit must be <=100' }, 400);
        if (f.failHistory) return json({ message: '提交历史暂时离线' }, 503);
        return json({ commits: [{ hash: 'aaaaaaaa', message: '更新缓存服务的资源配置', author: '运维团队', date: '2026-11-08T09:00:00Z' }, { hash: 'bbbbbbbb', message: '初始化缓存配置和持久化数据卷的版本记录', author: '平台维护者', date: '2026-11-07T08:00:00Z' }] });
      }
      if (f.hold) await new Promise(resolve => { f.release = resolve; });
      if (f.failWrite) return json({ message: '仓库忙，请稍后重试' }, 409);
      const payload = init.body ? JSON.parse(init.body) : {};
      if (method === 'PATCH') { Object.assign(f.repos[0], payload); return json(f.repos[0]); }
      if (method === 'DELETE') { f.repos = []; return json({ ok: true }); }
      if (path.endsWith('/sync')) { Object.assign(f.repos[0], { lastCommit: 'cccccccc', status: 'synced', lastSync: '2026-11-09T00:00:00Z' }); return json({ ok: true, commit: 'cccccccc', hasChanges: true, syncedAt: '2026-11-09T00:00:00Z' }); }
      if (path.endsWith('/rollback')) { Object.assign(f.repos[0], { lastCommit: payload.commitHash, status: 'rolled_back' }); return json({ ok: true, commit: payload.commitHash }); }
      if (method === 'POST') { const repo = { ...payload, id: 'repo-new', status: 'pending' }; f.repos.push(repo); return json(repo); }
      return json({});
    };
  });
  await page.goto('./#/gitops' + query);
  await expect(page.getByRole('heading', { name: 'GitOps 集成', exact: true })).toBeVisible();
  await expect(page.locator('.gitops-repo')).toHaveCount(1);
  return errors;
}
const card = page => page.locator('.gitops-repo').filter({ hasText: '缓存基础设施' });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
async function release(page) { await page.evaluate(() => { window.gitopsFixture.hold = false; window.gitopsFixture.release(); }); }
async function noOverflow(page) { expect(await page.locator('.app-main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true); }

test('编辑失败保留草稿，重复提交受保护，成功后刷新失败仍显示已保存状态', async ({ page }, testInfo) => {
  const errors = await install(page); await page.screenshot({ path: testInfo.outputPath('gitops-overview.png') }); await card(page).getByRole('button', { name: '编辑', exact: true }).click();
  const form = dialog(page, '编辑仓库'); await form.getByLabel('仓库名称', { exact: true }).fill('缓存工作区 · 修改后');
  await page.evaluate(() => { Object.assign(window.gitopsFixture, { hold: true, failWrite: true }); });
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(form).toBeVisible(); await release(page);
  await expect(form.getByRole('alert')).toContainText('仓库忙'); await expect(form.getByRole('alert')).toBeInViewport(); await expect(form.getByLabel('仓库名称', { exact: true })).toHaveValue('缓存工作区 · 修改后');
  await page.evaluate(() => { Object.assign(window.gitopsFixture, { failWrite: false, failRead: true }); });
  await form.getByRole('button', { name: '保存', exact: true }).click(); await expect(form).toHaveCount(0);
  await expect(page.locator('.gitops-feedback')).toContainText('仓库配置已保存'); await expect(page.locator('.gitops-repo')).toContainText('缓存工作区 · 修改后');
  const writes = await page.evaluate(() => window.gitopsFixture.calls.filter(call => call.method === 'PATCH'));
  expect(writes).toHaveLength(2); expect(Object.keys(writes[0].body).sort()).toEqual(['autoSync', 'branch', 'localPath', 'name', 'projectId', 'sshKey', 'url'].sort()); expect(writes[0].body.sshKey).toBe('');
  expect(errors).toEqual([]);
});

test('新增仓库保留确认结果，搜索和清空能找回新条目', async ({ page }, testInfo) => {
  const errors = await install(page); await page.getByRole('button', { name: '添加仓库', exact: true }).click(); const form = dialog(page, '添加仓库');
  await form.getByLabel('仓库名称', { exact: true }).fill('新的文档仓库');
  await form.getByPlaceholder('git@github.com:user/repo.git').fill('https://example.invalid/docs.git');
  await form.getByRole('combobox', { name: '关联项目', exact: true }).selectOption('cache');
  await form.getByPlaceholder('/path/to/local/repo').fill('/srv/compose/docs');
  await page.screenshot({ path: testInfo.outputPath('gitops-form.png') });
  await page.evaluate(() => { window.gitopsFixture.failRead = true; });
  await form.getByRole('button', { name: '添加', exact: true }).click(); await expect(form).toHaveCount(0);
  await expect(page.locator('.gitops-repo')).toHaveCount(2); await expect(page.locator('.gitops-feedback')).toContainText('仓库已添加');
  await page.getByLabel('搜索 GitOps 仓库', { exact: true }).fill('没有匹配项'); await expect(page.getByText('没有匹配的仓库', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click(); await expect(page.locator('.gitops-repo')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('删除确认等待、失败重试与成功反馈可见', async ({ page }) => {
  const errors = await install(page); await card(page).getByRole('button', { name: '删除', exact: true }).click(); const confirm = dialog(page, '删除 GitOps 仓库');
  await expect(confirm).toContainText('缓存基础设施'); await page.evaluate(() => { Object.assign(window.gitopsFixture, { hold: true, failWrite: true }); });
  await confirm.getByRole('button', { name: '删除仓库', exact: true }).click(); await expect(confirm.getByRole('button', { name: '删除中…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(confirm).toBeVisible(); await release(page); await expect(confirm.getByRole('alert')).toContainText('仓库忙');
  await page.evaluate(() => { Object.assign(window.gitopsFixture, { failWrite: false, failRead: true }); });
  await confirm.getByRole('button', { name: '删除仓库', exact: true }).click(); await expect(confirm).toHaveCount(0);
  await expect(page.locator('.gitops-repo')).toHaveCount(0); await expect(page.locator('.gitops-feedback')).toContainText('本地文件保留');
  await expect(page.locator('.gitops-feedback')).toBeInViewport(); expect(errors).toEqual([]);
});

test('同步更新提交与漂移，去项目后可返回 GitOps', async ({ page }) => {
  const errors = await install(page); await page.evaluate(() => { window.gitopsFixture.failRead = true; });
  await card(page).getByRole('button', { name: '同步', exact: true }).click();
  await expect(page.locator('.gitops-feedback')).toContainText('尚未应用到容器'); await expect(card(page)).toContainText('ccccccc');
  expect(await page.evaluate(() => window.gitopsFixture.driftCalls)).toBeGreaterThanOrEqual(2);
  await page.getByRole('link', { name: '检查并应用配置', exact: true }).click(); await expect(page).toHaveURL(/#\/services\?focus=cache&from=gitops/);
  await page.getByRole('button', { name: '返回GitOps', exact: true }).or(page.getByRole('link', { name: '返回GitOps', exact: true })).click();
  await expect(page.getByRole('heading', { name: 'GitOps 集成', exact: true })).toBeVisible(); expect(errors).toEqual([]);
});

test('历史符合 API 上限，回滚失败保留目标，成功提供后续操作', async ({ page }) => {
  const errors = await install(page); await card(page).getByRole('button', { name: '历史', exact: true }).click(); const history = dialog(page, '提交历史 · 缓存基础设施');
  await expect(history.getByText('初始化缓存配置和持久化数据卷的版本记录', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.gitopsFixture.calls.find(call => call.path.endsWith('/history')).search)).toBe('?limit=100');
  await history.getByRole('button', { name: '回滚', exact: true }).click(); const confirm = dialog(page, '回滚 GitOps 仓库'); await expect(confirm).toContainText('bbbbbbb');
  await page.evaluate(() => { window.gitopsFixture.failWrite = true; }); await confirm.getByRole('button', { name: '确认回滚', exact: true }).click();
  await expect(confirm.getByRole('alert')).toContainText('仓库忙');
  await page.evaluate(() => { Object.assign(window.gitopsFixture, { failWrite: false, failRead: true }); });
  await confirm.getByRole('button', { name: '确认回滚', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.gitops-feedback')).toContainText('尚未应用到容器'); await expect(card(page)).toContainText('已回滚'); await expect(card(page)).toContainText('bbbbbbb'); expect(errors).toEqual([]);
});

test('深链历史关闭后刷新不重开，历史错误能局部重试', async ({ page }) => {
  const errors = await install(page, '?repo=repo-a&from=ops-center'); const history = dialog(page, '提交历史 · 缓存基础设施'); await expect(history).toBeVisible();
  await page.keyboard.press('Escape'); await expect(history).toHaveCount(0);
  await card(page).getByRole('button', { name: '同步', exact: true }).click(); await expect(page.locator('.gitops-feedback')).toBeVisible(); await expect(history).toHaveCount(0);
  await page.evaluate(() => { window.gitopsFixture.failHistory = true; }); await card(page).getByRole('button', { name: '历史', exact: true }).click();
  await expect(history.getByRole('alert')).toContainText('提交历史暂时离线');
  await page.evaluate(() => { window.gitopsFixture.failHistory = false; }); await history.getByRole('button', { name: '重试', exact: true }).click();
  await expect(history.getByRole('alert')).toHaveCount(0); await expect(history.locator('article')).toHaveCount(2); expect(errors).toEqual([]);
});

test('切换节点后迟到的编辑结果不重新打开窗口或误报成功', async ({ page }) => {
  const errors = await install(page); await card(page).getByRole('button', { name: '编辑', exact: true }).click(); const form = dialog(page, '编辑仓库');
  await form.getByLabel('仓库名称', { exact: true }).fill('旧节点迟到内容'); await page.evaluate(() => { window.gitopsFixture.hold = true; });
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.gitopsFixture.release)).toBe(true);
  await page.evaluate(() => { window.dispatchEvent(new CustomEvent('composeops:host-changed')); }); await expect(form).toHaveCount(0);
  await release(page); await expect(page.locator('.gitops-feedback')).toHaveCount(0); await expect(card(page)).not.toContainText('旧节点迟到内容');
  expect(errors).toEqual([]);
});

test('缓存页面离开后旧回调失效，返回可继续操作', async ({ page }) => {
  const errors = await install(page); await card(page).getByRole('button', { name: '编辑', exact: true }).click();
  await page.evaluate(() => { window.gitopsFixture.hold = true; }); await dialog(page, '编辑仓库').getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.gitopsFixture.release)).toBe(true);
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await release(page); await expect(page.locator('.gitops-feedback')).toHaveCount(0);
  await page.goto('./#/gitops'); await expect(card(page).getByRole('button', { name: '编辑', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden'); expect(errors).toEqual([]);
});

test('320px 卡片、路径和提交历史无溢出，素材遵守手机加载策略', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 780 }); await page.emulateMedia({ reducedMotion: 'reduce' }); const errors = await install(page);
  await noOverflow(page); await card(page).getByText('查看工作区路径', { exact: true }).click();
  await expect(card(page).getByText('/srv/compose/infrastructure/production/cache-platform/compose-repository', { exact: true })).toBeVisible(); await noOverflow(page);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some(item => /gitops-\d+.*webp/.test(item.name)))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('gitops-mobile-overview.png'), fullPage: true });
  await card(page).getByRole('button', { name: '历史', exact: true }).click(); const history = dialog(page, '提交历史 · 缓存基础设施'); await expect(history.locator('article')).toHaveCount(2);
  expect(await history.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true); await history.getByRole('button', { name: '回滚', exact: true }).click();
  await expect(dialog(page, '回滚 GitOps 仓库')).toBeVisible(); await page.keyboard.press('Escape'); await expect(history).toBeVisible(); await expect(dialog(page, '回滚 GitOps 仓库')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('gitops-mobile-history.png') }); expect(errors).toEqual([]);
});


test('真实数组形状的漂移结果有中文修复建议，扫描失败保留旧结果并能重试', async ({ page }) => {
  const errors = await install(page); await page.evaluate(() => { window.gitopsFixture.diverged = true; });
  await page.getByRole('button', { name: '重新检测 GitOps 漂移状态', exact: true }).click();
  await expect(card(page)).toContainText('compose.yml'); await expect(card(page)).toContainText('提交或恢复本地改动');
  await expect(page.getByText('有差异 1', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.gitopsFixture.failDrift = true; });
  await page.getByRole('button', { name: '重新检测 GitOps 漂移状态', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('漂移扫描暂不可用'); await expect(card(page)).toContainText('compose.yml');
  await page.evaluate(() => { Object.assign(window.gitopsFixture, { failDrift: false, diverged: false }); });
  await page.getByRole('button', { name: '重新检测 GitOps 漂移状态', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0); await expect(card(page)).not.toContainText('compose.yml'); expect(errors).toEqual([]);
});

test('320px 长表单固定保存入口，失败提示主动进入视口且保持草稿', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 }); const errors = await install(page);
  await card(page).getByRole('button', { name: '编辑', exact: true }).click(); const form = dialog(page, '编辑仓库');
  await form.getByLabel('仓库名称', { exact: true }).fill('窄屏待保存草稿');
  await form.getByPlaceholder('/root/.ssh/id_ed25519').fill('/keys/composeops-ed25519');
  await expect(form.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
  await page.evaluate(() => { window.gitopsFixture.failWrite = true; });
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByRole('alert')).toBeInViewport(); await expect(form.getByRole('alert')).toBeFocused();
  await expect(form.getByLabel('仓库名称', { exact: true })).toHaveValue('窄屏待保存草稿');
  expect(await form.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('gitops-320-form-recovery.png') }); expect(errors).toEqual([]);
});
