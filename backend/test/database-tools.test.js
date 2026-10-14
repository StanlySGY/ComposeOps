import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseProbeCommand, isSupportedDatabaseImage } from '../src/services/tools/database-tools.js';

test('database probe: only allows fixed Redis/PostgreSQL read-only health commands', () => {
  assert.deepEqual(databaseProbeCommand('redis'), ['redis-cli', '--raw', 'PING']);
  assert.deepEqual(databaseProbeCommand('postgres'), ['pg_isready', '-h', '127.0.0.1', '-p', '5432', '-q']);
  assert.throws(() => databaseProbeCommand('mysql'), /仅支持 redis 或 postgres/);
});

test('database probe: project and container scope must be validated against the active context', async () => {
  const { registerDatabaseTools } = await import('../src/services/tools/database-tools.js');
  let config;
  registerDatabaseTools({ registerTool(name, definition) { if (name === 'database.probe') config = definition; return this; } });
  assert.ok(config);
  await assert.rejects(
    config.execute({ projectId: 'other-project', containerId: 'container-1', engine: 'redis' }, {
      project: { id: 'active-project' }, container: { id: 'container-1' },
    }),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(
    config.execute({ projectId: 'active-project', containerId: 'other-container', engine: 'redis' }, {
      project: { id: 'active-project' }, container: { id: 'container-1' },
    }),
    (error) => error.statusCode === 403,
  );
});

test('database probe: refuses running database probes in an unrelated image', () => {
  assert.equal(isSupportedDatabaseImage('redis', 'redis:7-alpine'), true);
  assert.equal(isSupportedDatabaseImage('redis', 'docker.io/library/redis@sha256:abc'), true);
  assert.equal(isSupportedDatabaseImage('redis', 'postgres:16-alpine'), false);
  assert.equal(isSupportedDatabaseImage('postgres', 'postgres:16-alpine'), true);
  assert.equal(isSupportedDatabaseImage('postgres', 'redis:7-alpine'), false);
  assert.equal(isSupportedDatabaseImage('postgres', 'my-postgres-tools:latest'), false);
});
