import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgUiAdapter } from '../src/lib/agent-agui.js';

test('AG-UI adapter emits run and message lifecycle events around native token stream', () => {
  const adapter = createAgUiAdapter({ threadId: 'session-7', runId: 'run-1' });
  const first = adapter.map({ type: 'token', content: '你好' });
  assert.deepEqual(first.map((event) => event.type), ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
  assert.equal(first[0].threadId, 'session-7');
  assert.equal(first[2].delta, '你好');
  const second = adapter.map({ type: 'tool_result', tool: 'compose.ps', success: true });
  assert.deepEqual(second.map((event) => event.type), ['CUSTOM']);
  assert.equal(second[0].name, 'composeops.tool_result');
  const done = adapter.map({ type: 'done', content: '你好' });
  assert.deepEqual(done.map((event) => event.type), ['TEXT_MESSAGE_END', 'RUN_FINISHED']);
  assert.deepEqual(adapter.map({ type: 'done', closed: true }), []);
});

test('AG-UI adapter supports non-streaming completion and terminal errors', () => {
  const complete = createAgUiAdapter({ threadId: 't', runId: 'r' });
  assert.deepEqual(complete.map({ type: 'done', content: '完成' }).map((event) => event.type), [
    'RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED',
  ]);
  const failed = createAgUiAdapter({ threadId: 't', runId: 'r2' });
  const events = failed.map({ type: 'error', content: '上游失败' });
  assert.deepEqual(events.map((event) => event.type), ['RUN_STARTED', 'RUN_ERROR']);
  assert.equal(events[1].message, '上游失败');
  assert.deepEqual(failed.map({ type: 'done' }), []);
});
