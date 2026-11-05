import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const tempDir = mkdtempSync(join(tmpdir(), 'composeops-gitops-e2e-'));
process.env.DB_PATH = join(tempDir, 'test.db');

const { addGitOpsRepo, deleteGitOpsRepo, getGitOpsHistory, listGitOpsRepos, rollbackGitOpsRepo, syncGitOpsRepo, updateGitOpsRepo } = await import('../src/services/gitops.js');

const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};

function git(args, cwd = tempDir) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

const httpRoot = join(tempDir, 'http-root');
const bareRepo = join(httpRoot, 'repo.git');
const seedRepo = join(tempDir, 'seed');
mkdirSync(httpRoot, { recursive: true });
git(['init', '--bare', '--initial-branch=main', bareRepo]);
git(['init', '--initial-branch=main', seedRepo]);
git(['config', 'user.name', 'ComposeOps Integration'], seedRepo);
git(['config', 'user.email', 'composeops-integration@example.invalid'], seedRepo);
writeFileSync(join(seedRepo, 'release.txt'), 'release-1\n');
git(['add', 'release.txt'], seedRepo);
git(['commit', '-m', 'release 1'], seedRepo);
git(['remote', 'add', 'origin', bareRepo], seedRepo);
git(['push', 'origin', 'main'], seedRepo);
git(['--git-dir', bareRepo, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
git(['--git-dir', bareRepo, 'update-server-info']);

let pendingInfoGate = null;
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (pendingInfoGate && pathname.endsWith('/info/refs')) {
    const gate = pendingInfoGate;
    pendingInfoGate = null;
    gate.requested.resolve();
    await gate.release.promise;
  }
  const filePath = resolve(httpRoot, '.' + pathname);
  if (filePath !== httpRoot && !filePath.startsWith(httpRoot + sep)) {
    response.writeHead(404).end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => response.writeHead(404).end());
  stream.pipe(response);
});

await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
const remoteUrl = 'http://127.0.0.1:' + address.port + '/repo.git';

function addTestRepo(suffix, branch = 'main') {
  return addGitOpsRepo({
    name: 'integration-' + suffix,
    url: remoteUrl,
    branch,
    localPath: join(tempDir, 'checkout-' + suffix),
    projectId: 'integration-' + suffix,
    autoSync: false,
  });
}

test.after(async () => {
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(tempDir, { recursive: true, force: true });
});

test('gitops integration: HTTP clone, no-op sync, remote commit sync and history', async () => {
  const repo = addTestRepo('clone-sync');
  const first = await syncGitOpsRepo(repo.id);
  assert.equal(first.ok, true);
  assert.equal(first.hasChanges, false, 'first clone establishes the baseline rather than reporting a new update');
  assert.equal(readFileSync(join(repo.localPath, 'release.txt'), 'utf8'), 'release-1\n');
  assert.equal(listGitOpsRepos().find((item) => item.id === repo.id).lastCommit, first.commit);

  const noChange = await syncGitOpsRepo(repo.id);
  assert.equal(noChange.hasChanges, false, 'syncing the same remote commit must not report an update');
  assert.equal(noChange.commit, first.commit);

  writeFileSync(join(seedRepo, 'release.txt'), 'release-2\n');
  writeFileSync(join(seedRepo, 'notes.txt'), 'new remote file\n');
  git(['add', 'release.txt', 'notes.txt'], seedRepo);
  git(['commit', '-m', 'release 2'], seedRepo);
  git(['push', 'origin', 'main'], seedRepo);
  git(['--git-dir', bareRepo, 'update-server-info']);

  const updated = await syncGitOpsRepo(repo.id);
  assert.equal(updated.hasChanges, true, 'new remote commit must be reported to the UI');
  assert.notEqual(updated.commit, first.commit);
  assert.equal(readFileSync(join(repo.localPath, 'release.txt'), 'utf8'), 'release-2\n');
  assert.equal(readFileSync(join(repo.localPath, 'notes.txt'), 'utf8'), 'new remote file\n');
  const history = await getGitOpsHistory(repo.id, 10);
  assert.equal(history.commits.length, 2);
  assert.equal(history.commits[0].hash, updated.commit);
  assert.equal(history.commits[0].message, 'release 2');
});

