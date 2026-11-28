import { test, expect } from '@playwright/test';

async function install(page) {
  await page.goto('./#/dashboard'); await expect(page.locator('.app-header')).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    const f = window.rollbackFixture = { failHistory: false, failRollback: false, holdHistory: false, holdRollback: false, writes: [], aborted: false };
    const repo = { id: 'synthetic-repo', name: '合成测试仓库', projectId: 'cache', branch: 'main', lastCommit: 'a'.repeat(40) };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href), path = url.pathname;
      if (path === '/api/v1/gitops') return json({ repositories: [repo] });
      if (path.endsWith('/synthetic-repo/history')) {
        init.signal?.addEventListener('abort', () => { f.aborted = true; }, { once: true });
        if (f.holdHistory) await new Promise(resolve => { f.releaseHistory = resolve; });
        if (f.failHistory) return json({ message: '合成历史暂时不可用' }, 503);
        return json({ commits: [{ hash: 'b'.repeat(40), message: '恢复数据库连接配置并保留原数据卷', author: '测试用户', date: '2026-11-28' }] });
      }
      if (path.endsWith('/synthetic-repo/rollback')) {
        f.writes.push({ path, body: JSON.parse(init.body) });
        if (f.holdRollback) await new Promise(resolve => { f.releaseRollback = resolve; });
        if (f.failRollback) return json({ message: '仓库暂时忙碌' }, 409);
        repo.lastCommit = JSON.parse(init.body).commitHash;
        return json({ ok: true, commit: repo.lastCommit });
      }
      return original(input, init);
    };
  });
  await page.goto('./#/review?tab=rollback');
  await expect(page.getByRole('heading', { name: 'GitOps 回滚', exact: true })).toBeVisible();
  return page.getByRole('row').filter({ hasText: '合成测试仓库' }).getByRole('button', { name: '历史', exact: true });
}
const historyModal = page => page.getByRole('dialog', { name: '提交历史 · 合成测试仓库', exact: true });
const confirmModal = page => page.getByRole('dialog', { name: '回滚 GitOps 仓库', exact: true });

test('历史立即打开，关闭取消读取；错误原位重试', async ({ page }) => {
  const open = await install(page); await page.evaluate(() => { window.rollbackFixture.holdHistory = true; });
  await open.click(); const modal = historyModal(page);
  await expect(modal.getByRole('status')).toContainText('正在读取提交历史');
  await expect.poll(() => page.evaluate(() => typeof window.rollbackFixture.releaseHistory)).toBe('function');
  await page.keyboard.press('Escape'); await expect(modal).toHaveCount(0);
  expect(await page.evaluate(() => window.rollbackFixture.aborted)).toBe(true);
  await page.evaluate(() => { window.rollbackFixture.releaseHistory(); window.rollbackFixture.holdHistory = false; window.rollbackFixture.failHistory = true; });
  await open.click(); await expect(modal.getByRole('alert')).toContainText('合成历史暂时不可用');
  await expect(modal.getByText('暂无提交历史', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.rollbackFixture.failHistory = false; });
  await modal.getByRole('button', { name: '重试', exact: true }).click();
  await expect(modal.getByText('恢复数据库连接配置并保留原数据卷', { exact: true })).toBeVisible();
});

test('确认时锁定操作，失败保留目标，成功说明配置仍待应用', async ({ page }) => {
  const open = await install(page); await open.click(); await historyModal(page).getByRole('button', { name: '回滚', exact: true }).click();
  const confirm = confirmModal(page); await expect(confirm).toContainText('bbbbbbb');
  await page.evaluate(() => { window.rollbackFixture.holdRollback = window.rollbackFixture.failRollback = true; });
  await confirm.getByRole('button', { name: '确认回滚', exact: true }).click();
  await expect(confirm.getByRole('button', { name: '执行中…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(confirm).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.rollbackFixture.releaseRollback)).toBe('function');
  await page.evaluate(() => { window.rollbackFixture.holdRollback = false; window.rollbackFixture.releaseRollback(); });
  await expect(confirm.getByRole('alert')).toContainText('仓库暂时忙碌');
  await page.evaluate(() => { window.rollbackFixture.failRollback = false; });
  await confirm.getByRole('button', { name: '确认回滚', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const feedback = page.getByRole('status').filter({ hasText: '工作区已回滚' });
  await expect(feedback).toContainText('运行中的容器尚未应用'); await expect(feedback).toBeInViewport();
  const writes = await page.evaluate(() => window.rollbackFixture.writes);
  expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]); expect(writes[0].body.commitHash).toBe('b'.repeat(40));
  await feedback.getByRole('link', { name: '检查并应用配置', exact: true }).click(); await expect(page).toHaveURL(/#\/services\?focus=cache&from=review/);
});

for (const context of ['host', 'expire']) test(`${context} 后旧回滚完成不弹出成功或重提操作`, async ({ page }) => {
  const open = await install(page); await open.click(); await historyModal(page).getByRole('button', { name: '回滚', exact: true }).click();
  await page.evaluate(() => { window.rollbackFixture.holdRollback = true; });
  await confirmModal(page).getByRole('button', { name: '确认回滚', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.rollbackFixture.releaseRollback)).toBe('function');
  await page.evaluate(context => window.dispatchEvent(new Event(context === 'host' ? 'composeops:host-changed' : 'composeops:unauthorized')), context);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(async () => { window.rollbackFixture.releaseRollback(); await new Promise(resolve => setTimeout(resolve, 150)); });
  await expect(page.getByText(/工作区已回滚/)).toHaveCount(0);
  expect(await page.evaluate(() => window.rollbackFixture.writes.length)).toBe(1);
});

test('320px 历史与确认框不溢出，失败信息在当前弹窗可见', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 }); const open = await install(page); await open.click(); const history = historyModal(page);
  await expect(history.getByText('恢复数据库连接配置并保留原数据卷', { exact: true })).toBeVisible();
  expect(await history.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await history.getByRole('button', { name: '回滚', exact: true }).click(); const confirm = confirmModal(page);
  await page.evaluate(() => { window.rollbackFixture.failRollback = true; });
  await confirm.getByRole('button', { name: '确认回滚', exact: true }).click(); await expect(confirm.getByRole('alert')).toBeInViewport();
  expect(await confirm.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('rollback-320-retry.png') });
});
