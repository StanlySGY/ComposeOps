import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunBudget, fitAgentContext, validateBudget, BUDGET_DEFAULTS } from '../src/services/agent/budget.js';
import { createRun, getRun, patchRun } from '../src/services/agent/run-store.js';
import { createAiSession } from '../src/lib/db.js';
import { requestWithAiChannels } from '../src/services/ai-channels.js';
const limits = { ...BUDGET_DEFAULTS, total: 10000, output: 1000, rounds: 2 };
test('budget reserves before requests, conservatively retains failed usage and cannot reset on resume', () => {
 const run = createRun('预算', { sessionId: createAiSession() });
 const context = { durableRunId: run.id, budgetLimits: limits }, budget = createRunBudget(context, () => {});
 budget.reserve({ messages: [{ role: 'user', content: 'x'.repeat(5000) }], tools: [] });
 assert.throws(() => budget.reserve({ messages: [{ role: 'user', content: 'x'.repeat(5000) }], tools: [] }), /预算/);
 patchRun(run.id, { checkpoint: { content: 'another trace' } });
 assert.ok(getRun(run.id).checkpoint.budget.used > 5000);
 const resumed = createRunBudget(context, () => {});
 assert.throws(() => resumed.reserve({ messages: [{ role: 'user', content: 'x'.repeat(5000) }], tools: [] }), /预算/);
});
test('budget uses reported usage, guards writes after overrun and validates limits', () => {
 const budget = createRunBudget({ budgetLimits: limits }, () => {});
 budget.reserve({ messages: [{ role: 'user', content: 'x' }], tools: [] }); budget.settle({ total_tokens: 12000 });
 assert.throws(() => budget.assertRemaining(), /预算/);
 assert.equal(budget.snapshot().reported, 12000); assert.equal(budget.snapshot().estimated, false);
 assert.throws(() => validateBudget({ ...limits, total: -1 }), /预算/);
});
test('context trimming preserves goal and complete latest tool call pairs', () => {
 const messages = [{ role: 'system', content: 'policy' }, { role: 'user', content: 'old'.repeat(5000) }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'CURRENT GOAL' }, { role: 'assistant', tool_calls: [{ id: 'a' }] }, { role: 'tool', tool_call_id: 'a', content: 'x'.repeat(8000) }, { role: 'assistant', tool_calls: [{ id: 'b' }] }, { role: 'tool', tool_call_id: 'b', content: 'latest proof' }];
 const fitted = fitAgentContext(messages, [], 7000); assert.ok(fitted.savedBytes > 0);
 assert.ok(fitted.messages.some(m => m.content === 'CURRENT GOAL')); assert.equal(fitted.messages.at(-1).tool_call_id, 'b');
 assert.ok(fitted.messages.some(m => m.tool_calls?.some(c => c.id === 'b')));
 assert.equal(messages[1].content.length, 15000);
});
test('channel failover is charged per attempt; budget exhaustion does not dispatch fallback', async () => {
 const budget = createRunBudget({ budgetLimits: { ...limits, rounds: 1 } }, () => {}); let calls = 0;
 const channels = [1,2].map(id => ({ id: 'budget'+id, apiKey: 'fixture', baseUrl: 'http://budget.test', model: 'fixture' }));
 await assert.rejects(requestWithAiChannels({ channels, messages: [], tools: [], beforeRequest: data => budget.reserve(data) }, async () => { calls++; throw Object.assign(new Error('limit'), { status: 429 }); }), /预算/);
 assert.equal(calls, 1);
});
