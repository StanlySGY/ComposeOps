import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-agent-isolation-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { OperationsAgent } = await import('../src/services/agent.js');
const { createAgentPlan, listAgentExecutions } = await import('../src/lib/db.js');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('agent: concurrent macro runs keep audit ownership and runaway guards isolated', async () => {
  const agent = new OperationsAgent();
  const planA = createAgentPlan(0, '并发宏任务 A', { role: 'planner', steps: [], confirmations: [] });
  const planB = createAgentPlan(0, '并发宏任务 B', { role: 'planner', steps: [], confirmations: [] });
  const startedA = deferred();
  const startedB = deferred();
  const releaseA = deferred();
  const releaseB = deferred();
  const guardCalls = { a: 0, b: 0 };
  const guardA = { observe() { guardCalls.a += 1; return null; } };
  const guardB = { observe() { guardCalls.b += 1; return null; } };

  // Hold each macro at its first step so both runs overlap on the same Agent instance.
  const originalExecuteTool = agent.executeTool.bind(agent);
  agent.executeTool = async (toolName, params = {}) => {
    if (toolName === 'backup.trigger' && params.projectId === 'project-a') {
      startedA.resolve();
      await releaseA.promise;
    } else if (toolName === 'backup.trigger' && params.projectId === 'project-b') {
      startedB.resolve();
      await releaseB.promise;
    }
    return { success: true, result: { projectId: params.projectId || null }, durationMs: 1, postconditionStatus: 'passed' };
  };

  const runMacro = (projectId, planId, runawayGuard) => originalExecuteTool(
    'macro.safe_restart', { projectId }, {}, [], { planId, runawayGuard },
  );

  const runA = runMacro('project-a', planA, guardA);
  await startedA.promise;
  const runB = runMacro('project-b', planB, guardB);
  await startedB.promise;

  releaseB.resolve();
  releaseA.resolve();
  const [resultA, resultB] = await Promise.all([runA, runB]);

  assert.equal(resultA.success, true);
  assert.equal(resultB.success, true);
  assert.deepEqual(listAgentExecutions(planA).map((row) => row.tool_name), [
    'backup.trigger', 'compose.stop', 'config.validate', 'compose.up',
  ]);
  assert.deepEqual(listAgentExecutions(planB).map((row) => row.tool_name), [
    'backup.trigger', 'compose.stop', 'config.validate', 'compose.up',
  ]);
  assert.equal(guardCalls.a, 4, 'run A must observe only its own four macro steps');
  assert.equal(guardCalls.b, 4, 'run B must observe only its own four macro steps');
  assert.equal(agent._loopAudit, undefined, 'execution-scoped state must not live on the Agent singleton');
});
