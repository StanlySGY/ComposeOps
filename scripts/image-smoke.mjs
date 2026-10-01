#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const candidate = process.argv[2];
const baseline = process.argv[3];
if (!candidate) throw new Error('Usage: node scripts/image-smoke.mjs <candidate-image> [upgrade-from-image]');
const suffix = randomBytes(5).toString('hex');
const prefix = 'composeops-smoke-' + suffix;
const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
const volumes = [prefix + '-data', prefix + '-restored'];
const containers = [];
const password = 'smoke-' + randomBytes(16).toString('hex');
const marker = 'persisted-' + suffix;
function docker(args, required = true) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 180000 });
  if (required && (result.status !== 0 || result.error)) throw new Error('Docker command failed: ' + args[0] + '\n' + (result.stderr || result.error?.message));
  return (result.stdout || '').trim();
}
function cleanup() {
  for (const name of containers) docker(['rm', '-f', name], false);
  for (const name of volumes) docker(['volume', 'rm', name], false);
  rmSync(directory, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(1); });
async function ready(base) {
  for (let i = 0; i < 120; i++) {
    try { const res = await fetch(base + '/health', { signal: AbortSignal.timeout(2500) }); if (res.ok) return; } catch { /* starting */ }
    await delay(500);
  }
  throw new Error('Container did not become healthy');
}
async function start(name, image, volume) {
  containers.push(name);
  docker(['run', '-d', '--name', name, '--label', 'composeops.smoke=' + suffix,
    '-e', 'LOG_LEVEL=error', '-e', 'ENABLE_SHELL=0',
    '-p', '127.0.0.1::3001', '-v', volume + ':/app/backend/data',
    '-v', '/var/run/docker.sock:/var/run/docker.sock', image]);
  const base = 'http://' + docker(['port', name, '3001/tcp']).split('\n')[0];
  await ready(base);
  return base;
}
async function request(base, route, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + '/api/v1' + route, { method, signal: AbortSignal.timeout(10000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(res.status, 200, route + ' must succeed');
  return { data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
try {
  for (const name of volumes) docker(['volume', 'create', '--label', 'composeops.smoke=' + suffix, name]);
  const initialName = prefix + '-initial';
  let base = await start(initialName, baseline || candidate, volumes[0]);
  assert.equal((await request(base, '/auth/status')).data.setupRequired, true);
  assert.equal((await fetch(base + '/api/v1/ai/config')).status, 401);
  const auth = await request(base, '/auth/setup', { method: 'POST', body: { password } });
  await request(base, '/ai/config', { method: 'POST', cookie: auth.cookie, body: { systemPrompt: marker } });
  docker(['restart', initialName]);
  base = 'http://' + docker(['port', initialName, '3001/tcp']).split('\n')[0];
  await ready(base);
  assert.equal((await request(base, '/ai/config', { cookie: auth.cookie })).data.systemPrompt, marker);
  console.log('PASS first installation, authentication and restart persistence');

  let currentName = initialName;
  if (baseline) {
    docker(['rm', '-f', initialName]);
    currentName = prefix + '-upgraded';
    base = await start(currentName, candidate, volumes[0]);
    const login = await request(base, '/auth/login', { method: 'POST', body: { password } });
    assert.equal((await request(base, '/ai/config', { cookie: login.cookie })).data.systemPrompt, marker);
    console.log('PASS upgrade from ' + baseline + ' with existing data');
  }
  const html = await (await fetch(base + '/')).text();
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(script, 'built frontend entry must exist');
  assert.equal((await fetch(new URL(script, base))).status, 200);
  docker(['exec', currentName, 'node', 'scripts/database-backup.js', '--output', '/app/backend/data/smoke-snapshot.db']);
  docker(['cp', currentName + ':/app/backend/data/smoke-snapshot.db', path.join(directory, 'snapshot.db')]);
  chmodSync(path.join(directory, 'snapshot.db'), 0o600);
  const restoreHelper = prefix + '-copy';
  containers.push(restoreHelper);
  docker(['run', '--rm', '--name', restoreHelper, '-v', volumes[1] + ':/app/backend/data', '-v', directory + ':/snapshot:ro', '--entrypoint', 'node', candidate,
    '-e', "require('fs').copyFileSync('/snapshot/snapshot.db','data/opsdash.db');require('fs').chmodSync('data/opsdash.db',0o600)"]);
  const restoredBase = await start(prefix + '-restore', candidate, volumes[1]);
  const restoredAuth = await request(restoredBase, '/auth/login', { method: 'POST', body: { password } });
  assert.equal((await request(restoredBase, '/ai/config', { cookie: restoredAuth.cookie })).data.systemPrompt, marker);
  console.log('PASS online database backup, fresh-volume restore and frontend assets');
} finally { cleanup(); }
