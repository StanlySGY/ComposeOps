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
const databasePath = path.join(workDir, 'agent-test.db');
process.env.DB_PATH = databasePath;

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

  // The registered Agent tool runs exactly the same fixed argv commands against actual containers.
  const { registerDatabaseTools } = await import('../backend/src/services/tools/database-tools.js');
  const registered = new Map();
  registerDatabaseTools({ registerTool(name, config) { registered.set(name, config); return this; } });
  const probeTool = registered.get('database.probe');
  assert.ok(probeTool, 'database.probe Agent tool should be registered');
  const fixtureProject = { id: projectName, projectName: 'Database Integration', managed: true };
  async function probe(engine, id) {
    return probeTool.execute(
      { engine, projectId: projectName, containerId: id },
      { project: fixtureProject, container: { id, name: engine } },
    );
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
