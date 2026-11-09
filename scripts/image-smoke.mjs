#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const candidate = process.argv[2];
const baseline = process.argv[3];
if (!candidate) throw new Error('Usage: node scripts/image-smoke.mjs <candidate-image> [upgrade-from-image]');
// Run external-service recovery integrations once in the fresh-install CI leg.
// The upgrade leg passes a baseline image and skips these duplicate integration runs.
if (!baseline) {
  // Let the external-service integration invoke the tool from the candidate image that the job built.
  process.env.COMPOSEOPS_TEST_IMAGE = candidate;
  console.log('Running isolated Redis/PostgreSQL Agent health and recovery integration');
  await import('./database-service-integration.mjs');
  console.log('Running isolated Docker named-volume backup/restore integration');
  await import('./volume-backup-integration.mjs');
}
const suffix = randomBytes(5).toString('hex');
const prefix = 'composeops-smoke-' + suffix;
const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
const keyDirectory = mkdtempSync(path.join(os.tmpdir(), prefix + '-key-'));
const keyFile = path.join(keyDirectory, 'database-key');
writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const volumes = [prefix + '-data', prefix + '-restored', prefix + '-recovery'];
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
  rmSync(keyDirectory, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(1); });
async function ready(base) {
  for (let i = 0; i < 120; i++) {
    try { const res = await fetch(base + '/health', { signal: AbortSignal.timeout(2500) }); if (res.ok) return; } catch { /* starting */ }
    await delay(500);
  }
  throw new Error('Container did not become healthy');
}
function keyArgs(encrypted) {
  return encrypted ? ['-e', 'DB_ENCRYPTION_KEY_FILE=/run/secrets/database-key',
    '-v', keyFile + ':/run/secrets/database-key:ro'] : [];
}
async function start(name, image, volume, encrypted = false) {
  containers.push(name);
  docker(['run', '-d', '--name', name, '--label', 'composeops.smoke=' + suffix,
    '-e', 'LOG_LEVEL=error', '-e', 'ENABLE_SHELL=0',
    '-p', '127.0.0.1::3001', '-v', volume + ':/app/backend/data',
    '-v', '/var/run/docker.sock:/var/run/docker.sock', ...keyArgs(encrypted), image]);
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
function snapshot(name, volume, file, encrypted = false) {
  // Use the candidate's standalone backup CLI: older baselines may not ship it.
  // This opens SQLite without running application schema migrations.
  const helper = prefix + '-backup-' + file;
  containers.push(helper);
  docker(['run', '--rm', '--name', helper, '-v', volume + ':/app/backend/data',
    ...keyArgs(encrypted), '--entrypoint', 'node', candidate,
    'scripts/database-backup.js', '--output', 'data/' + file + '.db']);
  docker(['cp', name + ':/app/backend/data/' + file + '.db', path.join(directory, file + '.db')]);
  chmodSync(path.join(directory, file + '.db'), 0o600);
}
function restoreSnapshot(file, volume) {
  const helper = prefix + '-copy-' + file;
  containers.push(helper);
  docker(['run', '--rm', '--name', helper, '-v', volume + ':/app/backend/data',
    '-v', directory + ':/snapshot:ro', '--entrypoint', 'node', candidate, '-e',
    `require('fs').copyFileSync('/snapshot/${file}.db','data/opsdash.db');require('fs').chmodSync('data/opsdash.db',0o600)`]);
}
async function verifyPersistedState(base) {
  assert.equal((await request(base, '/auth/status')).data.setupRequired, false);
  assert.equal((await fetch(base + '/api/v1/ai/config')).status, 401);
  const login = await request(base, '/auth/login', { method: 'POST', body: { password } });
  assert.equal((await request(base, '/ai/config', { cookie: login.cookie })).data.systemPrompt, marker);
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
    snapshot(initialName, volumes[0], 'before-upgrade');
    docker(['rm', '-f', initialName]);
    currentName = prefix + '-upgraded';
    base = await start(currentName, candidate, volumes[0]);
    await verifyPersistedState(base);
    console.log('PASS upgrade from ' + baseline + ' with existing data');
  }
  const html = await (await fetch(base + '/')).text();
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(script, 'built frontend entry must exist');
  assert.equal((await fetch(new URL(script, base))).status, 200);
  snapshot(currentName, volumes[0], 'snapshot');
  restoreSnapshot('snapshot', volumes[1]);
  const restoreName = prefix + '-restore';
  const restoredBase = await start(restoreName, candidate, volumes[1]);
  await verifyPersistedState(restoredBase);
  console.log('PASS online database backup, fresh-volume restore and frontend assets');

  if (baseline) {
    // A downgrade restores the pre-upgrade database into a NEW volume. Never
    // start an old image against the database already migrated by the candidate.
    restoreSnapshot('before-upgrade', volumes[2]);
    const rollbackBase = await start(prefix + '-rollback', baseline, volumes[2]);
    await verifyPersistedState(rollbackBase);
    console.log('PASS rollback to ' + baseline + ' using pre-upgrade snapshot in a new volume');
  } else {
    docker(['rm', '-f', restoreName]);
    const encryptedName = prefix + '-encrypted';
    const encryptedBase = await start(encryptedName, candidate, volumes[1], true);
    await verifyPersistedState(encryptedBase);
    snapshot(encryptedName, volumes[1], 'encrypted-snapshot', true);
    const encryptedBytes = readFileSync(path.join(directory, 'encrypted-snapshot.db'));
    assert.notEqual(encryptedBytes.subarray(0, 16).toString(), 'SQLite format 3\0');
    assert.equal(encryptedBytes.includes(Buffer.from(marker)), false);
    restoreSnapshot('encrypted-snapshot', volumes[2]);
    const encryptedRestoreBase = await start(prefix + '-encrypted-restore', candidate, volumes[2], true);
    await verifyPersistedState(encryptedRestoreBase);
    console.log('PASS plaintext-to-encrypted migration, encrypted backup and fresh-volume restore with external key');
  }
} finally { cleanup(); }
