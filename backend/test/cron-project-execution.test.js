import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'cron-execution-'));
const log = path.join(root, 'calls.jsonl'), executable = path.join(root, 'compose-fixture');
await writeFile(executable, '#!' + process.execPath + '\n' + `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),host:process.env.DOCKER_HOST||''})+'\\n');`, { mode: 0o700 });
process.env.COMPOSE_BIN = executable;
const { getDockerForHost, setActiveHost, upsertHost, deleteHost } = await import('../src/services/docker-hosts.js');
const { scanProjects, invalidateScanCache } = await import('../src/services/scanner.js');
const { setProjectPreference } = await import('../src/lib/db.js');
const { createJob, runJobNow, deleteJob, listHistory } = await import('../src/services/cron-scheduler.js');
test.after(() => rm(root, { recursive: true, force: true }));

test('真实子进程调度只为已确认项目拉取，活动节点切换和其它项目不改变CLI参数', async t => {
  const rows = [];
  for (const name of ['selected', 'unrelated']) {
    const dir = path.join(root, name); await mkdir(dir); const compose = path.join(dir, 'compose.yml');
    await writeFile(compose, 'services: {}\n');
    rows.push({ Id: name, Names: ['/' + name], State: 'running', Labels: { 'com.docker.compose.project': name,
      'com.docker.compose.project.working_dir': dir, 'com.docker.compose.project.config_files': compose } });
  }
  t.mock.method(getDockerForHost('local'), 'listContainers', async () => rows);
  t.mock.method(getDockerForHost('local'), 'info', async () => ({ ID: 'fixed-engine' }));
  invalidateScanCache(); const projects = await scanProjects('local');
  for (const project of projects) setProjectPreference(project.id, { managed: true, mountEnabled: true });
  const project = projects.find(item => item.projectName === 'selected');
  const host = upsertHost({ name: '不应访问', type: 'tcp', host: '127.0.0.1', port: 9 });
  t.after(() => { setActiveHost('local'); deleteHost(host.id); invalidateScanCache(); });
  const remote = t.mock.method(getDockerForHost(host.id), 'listContainers', async () => { throw new Error('不应访问'); });
  const job = await createJob({ name: '仅拉取selected', type: 'pull-images', cron: '0 0 * * *', scope: 'project', hostId: 'local', projectId: project.id, enabled: false });
  t.after(() => deleteJob(job.id));
  setActiveHost(host.id); const result = await runJobNow(job.id);
  assert.equal(result.ok, true); assert.match(result.summary, /已拉取 1 个项目/);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { args: ['--project-name', 'selected', '-f', path.join(root, 'selected/compose.yml'), 'pull'], cwd: path.join(root, 'selected'), host: '' });
  assert.equal(remote.mock.callCount(), 0);
  assert.equal((await listHistory())[0].projectId, project.id);
});
