#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const root = mkdtempSync(path.join(os.tmpdir(), 'composeops-recovery-it-'));
const projectDir = path.join(root, 'project');
mkdirSync(projectDir);
process.env.DB_PATH = path.join(root, 'state.db');

const suffix = randomBytes(6).toString('hex');
const projectId = 'compose-recovery-it-' + suffix;
const projectName = 'composeops-recovery-it-' + suffix;
const composeFile = path.join(projectDir, 'compose.yaml');
const overrideFile = path.join(projectDir, 'compose.override.yaml');
const originalMain = 'name: ' + projectName + '\nservices:\n  app:\n    image: busybox:1.36\n    command: ["sh", "-c", "while true; do sleep 3600; done"]\n    labels:\n      com.composeops.recovery: original\n';
const originalOverride = 'services:\n  app:\n    environment:\n      RECOVERY_STATE: original\n';
const changedMain = originalMain.replace('com.composeops.recovery: original', 'com.composeops.recovery: changed');
const changedOverride = originalOverride.replace('RECOVERY_STATE: original', 'RECOVERY_STATE: changed');

function docker(args) {
  const result = spawnSync('docker', args, {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('docker ' + args.join(' ') + ' failed (exit ' + result.status + '): ' + String(result.stderr || result.stdout).slice(0, 3000));
  }
  return String(result.stdout || '').trim();
}

function compose(args) {
  return docker(['compose', '--project-name', projectName, '--file', composeFile, '--file', overrideFile, ...args]);
}

let completed = false;
try {
  writeFileSync(composeFile, changedMain, { mode: 0o600 });
  writeFileSync(overrideFile, changedOverride, { mode: 0o600 });
  compose(['config', '--quiet']);

  // Import only after DB_PATH points at this isolated integration run.
  const { addComposeBackupBatch } = await import('../backend/src/lib/db.js');
  const { restoreComposeBackupBatch, rollbackProject } = await import('../backend/src/services/image-updater.js');
  const snapshots = [
    { filePath: composeFile, content: originalMain },
    { filePath: overrideFile, content: originalOverride },
  ];
  addComposeBackupBatch(projectId, snapshots, 'upgrade:' + suffix);

  const result = await rollbackProject({
    id: projectId,
    projectName,
    managed: true,
    editable: true,
    mounted: true,
    workingDir: projectDir,
    composeFile,
    composeFiles: [composeFile, overrideFile],
    host: { type: 'local' },
  });
  assert.equal(result.code, 0, 'Compose should be recreated after rollback');
  assert.equal(result.restored, 2, 'all Compose files should be restored');
  assert.equal(readFileSync(composeFile, 'utf8'), originalMain);
  assert.equal(readFileSync(overrideFile, 'utf8'), originalOverride);

  const containerId = compose(['ps', '--quiet', 'app']).split(/\r?\n/)[0];
  assert.ok(containerId, 'rollback should start the Compose service');
  const runtimeState = docker(['inspect', '--format', '{{.State.Status}}', containerId]);
  assert.equal(runtimeState, 'running', 'recreated service should be running');
  const environment = docker(['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', containerId]);
  assert.match(environment, /RECOVERY_STATE=original/, 'recreated service should use restored Compose environment');
  const label = docker(['inspect', '--format', '{{index .Config.Labels "com.composeops.recovery"}}', containerId]);
  assert.equal(label, 'original', 'recreated service should use restored Compose labels');

  // Exercise the compensating-write path against real files, not an in-memory mock.
  writeFileSync(composeFile, changedMain);
  writeFileSync(overrideFile, changedOverride);
  let failedOnce = false;
  await assert.rejects(
    restoreComposeBackupBatch(snapshots, [
      { filePath: composeFile, content: changedMain },
      { filePath: overrideFile, content: changedOverride },
    ], async (filePath, content) => {
      if (filePath === overrideFile && !failedOnce) {
        failedOnce = true;
        throw new Error('simulated second-file write failure');
      }
      writeFileSync(filePath, content);
    }),
    (error) => error.statusCode === 409 && error.compensationFailures.length === 0,
  );
  assert.equal(readFileSync(composeFile, 'utf8'), changedMain, 'first file should be compensated to its pre-restore content');
  assert.equal(readFileSync(overrideFile, 'utf8'), changedOverride, 'failing file should retain its pre-restore content');

  completed = true;
  console.log(JSON.stringify({
    result: 'PASS',
    projectName,
    checks: [
      'database-backed multi-file upgrade backup',
      'real rollbackProject restores both Compose files',
      'docker compose force-recreate applies restored environment and labels',
      'real filesystem compensates a mid-batch restore write failure',
    ],
    restoredFiles: result.restored,
    composeExitCode: result.code,
    runtimeState,
    runtimeEnvironment: 'original',
    runtimeLabel: label,
  }, null, 2));
} finally {
  try { compose(['down', '--volumes', '--remove-orphans', '--timeout', '5']); }
  catch (error) { console.error('Cleanup warning for ' + projectName + ': ' + error.message); }
  try { rmSync(root, { recursive: true, force: true }); }
  catch (error) { console.error('Temporary directory cleanup warning: ' + error.message); }
  if (!completed) console.error('Compose recovery integration did not complete successfully (project ' + projectName + ').');
}
