import { test, expect } from '@playwright/test';

async function install(page, existing = false) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(existing => {
    const original = window.fetch;
    const f = window.agentStreamFixture = { calls: [], streams: [], rows: existing ? [{ sessionId: 5, title: '排障与恢复', messageCount: 4 }] : [], mode: 'ask', holdCreate: false, failCreate: false, failTruncate: false, failMode: false, failApprove: false };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href), path = url.pathname, method = init.method || 'GET';
      if (!path.startsWith('/api/v1/ai/')) return original(input, init);
      const body = init.body ? JSON.parse(init.body) : {}; f.calls.push({ path, method, body });
      if (method === 'GET' && path === '/api/v1/ai/sessions') return json({ sessions: f.rows });
      if (method === 'GET' && path === '/api/v1/ai/agent/memories') return json({ memories: [] });
      if (method === 'GET' && path === '/api/v1/ai/history') return json({ approvalMode: f.mode, hasMore: false, messages: [
        { id: 101, role: 'user', content: '检查备份完整性' }, { id: 102, role: 'assistant', content: '备份文件校验完成。' },
        { id: 103, role: 'user', content: '核对恢复步骤' }, { id: 104, role: 'assistant', content: '先准备隔离环境，再核对恢复结果。' },
      ] });
      if (path === '/api/v1/ai/agent/sessions' && method === 'POST') {
        if (f.holdCreate) await new Promise(resolve => { f.releaseCreate = resolve; });
        if (f.failCreate) return json({ message: '暂时无法创建会话' }, 503);
        f.rows = [{ sessionId: 5, title: '排障与恢复', messageCount: 0 }]; return json({ sessionId: 5 });
      }
      if (path === '/api/v1/ai/agent/execute-stream') {
        let controller, ended = false;
        const stream = new ReadableStream({ start(value) { controller = value; } });
        const item = { payload: body, emit(event) { if (!ended) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n')); }, close() { if (!ended) { ended = true; controller.close(); } }, fail() { if (!ended) { ended = true; controller.error(new Error('模拟网络断开')); } } };
        init.signal?.addEventListener('abort', () => { if (!ended) { ended = true; controller.error(new DOMException('已中断', 'AbortError')); } });
        f.streams.push(item); item.emit({ type: 'session_meta', userMessageId: 200 + f.streams.length });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === '/api/v1/ai/history/truncate') return f.failTruncate ? json({ message: '历史同步暂时失败' }, 503) : json({ ok: true });
      if (path === '/api/v1/ai/agent/approval-mode') { if (f.failMode) return json({ message: '模式更新失败' }, 503); f.mode = body.mode; return json({ success: true, mode: body.mode }); }
      if (path === '/api/v1/ai/agent/approve') return f.failApprove ? json({ message: '审批请求失败' }, 503) : json({ success: true });
      return original(input, init);
    };
  }, existing);
  await page.goto('./#/agent'); await expect(page.getByRole('heading', { name: 'AI 智能运维 Agent', exact: true })).toBeVisible();
  if (existing) await expect(page.locator('.agent-message')).toHaveCount(4);
  else await expect(page.getByRole('heading', { name: '这是一段新的运维会话' })).toBeVisible();
  return errors;
}
const composer = page => page.getByRole('textbox', { name: '向 Agent 发送消息', exact: true });
async function send(page, text = '只读检查服务') { await composer(page).fill(text); await composer(page).press('Enter'); }
async function count(page, n) { await expect.poll(() => page.evaluate(() => window.agentStreamFixture.streams.length)).toBe(n); }
async function emit(page, event, index = 0) { await page.evaluate(({ event, index }) => window.agentStreamFixture.streams[index].emit(event), { event, index }); }
async function done(page, index = 0, content = '检查完成') { await page.evaluate(({ index, content }) => { const item = window.agentStreamFixture.streams[index]; item.emit({ type: 'done', content }); item.close(); }, { index, content }); }
async function stop(page) { await page.getByRole('button', { name: '中断', exact: true }).click(); await expect(page.getByRole('button', { name: '中断', exact: true })).toHaveCount(0); }

