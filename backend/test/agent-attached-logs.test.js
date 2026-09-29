import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-attlogs-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { getAgent } = await import('../src/services/agent.js');
const { createAiSession, getAiHistory, setSetting } = await import('../src/lib/db.js');
const db = (await import('../src/lib/db.js')).default;

const STOP_STREAM = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: '收到' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } })}\n\n`,
  'data: [DONE]\n\n',
].join('');

test('agent: attachedLogs 以不可信定界块注入 Prompt 且不落入会话历史', async () => {
  setSetting('ai.api_key', 'test-key');
  setSetting('ai.base_url', 'http://ai.test/v1');
  const originalFetch = globalThis.fetch;
  const restoreFetch = () => { globalThis.fetch = originalFetch; };
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return new Response(STOP_STREAM, { status: 200 });
  };
  try {
    const agent = getAgent();
    const sessionId = createAiSession();
    const events = [];
    const result = await agent.executeWithLoop(
      '看一下这个报错',
      { sessionId, attachedLogs: 'ERROR boom\nINFO started' },
      (event) => events.push(event),
    );
    assert.equal(result.finalContent, '收到');
    const done = events.find((event) => event.type === 'done');
    assert.deepEqual(done.usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, rounds: 1 });
    assert.deepEqual(db.prepare('SELECT model, prompt_tokens, completion_tokens, total_tokens FROM ai_usage WHERE session_id = ?').get(sessionId), {
      model: 'gpt-4o', prompt_tokens: 12, completion_tokens: 7, total_tokens: 19,
    });
    // 思考/执行进度 trace 进入公开事件流(执行动态面板数据源)
    const traces = events.filter((event) => event.type === 'trace');
    assert.ok(traces.some((event) => event.trace?.phase === 'loop_started'), '应有 loop_started 轨迹');
    assert.ok(traces.every((event) => typeof event.trace?.content === 'string'), 'trace 必须带可展示内容');

    const system = captured.messages.find((message) => message.role === 'system');
    const user = captured.messages.at(-1);
    assert.ok(system.content.includes('UNTRUSTED'), '挂载日志时 system 必须带不可信护栏');
    assert.ok(user.content.includes('<<<UNTRUSTED CONTAINER_LOGS#'), '日志必须包进定界块');
    assert.ok(user.content.includes('ERROR boom'));
    assert.ok(user.content.startsWith('看一下这个报错'), '原问题在前,日志只是附件');

    const history = getAiHistory(10, sessionId).filter((item) => item.role === 'user');
    assert.equal(history.at(-1).content, '看一下这个报错', '落库历史只存原问题,不存日志原文');
  } finally {
    restoreFetch();
  }
});

test('agent: Tool Loop 多轮 usage 累计并逐轮落库', async () => {
  setSetting('ai.api_key', 'test-key');
  setSetting('ai.base_url', 'http://ai.test/v1');
  const agent = getAgent();
  agent.registerTool('test.noop', {
    description: '测试用只读工具',
    requiredPermission: 'readonly',
    confirmationRequired: false,
    requiresProject: false,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  });
  const responses = [
    [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'test.noop', arguments: '{}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''),
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '完成' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''),
  ];
  const sessionId = createAiSession();
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => new Response(responses[callCount++], { status: 200 });
  try {
    const events = [];
    const result = await agent.executeWithLoop('执行一个只读测试', { sessionId }, (event) => events.push(event));
    const done = events.find((event) => event.type === 'done');
    assert.equal(result.finalContent, '完成');
    assert.deepEqual(done.usage, { prompt_tokens: 150, completion_tokens: 15, total_tokens: 165, rounds: 2 });
    assert.deepEqual(db.prepare('SELECT prompt_tokens, completion_tokens, total_tokens FROM ai_usage WHERE session_id = ? ORDER BY id').all(sessionId), [
      { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    ]);
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  }
});