test('gitops integration: same-repository sync, rollback, update and delete are mutually exclusive', async () => {
  const repo = addTestRepo('locking');
  const requested = deferred();
  const release = deferred();
  pendingInfoGate = { requested, release };

  const firstSync = syncGitOpsRepo(repo.id);
  await requested.promise;
  await assert.rejects(syncGitOpsRepo(repo.id), (error) => error.statusCode === 409 && error.code === 'GITOPS_OPERATION_IN_PROGRESS');
  await assert.rejects(rollbackGitOpsRepo(repo.id, '0123456789012345678901234567890123456789'), (error) => error.statusCode === 409 && error.code === 'GITOPS_OPERATION_IN_PROGRESS');
  assert.throws(() => updateGitOpsRepo(repo.id, { name: 'raced-update' }), (error) => error.statusCode === 409 && error.code === 'GITOPS_OPERATION_IN_PROGRESS');
  assert.throws(() => deleteGitOpsRepo(repo.id), (error) => error.statusCode === 409 && error.code === 'GITOPS_OPERATION_IN_PROGRESS');
  const parallelRepo = addTestRepo('parallel-config-add');

  release.resolve();
  const result = await firstSync;
  assert.equal(result.ok, true);
  assert.equal(listGitOpsRepos().some((item) => item.id === repo.id), true);
  assert.equal(listGitOpsRepos().some((item) => item.id === parallelRepo.id), true, 'sync state write must preserve other repository configuration added in parallel');
});

test('gitops integration: sync reattaches the configured branch after branch changes and rollback', async () => {
  const repo = addTestRepo('branch-reattach', 'main');
  const initial = await syncGitOpsRepo(repo.id);
  const mainCommit = initial.commit;

  git(['checkout', '-b', 'release'], seedRepo);
  writeFileSync(join(seedRepo, 'release.txt'), 'release branch\n');
  git(['add', 'release.txt'], seedRepo);
  git(['commit', '-m', 'release branch'], seedRepo);
  git(['push', 'origin', 'release'], seedRepo);
  git(['--git-dir', bareRepo, 'update-server-info']);

  updateGitOpsRepo(repo.id, { branch: 'release' });
  const switched = await syncGitOpsRepo(repo.id);
  assert.equal(git(['symbolic-ref', '--short', 'HEAD'], repo.localPath), 'release', 'sync must switch the checkout to the configured branch, not only move the current branch pointer');
  assert.equal(readFileSync(join(repo.localPath, 'release.txt'), 'utf8'), 'release branch\n');

  await rollbackGitOpsRepo(repo.id, mainCommit);
  assert.equal(git(['rev-parse', 'HEAD'], repo.localPath), mainCommit);
  assert.throws(() => git(['symbolic-ref', '--short', 'HEAD'], repo.localPath), /detached|symbolic ref|not a symbolic ref/i);
  assert.equal(listGitOpsRepos().find((item) => item.id === repo.id).status, 'rolled_back', 'rollback must not be reported as a normal branch sync');

  const recovered = await syncGitOpsRepo(repo.id);
  assert.equal(recovered.commit, switched.commit);
  assert.equal(git(['symbolic-ref', '--short', 'HEAD'], repo.localPath), 'release', 'sync after rollback must reattach the configured branch');
  assert.equal(git(['rev-parse', 'HEAD'], repo.localPath), switched.commit);
  assert.equal(listGitOpsRepos().find((item) => item.id === repo.id).status, 'synced');
});

test('gitops integration: nonexistent branch leaves a clear error instead of a false synced state', async () => {
  const repo = addTestRepo('missing-branch', 'branch-that-does-not-exist');
  await assert.rejects(syncGitOpsRepo(repo.id), /Git 同步失败/);
  const saved = listGitOpsRepos().find((item) => item.id === repo.id);
  assert.equal(saved.status, 'error');
  assert.match(saved.lastError, /branch-that-does-not-exist|Remote branch/);
  assert.equal(existsSync(join(repo.localPath, '.git')), false);
});

