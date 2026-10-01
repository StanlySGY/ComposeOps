import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as settle } from 'node:timers/promises';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-agent-stream-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
const { buildApp } = await import('../src/app.js');
const { getAgent } = await import('../src/services/agent.js');
const { setSetting, addAiMessage, getAiHistory, getAiActiveHistory } = await import('../src/lib/db.js');
const { setAiConfig } = await import('../src/services/ai.js');
const { createBackgroundTask, resetBackgroundTasks } = await import('../src/services/agent/background-tasks.js');
const app = await buildApp({ logger: false });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { password: 'isolated-stream-test' } });
assert.equal(setup.statusCode, 200);
const cookie = String(setup.headers['set-cookie']).split(';')[0];
const agent = getAgent();
const realFetch = globalThis.fetch;
setSetting('ai.api_key', 'test-key');
setSetting('ai.base_url', 'http://audit-model.test/v1');
const captured = [];
let replies = [];
let executions = [];
agent.registerTool('test.approval', {
  description: '只写入测试内存', requiredPermission: 'readonly', requiresProject: false, confirmationRequired: true,
  parameters: { type: 'object', properties: { value: { type: 'string' } } },
  execute: async params => { executions.push(params); return { saved: params.value }; },
});

const stream = deltas => [
  ...deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`),
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join('');
const toolReply = () => stream([{ tool_calls: [{ index: 0, id: 'test-call', type: 'function', function: { name: 'test.approval', arguments: '{"value":"original"}' } }] }]);
function mockModel(t) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).startsWith('http://audit-model.test/')) return realFetch(url, options);
    captured.push(JSON.parse(options.body));
    assert.ok(replies.length, '模型调用次数应有界');
    const bytes = Buffer.from(replies.shift());
    return new Response(new ReadableStream({ start(controller) {
      // 故意拆开中文 UTF-8、SSE 行及工具参数。
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
      controller.close();
    } }));
  });
}
async function request(url, body, method = 'POST') {
  const response = await app.inject({ method, url: `/api/v1/ai${url}`, headers: { cookie }, payload: body });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function run(sessionId, onEvent = () => {}, extra = {}, signal = AbortSignal.timeout(10000)) {
  const response = await realFetch(`${base}/api/v1/ai/agent/execute-stream`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message: '受控测试', ...extra }), signal,
  });
  assert.equal(response.status, 200);
  const events = [];
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!frame.startsWith('data: ')) continue;
      const event = JSON.parse(frame.slice(6));
      events.push(event);
      await onEvent(event);
    }
  }
  assert.equal(events.at(-1).type, 'done');
  return events;
}
test.beforeEach(() => { captured.length = 0; executions = []; replies = []; });
test.after(async () => { resetBackgroundTasks(); await app.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

test('真实 SSE: 工具完成后主渠道故障，只重试模型请求且公开切换状态', async t => {
  const { default: db } = await import('../src/lib/db.js');
  t.after(() => db.prepare("DELETE FROM settings WHERE key = 'ai.channels'").run());
  const channel = name => ({ id: name, name, baseUrl: `http://${name}.test/v1`, apiKey: `private-${name}`, model: `${name}-model`, enabled: true, supportsTools: true });
  setAiConfig({ channels: [channel('primary'), channel('backup')] });
  let primaryCalls = 0, backupCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('http://primary.test/')) {
      primaryCalls++;
      return primaryCalls === 1 ? new Response(toolReply()) : new Response('unavailable', { status: 503 });
    }
    if (String(url).startsWith('http://backup.test/')) {
      backupCalls++;
      const body = JSON.parse(options.body);
      assert.ok(body.messages.some(message => message.role === 'tool' && message.content.includes('original')));
      assert.equal(executions.length, 1);
      return new Response(stream([{ content: '已完成，不再重复操作' }]));
    }
    return realFetch(url, options);
  });
  const { sessionId } = await request('/agent/sessions', {});
  const events = await run(sessionId, async event => {
    if (event.type === 'confirmation_required') await request('/agent/approve', { executionId: event.executionId, toolCallId: event.toolCallId, approved: true });
  });
  assert.equal(primaryCalls, 2); assert.equal(backupCalls, 1); assert.equal(executions.length, 1);
  assert.ok(events.some(event => event.type === 'channel_failed' && event.channelName === 'primary'));
  assert.ok(events.some(event => event.type === 'channel_selected' && event.channelName === 'backup'));
  assert.ok(!JSON.stringify(events).includes('private-primary'));
  assert.equal(getAiHistory(10, sessionId).at(-1).content, '已完成，不再重复操作');
});

test('真实 SSE: 审批前不执行,修改参数后执行,中文 Markdown 和日志脱敏完整', async t => {
  mockModel(t);
  const { sessionId } = await request('/agent/sessions', {});
  const answer = '审查完成\n\n| 项目 | 状态 |\n| --- | --- |\n| 中文🙂 | 正常 |';
  replies = [toolReply(), stream([...answer].map(content => ({ content })))];
  const events = await run(sessionId, async event => {
    if (event.type !== 'confirmation_required') return;
    assert.equal(executions.length, 0);
    await request('/agent/approve', { executionId: event.executionId, toolCallId: event.toolCallId, approved: true, input: { value: 'edited' } });
  }, { attachedLogs: 'API_KEY=temporary-private-value\nERROR 中文', pageContext: { state: 'TOKEN=another-private-value' } });
  assert.deepEqual(executions, [{ value: 'edited' }]);
  assert.equal(events.filter(event => event.type === 'token').map(event => event.content).join(''), answer);
  assert.ok(events.some(event => event.type === 'tool_result'));
  assert.ok(!JSON.stringify(captured).includes('temporary-private-value'));
  assert.ok(!JSON.stringify(captured).includes('another-private-value'));
  assert.equal(getAiHistory(10, sessionId).at(-1).content, answer);
});

