import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeSourceDeployment } from '../src/services/source-deploy.js';

const project = {
  id: 'source-deploy-test',
  projectName: 'demo-stack',
  workingDir: '/srv/demo-stack',
  composeFiles: ['/srv/demo-stack/compose.yaml', '/srv/demo-stack/compose.prod.yaml'],
};
const beforeCommit = '1'.repeat(40);
const afterCommit = '2'.repeat(40);

function commandHarness(overrides = {}) {
  const calls = [];
  let statusChecks = 0;
  const runCommand = async (args, options) => {
    calls.push({ args, options });
    const joined = args.join(' ');
    if (joined.includes('rev-parse --show-prefix')) return { code: 0, stdout: overrides.repoPrefix ?? '', stderr: '' };
    if (joined.includes('branch --show-current')) return { code: 0, stdout: String(overrides.branch ?? 'main') + '\n', stderr: '' };
    if (joined.includes('symbolic-full-name')) return { code: overrides.upstreamCode ?? 0, stdout: String(overrides.upstream ?? 'origin/main') + '\n', stderr: '' };
    if (joined.includes('status --porcelain')) { statusChecks += 1; return { code: 0, stdout: (statusChecks > 1 ? overrides.postPullStatus : overrides.status) ?? '', stderr: '' }; }
    if (joined.includes('rev-parse HEAD')) return { code: 0, stdout: (calls.filter(call => call.args.join(' ').includes('rev-parse HEAD')).length === 1 ? beforeCommit : (overrides.afterCommit ?? afterCommit)) + '\n', stderr: '' };
    if (joined.includes('pull --ff-only')) return { code: overrides.pullCode ?? 0, stdout: 'Fast-forward\n', stderr: overrides.pullError || '' };
    if (joined.includes('compose') && joined.includes('config --quiet')) return { code: overrides.configCode ?? 0, stdout: '', stderr: overrides.configError || '' };
    if (joined.includes('compose') && joined.includes('up -d --build')) return { code: overrides.buildCode ?? 0, stdout: 'build complete\n', stderr: '' };
    throw new Error('Unexpected command: ' + joined);
  };
  return { calls, runCommand };
}

test('source deploy: clean tracked branch pulls fast-forward, validates config, then builds and starts', async () => {
  const { calls, runCommand } = commandHarness();
  const output = [];
  const result = await executeSourceDeployment(project, { runCommand, onOutput: (stream, chunk) => output.push([stream, chunk]) });
  assert.ok(calls.filter(call => call.args[0] === 'git').every(call => call.args[1] === '-c' && call.args[2] === 'safe.directory=/srv/demo-stack'));
  const commandLines = calls.map(call => call.args.join(' '));
  const pullIndex = commandLines.findIndex(command => command.includes('pull --ff-only'));
  const configIndex = commandLines.findIndex(command => command.includes('config --quiet'));
  const buildIndex = commandLines.findIndex(command => command.includes('up -d --build'));
  assert.ok(pullIndex > 0 && configIndex > pullIndex && buildIndex > configIndex);
  assert.deepEqual(result, { branch: 'main', upstream: 'origin/main', beforeCommit, afterCommit, updated: true });
  assert.ok(commandLines[configIndex].includes('--project-directory /srv/demo-stack'));
  assert.ok(commandLines[configIndex].includes('-f /srv/demo-stack/compose.yaml -f /srv/demo-stack/compose.prod.yaml'));
  assert.ok(commandLines[buildIndex].endsWith('up -d --build'));
  assert.ok(output.some(([, text]) => text.includes('请继续检查容器运行状态')));
  assert.ok(calls.some(call => call.options.timeoutMs === 15 * 60_000));
});

test('source deploy: refuses modified or untracked worktree before pulling', async () => {
  for (const status of [' M compose.yaml', '?? .env.local']) {
    const { calls, runCommand } = commandHarness({ status });
    await assert.rejects(executeSourceDeployment(project, { runCommand }), { code: 'SOURCE_DEPLOY_WORKTREE_DIRTY' });
    assert.equal(calls.some(call => call.args.includes('pull')), false);
    assert.equal(calls.some(call => call.args.includes('compose')), false);
  }
});

test('source deploy: refuses nested repository working directories before pulling', async () => {
  const nested = commandHarness({ repoPrefix: 'services/api/' });
  await assert.rejects(executeSourceDeployment(project, { runCommand: nested.runCommand }), { code: 'SOURCE_DEPLOY_REPOSITORY_ROOT_MISMATCH' });
  assert.equal(nested.calls.some(call => call.args.includes('pull')), false);
});

test('source deploy: refuses detached HEAD and missing upstream', async () => {
  const detached = commandHarness({ branch: '' });
  await assert.rejects(executeSourceDeployment(project, { runCommand: detached.runCommand }), { code: 'SOURCE_DEPLOY_DETACHED_HEAD' });
  assert.equal(detached.calls.some(call => call.args.includes('pull')), false);

  const noUpstream = commandHarness({ upstream: '', upstreamCode: 128 });
  await assert.rejects(executeSourceDeployment(project, { runCommand: noUpstream.runCommand }), { code: 'SOURCE_DEPLOY_NO_UPSTREAM' });
  assert.equal(noUpstream.calls.some(call => call.args.includes('pull')), false);
});

test('source deploy: post-pull hooks that dirty the worktree prevent Compose build', async () => {
  const { calls, runCommand } = commandHarness({ postPullStatus: ' M generated.env' });
  await assert.rejects(executeSourceDeployment(project, { runCommand }), { code: 'SOURCE_DEPLOY_POST_PULL_DIRTY' });
  assert.equal(calls.some(call => call.args.includes('compose')), false);
});

test('source deploy: pull failure never proceeds to Compose', async () => {
  const { calls, runCommand } = commandHarness({ pullCode: 1, pullError: 'Not possible to fast-forward' });
  await assert.rejects(executeSourceDeployment(project, { runCommand }), /拉取源码.*失败/);
  assert.equal(calls.some(call => call.args.includes('compose')), false);
});

test('source deploy: invalid Compose config never builds or starts containers', async () => {
  const { calls, runCommand } = commandHarness({ configCode: 1, configError: 'invalid compose file' });
  await assert.rejects(executeSourceDeployment(project, { runCommand }), /校验 Compose 配置失败/);
  assert.equal(calls.some(call => call.args.includes('up')), false);
});

test('source deploy: build failure is reported and does not retry automatically', async () => {
  const { calls, runCommand } = commandHarness({ buildCode: 17 });
  await assert.rejects(executeSourceDeployment(project, { runCommand }), /构建并启动服务 .*失败/);
  assert.equal(calls.filter(call => call.args.includes('up')).length, 1);
});
