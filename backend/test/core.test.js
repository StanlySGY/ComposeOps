import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-test-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const auth = await import('../src/lib/auth.js');
const database = await import('../src/lib/db.js');
const { composeArgs, resolveProjectFile } = await import('../src/services/compose-runner.js');
const { parseYaml, validateYaml } = await import('../src/lib/files.js');
const { demuxStream } = await import('../src/lib/docker-streams.js');
const { buildMountPlan, compactMountPaths, safeProjectMountPath } = await import('../src/services/mount-plan.js');
const { runContainerAction, supportsContainerAction } = await import('../src/services/project-control.js');
const { assertProjectActionAllowed } = await import('../src/services/project-action-runner.js');

test('passwords are hashed and sessions are authenticated by cookie', () => {
  assert.throws(() => auth.setPassword('short'), /至少需要 10/);
  auth.setPassword('correct-horse-battery');
  assert.equal(auth.verifyPassword('correct-horse-battery'), true);
  assert.equal(auth.verifyPassword('wrong-password'), false);

  let cookie = '';
  auth.issueSession({ header(name, value) { if (name === 'Set-Cookie') cookie = value; } });
  assert.match(cookie, /HttpOnly/);
  // Lax:跨站写请求不带 Cookie(CSRF 面与 Strict 相同),同时外链跳转不丢会话;
  // SameSite=None 仅在 EMBED_MODE=1 且 HTTPS 时使用(见 auth.js)。
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(auth.isAuthenticated({ headers: { cookie: cookie.split(';')[0] } }), true);
  auth.changePassword('correct-horse-battery', 'new-correct-horse-battery');
  assert.equal(auth.isAuthenticated({ headers: { cookie: cookie.split(';')[0] } }), false);
  assert.equal(auth.verifyPassword('new-correct-horse-battery'), true);
});

test('compose actions map to fixed argument lists', () => {
  const project = { composeFiles: ['/srv/app/compose.yml', '/srv/app/compose.prod.yml'] };
  assert.deepEqual(composeArgs(project, 'up'), [
    'compose', '-f', '/srv/app/compose.yml', '-f', '/srv/app/compose.prod.yml', 'up', '-d',
  ]);
  assert.deepEqual(composeArgs(project, 'restart'), [
    'compose', '-f', '/srv/app/compose.yml', '-f', '/srv/app/compose.prod.yml', 'restart',
  ]);
  assert.deepEqual(composeArgs(project, 'stop'), [
    'compose', '-f', '/srv/app/compose.yml', '-f', '/srv/app/compose.prod.yml', 'stop',
  ]);
  assert.throws(() => composeArgs(project, 'exec'), /不支持/);
  assert.throws(
    () => assertProjectActionAllowed({ managed: true, mountEnabled: true, editable: true }, 'exec'),
    (error) => error.statusCode === 400 && /不支持/.test(error.message)
  );
});

test('managed projects can control existing containers without Compose files', async () => {
  const calls = [];
  const fakeDocker = {
    getContainer(id) {
      return {
        async start() { calls.push(`start:${id}`); },
        async restart() { calls.push(`restart:${id}`); },
        async stop() { calls.push(`stop:${id}`); },
        async inspect() { return { State: { Status: id === 'one' ? 'running' : 'exited' } }; },
      };
    },
  };
  const project = { containers: [
    { id: 'one', name: 'web', state: 'running', image: 'nginx' },
    { id: 'two', name: 'worker', state: 'exited', image: 'worker' },
  ] };
  const output = [];
  assert.equal(supportsContainerAction('pull'), false);
  assert.equal(await runContainerAction(project, 'up', (type, value) => output.push([type, value]), fakeDocker), 0);
  assert.deepEqual(calls, ['start:two']);
  assert.match(output.map((item) => item[1]).join(''), /web: 当前状态 running，无需启动/);
  await runContainerAction(project, 'restart', () => {}, fakeDocker);
  assert.deepEqual(calls.slice(1), ['restart:one', 'start:two']);
  await assert.rejects(runContainerAction(project, 'pull', () => {}, fakeDocker), /需要挂载/);
});