test('SSE分片在执行结束前可见，保留Markdown边界', async ({ page }) => {
  const errors = await install(page); await send(page); await count(page, 1);
  await emit(page, { type: 'token', content: '校验结果\n\n| 文件 | 状态 |\n| --- | --- |\n' });
  await emit(page, { type: 'token', content: '| 备份 | 正常 |\n' });
  await expect(page.locator('.agent-markdown table')).toContainText('备份'); await expect(page.getByRole('button', { name: '中断', exact: true })).toBeVisible();
  await done(page, 0, '校验结果\n\n| 文件 | 状态 |\n| --- | --- |\n| 备份 | 正常 |'); expect(errors).toEqual([]);
});
test('停止暂停后续队列，移除和恢复均作用于正确消息', async ({ page }, info) => {
  const errors = await install(page); await send(page); await count(page, 1); await emit(page, { type: 'token', content: '已经读取容器状态，尚未修改配置。' });
  await send(page, '核对备份'); await send(page, '无需执行的草稿'); await stop(page);
  const queue = page.getByRole('region', { name: '待发送消息' }); await expect(queue).toContainText('队列已暂停'); await expect(queue.getByRole('listitem')).toHaveCount(2);
  await queue.getByRole('button', { name: '移除第 2 条待发送消息' }).click(); await expect(queue.getByRole('listitem')).toHaveCount(1); await count(page, 1);
  await page.screenshot({ path: info.outputPath('agent-paused-queue.png') });
  await queue.getByRole('button', { name: '恢复队列' }).click(); await count(page, 2); expect(await page.evaluate(() => window.agentStreamFixture.streams[1].payload.message)).toBe('核对备份'); await done(page, 1); expect(errors).toEqual([]);
});
test('继续中断任务沿用角色上下文并保持剩余队列暂停', async ({ page }) => {
  await install(page); if (await page.getByRole('button', { name: '会话设置', exact: true }).isVisible()) await page.getByRole('button', { name: '会话设置', exact: true }).click(); await page.getByRole('combobox', { name: '选择本轮 Agent Worker' }).selectOption('validator'); if (await page.getByRole('button', { name: '会话设置', exact: true }).isVisible()) await page.getByRole('button', { name: '会话设置', exact: true }).click(); await send(page); await count(page, 1); await send(page, '稍后核对资源'); await stop(page);
  await page.getByRole('button', { name: '继续执行', exact: true }).click(); await count(page, 2);
  expect(await page.evaluate(() => window.agentStreamFixture.streams[1].payload.role)).toBe('validator'); await done(page, 1); await count(page, 2); await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('队列已暂停');
});
test('网络断开保留部分回答并提供独立恢复入口', async ({ page }, info) => {
  await install(page); await send(page); await count(page, 1); await emit(page, { type: 'token', content: '已确认备份文件存在。' }); await send(page, '检查校验和');
  await page.evaluate(() => window.agentStreamFixture.streams[0].fail()); await expect(page.locator('.agent-markdown')).toContainText('已确认备份文件存在'); await expect(page.locator('.agent-stream-error')).toContainText('模拟网络断开'); await count(page, 1);
  await expect(page.getByRole('button', { name: '继续执行', exact: true })).toBeVisible(); await page.screenshot({ path: info.outputPath('agent-partial-error.png') });
});
test('等待新建会话时显示忙态，中断保留未发送草稿', async ({ page }) => {
  await install(page); await page.evaluate(() => { window.agentStreamFixture.holdCreate = true; }); await send(page, '尚未送出的任务');
  await expect(page.getByRole('button', { name: '中断', exact: true })).toBeVisible(); await page.getByRole('button', { name: '中断', exact: true }).click();
  await page.evaluate(() => window.agentStreamFixture.releaseCreate()); await expect(composer(page)).toHaveValue('尚未送出的任务'); await count(page, 0); await expect(page.locator('.agent-message')).toHaveCount(0);
});
test('创建失败保留输入，修复连接后可以原地重试', async ({ page }) => {
  const errors = await install(page); await page.evaluate(() => { window.agentStreamFixture.failCreate = true; }); await send(page, '保留这段问题'); await expect(composer(page)).toHaveValue('保留这段问题');
  await page.evaluate(() => { window.agentStreamFixture.failCreate = false; }); await composer(page).press('Enter'); await count(page, 1); await done(page); expect(errors).toEqual([]);
});
test('早期回复的重新生成准确截断对应问题之后的历史', async ({ page }) => {
  await install(page, true); await page.getByRole('button', { name: '重新生成回复', exact: true }).first().click(); await count(page, 1);
  expect(await page.evaluate(() => window.agentStreamFixture.calls.find(c => c.path.endsWith('/truncate')).body.fromMessageId)).toBe(101);
  expect(await page.evaluate(() => window.agentStreamFixture.streams[0].payload.message)).toBe('检查备份完整性'); await expect(page.locator('.agent-message')).toHaveCount(2); await done(page);
});
test('编辑重发失败保留编辑横条，重试不会变成追加消息', async ({ page }) => {
  await install(page, true); await page.getByRole('button', { name: '编辑并重发', exact: true }).first().click(); await composer(page).fill('修订的备份核对目标'); await page.evaluate(() => { window.agentStreamFixture.failTruncate = true; }); await composer(page).press('Enter');
  await expect(page.locator('.agent-edit-banner')).toBeVisible(); await expect(composer(page)).toHaveValue('修订的备份核对目标'); await count(page, 0);
  await page.evaluate(() => { window.agentStreamFixture.failTruncate = false; }); await composer(page).press('Enter'); await count(page, 1); await done(page); await expect(page.locator('.agent-edit-banner')).toHaveCount(0);
});
test('工作台转到抽屉继续同一执行，IME不误发送且可停止', async ({ page }) => {
  const errors = await install(page); await send(page); await count(page, 1); await page.evaluate(() => { location.hash = '#/services'; }); await expect(page.locator('.agent-chat')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('composeops:agent-prompt', { detail: { prompt: '稍后检查', context: { page: '服务' } } })));
  const drawer = page.getByRole('dialog', { name: '页面 Agent', exact: true }); await expect(drawer).toBeVisible();
  const input = drawer.getByRole('textbox', { name: '给页面 Agent 发送消息' }); await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 }); await expect(drawer.getByRole('region', { name: '待发送消息' })).toHaveCount(0);
  await input.press('Enter'); await expect(drawer.getByRole('region', { name: '待发送消息' })).toBeVisible(); await drawer.getByRole('button', { name: '中断执行', exact: true }).click(); await expect(drawer.getByRole('region', { name: '待发送消息' })).toContainText('队列已暂停'); await count(page, 1); expect(errors).toEqual([]);
});
test('抽屉参数错误留在确认卡内，原回复和原参数均保留', async ({ page }) => {
  await install(page); await send(page); await count(page, 1); await emit(page, { type: 'token', content: '需要你确认后才能重启。' });
  await emit(page, { type: 'confirmation_required', executionId: 'p1', toolCallId: 'c1', tool: 'compose.restart', params: { projectId: 'p1' }, description: '重启测试项目', risk: 'medium' });
  await page.evaluate(() => { location.hash = '#/services'; }); await expect(page.locator('.agent-chat')).toHaveCount(0); await page.evaluate(() => window.dispatchEvent(new CustomEvent('composeops:agent-prompt', { detail: { prompt: '核对参数' } })));
  const drawer = page.getByRole('dialog', { name: '页面 Agent', exact: true }); await drawer.getByText('查看 / 编辑参数', { exact: true }).click();
  await drawer.getByRole('textbox', { name: '确认执行参数 JSON' }).fill('[]'); await drawer.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(drawer.getByRole('alert')).toContainText('JSON 对象'); await expect(drawer.locator('.agent-drawer-markdown')).toContainText('需要你确认');
  expect(await page.evaluate(() => window.agentStreamFixture.calls.filter(c => c.path.endsWith('/approve')).length)).toBe(0);
  await drawer.getByRole('textbox', { name: '确认执行参数 JSON' }).fill('{"projectId":"p1"}'); await drawer.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(drawer.locator('.agent-drawer-confirm')).toHaveCount(0); await done(page);
});
test('320px窄屏队列可展开、恢复按钮可触达，无横向溢出', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await install(page); await send(page); await count(page, 1); await send(page, '检查这个目标 https://example.invalid/' + 'very-long-path-'.repeat(14)); await stop(page);
  const queue = page.getByRole('region', { name: '待发送消息' }); await expect(queue.getByRole('button', { name: '恢复队列' })).toBeInViewport(); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await composer(page).scrollIntoViewIfNeeded(); await expect(composer(page)).toBeInViewport(); await page.getByRole('button', { name: '排队发送', exact: true }).scrollIntoViewIfNeeded(); await expect(page.getByRole('button', { name: '排队发送', exact: true })).toBeInViewport(); await page.screenshot({ path: info.outputPath('agent-queue-mobile.png') }); await queue.getByRole('button', { name: /队列已暂停/ }).click(); await expect(queue.getByRole('list')).toHaveCount(0);
});

