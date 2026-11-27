#!/usr/bin/env node
// Real Docker helpers, a unique temporary directory and an isolated database.
// No existing project is started/stopped or granted management permissions.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'composeops-read-acceptance-'));
process.env.DB_PATH = path.join(root, 'test.db');
process.env.COMPOSEOPS_RUNNER_IMAGE ||= 'stanly1997/opsdash:latest';
const { withReadOnlyRunner, withRunner, execInRunner, readWorkspaceCompose, closeAllWorkspaceRunners } = await import('../backend/src/services/compose-workspace.js');
const { readProjectEnv, saveProjectEnv, listProjectEnvFiles } = await import('../backend/src/services/project-env.js');
const { default: db } = await import('../backend/src/lib/db.js');
const project = { id: path.basename(root), hostId: 'local', activeHostAtScan: 'local', projectName: path.basename(root), workingDir: root, composeFiles: [path.join(root, 'compose.yml')], managed: true, editable: true, workspaceAvailable: true, mounted: false };
const checks = [];
try {
  await writeFile(project.composeFiles[0], 'services: {}\n');
  await writeFile(path.join(root, '.env.production'), 'MODE=first\n');
  let original;
  await withReadOnlyRunner(project, async runner => {
    original = runner.id;
    const config = await runner.inspect();
    assert.equal(config.HostConfig.NetworkMode, 'none');
    assert.equal(config.HostConfig.ReadonlyRootfs, true);
    assert.equal(config.Mounts.length, 1); assert.equal(config.Mounts[0].RW, false);
    assert.equal((await execInRunner(runner, ['test', '-S', '/var/run/docker.sock'])).code, 1);
    assert.notEqual((await execInRunner(runner, ['touch', path.join(root, 'must-not-write')])).code, 0);
    assert.equal((await execInRunner(runner, ['node', '-e', 'process.stdout.write(Object.keys(require("os").networkInterfaces()).join(","))'])).stdout, 'lo');
  });
  checks.push('real read helper: read-only bind/root, no Docker socket, loopback only, write refused');
  for (let i = 0; i < 5; i++) {
    assert.equal((await readWorkspaceCompose(project)).content, 'services: {}\n');
    await withReadOnlyRunner(project, runner => assert.equal(runner.id, original));
  }
  checks.push('repeated Compose reads reuse only the read helper');
  const files = await listProjectEnvFiles(project);
  assert(files.some(f => f.name === '.env.production' && f.exists));
  assert(files.some(f => f.name === '.env' && !f.exists));
  const first = await readProjectEnv(project, '.env.production');
  assert.equal(first.raw, 'MODE=first\n');
  const saved = await saveProjectEnv(project, { raw: 'MODE=saved\n', expectedVersion: first.version }, '.env.production');
  assert.equal(await readFile(path.join(root, '.env.production'), 'utf8'), 'MODE=saved\n');
  assert.equal(await readFile(path.join(root, saved.backup), 'utf8'), 'MODE=first\n');
  await assert.rejects(saveProjectEnv(project, { raw: 'MODE=stale\n', expectedVersion: first.version }, '.env.production'), { code: 'ENV_VERSION_CONFLICT' });
  checks.push('real workspace env read/save, backup, stale-version rejection and suffix discovery');
  await symlink('/etc/hostname', path.join(root, '.env.link'));
  await assert.rejects(readProjectEnv(project, '.env.link'), { code: 'ENV_UNSAFE_TARGET' });
  checks.push('workspace env symlink outside the project refused');
  await withRunner(project, async runner => {
    assert.notEqual(runner.id, original);
    assert.equal((await execInRunner(runner, ['docker', 'compose', '-f', project.composeFiles[0], 'config', '--quiet'])).code, 0);
    assert.equal((await execInRunner(runner, ['docker', 'version', '--format', '{{.Server.Version}}'])).code, 0);
  });
  checks.push('separate execution helper retains Compose and Docker daemon access');
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await closeAllWorkspaceRunners(); db.close(); await rm(root, { recursive: true, force: true });
}
