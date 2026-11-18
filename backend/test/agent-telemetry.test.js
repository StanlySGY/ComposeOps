import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTrace } from '../src/services/agent/telemetry.js';

test('Agent OTLP exporter emits GenAI spans without prompt or tool argument content', async () => {
  let captured = null;
  const trace = createAgentTrace({ role: 'executor', planId: 'plan-42', endpoint: 'http://collector.invalid:4318/v1/traces', fetchImpl: async (url, options) => {
    captured = { url, payload: JSON.parse(options.body) };
    return { ok: true, status: 200 };
  } });
  const llm = trace.startSpan('chat', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'model-x' });
  llm.end({ ok: true, values: { 'gen_ai.usage.input_tokens': 12, 'gen_ai.usage.output_tokens': 5 } });
  const tool = trace.startSpan('execute_tool', { 'gen_ai.tool.name': 'compose.ps' });
  tool.end({ ok: true, values: { 'composeops.tool.duration_ms': 18, 'tool.arguments': 'do-not-export-this' } });
  trace.root.end({ ok: true, values: { 'composeops.execution.status': 'completed' } });
  await trace.flush();
  assert.equal(captured.url, 'http://collector.invalid:4318/v1/traces');
  const spans = captured.payload.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 3);
  assert.equal(spans[0].name, 'invoke_agent');
  assert.equal(spans[1].name, 'chat');
  assert.equal(spans[2].name, 'execute_tool');
  assert.equal(spans[1].parentSpanId, spans[0].spanId);
  assert.equal(spans[2].parentSpanId, spans[0].spanId);
  assert.equal(JSON.stringify(captured.payload).includes('do-not-export-this'), false);
  assert.equal(JSON.stringify(captured.payload).includes('prompt'), false);
});

test('Agent OTLP exporter is disabled without endpoint', async () => {
  let called = false;
  const trace = createAgentTrace({ role: 'planner', endpoint: '', fetchImpl: async () => { called = true; throw new Error('must not be called'); } });
  trace.startSpan('chat', { 'gen_ai.request.model': 'model-y' }).end();
  await trace.flush();
  assert.equal(called, false);
});