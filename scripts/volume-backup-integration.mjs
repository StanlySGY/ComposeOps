#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const suffix = randomBytes(6).toString('hex');
const projectName = `composeops-volume-it-${suffix}`;
const sourceVolume = `${projectName}_data`;
const restoreVolume = `${projectName}-restore`;
const tempDir = mkdtempSync(path.join(os.tmpdir(), `${projectName}-`));
const composeFile = path.join(tempDir, 'compose.yaml');
const timeout = 120_000;
const sentinel = `ComposeOps isolated volume recovery ${suffix}\n`;
const manifest = JSON.stringify({ projectName, nonce: suffix, nested: { recovery: 'ok', sequence: [1, 2, 3] } }, null, 2) + '\n';

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: tempDir,
    encoding: options.binary ? null : 'utf8',
    input: options.input,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stdout = String(result.stdout || '');
    const stderr = String(result.stderr || '');
    throw new Error(`docker ${args.join(' ')} failed (exit ${result.status}): ${(stderr || stdout).slice(0, 3000)}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function runCompose(args) {
  return docker(['compose', '--project-name', projectName, '--file', composeFile, ...args]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

let completed = false;
try {
  const sentinelB64 = Buffer.from(sentinel).toString('base64');
  const manifestB64 = Buffer.from(manifest).toString('base64');
  const seedCommand = [
    'set -eu',
    'mkdir -p /data/nested',
    `printf '%s' '${sentinelB64}' | base64 -d > /data/sentinel.txt`,
    `printf '%s' '${manifestB64}' | base64 -d > /data/nested/manifest.json`,
    'while true; do sleep 2; done',
  ].join('; ');
  const composeYaml = [
    'services:',
    '  seed:',
    '    image: busybox:1.36',
    `    command: ${JSON.stringify(['sh', '-c', seedCommand])}`,
    '    labels:',
    `      com.composeops.integration: ${JSON.stringify(projectName)}`,
    '    volumes:',
    '      - data:/data',
    '    healthcheck:',
    `      test: ${JSON.stringify(['CMD-SHELL', 'test -s /data/sentinel.txt && test -s /data/nested/manifest.json'])}`,
    '      interval: 1s',
    '      timeout: 1s',
    '      retries: 20',
    '      start_period: 1s',
    'volumes:',
    '  data:',
    '    labels:',
    `      com.composeops.integration: ${JSON.stringify(projectName)}`,
    'networks:',
    '  default:',
    '    internal: true',
    '',
  ].join('\n');
  writeFileSync(composeFile, composeYaml, { mode: 0o600 });

  docker(['volume', 'create', '--label', `com.composeops.integration=${projectName}`, restoreVolume]);
  runCompose(['config', '--quiet']);
  const services = String(runCompose(['config', '--services'])).trim().split(/\r?\n/);
  assert.ok(services.includes('seed'), 'Compose service discovery did not return seed');

  runCompose(['up', '--detach', '--wait', '--wait-timeout', '45', 'seed']);
  const containerId = String(runCompose(['ps', '--all', '--quiet', 'seed'])).trim();
  assert.ok(containerId, 'deployed Compose service container was not discovered');
  const state = String(docker(['inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', containerId])).trim();
  assert.equal(state, 'running|healthy', `Compose service did not reach healthy state: ${state}`);

  runCompose(['restart', 'seed']);
  runCompose(['up', '--detach', '--wait', '--wait-timeout', '30', 'seed']);
  const afterRestart = String(docker(['inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', containerId])).trim();
  assert.equal(afterRestart, 'running|healthy', `Compose restart did not recover health: ${afterRestart}`);

  const archive = docker([
    'run', '--rm', '--network', 'none',
    '--mount', `type=volume,src=${sourceVolume},dst=/source,readonly`,
    'busybox:1.36', 'tar', '-czf', '-', '-C', '/source', '.',
  ], { binary: true });
  assert.ok(Buffer.isBuffer(archive) && archive.length > 32, 'source named-volume archive is unexpectedly empty');

  docker([
    'run', '--rm', '--network', 'none', '--interactive',
    '--mount', `type=volume,src=${restoreVolume},dst=/restore`,
    'busybox:1.36', 'sh', '-c', 'tar -xzf - -C /restore',
  ], { input: archive });

  const readBack = String(docker([
    'run', '--rm', '--network', 'none',
    '--mount', `type=volume,src=${restoreVolume},dst=/restore,readonly`,
    'busybox:1.36', 'sh', '-c',
    'sha256sum /restore/sentinel.txt /restore/nested/manifest.json && cat /restore/sentinel.txt && cat /restore/nested/manifest.json',
  ]));
  const expected = [
    `${sha256(sentinel)}  /restore/sentinel.txt`,
    `${sha256(manifest)}  /restore/nested/manifest.json`,
  ];
  for (const line of expected) assert.ok(readBack.includes(line), `Restored file hash mismatch: ${line}`);
  assert.ok(readBack.includes(sentinel), 'restored sentinel content differs');
  assert.ok(readBack.includes(manifest), 'restored nested manifest content differs');

  completed = true;
  console.log(JSON.stringify({
    result: 'PASS',
    project: projectName,
    checks: ['compose-config', 'service-discovery', 'up-and-health', 'restart', 'named-volume-tar-backup', 'isolated-volume-restore', 'sha256-and-content-verification'],
    sourceVolume,
    restoreVolume,
    archiveBytes: archive.length,
    hashes: { sentinel: sha256(sentinel), manifest: sha256(manifest) },
  }, null, 2));
} finally {
  // Only delete this run's uniquely named Compose project, container and labeled volumes.
  try { runCompose(['down', '--volumes', '--remove-orphans', '--timeout', '5']); } catch (error) {
    console.error(`Cleanup warning for ${projectName}: ${error.message}`);
  }
  for (const volume of [sourceVolume, restoreVolume]) {
    try { docker(['volume', 'rm', '--force', volume]); } catch { /* Compose down may already have removed it. */ }
  }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch (error) {
    console.error(`Temporary directory cleanup warning: ${error.message}`);
  }
  if (!completed) console.error(`Isolated Docker volume integration did not complete successfully (project ${projectName}).`);
}