test('真实 SSE: 拒绝审批不执行工具,流正常结束且清理审批等待', async t => {
  mockModel(t);
  const { sessionId } = await request('/agent/sessions', {});
  replies = [toolReply(), stream([{ content: '已取消' }])];
  const events = await run(sessionId, async event => {
    if (event.type === 'confirmation_required') await request('/agent/approve', { executionId: event.executionId, toolCallId: event.toolCallId, approved: false });
  });
  assert.equal(executions.length, 0);
  assert.ok(events.some(event => event.type === 'tool_rejected'));
  assert.equal(agent.pendingApprovals.size, 0);
  assert.equal(agent.activeExecutions.size, 0);
});

test('真实 SSE: 空轮重试一次恢复,连续空轮返回错误并结束', async t => {
  mockModel(t);
  let { sessionId } = await request('/agent/sessions', {});
  replies = [stream([]), stream([{ content: '恢复完成' }])];
  const recovered = await run(sessionId);
  assert.ok(recovered.some(event => event.type === 'token' && event.content.includes('恢复完成')));
  assert.equal(captured.length, 2);
  ({ sessionId } = await request('/agent/sessions', {}));
  replies = [stream([]), stream([])];
  const failed = await run(sessionId);
  assert.ok(failed.some(event => event.type === 'error' && event.content.includes('空回复')));
  assert.equal(captured.length, 4);
});

test('真实 SSE: 等待审批时关闭连接释放执行和审批槽位', async t => {
  mockModel(t);
  const { sessionId } = await request('/agent/sessions', {});
  replies = [toolReply()];
  const controller = new AbortController();
  await assert.rejects(run(sessionId, event => {
    if (event.type === 'confirmation_required') controller.abort();
  }, {}, controller.signal), { name: 'AbortError' });
  for (let i = 0; i < 100 && agent.activeExecutions.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(executions.length, 0);
  assert.equal(agent.pendingApprovals.size, 0);
  assert.equal(agent.activeExecutions.size, 0);
});

test('压缩 API 保留完整历史,下一轮注入摘要及已完成的后台任务', async t => {
  mockModel(t);
  const { sessionId } = await request('/agent/sessions', {});
  for (let i = 0; i < 8; i++) addAiMessage(i % 2 ? 'assistant' : 'user', `审查消息-${i}`, {}, sessionId);
  const summary = '## 目标\n完成受控审查\n## 下一步\n验证执行链路和后台任务结果。';
  replies = [JSON.stringify({ choices: [{ message: { content: summary } }] })];
  await request('/agent/compact', { sessionId, keepRecent: 2 });
  assert.equal(getAiHistory(20, sessionId).length, 8);
  assert.equal(getAiActiveHistory(20, sessionId).length, 2);
  createBackgroundTask({ sessionId, label: '审查后台任务', run: async output => { output('后台测试完成'); return 0; } });
  await settle();
  replies = [stream([{ content: '已读取摘要和任务结果' }])];
  await run(sessionId);
  const prompt = JSON.stringify(captured.at(-1).messages);
  assert.ok(prompt.includes('完成受控审查'));
  assert.ok(prompt.includes('background-task-update'));
  assert.ok(prompt.includes('后台测试完成'));
  assert.ok(!prompt.includes('审查消息-0'));
});

test('真实 SSE: 兼容模式完成审批、工具执行和结果回传，正文只发射一次', async t => {
  const { default: db } = await import('../src/lib/db.js');
  t.after(() => db.prepare("DELETE FROM settings WHERE key = 'ai.channels'").run());
  setAiConfig({ channels: [{ id: 'compatible', name: '兼容渠道', baseUrl: 'http://compatible.test/v1', apiKey: 'test-key', model: 'compatible-model', streamToolCalls: false }] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).startsWith('http://compatible.test/')) return realFetch(url, options);
    const body = JSON.parse(options.body);
    assert.equal(body.stream, false);
    calls++;
    if (calls === 1) return Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 'buffered-call', type: 'function', function: { name: 'test.approval', arguments: '{"value":"buffered"}' } }] }, finish_reason: 'tool_calls' }] });
    assert.equal(calls, 2);
    assert.ok(body.messages.some(item => item.role === 'tool' && item.content.includes('buffered')));
    return Response.json({ choices: [{ message: { content: '兼容调用已完成' }, finish_reason: 'stop' }] });
  });
  const { sessionId } = await request('/agent/sessions', {});
  const events = await run(sessionId, async event => {
    if (event.type === 'confirmation_required') await request('/agent/approve', { executionId: event.executionId, toolCallId: event.toolCallId, approved: true });
  });
  assert.deepEqual(executions, [{ value: 'buffered' }]);
  assert.equal(calls, 2);
  assert.equal(events.filter(event => event.type === 'token').map(event => event.content).join(''), '兼容调用已完成');
  assert.equal(getAiHistory(10, sessionId).at(-1).content, '兼容调用已完成');
  assert.equal(agent.pendingApprovals.size, 0);
});
