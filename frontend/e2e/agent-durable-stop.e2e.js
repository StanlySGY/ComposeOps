import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: '向 Agent 发送消息', exact: true });
const stop = page => page.getByRole('button', { name: '中断', exact: true });

test('离线演示显示真实模拟任务状态，中断后释放输入且没有未模拟查询错误', async ({ page }) => {
  await page.goto('./#/agent');
  await input(page).fill('只读检查示例项目'); await input(page).press('Enter');
  await expect(page.locator('.agent-markdown')).toContainText('离线预设排障演示');
  await expect(page.getByText('此操作未在离线预览中模拟', { exact: false })).toHaveCount(0);
  await stop(page).click(); await expect(stop(page)).toHaveCount(0);
  await expect(input(page)).toBeEditable();
  const result = await page.evaluate(async () => {
    const { sessions } = await (await fetch('/api/v1/ai/sessions')).json();
    return (await fetch('/api/v1/ai/agent/sessions/' + sessions[0].sessionId + '/runs')).json();
  });
  expect(result.runs).toHaveLength(1);
  expect(result.runs[0].status).toBe('interrupted');
  expect(result.runs[0].result.finalContent).toContain('没有执行真实操作');
  await page.getByRole('button', { name: '继续执行', exact: true }).click();
  await expect.poll(() => page.evaluate(async id => (await (await fetch('/api/v1/ai/agent/runs/' + id)).json()).run.status, result.runs[0].id)).toBe('waiting_approval');
  const progress = page.getByRole('region', { name: '任务进度与恢复' });
  await expect(progress).toContainText('等待审批');
  await progress.getByRole('button', { name: '批准此步骤', exact: true }).click();
  await expect(progress).toContainText('本轮完成');
  const final = await page.evaluate(async id => (await fetch('/api/v1/ai/agent/runs/' + id)).json(), result.runs[0].id);
  expect(final.run.id).toBe(result.runs[0].id);
  expect(final.run.status).toBe('completed');
  expect(final.run.result.finalContent).toContain('模拟修复完成');
  const duplicate = await page.evaluate(async ({ id, revision }) => (await fetch('/api/v1/ai/agent/runs/' + id + '/resume', { method: 'POST', body: JSON.stringify({ revision }) })).status, final.run);
  expect(duplicate).toBe(409);
});

test('先中断后收到编号时停止失败可重试，队列不会自动执行', async ({ page }) => {
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    const fixture = window.durableStopFixture = { calls: 0, executions: 0, emit: null };
    window.fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/ai/agent/execute-stream') {
        fixture.executions++;
        const stream = new ReadableStream({ start(controller) {
          fixture.emit = event => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
          init.signal.addEventListener('abort', () => controller.error(new DOMException('停止', 'AbortError')), { once: true });
        } });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === '/api/v1/ai/agent/runs/late-stop/stop') {
        fixture.calls++;
        return new Response(JSON.stringify(fixture.calls === 1 ? { message: '模拟停止服务离线' } : { run: { status: 'stopping' } }), { status: fixture.calls === 1 ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
      }
      return original(input, init);
    };
  });
  await page.goto('./#/agent');
  await input(page).fill('第一项检查'); await input(page).press('Enter');
  await expect.poll(() => page.evaluate(() => window.durableStopFixture.executions)).toBe(1);
  await input(page).fill('保留待发送检查'); await input(page).press('Enter');
  await stop(page).click();
  await page.evaluate(() => window.durableStopFixture.emit({ type: 'durable_run', runId: 'late-stop', status: 'running' }));
  await expect(page.locator('.agent-stream-error')).toContainText('停止请求未确认');
  await page.evaluate(() => window.durableStopFixture.emit({ type: 'token', content: '停止尚未确认，继续显示服务端进展。' }));
  await expect(page.locator('.agent-markdown')).toContainText('继续显示服务端进展');
  await stop(page).click(); await expect(stop(page)).toHaveCount(0);
  await expect(page.locator('.agent-stream-error')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('队列已暂停');
  expect(await page.evaluate(() => ({ calls: window.durableStopFixture.calls, executions: window.durableStopFixture.executions }))).toEqual({ calls: 2, executions: 1 });
});
