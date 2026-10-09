import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listProjectEnvBackups, restoreProjectEnvBackup } from '../src/services/project-env-backups.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'composeops-env-backups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    project: { id: 'env-backup-' + path.basename(root), projectName: 'env-backup-test', workingDir: root, mounted: true, editable: true, managed: true },
  };
}

test('lists only regular backups for the selected env file and never returns contents', async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(path.join(root, '.env.backup.1000.abcdef'), 'SECRET_VALUE=do-not-return\n');
  await writeFile(path.join(root, '.env.backup.2000.abcdef'), 'APP_MODE=older\n');
  await writeFile(path.join(root, '.env.backup.3000.nothex'), 'ignored\n');
  await writeFile(path.join(root, 'other.env.backup.4000.abcdef'), 'other\n');
  const outside = path.join(root, 'outside');
  await writeFile(outside, 'outside\n');
  await symlink(outside, path.join(root, '.env.backup.5000.abcdef'));
  const result = await listProjectEnvBackups(project, '.env');
  assert.deepEqual(result.backups.map((item) => item.name), ['.env.backup.2000.abcdef', '.env.backup.1000.abcdef']);
  assert.equal(result.backups[0].size, Buffer.byteLength('APP_MODE=older\n'));
  assert.equal(JSON.stringify(result).includes('SECRET_VALUE'), false);
});

test('restores selected backup, retains it, and snapshots the current content', async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(path.join(root, '.env'), 'APP_MODE=current\n', { mode: 0o600 });
  const selected = '.env.backup.12345.abcdef';
  await writeFile(path.join(root, selected), 'APP_MODE=historical\n', { mode: 0o600 });
  const result = await restoreProjectEnvBackup(project, '.env', selected);
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'APP_MODE=historical\n');
  assert.equal(await readFile(path.join(root, selected), 'utf8'), 'APP_MODE=historical\n');
  assert.equal(await readFile(path.join(root, result.backup), 'utf8'), 'APP_MODE=current\n');
  assert.equal(result.restoredFrom, selected);
  assert.equal(result.ok, true);
});

test('rejects path traversal and symlink backups', async (t) => {
  const { root, project } = await fixture(t);
  await assert.rejects(restoreProjectEnvBackup(project, '.env', '../.env.backup.12345.abcdef'), (error) => error.code === 'ENV_BACKUP_INVALID' && error.statusCode === 400);
  const outside = path.join(root, 'outside');
  await writeFile(outside, 'APP_MODE=outside\n');
  await symlink(outside, path.join(root, '.env.backup.12345.abcdef'));
  await assert.rejects(restoreProjectEnvBackup(project, '.env', '.env.backup.12345.abcdef'), (error) => error.code === 'ENV_UNSAFE_BACKUP' && error.statusCode === 403);
  assert.equal(await readFile(outside, 'utf8'), 'APP_MODE=outside\n');
});

test('rejects missing and oversized backups', async (t) => {
  const { root, project } = await fixture(t);
  await assert.rejects(restoreProjectEnvBackup(project, '.env', '.env.backup.12345.abcdef'), (error) => error.code === 'ENV_BACKUP_NOT_FOUND' && error.statusCode === 404);
  await writeFile(path.join(root, '.env.backup.12345.abcdef'), 'X=' + 'a'.repeat(256 * 1024));
  await assert.rejects(restoreProjectEnvBackup(project, '.env', '.env.backup.12345.abcdef'), (error) => error.statusCode === 413);
});
