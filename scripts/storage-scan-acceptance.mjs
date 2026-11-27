#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = await mkdtemp(path.join(tmpdir(), 'storage-scan-acceptance-'));
process.env.DB_PATH = path.join(root, 'fixture.db'); process.env.DISABLE_BACKGROUND_JOBS = '1';
const { default: db } = await import('../backend/src/lib/db.js');
const { getDockerForHost } = await import('../backend/src/services/docker-hosts.js');
const { readDockerDiskUsage } = await import('../backend/src/services/docker-disk-usage.js');
const { getDockerUsage } = await import('../backend/src/services/maintenance.js');
const { getStorageStats } = await import('../backend/src/services/cost-analysis.js');
const docker = getDockerForHost('local'), original = docker.df.bind(docker); let calls = 0;
// A short response delay makes the caller-timeout boundary deterministic even on an empty Engine.
docker.df = async options => { calls++; const result = await original(options); await delay(50); return result; };
try {
  const begin = performance.now();
  const short = readDockerDiskUsage('local', { timeoutMs: 10 });
  const rejected = assert.rejects(short, { statusCode: 503 });
  const long = readDockerDiskUsage('local', { timeoutMs: 60000 });
  await rejected; const data = await long; assert.ok(Array.isArray(data.Images)); assert.equal(calls, 1);
  const [maintenance, cost] = await Promise.all([getDockerUsage('local'), getStorageStats('local')]);
  assert.equal(calls, 1); assert.equal(maintenance.hostId, 'local'); assert.ok(cost);
  console.log(JSON.stringify({ passed: true, dockerScans: calls, callerTimeoutIsolated: true, maintenanceAndCostReused: true,
    elapsedMs: Math.round(performance.now() - begin), testResponseDelayMs: 50, productionDataChanged: false, operations: ['Docker system df read'] }));
} finally { docker.df = original; db.close(); await rm(root, { recursive: true, force: true }); }
