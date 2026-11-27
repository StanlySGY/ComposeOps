#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), root = await mkdtemp(path.join(tmpdir(), 'metric-sample-acceptance-'));
const name = 'metric-sample-' + randomBytes(6).toString('hex'), file = path.join(root, 'compose.yml');
process.env.DB_PATH = path.join(root, 'fixture.db'); process.env.DISABLE_BACKGROUND_JOBS = '1';
const docker = async args => (await exec('docker', args, { encoding: 'utf8', timeout: 30000 })).stdout.trim();
const image = process.argv[2]; assert.match(image || '', /@sha256:[a-f0-9]{64}$/);
const { default: Fastify } = await import('fastify');
const { default: metricsRoutes } = await import('../backend/src/routes/metrics.js');
const { getDockerForHost } = await import('../backend/src/services/docker-hosts.js');
const { scanProjects, invalidateScanCache } = await import('../backend/src/services/scanner.js');
const { setProjectPreference } = await import('../backend/src/lib/db.js');
const app = Fastify(); await app.register(metricsRoutes, { prefix: '/metrics' });
let id;
try {
  await writeFile(file, 'services: {}\n');
  id = await docker(['run', '-d', '--pull', 'never', '--network', 'none', '--name', name,
    '--label', 'com.docker.compose.project=' + name, '--label', 'com.docker.compose.service=web',
    '--label', 'com.docker.compose.project.working_dir=' + root, '--label', 'com.docker.compose.project.config_files=' + file,
    image, 'sleep', '3600']);
  invalidateScanCache(); const project = (await scanProjects('local')).find(item => item.projectName === name);
  assert.ok(project); setProjectPreference(project.id, { managed: true });
  const client = getDockerForHost('local'), original = client.getContainer.bind(client); let sampleCalls = 0;
  client.getContainer = target => { const container = original(target), sample = container.stats.bind(container); container.stats = options => { sampleCalls++; return sample(options); }; return container; };
  const response = await Promise.all(['cpu', 'memory', 'network', 'disk'].map(metric => app.inject({ method: 'GET', url: `/metrics/container/${id}?metric=${metric}&period=5m` })));
  assert.ok(response.every(row => row.statusCode === 200)); assert.equal(sampleCalls, 1);
  const values = response.map(row => row.json().data);
  assert.equal(new Set(values.map(item => item.timestamp)).size, 1);
  assert.ok(values.every(item => item.average === null && item.peak === null && item.trend === 'unknown'));
  setProjectPreference(project.id, { managed: false });
  const denied = await app.inject({ method: 'GET', url: `/metrics/container/${id}?metric=memory&period=5m` });
  assert.equal(denied.statusCode, 403); assert.equal(sampleCalls, 1);
  console.log(JSON.stringify({ passed: true, httpReads: 4, dockerSamples: sampleCalls, sharedTimestamp: true, noInventedHistory: true, revokeReturns: denied.statusCode,
    available: Object.fromEntries(['cpu', 'memory', 'network', 'disk'].map((metric, i) => [metric, values[i].available])), productionDataChanged: false }));
} finally {
  await app.close();
  if (id) await docker(['rm', '-f', id]);
  await rm(root, { recursive: true, force: true });
}
