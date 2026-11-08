import { test, expect } from '@playwright/test';
const source = 'services:\n  web:\n    image: nginx:alpine\n    environment:\n      MESSAGE: "你好 ComposeOps"\n';
async function install(page, mode = 'clipboard') {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(({ mode, source }) => {
    const original = window.fetch; const f = window.codeCopyFixture = { copied: [], mode };
    const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'http' ? undefined : { writeText: async text => { if (f.mode === 'failed') throw new Error('permission denied'); f.copied.push(text); } } });
    document.execCommand = command => { if (command !== 'copy' || f.mode === 'failed') return false; f.copied.push(document.activeElement.value); return true; };
    window.fetch = async (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/ai/sessions') return json({ sessions: [{ sessionId: 30, title: '配置说明', messageCount: 2 }] });
      if (path === '/api/v1/ai/history') return json({ messages: [{ id: 1, role: 'user', content: '解释配置' }, { id: 2, role: 'assistant', content: '检查缩进后再保存配置。\n\n```yaml\n' + source + '```' }], hasMore: false, approvalMode: 'ask' });
      return original(input, options);
    };
  }, { mode, source });
  await page.goto('./#/agent'); await expect(page.getByRole('button', { name: '复制代码', exact: true })).toBeVisible(); return errors;
}
test('工作台代码复制入口常显，保留中文、缩进和换行', async ({ page }, info) => {
  const errors = await install(page); await page.getByRole('button', { name: '复制代码', exact: true }).click();
  await expect(page.locator('.agent-markdown [role="status"]')).toHaveText('已复制代码'); expect(await page.evaluate(() => window.codeCopyFixture.copied)).toEqual([source]);
  await page.screenshot({ path: info.outputPath('agent-code-copy.png'), fullPage: true }); expect(errors).toEqual([]);
});
test('HTTP复制回退不会吞掉输入草稿或选区', async ({ page }) => {
  await install(page, 'http'); const input = page.getByRole('textbox', { name: '向 Agent 发送消息', exact: true }); await input.fill('保留未发送的草稿');
  await input.evaluate(el => { el.focus(); el.setSelectionRange(2, 5); });
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  expect(await page.evaluate(() => window.codeCopyFixture.copied)).toEqual([source]); await expect(input).toHaveValue('保留未发送的草稿');
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 5]);
});
test('复制权限失败有反馈并可重试，不出现未捕获异常', async ({ page }) => {
  const errors = await install(page, 'failed'); await page.getByRole('button', { name: '复制代码', exact: true }).click();
  await expect(page.locator('.agent-markdown [role="status"]')).toContainText('复制失败'); await expect(page.getByRole('button', { name: '复制代码', exact: true })).toHaveText('重试复制');
  await page.evaluate(() => { window.codeCopyFixture.mode = 'clipboard'; }); await page.getByRole('button', { name: '复制代码', exact: true }).click();
  expect(await page.evaluate(() => window.codeCopyFixture.copied)).toEqual([source]); expect(errors).toEqual([]);
});
test('代码块在手机窄屏不遮挡正文且不撑宽页面', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await install(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const button = await page.getByRole('button', { name: '复制代码', exact: true }).boundingBox();
  const code = await page.locator('.agent-markdown pre code').boundingBox(); expect(button.y + button.height).toBeLessThanOrEqual(code.y + 2);
});
