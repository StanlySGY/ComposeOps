import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';

const { createDefinition } = await import('../src/services/workflow-engine.js');
const { routeWorkflowEvent, runWorkflowCronTriggers } = await import('../src/services/event-router.js');
const { getWorkflowInstance } = await import('../src/lib/db.js');

test('event router starts only definitions matching explicitly configured event types', async () => {
  const definition = createDefinition({
    name: 'Docker container event',
    triggerType: 'event',
    triggerConfig: { eventTypes: 'container', sources: 'docker', actions: 'die', projectId: 'project-a' },
    nodes: [{ id: 'trigger', type: 'trigger', config: {} }],
  });
  const result = await routeWorkflowEvent({
    eventId: 'docker:host-a:container-a:die:123',
    source: 'docker',
    eventType: 'container',
    action: 'die',
    projectId: 'project-a',
    timestamp: 123,
  });
  assert.equal(result.matched, 1);
  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].replayed, false);
  assert.ok(getWorkflowInstance(result.started[0].instanceId));
  assert.equal(definition.enabled, 1);
});

test('event router is idempotent for the same source event', async () => {
  const definition = createDefinition({
    name: 'Idempotent Docker event',
    triggerType: 'event',
    triggerConfig: { eventTypes: ['container'], sources: ['docker'] },
    nodes: [{ id: 'trigger', type: 'trigger', config: {} }],
  });
  const event = {
    eventId: 'docker:host-a:container-b:die:456',
    source: 'docker',
    eventType: 'container',
    action: 'die',
    projectId: 'project-b',
    timestamp: 456,
  };
  const first = await routeWorkflowEvent(event);
  const second = await routeWorkflowEvent(event);
  assert.equal(first.matched, 1);
  assert.equal(second.started.length, 1);
  assert.equal(second.started[0].replayed, true);
  assert.equal(second.started[0].instanceId, first.started[0].instanceId);
  assert.equal(definition.triggerType, 'event');
});

test('event router does not let a workflow event recursively trigger another workflow', async () => {
  createDefinition({
    name: 'Must not recurse',
    triggerType: 'event',
    triggerConfig: { eventTypes: '*' },
    nodes: [{ id: 'trigger', type: 'trigger', config: {} }],
  });
  const result = await routeWorkflowEvent({
    eventId: 'workflow:event:1',
    source: 'workflow',
    eventType: 'workflow',
    action: 'completed',
  });
  assert.deepEqual(result, { matched: 0, started: [] });
});

test('cron workflow trigger is idempotent for the same local minute', async () => {
  const definition = createDefinition({
    name: 'Every minute',
    triggerType: 'cron',
    triggerConfig: { cron: '* * * * *' },
    nodes: [{ id: 'trigger', type: 'trigger', config: {} }],
  });
  const now = new Date(2026, 10, 2, 12, 34, 0, 0);
  const first = await runWorkflowCronTriggers(now);
  const second = await runWorkflowCronTriggers(now);
  const firstMatch = first.find((item) => item.definitionId === definition.id);
  const secondMatch = second.find((item) => item.definitionId === definition.id);
  assert.ok(firstMatch);
  assert.ok(secondMatch);
  assert.equal(firstMatch.replayed, false);
  assert.equal(secondMatch.replayed, true);
  assert.equal(secondMatch.instanceId, firstMatch.instanceId);
});
