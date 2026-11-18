import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgUiAdapter } from '../src/lib/agent-agui.js';
import { toA2UiMessages } from '../src/lib/agent-a2ui.js';

test('AG-UI 1.0 emits run, text and complete server-side tool-call lifecycle events', () => {
  const adapter = createAgUiAdapter({ threadId: 'session-7', runId: 'run-1' });
  const first = adapter.map({ type: 'token', content: '你好' });
  assert.deepEqual(first.map((event) => event.type), ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
  assert.equal(first[0].threadId, 'session-7');
  assert.equal(first[2].delta, '你好');

  const requested = adapter.map({ type: 'tool_requested', toolCallId: 'call-1', tool: 'compose.ps', paramsText: '{"projectId":"p1"}' });
  assert.deepEqual(requested.map((event) => event.type), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'CUSTOM']);
  assert.equal(requested[0].toolCallId, 'call-1');
  assert.equal(requested[0].toolCallName, 'compose.ps');
  assert.equal(requested[1].delta, '{"projectId":"p1"}');

  const executing = adapter.map({ type: 'tool_executing', toolCallId: 'call-1', tool: 'compose.ps' });
  assert.deepEqual(executing.map((event) => event.type), ['STEP_STARTED', 'CUSTOM']);
  const result = adapter.map({ type: 'tool_result', toolCallId: 'call-1', tool: 'compose.ps', success: true, summary: '2 services' });
  assert.deepEqual(result.map((event) => event.type), ['TOOL_CALL_RESULT', 'STEP_FINISHED', 'CUSTOM']);
  assert.equal(JSON.parse(result[0].content).summary, '2 services');
  assert.equal(result[2].name, 'composeops.tool_result');

  const done = adapter.map({ type: 'done', content: '你好' });
  assert.deepEqual(done.map((event) => event.type), ['CUSTOM', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
  assert.deepEqual(adapter.map({ type: 'done', closed: true }), []);
});

test('AG-UI adapter wraps A2UI v1.0 surfaces in typed custom events', () => {
  const adapter = createAgUiAdapter({ threadId: 't', runId: 'r-ui' });
  const events = adapter.map({ type: 'ui_present', blocks: [{ type: 'notice', title: '发布状态', text: '已完成' }] });
  const a2ui = events.find((event) => event.name === 'a2ui.message');
  assert.equal(a2ui.type, 'CUSTOM');
  assert.equal(a2ui.value.version, 'v1.0');
  assert.equal(a2ui.value.createSurface.surfaceId, 'composeops_r-ui-ui-0');
  assert.equal(a2ui.value.createSurface.components[0].id, 'root');
});

test('A2UI v1.0 converter emits only fixed basic-catalog components and bounds input', () => {
  const [message] = toA2UiMessages([{ type: 'status', title: 'API', status: 'healthy' }, { type: 'metrics', items: [{ label: 'CPU', value: '42', unit: '%' }] }], 'run-2');
  assert.equal(message.version, 'v1.0');
  const components = message.createSurface.components;
  assert.ok(components.every((item) => ['Column', 'Card', 'Text'].includes(item.component)));
  assert.ok(components.some((item) => item.id === 'root' && item.component === 'Column'));
  assert.ok(components.some((item) => item.component === 'Text' && item.text === 'API'));
  assert.deepEqual(toA2UiMessages([], 'run-3'), []);
});

test('AG-UI adapter supports non-streaming completion and terminal errors', () => {
  const complete = createAgUiAdapter({ threadId: 't', runId: 'r' });
  assert.deepEqual(complete.map({ type: 'done', content: '完成' }).map((event) => event.type), [
    'RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'CUSTOM', 'TEXT_MESSAGE_END', 'RUN_FINISHED',
  ]);
  const failed = createAgUiAdapter({ threadId: 't', runId: 'r2' });
  const events = failed.map({ type: 'error', content: '上游失败' });
  assert.deepEqual(events.map((event) => event.type), ['RUN_STARTED', 'RUN_ERROR']);
  assert.equal(events[1].message, '上游失败');
  assert.deepEqual(failed.map({ type: 'done' }), []);
});
