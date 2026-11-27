import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import projectRoutes from '../src/routes/projects.js';
import { scanProjects, invalidateScanCache } from '../src/services/scanner.js';
import { getDockerForHost } from '../src/services/docker-hosts.js';
import { setProjectPreference } from '../src/lib/db.js';

test('env API 保留版本字段、拒绝非法文件且不会落到主 .env，恢复也拒绝过期版本', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'composeops-env-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compose = path.join(root, 'compose.yml');
  await writeFile(compose, 'services: {}\n'); await writeFile(path.join(root, '.env'), 'MODE=main\n');
  t.mock.method(getDockerForHost('local'), 'listContainers', async () => [{ Id: 'env-api', Names: ['/env-api'], State: 'running', Status: 'Up', Labels: {
    'com.docker.compose.project': 'env-api', 'com.docker.compose.project.working_dir': root, 'com.docker.compose.project.config_files': compose,
  } }]);
  invalidateScanCache(); t.after(invalidateScanCache);
  const [project] = await scanProjects(); setProjectPreference(project.id, { managed: true, mountEnabled: true });
  const app = Fastify(); await app.register(projectRoutes, { prefix: '/projects' }); t.after(() => app.close());
  const endpoint = `/projects/${project.id}/env`;
  const initial = await app.inject({ url: endpoint + '?file=.env.production' });
  assert.equal(initial.statusCode, 200, initial.body); assert.equal(initial.json().exists, false);
  const save = await app.inject({ method: 'PUT', url: endpoint, payload: { file: '.env.production', raw: 'MODE=prod\n', expectedVersion: initial.json().version } });
  assert.equal(save.statusCode, 200, save.body);
  const stale = await app.inject({ method: 'PUT', url: endpoint, payload: { file: '.env.production', raw: 'MODE=stale\n', expectedVersion: initial.json().version } });
  assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'ENV_VERSION_CONFLICT');
  const invalid = await app.inject({ method: 'PUT', url: endpoint, payload: { file: '../invalid.env', raw: 'MODE=overwrite\n' } });
  assert.equal(invalid.statusCode, 400); assert.equal((await app.inject({ url: endpoint + '?file=invalid' })).statusCode, 400);
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'MODE=main\n');
  const restore = await app.inject({ method: 'POST', url: endpoint + '/backups/restore', payload: { file: '.env.production', backup: save.json().backup, expectedVersion: initial.json().version } });
  assert.equal(restore.statusCode, 409); assert.equal(restore.json().code, 'ENV_VERSION_CONFLICT');
  assert.equal(await readFile(path.join(root, '.env.production'), 'utf8'), 'MODE=prod\n');
  assert.equal((await readdir(root)).filter(n => n.includes('.backup.')).length, 1);
});
