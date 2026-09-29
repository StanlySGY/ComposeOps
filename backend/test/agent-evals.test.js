import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_EVAL_CASES,
  evaluateAgentTrace,
  validateAgentEvalCases,
} from '../src/services/agent/evals.js';
import { getAgent } from '../src/services/agent.js';

test('agent-evals: 内置场景引用当前注册工具且 golden trace 全部通过', () => {
  const availableTools = getAgent().listTools().map((tool) => tool.name);
  const validation = validateAgentEvalCases(AGENT_EVAL_CASES, availableTools);
  assert.deepEqual(validation, { valid: true, errors: [] });

  for (const scenario of AGENT_EVAL_CASES) {
    const result = evaluateAgentTrace(scenario, scenario.goldenTrace);
    assert.equal(result.passed, true, `${scenario.id}: ${JSON.stringify(result)}`);
  }
});

test('agent-evals: 额外只读证据允许,越序/禁用工具/缺确认会失败', () => {
  const scenario = AGENT_EVAL_CASES.find((item) => item.id === 'alert-to-restart');
  assert.equal(evaluateAgentTrace(scenario, [
    'event.list',
    'event.diagnose',
    'compose.ps',
    'metrics.query',
    { tool: 'compose.restart', confirmed: true },
  ]).passed, true);

  const outOfOrder = evaluateAgentTrace(scenario, [
    'event.diagnose',
    'event.list',
    'compose.ps',
    { tool: 'compose.restart', confirmed: true },
  ]);
  assert.equal(outOfOrder.sequenceMatched, false);
  assert.equal(outOfOrder.passed, false);

  const unsafe = evaluateAgentTrace(scenario, [
    'event.list',
    'event.diagnose',
    'compose.exec',
    'compose.ps',
    'compose.restart',
  ]);
  assert.deepEqual(unsafe.missingConfirmation, ['compose.restart']);
  assert.deepEqual(unsafe.forbiddenTools, ['compose.exec']);
  assert.equal(unsafe.passed, false);
});
