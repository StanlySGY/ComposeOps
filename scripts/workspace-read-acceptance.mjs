#!/usr/bin/env node
// Real Docker helpers, a unique temporary directory and an isolated database.
// No existing project is started/stopped or granted management permissions.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, chmod, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'composeops-read-acceptance-'));
process.env.DB_PATH = path.join(root, 'test.db');
process.env.COMPOSEOPS_RUNNER_IMAGE ||= 'stanly1997/opsdash:latest';
const { withReadOnlyRunner, withRunner, execInRunner, readWorkspaceCompose, saveWorkspaceCompose, replaceWorkspaceComposeFile, readArchiveFile, workspaceRunnerStats, closeAllWorkspaceRunners } = await import('../backend/src/services/compose-workspace.js');
const { readProjectEnv, saveProjectEnv, listProjectEnvFiles } = await import('../backend/src/services/project-env.js');
const { getProjectUpdates } = await import('../backend/src/services/image-updater.js');
const { default: db, setProjectPreference } = await import('../backend/src/lib/db.js');
const project = { id: path.basename(root), hostId: 'local', activeHostAtScan: 'local', projectName: path.basename(root).toLowerCase(), workingDir: root, composeFiles: [path.join(root, 'compose.yml')], managed: true, editable: true, workspaceAvailable: true, mounted: false };
const checks = [];
setProjectPreference(project.id, { managed: true, mountEnabled: true });
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
  await writeFile(path.join(root, 'large.yml'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await symlink('/etc/hostname', path.join(root, 'config-link'));
  await withReadOnlyRunner(project, async runner => {
    await assert.rejects(readArchiveFile(runner, path.join(root, 'large.yml')), { statusCode: 413 });
    await assert.rejects(readArchiveFile(runner, root), { statusCode: 403 });
    await assert.rejects(readArchiveFile(runner, path.join(root, 'config-link')), { statusCode: 403 });
  });
  checks.push('real Docker archives reject oversize files, directory paths and symlinks');
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
  await closeAllWorkspaceRunners();
  await writeFile(project.composeFiles[0], 'services:\n  check:\n    image: ${IMAGE:-busybox:latest}\n');
  await writeFile(path.join(root, '.env'), 'IMAGE=alpine:latest\n');
  await withReadOnlyRunner(project, async runner => {
    const config = await execInRunner(runner, ['docker', 'compose', '--project-name', project.projectName, '-f', project.composeFiles[0], 'config', '--format', 'json', '--no-env-resolution']);
    assert.equal(config.code, 0, config.stderr);
  });
  const updates = await getProjectUpdates(project);
  assert.equal(updates.images[0].image, 'alpine:latest');
  assert.equal(updates.images[0].status, 'not_deployed');
  assert(workspaceRunnerStats().entries.every(entry => entry.mode === 'read'));
  checks.push('image inspection resolves Compose variables using only the read helper');
  await writeFile(project.composeFiles[0], 'services: {}\n');
  await withRunner(project, async runner => {
    assert.notEqual(runner.id, original);
    assert.equal((await execInRunner(runner, ['docker', 'compose', '-f', project.composeFiles[0], 'config', '--quiet'])).code, 0);
    assert.equal((await execInRunner(runner, ['docker', 'version', '--format', '{{.Server.Version}}'])).code, 0);
  });
  checks.push('separate execution helper retains Compose and Docker daemon access');
  const file = project.composeFiles[0], changed = 'services: {}\n# saved\n', external = 'services: {}\n# external editor\n';
  await chmod(file, 0o640);
  await saveWorkspaceCompose(project, 0, changed, 'save', 'services: {}\n');
  assert.equal(await readFile(file, 'utf8'), changed); assert.equal((await stat(file)).mode & 0o777, 0o640);
  await withRunner(project, async runner => {
    const previous = await readArchiveFile(runner, file);
    await assert.rejects(replaceWorkspaceComposeFile(runner, file, 'services: {}\n# stale\n', previous, {
      beforeReplace: () => writeFile(file, external),
    }), { code: 'COMPOSE_VERSION_CONFLICT', writeApplied: false });
  });
  assert.equal(await readFile(file, 'utf8'), external);
  await withRunner(project, async runner => {
    const previous = await readArchiveFile(runner, file);
    await assert.rejects(replaceWorkspaceComposeFile(runner, file, changed, previous, {
      beforeReplace: () => chmod(file, 0o600),
    }), { code: 'COMPOSE_VERSION_CONFLICT', writeApplied: false });
  });
  assert.equal(await readFile(file, 'utf8'), external); assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readdir(root)).filter(name => name.startsWith('.composeops-') && name.endsWith('.tmp')).length, 0);
  setProjectPreference(project.id, { mountEnabled: false });
  await assert.rejects(saveWorkspaceCompose(project, 0, changed), { statusCode: 403 });
  checks.push('workspace Compose staging preserves mode, rejects external edits, removes temporary files and enforces live authorization');
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await closeAllWorkspaceRunners(); db.close(); await rm(root, { recursive: true, force: true });
}
