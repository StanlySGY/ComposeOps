import { test, expect } from '@playwright/test';

async function install(page, options = {}) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(options => {
    const original = window.fetch, OriginalSocket = window.WebSocket;
    const f = window.shellFixture = { sockets: [], failCapabilities: !!options.failCapabilities, failProjects: false, state: 'running' };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/projects') return f.failProjects ? json({ message: '项目列表暂时不可用' }, 503) : json({ projects: [{ id: 'shell-project', projectName: '生产业务 · 终端验证工作区', status: 'running', editable: true, managed: true, containers: [
        { id: 'shell-web', name: 'composeops-terminal-workspace-long-container-name-web-01', state: f.state }, { id: 'shell-worker', name: '后台任务容器', state: 'running' },
      ] }] });
      if (path === '/api/v1/system/capabilities') return f.failCapabilities ? json({ message: '功能开关暂时不可用' }, 503) : json({ shellEnabled: true });
      return original(input, init);
    };
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        super(); if (!String(url).includes('/ws/exec')) return new OriginalSocket(url);
        this.url = String(url); this.readyState = 0; this.sent = []; f.sockets.push(this);
        queueMicrotask(() => { if (this.readyState !== 0) return; this.readyState = 1; this.onopen?.(new Event('open')); });
      }
      control(value) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) })); }
      output(value) { this.onmessage?.(new MessageEvent('message', { data: new TextEncoder().encode(value).buffer })); }
      send(value) { this.sent.push(value); }
      close() { this.readyState = 3; this.onclose?.(new Event('close')); }
    };
  }, options);
  await page.goto('./#/shell?projectId=shell-project&containerId=shell-web&returnTo=services');
  await expect(page.getByRole('heading', { name: '容器终端', exact: true })).toBeVisible();
  return errors;
}
async function ready(page) { await expect.poll(() => page.evaluate(() => window.shellFixture.sockets.length)).toBeGreaterThan(0); await page.evaluate(() => { const s = window.shellFixture.sockets.at(-1); s.control({ type: 'ready' }); s.output('composeops@web:~$ pwd\r\n/workspace\r\ncomposeops@web:~$ '); }); await expect(page.locator('.terminal-session-bar strong')).toHaveText('已连接'); }
const terminal = page => page.locator('.xterm-helper-textarea');
async function showTargets(page) { const toggle = page.locator('.shell-target-toggle'); if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click(); }
async function commandCount(page) { return page.evaluate(() => window.shellFixture.sockets.flatMap(s => s.sent).filter(value => !value.startsWith('{')).length); }

