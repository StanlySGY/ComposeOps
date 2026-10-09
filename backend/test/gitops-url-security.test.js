import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const tempDir = mkdtempSync(join(tmpdir(), 'composeops-gitops-url-'));
process.env.DB_PATH = join(tempDir, 'test.db');
const { addGitOpsRepo } = await import('../src/services/gitops.js');

test.after(() => rmSync(tempDir, { recursive: true, force: true }));

for (const url of [
  'https://alice:secret@example.com/team/repo.git',
  'http://token@example.com/team/repo.git',
  'https://alice%40example.com:secret@example.com/team/repo.git',
  'ssh://git:secret@example.com/team/repo.git',
]) {
  test('gitops URL security rejects embedded HTTP credentials: ' + url.split('@').at(-1), () => {
    assert.throws(
      () => addGitOpsRepo({ name: 'credential-test', url, localPath: join(tempDir, 'repo'), projectId: 'p' }),
      (error) => error.statusCode === 400 && /不允许包含用户名或密码/.test(error.message),
    );
  });
}

test('gitops URL security accepts credential-free HTTPS and standard SSH URLs', () => {
  const httpsRepo = addGitOpsRepo({ name: 'https-ok', url: 'https://example.com/team/repo.git', localPath: join(tempDir, 'https'), projectId: 'p' });
  const sshRepo = addGitOpsRepo({ name: 'ssh-ok', url: 'git@example.com:team/repo.git', localPath: join(tempDir, 'ssh'), projectId: 'p' });
  const sshUrlRepo = addGitOpsRepo({ name: 'ssh-url-ok', url: 'ssh://git@example.com/team/repo.git', localPath: join(tempDir, 'ssh-url'), projectId: 'p' });
  assert.equal(httpsRepo.url, 'https://example.com/team/repo.git');
  assert.equal(sshRepo.url, 'git@example.com:team/repo.git');
  assert.equal(sshUrlRepo.url, 'ssh://git@example.com/team/repo.git');
});
