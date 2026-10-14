#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const suffix = randomBytes(6).toString('hex');
const projectName = `composeops-db-it-${suffix}`;
const workDir = mkdtempSync(path.join(os.tmpdir(), `${projectName}-`));
const composeFile = path.join(workDir, 'compose.yaml');
const probeImage = process.env.COMPOSEOPS_TEST_IMAGE || 'stanly1997/opsdash:latest';

function docker(args, { expectFailure = false, timeout = 120000 } = {}) {
  const result = spawnSync('docker', args, {
    cwd: workDir,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (expectFailure) {
    assert.notEqual(result.status, 0, `docker ${args.join(' ')} unexpectedly succeeded`);
    return String(result.stderr || result.stdout || '');
  }
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed (exit ${result.status}): ${String(result.stderr || result.stdout).slice(0, 3000)}`);
  }
  return String(result.stdout || '').trim();
}

const compose = (args, options) => docker(['compose', '--project-name', projectName, '--file', composeFile, ...args], options);
const yaml = `services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis-data:/data
    labels:
      com.composeops.integration: "${projectName}"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 1s
      retries: 20
      start_period: 2s
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: composeops_test
      POSTGRES_PASSWORD: composeops_test_only
      POSTGRES_DB: composeops_test
    volumes:
      - postgres-data:/var/lib/postgresql/data
    labels:
      com.composeops.integration: "${projectName}"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U composeops_test -d composeops_test"]
      interval: 2s
      timeout: 1s
      retries: 30
      start_period: 5s
volumes:
  redis-data:
  postgres-data:
networks:
  default:
    internal: true
`;
writeFileSync(composeFile, yaml, { mode: 0o600 });

let completed = false;
try {
  compose(['config', '--quiet']);
  compose(['up', '--detach', '--wait', '--wait-timeout', '150']);
  const redisId = compose(['ps', '--quiet', 'redis']).split(/\r?\n/)[0];
  const postgresId = compose(['ps', '--quiet', 'postgres']).split(/\r?\n/)[0];
  assert.ok(redisId, 'Redis container should be discovered');
  assert.ok(postgresId, 'PostgreSQL container should be discovered');

  // Run the real registered Agent tool inside the candidate application image, with its own
  // dependency graph, while sharing only the isolated runner Docker socket. This mirrors deployment
  // and avoids relying on node_modules being installed on the CI host.
  async function probe(engine, id) {
    const params = { engine, projectId: projectName, containerId: id };
    const source = `
      import { registerDatabaseTools } from './src/services/tools/database-tools.js';
      const request = ${JSON.stringify(params)};
      const registry = new Map();
      registerDatabaseTools({ registerTool(name, config) { registry.set(name, config); return this; } });
      const tool = registry.get('database.probe');
      if (!tool) throw new Error('database.probe Agent tool is not registered');
      const result = await tool.execute(request, {
        project: { id: request.projectId, projectName: 'Database Integration', managed: true },
        container: { id: request.containerId, name: request.engine },
      });
      console.log('__COMPOSEOPS_DATABASE_PROBE__' + JSON.stringify(result));
    `;
    const output = docker([
      'run', '--rm', '--label', `com.composeops.integration=${projectName}`,
      '--volume', '/var/run/docker.sock:/var/run/docker.sock',
      '--entrypoint', 'node', probeImage, '--input-type=module', '-e', source,
    ], { timeout: 120000 });
    const marker = '__COMPOSEOPS_DATABASE_PROBE__';
    const markerIndex = output.lastIndexOf(marker);
    assert.notEqual(markerIndex, -1, 'probe helper should return structured output');
    return JSON.parse(output.slice(markerIndex + marker.length).trim());
  }

  const redisHealth = await probe('redis', redisId);
  assert.equal(redisHealth.status, 'healthy', `Redis PING failed: ${JSON.stringify(redisHealth)}`);
  assert.match(redisHealth.stdout, /PONG/i);

  const postgresHealth = await probe('postgres', postgresId);
  assert.equal(postgresHealth.status, 'healthy', `PostgreSQL pg_isready failed: ${JSON.stringify(postgresHealth)}`);

  docker(['exec', redisId, 'redis-cli', 'SET', 'composeops:integration', 'persisted']);
  const sql = "CREATE TABLE IF NOT EXISTS composeops_integration (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO composeops_integration(id, value) VALUES (1, 'persisted') ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;";
  docker(['exec', postgresId, 'psql', '-U', 'composeops_test', '-d', 'composeops_test', '-v', 'ON_ERROR_STOP=1', '-c', sql]);

  compose(['stop', 'redis', 'postgres']);
  const redisDown = await probe('redis', redisId);
  const postgresDown = await probe('postgres', postgresId);
  assert.equal(redisDown.healthy, false, 'stopped Redis must not be reported healthy');
  assert.equal(postgresDown.healthy, false, 'stopped PostgreSQL must not be reported healthy');

  compose(['start', 'redis', 'postgres']);
  compose(['up', '--detach', '--wait', '--wait-timeout', '90', 'redis', 'postgres']);
  const redisRecovered = await probe('redis', redisId);
  const postgresRecovered = await probe('postgres', postgresId);
  assert.equal(redisRecovered.status, 'healthy');
  assert.equal(postgresRecovered.status, 'healthy');
  assert.equal(docker(['exec', redisId, 'redis-cli', '--raw', 'GET', 'composeops:integration']), 'persisted');

  const queryResult = docker(['exec', postgresId, 'psql', '-U', 'composeops_test', '-d', 'composeops_test', '-Atqc', 'SELECT value FROM composeops_integration WHERE id = 1']);
  assert.equal(queryResult, 'persisted', 'PostgreSQL data should survive container restart');

  completed = true;
  console.log(JSON.stringify({
    result: 'PASS',
    project: projectName,
    checks: [
      'real Agent database.probe against Redis',
      'real Agent database.probe against PostgreSQL',
      'health checks fail while both services are stopped',
      'health checks recover after restart',
      'Redis append-only data survives restart',
      'PostgreSQL data survives restart',
    ],
    redis: { initial: redisHealth.status, stopped: redisDown.status, recovered: redisRecovered.status },
    postgres: { initial: postgresHealth.status, stopped: postgresDown.status, recovered: postgresRecovered.status },
  }, null, 2));
} finally {
  try { compose(['down', '--volumes', '--remove-orphans', '--timeout', '5']); }
  catch (error) { console.error(`Cleanup warning for ${projectName}: ${error.message}`); }
  try { rmSync(workDir, { recursive: true, force: true }); }
  catch (error) { console.error(`Temporary directory cleanup warning: ${error.message}`); }
  if (!completed) console.error(`Database service integration did not complete successfully (project ${projectName}).`);
}