test('project file validation rejects symlinks escaping the project root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-root-'));
  const outside = path.join(tempDir, 'outside.yml');
  fs.writeFileSync(outside, 'services: {}\n');
  const linked = path.join(root, 'compose.yml');
  fs.symlinkSync(outside, linked);
  await assert.rejects(
    resolveProjectFile({ workingDir: root, composeFiles: [linked] }, 0),
    /不在项目目录内/
  );
});

test('exports and imports exclude credentials', () => {
  database.setSetting('ai.api_key', 'secret-key');
  database.setSetting('notifications.config', JSON.stringify({ token: 'secret-token' }));
  database.setSetting('ai.model', 'model-a');
  const exported = database.exportUserData();
  assert.equal(exported.settings['ai.api_key'], undefined);
  assert.equal(exported.settings['notifications.config'], undefined);
  database.importUserData({ settings: { 'ai.model': 'model-b', 'auth.password_hash': 'bad' } });
  assert.equal(database.getSetting('ai.model'), 'model-b');
  assert.notEqual(database.getSetting('auth.password_hash'), 'bad');
});

test('project activity only returns operations for the selected project', () => {
  database.addOperation({ projectId: 'activity-a', projectName: 'alpha', action: 'compose.save', status: 'success' });
  database.addOperation({ projectId: 'activity-b', projectName: 'beta', action: 'compose.stop', status: 'failed' });
  database.addOperation({ projectId: 'activity-a', projectName: 'alpha', action: 'compose.restart', status: 'success' });
  const operations = database.listProjectOperations('activity-a', 10);
  assert.deepEqual(operations.map((item) => item.action), ['compose.restart', 'compose.save']);
  assert.ok(operations.every((item) => item.projectId === 'activity-a'));
});

test('background jobs persist structured project progress', () => {
  const created = database.createBackgroundJob({ id: 'job-test', type: 'project.batch', action: 'restart', projects: [
    { id: 'project-one', projectName: 'one' },
    { id: 'project-two', projectName: 'two' },
  ] });
  assert.equal(created.status, 'queued');
  assert.equal(created.items.length, 2);
  database.updateBackgroundJob('job-test', 'running', 0);
  database.updateBackgroundJobItem(created.items[0].id, { status: 'success', output: 'done', exitCode: 0 });
  database.updateBackgroundJob('job-test', 'running', 1);
  const running = database.getBackgroundJob('job-test');
  assert.equal(running.completed, 1);
  assert.equal(running.items[0].status, 'success');
  assert.equal(running.items[0].output, 'done');
  assert.equal(database.listBackgroundJobs().some((job) => job.id === 'job-test'), true);
  database.interruptRunningBackgroundJobs();
  assert.equal(database.getBackgroundJob('job-test').status, 'interrupted');
  assert.equal(database.getBackgroundJob('job-test').items[1].status, 'interrupted');
});

test('project management is explicit and can be updated as a discovered allowlist', () => {
  assert.equal(database.getProjectPreference('new-project').managed, 0);
  database.setProjectPreference('project-a', { managed: true, favorite: true, note: 'primary' });
  database.setProjectPreference('vanished-project', { managed: true });
  assert.deepEqual(database.getProjectPreference('project-a'), { managed: 1, favorite: 1, note: 'primary' });
  database.setProjectManagement(['project-a', 'project-b'], ['project-b']);
  assert.equal(database.getProjectPreference('project-a').managed, 0);
  assert.equal(database.getProjectPreference('project-b').managed, 1);
  assert.equal(database.getProjectMountEnabled('project-b'), false);
  database.setProjectManagement(['project-a', 'project-b'], ['project-b'], ['project-b']);
  assert.equal(database.getProjectMountEnabled('project-b'), true);
  assert.equal(database.exportUserData().projectPreferences.find((item) => item.projectId === 'project-b').managed, 1);
  database.setProjectManagement(['project-a', 'project-b'], [], ['project-b']);
  assert.equal(database.getProjectMountEnabled('project-b'), false);
  assert.equal(database.getProjectPreference('vanished-project').managed, 0);
});

test('YAML validation rejects malformed documents', () => {
  assert.deepEqual(parseYaml('services:\n  web:\n    image: nginx\n'), { services: { web: { image: 'nginx' } } });
  assert.equal(validateYaml('services: {}\n'), true);
  assert.throws(() => validateYaml('services: [\n'), /flow sequence|YAML/i);
});