test('握手后等待真正就绪，禁止输入并可取消', async ({ page }) => {
  const errors = await install(page); await expect(page.locator('.terminal-session-bar')).toContainText('正在启动 Shell');
  await expect(terminal(page)).toHaveAttribute('readonly');
  await page.getByRole('button', { name: '取消连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeEnabled(); expect(await commandCount(page)).toBe(0); expect(errors).toEqual([]);
});
test('先于就绪消息到达的光标查询会在就绪后回复，启动时不能输入命令', async ({ page }) => {
  const errors = await install(page);
  await page.evaluate(() => window.shellFixture.sockets.at(-1).output('startup\r\n\x1b[6n'));
  await expect(terminal(page)).toHaveAttribute('readonly'); expect(await commandCount(page)).toBe(0);
  await page.evaluate(() => window.shellFixture.sockets.at(-1).control({ type: 'ready' }));
  await expect.poll(() => page.evaluate(() => window.shellFixture.sockets.at(-1).sent.some(value => value.startsWith('\x1b[') && /^\d+;\d+R$/.test(value.slice(2))))).toBe(true);
  expect(errors).toEqual([]);
});
test('就绪后输入与中断发送到当前会话，断开保留可见输出', async ({ page }, info) => {
  const errors = await install(page); await ready(page);
  await terminal(page).pressSequentially('pwd'); await terminal(page).press('Enter'); expect(await commandCount(page)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '断开', exact: true }).click();
  await expect(page.locator('.terminal-empty')).toHaveCount(0); await expect(page.locator('.shell-output-hint')).toContainText('输出已保留');
  await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('shell-retained.png'), fullPage: true }); expect(errors).toEqual([]);
});
test('目标切换保留上次输出归属，新连接明确绑定新容器', async ({ page }) => {
  await install(page); await ready(page); await showTargets(page); await page.getByRole('combobox', { name: '选择终端容器' }).selectOption('shell-worker');
  await expect(page.locator('.terminal-session-bar')).toContainText('long-container-name-web');
  await expect(page.locator('.terminal-session-bar')).toContainText('上次输出保留');
  await page.getByRole('button', { name: '新建会话', exact: true }).click(); await ready(page);
  await expect(page.locator('.terminal-session-bar')).toContainText('后台任务容器');
  expect(await page.evaluate(() => window.shellFixture.sockets.at(-1).url)).toContain('containerId=shell-worker');
});
test('清除显示不提交任何命令，辅助方向键有明确名称', async ({ page }, info) => {
  await install(page); await ready(page); await terminal(page).pressSequentially('echo pending');
  const before = await commandCount(page); await page.getByRole('button', { name: '清除终端滚动记录' }).click(); expect(await commandCount(page)).toBe(before);
  if (info.project.name.includes('mobile')) {
    for (const name of ['发送方向左键', '发送方向上键', '发送方向下键', '发送方向右键']) await page.getByRole('button', { name, exact: true }).click();
    expect(await commandCount(page)).toBe(before + 4);
  }
});
test('刷新发现停止容器时阻止后续输入，输出不被遮挡', async ({ page }) => {
  await install(page); await ready(page); await page.evaluate(() => { window.shellFixture.state = 'exited'; });
  await page.getByRole('button', { name: '刷新终端目标' }).click();
  await expect(page.getByText('当前容器未运行，无法建立终端。', { exact: false })).toBeVisible(); await expect(page.locator('.terminal-empty')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeDisabled();
});
test('功能开关请求失败保留项目列表，重试不自动建立会话', async ({ page }) => {
  await install(page, { failCapabilities: true }); await expect(page.getByRole('alert')).toContainText('功能开关暂时不可用');
  await expect(page.getByRole('combobox', { name: '选择终端项目' })).toContainText('终端验证工作区');
  await page.evaluate(() => { window.shellFixture.failCapabilities = false; }); await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeEnabled(); expect(await page.evaluate(() => window.shellFixture.sockets.length)).toBe(0);
});
test('服务端错误解释原因且不会伪报连接成功', async ({ page }) => {
  await install(page); await page.evaluate(() => window.shellFixture.sockets[0].control({ type: 'error', data: '容器未安装 bash，请改用 sh' }));
  await expect(page.getByRole('alert')).toContainText('容器未安装 bash'); await expect(page.locator('.terminal-session-bar')).not.toContainText('已连接'); await expect(page.getByRole('button', { name: '连接', exact: true })).toBeEnabled();
});
test('Shell选择写入URL且项目返回入口可点击', async ({ page }) => {
  await install(page); await ready(page); await showTargets(page); await page.getByRole('combobox', { name: '选择终端 Shell' }).selectOption('bash');
  await expect(page).toHaveURL(/cmd=bash/); await page.getByRole('navigation', { name: '项目内导航' }).getByRole('link', { name: '项目', exact: true }).click();
  await expect(page).toHaveURL(/#\/services/); expect(await page.evaluate(() => window.shellFixture.sockets[0].readyState)).toBe(3);
});
test('320像素窄屏长目标不造成页面横向溢出', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 }); await install(page); await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.getByRole('button', { name: '断开', exact: true })).toBeVisible();
  await page.locator('.terminal-host').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('shell-narrow.png'), fullPage: true });
});

