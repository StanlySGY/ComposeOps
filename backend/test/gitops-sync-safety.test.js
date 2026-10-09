import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const tempDir = mkdtempSync(join(tmpdir(), 'composeops-gitops-sync-'));
process.env.DB_PATH = join(tempDir, 'test.db');
const { setSetting, getSetting } = await import('../src/lib/db.js');
const { syncGitOpsRepo, rollbackGitOpsRepo } = await import('../src/services/gitops.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}
function makeRepo(options = {}) {
  const originUrl = options.originUrl || 'https://example.com/team/repo.git';
  const dir = mkdtempSync(join(tempDir, 'repo-'));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'ComposeOps Test'], dir);
  writeFileSync(join(dir, 'tracked.txt'), 'committed content\n');
  git(['add', 'tracked.txt'], dir);
  git(['commit', '-m', 'initial'], dir);
  git(['remote', 'add', 'origin', originUrl], dir);
  if (options.dirty) writeFileSync(join(dir, 'tracked.txt'), 'local uncommitted content\n');
  return dir;
}
function configureRepo(localPath, url = 'https://example.com/team/repo.git') {
  setSetting('gitops.repositories', JSON.stringify([{ id: 'test-repo', name: 'test-repo', url, branch: 'main', localPath, projectId: 'p', sshKey: null, status: 'pending' }]));
}

test.after(() => rmSync(tempDir, { recursive: true, force: true }));

test('gitops sync safety: refuses reset when local origin differs from configured URL', async () => {
  const localPath = makeRepo({ originUrl: 'https://example.com/other/repo.git' });
  configureRepo(localPath);
  const before = readFileSync(join(localPath, 'tracked.txt'), 'utf8');
  await assert.rejects(syncGitOpsRepo('test-repo'), /origin 与配置的仓库 URL 不一致/);
  assert.equal(readFileSync(join(localPath, 'tracked.txt'), 'utf8'), before);
  assert.equal(JSON.parse(getSetting('gitops.repositories', '[]'))[0].status, 'error');
});

test('gitops sync safety: refuses reset --hard when tracked files have local changes', async () => {
  const localPath = makeRepo({ dirty: true });
  configureRepo(localPath);
  const before = readFileSync(join(localPath, 'tracked.txt'), 'utf8');
  await assert.rejects(syncGitOpsRepo('test-repo'), /存在未提交的已跟踪文件改动/);
  assert.equal(readFileSync(join(localPath, 'tracked.txt'), 'utf8'), before);
});

test('gitops rollback safety: refuses to operate on a repository with a different origin', async () => {
  const localPath = makeRepo({ originUrl: 'https://example.com/unrelated/repo.git' });
  configureRepo(localPath);
  const before = readFileSync(join(localPath, 'tracked.txt'), 'utf8');
  await assert.rejects(rollbackGitOpsRepo('test-repo', '1234567890123456789012345678901234567890'), /origin 与配置的仓库 URL 不一致/);
  assert.equal(readFileSync(join(localPath, 'tracked.txt'), 'utf8'), before);
});

test('gitops rollback safety: refuses to discard tracked local edits', async () => {
  const localPath = makeRepo({ dirty: true });
  configureRepo(localPath);
  const before = readFileSync(join(localPath, 'tracked.txt'), 'utf8');
  await assert.rejects(rollbackGitOpsRepo('test-repo', '1234567890123456789012345678901234567890'), /存在未提交的已跟踪文件改动/);
  assert.equal(readFileSync(join(localPath, 'tracked.txt'), 'utf8'), before);
});
