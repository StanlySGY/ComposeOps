import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'image-operation-'));
process.env.DB_PATH = path.join(root, 'state.db');
const cli = path.join(root, 'compose.mjs');
await writeFile(cli, `import { appendFileSync, readFileSync } from 'node:fs';
const args=process.argv.slice(2), file=args[args.indexOf('-f')+1];
if(args.includes('config')) console.log(readFileSync(file,'utf8'));
else { appendFileSync(file+'.calls',JSON.stringify(args)+'\\n'); console.log('compose command'); }
`);
process.env.COMPOSE_BIN = `${process.execPath} ${cli}`;
const { getActivityDocker } = await import('../src/services/docker-hosts.js');
const { setProjectPreference } = await import('../src/lib/db.js');
const { upgradeProject, clearImageUpdateCache } = await import('../src/services/image-updater.js');
const { withProjectOperationLock } = await import('../src/services/project-operation-lock.js');
const imageId = 'sha256:' + 'a'.repeat(64), remoteId = 'sha256:' + 'b'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const folder = await mkdtemp(path.join(root, 'project-')), file = path.join(folder, 'compose.json');
  await writeFile(file, JSON.stringify({ services: { app: { image: 'registry.example.com/test/app:latest' } } }));
  const project = { id: folder, projectName: 'execution', workingDir: folder, mounted: true, managed: true, editable: true, composeFiles: [file] };
  setProjectPreference(project.id, { managed: true, mountEnabled: true });
  const docker = getActivityDocker();
  t.mock.method(docker, 'listContainers', async () => [{ Id: 'app', ImageID: imageId, Labels: {
    'com.docker.compose.project': project.projectName, 'com.docker.compose.project.working_dir': folder, 'com.docker.compose.service': 'app',
  } }]);
  t.mock.method(docker, 'getImage', () => ({ inspect: async () => ({ Id: imageId, Os: 'linux', Architecture: 'amd64' }) }));
  t.mock.method(docker, 'getContainer', () => ({ inspect: async () => ({ State: { Status: 'running' } }) }));
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ config: { digest: imageId } }));
  clearImageUpdateCache(); t.after(clearImageUpdateCache);
  return { project, docker, request, file };
}
test('升级排队期间取消，不进入镜像预检或执行命令', async t => {
  const { project, docker } = await fixture(t), started = deferred(), release = deferred();
  const holding = withProjectOperationLock(project.id, async () => { started.resolve(); await release.promise; });
  await started.promise;
  const controller = new AbortController();
  const work = upgradeProject(project, { services: ['app'], signal: controller.signal });
  const rejected = assert.rejects(work, { name: 'AbortError' });
  controller.abort(); release.resolve(); await holding; await rejected;
  assert.equal(docker.listContainers.mock.callCount(), 0);
});
test('升级预检期间取消，迟到的仓库结果不能继续拉取', async t => {
  const { project, request, file } = await fixture(t), started = deferred(), release = deferred();
  request.mock.mockImplementation(async () => { started.resolve(); await release.promise; return Response.json({ config: { digest: imageId } }); });
  const controller = new AbortController();
  const work = upgradeProject(project, { services: ['app'], signal: controller.signal });
  const rejected = assert.rejects(work, { name: 'AbortError' });
  await started.promise; controller.abort(); release.resolve(); await rejected;
  await assert.rejects(readFile(file + '.calls'), { code: 'ENOENT' });
});
test('排队时撤销纳管，旧项目快照不能继续执行', async t => {
  const { project, docker } = await fixture(t), started = deferred(), release = deferred();
  const holding = withProjectOperationLock(project.id, async () => { started.resolve(); await release.promise; });
  await started.promise;
  const work = upgradeProject(project, { services: ['app'] });
  const rejected = assert.rejects(work, { statusCode: 403 });
  setProjectPreference(project.id, { managed: false }); release.resolve(); await holding; await rejected;
  assert.equal(docker.listContainers.mock.callCount(), 0);
});
test('拉取之后取消，不执行重建且不报告升级成功', async t => {
  const { project, request, file } = await fixture(t);
  request.mock.mockImplementation(async () => Response.json({ config: { digest: remoteId } }));
  const controller = new AbortController();
  await assert.rejects(upgradeProject(project, { services: ['app'], signal: controller.signal,
    onOutput: () => controller.abort(),
  }), { name: 'AbortError' });
  const calls = (await readFile(file + '.calls', 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1); assert.ok(calls[0].includes('pull'));
});
test('拉取期间撤销目录授权，不继续容器重建', async t => {
  const { project, request, file } = await fixture(t);
  request.mock.mockImplementation(async () => Response.json({ config: { digest: remoteId } }));
  await assert.rejects(upgradeProject(project, { services: ['app'],
    onOutput: () => setProjectPreference(project.id, { mountEnabled: false }),
  }), { statusCode: 403 });
  const calls = (await readFile(file + '.calls', 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1); assert.ok(calls[0].includes('pull'));
});
test('成功升级只返回备份文件身份，配置内容不会混入终帧', async t => {
  const { project, request } = await fixture(t);
  request.mock.mockImplementation(async () => Response.json({ config: { digest: remoteId } }));
  const result = await upgradeProject(project, { services: ['app'] });
  assert.equal(result.ok, true); assert.equal(result.health.ok, true);
  assert.deepEqual(result.backups, [{ file: project.composeFiles[0] }]);
  assert.doesNotMatch(JSON.stringify(result), /registry\.example\.com|"content"/);
});
test.after(async () => { (await import('../src/lib/db.js')).default.close(); await rm(root, { recursive: true, force: true }); });