async function searchOutput(page) {
  await page.evaluate(() => window.shellFixture.sockets.at(-1).output('\r\nError alpha\r\nerror beta\r\nError gamma\r\n' + Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n$ '));
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  await page.getByRole('textbox', { name: '终端查找内容' }).fill('Error');
  await expect(page.locator('.shell-search-result')).toHaveText(/\d \/ 3/);
}
test('查找真实终端滚动记录并循环跳转、区分大小写和反馈无匹配', async ({ page }, info) => {
  const errors = await install(page); await ready(page); const before = await commandCount(page); await searchOutput(page);
  const query = page.getByRole('textbox', { name: '终端查找内容' }), result = page.locator('.shell-search-result');
  const first = await result.innerText();
  await query.press('Enter'); await expect(result).not.toHaveText(first);
  await query.press('Shift+Enter'); await expect(result).toHaveText(first);
  await page.getByRole('button', { name: '区分大小写' }).click();
  await expect(result).toHaveText(/\d \/ 2/); await expect(page.getByRole('button', { name: '区分大小写' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath('shell-search.png'), fullPage: true });
  await query.fill('不存在的内容'); await expect(result).toHaveText('未找到匹配');
  await expect(page.getByRole('button', { name: '下一个匹配' })).toBeDisabled();
  await query.fill(''); await expect(result).toHaveText('输入关键词');
  expect(await commandCount(page)).toBe(before); expect(errors).toEqual([]);
});
test('查找快捷键和关闭恢复焦点不会发送 Shell 按键', async ({ page }) => {
  const errors = await install(page); await ready(page); await searchOutput(page);
  const query = page.getByRole('textbox', { name: '终端查找内容' }); const before = await commandCount(page);
  await query.press('Escape'); await expect(query).toHaveCount(0); await expect(terminal(page)).toBeFocused();
  await terminal(page).press('Control+f'); await expect(query).toBeFocused();
  await query.press('F3'); await query.press('Shift+F3');
  await query.press('Escape'); await terminal(page).press('Meta+f'); await expect(query).toBeFocused();
  await page.getByRole('button', { name: '关闭终端查找' }).click(); await expect(terminal(page)).toBeFocused();
  expect(await commandCount(page)).toBe(before);
  await terminal(page).pressSequentially('pwd'); expect(await commandCount(page)).toBeGreaterThan(before); expect(errors).toEqual([]);
});
test('持续输出更新匹配计数，回到最新输出结束查找且不发送命令', async ({ page }) => {
  const errors = await install(page); await ready(page); await searchOutput(page);
  const before = await commandCount(page);
  await page.evaluate(() => window.shellFixture.sockets.at(-1).output('\r\nError delta\r\n$ '));
  await expect(page.locator('.shell-search-result')).toHaveText(/\d \/ 4/);
  await expect(page.getByRole('button', { name: '回到最新终端输出' })).toBeEnabled();
  await page.getByRole('button', { name: '回到最新终端输出' }).click();
  await expect(page.locator('.shell-search')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '回到最新终端输出' })).toBeDisabled();
  await expect(terminal(page)).toBeFocused(); expect(await commandCount(page)).toBe(before); expect(errors).toEqual([]);
});
test('断开后仍可搜索，新会话清除关键词与旧结果', async ({ page }) => {
  const errors = await install(page); await ready(page); await searchOutput(page);
  await showTargets(page); await page.getByRole('button', { name: '断开', exact: true }).click();
  await page.getByRole('textbox', { name: '终端查找内容' }).fill('gamma'); await expect(page.locator('.shell-search-result')).toHaveText('1 / 1');
  await page.getByRole('button', { name: '新建会话', exact: true }).click(); await ready(page);
  await expect(page.locator('.shell-search')).toHaveCount(0);
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '终端查找内容' })).toHaveValue('');
  await page.getByRole('textbox', { name: '终端查找内容' }).fill('gamma'); await expect(page.locator('.shell-search-result')).toHaveText('未找到匹配'); expect(errors).toEqual([]);
});
test('清除滚动记录后匹配同步消失，窄屏查找栏无横向溢出', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 }); const errors = await install(page); await ready(page); await searchOutput(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.getByRole('button', { name: '关闭终端查找' })).toBeVisible();
  expect((await page.locator('.shell-terminal').boundingBox()).height).toBeGreaterThanOrEqual(180);
  await page.screenshot({ path: info.outputPath('shell-search-narrow.png'), fullPage: true });
  const before = await commandCount(page); await page.getByRole('button', { name: '清除终端滚动记录' }).click();
  await expect(page.locator('.shell-search-result')).toHaveText('未找到匹配'); expect(await commandCount(page)).toBe(before); expect(errors).toEqual([]);
});
test('中文跨软换行仍能定位，达到高亮上限时不误报精确总数', async ({ page }) => {
  const errors = await install(page); await ready(page);
  const needle = '中文终端查找'.repeat(50);
  await page.evaluate(text => window.shellFixture.sockets.at(-1).output(`\r\n${text}\r\n${'match '.repeat(1050)}\r\n$ `), needle);
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click(); const query = page.getByRole('textbox', { name: '终端查找内容' });
  await query.fill(needle); await expect(page.locator('.shell-search-result')).toHaveText('1 / 1');
  await query.fill('match'); await expect(page.locator('.shell-search-result')).toHaveText('至少 1000 处');
  await page.getByRole('button', { name: '下一个匹配' }).click(); expect(errors).toEqual([]);
});