test('连接提前正常结束仍提示未完成，不能自动继续队列', async ({ page }) => {
  await install(page); await send(page); await count(page, 1); await emit(page, { type: 'token', content: '已读取部分状态' }); await send(page, '稍后检查');
  await page.evaluate(() => window.agentStreamFixture.streams[0].close()); await expect(page.locator('.agent-stream-error')).toContainText('未收到任务完成确认'); await count(page, 1); await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('队列已暂停');
});

test('切换到抽屉后新分片继续滚底，向上阅读时保持当前位置', async ({ page }) => {
  await install(page); await send(page); await count(page, 1);
  await emit(page, { type: 'token', content: '读取到一条运行状态。\n\n'.repeat(55) });
  const gap = locator => locator.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(() => gap(page.locator('.agent-messages'))).toBeLessThan(8);
  await page.evaluate(() => { location.hash = '#/services'; }); await expect(page.locator('.agent-chat')).toHaveCount(0); await page.evaluate(() => window.dispatchEvent(new CustomEvent('composeops:agent-prompt', { detail: { prompt: '继续查看输出' } })));
  const drawer = page.getByRole('dialog', { name: '页面 Agent', exact: true }), log = drawer.locator('.agent-drawer-messages');
  await emit(page, { type: 'token', content: '继续读取状态。\n\n'.repeat(20) }); await expect.poll(() => gap(log)).toBeLessThan(8);
  await log.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await emit(page, { type: 'token', content: '新到达的结果。\n\n'.repeat(12) }); await expect(drawer.locator('.agent-drawer-markdown')).toContainText('新到达的结果');
  expect(await log.evaluate(el => el.scrollTop)).toBe(0); await drawer.getByRole('button', { name: '中断执行', exact: true }).click();
});