test('Docker multiplexed streams survive fragmented frames', async () => {
  const demux = demuxStream();
  const stdout = [];
  const stderr = [];
  demux.stdout.on('data', (chunk) => stdout.push(chunk));
  demux.stderr.on('data', (chunk) => stderr.push(chunk));

  function frame(type, text) {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }
  const input = Buffer.concat([frame(1, 'hello'), frame(2, 'failure')]);
  demux.write(input.subarray(0, 3));
  demux.write(input.subarray(3, 12));
  demux.end(input.subarray(12));
  await Promise.all([
    new Promise((resolve) => demux.stdout.on('end', resolve)),
    new Promise((resolve) => demux.stderr.on('end', resolve)),
  ]);
  assert.equal(Buffer.concat(stdout).toString(), 'hello');
  assert.equal(Buffer.concat(stderr).toString(), 'failure');
});

test('mount plan deduplicates exact paths without broadening permissions', () => {
  assert.equal(safeProjectMountPath('/'), null);
  assert.equal(safeProjectMountPath('/home/user'), null);
  assert.equal(safeProjectMountPath('/home/user/services/app'), '/home/user/services/app');
  assert.deepEqual(compactMountPaths([
    '/srv/compose/app-a',
    '/srv/compose/app-a/worker',
    '/opt/app-b',
    '/opt/app-b',
    'relative/path',
  ]), ['/opt/app-b', '/srv/compose/app-a']);

  const projects = [
    { id: 'a', projectName: 'app-a', owner: 'Personal', workingDir: '/srv/compose/app-a', composeFiles: ['/srv/compose/app-a/compose.yml'], managed: true, mounted: false, editable: false, mountState: 'directory_unreachable', containers: [{}] },
    { id: 'b', projectName: 'app-b', owner: 'Personal', workingDir: '/srv/compose/app-b', composeFiles: ['/srv/compose/app-b/compose.yml'], managed: true, mounted: false, editable: false, mountState: 'directory_unreachable', containers: [{}] },
    { id: 'c', projectName: 'ready', owner: 'Personal', workingDir: '/srv/compose/ready', composeFiles: ['/srv/compose/ready/compose.yml'], managed: true, mounted: true, editable: true, mountState: 'ready', containers: [{}] },
    { id: 'd', projectName: 'legacy', owner: 'Personal', workingDir: '', composeFiles: [], managed: true, mounted: false, editable: false, mountState: 'metadata_missing', containers: [] },
    { id: 'e', projectName: 'stale', owner: 'Personal', workingDir: '/srv/stale', composeFiles: ['/srv/stale/missing.yml'], managed: true, mounted: false, editable: false, mountState: 'compose_files_unreachable', containers: [] },
    { id: 'f', projectName: 'unmanaged', owner: 'Personal', workingDir: '/srv/unmanaged', composeFiles: ['/srv/unmanaged/compose.yml'], managed: false, mounted: false, editable: false, mountState: 'directory_unreachable', containers: [] },
    { id: 'g', projectName: 'container-only', owner: 'Personal', workingDir: '/srv/container-only', composeFiles: ['/srv/container-only/compose.yml'], managed: true, mountEnabled: false, mounted: false, editable: false, mountState: 'directory_unreachable', containers: [] },
  ];
  const plan = buildMountPlan(projects);
  assert.deepEqual(plan.summary, { total: 7, managed: 6, operable: 1, unmanaged: 1, pending: 3, unsupported: 1 });
  assert.equal(plan.projects.find((item) => item.id === 'f').managed, false);
  assert.deepEqual(plan.mounts.map((item) => item.path), ['/srv/stale', '/srv/compose/app-a', '/srv/compose/app-b']);
  assert.doesNotMatch(plan.composeSnippet, /unmanaged/);
  assert.doesNotMatch(plan.composeSnippet, /container-only/);
  assert.equal(plan.parentSuggestions[0].path, '/srv/compose');
  assert.match(plan.composeSnippet, /source: "\/srv\/compose\/app-a"/);
  assert.doesNotMatch(plan.composeSnippet, /source: "\/srv\/compose"\n/);
  assert.equal(plan.recreateCommand, 'docker compose up -d --force-recreate opsdash');
});
