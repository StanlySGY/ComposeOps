import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-host-runtime-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
const { buildApp } = await import('../src/app.js');
const app = await buildApp({ logger: false });
test.after(async () => { await app.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

test('HTTP 节点切换: 旧 Docker 节点慢响应不混入新节点项目列表', async t => {
  const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { password: 'host-runtime-audit' } });
  assert.equal(setup.statusCode, 200);
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  async function api(url, payload, method = 'GET') {
    const response = await app.inject({ method, url: `/api/v1${url}`, payload, headers: { cookie } });
    assert.ok(response.statusCode < 300, response.body);
    return response.json();
  }
  let releaseOld;
  let oldStarted;
  const started = new Promise(resolve => { oldStarted = resolve; });
  async function node(name, slow = false) {
    const server = createServer((request, response) => {
      assert.match(request.url, /\/containers\/json/);
      const send = () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify([{ Id: name, Names: [`/${name}`], State: 'running', Labels: {
          'com.docker.compose.project': name,
          'com.docker.compose.project.working_dir': `/opt/${name}`,
        } }]));
      };
      if (slow) { releaseOld = send; oldStarted(); } else send();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const { host } = await api('/hosts', { name, type: 'tcp', host: '127.0.0.1', port: server.address().port }, 'POST');
    return host;
  }
  const first = await node('node-a', true);
  const second = await node('node-b');
  await api('/hosts/active', { hostId: first.id }, 'PUT');
  const old = api('/projects');
  await started;
  await api('/hosts/active', { hostId: second.id }, 'PUT');
  const current = await api('/projects');
  assert.equal(current.projects[0].projectName, 'node-b');
  assert.equal(current.projects[0].mountState, 'remote_api_only');
  assert.equal(current.projects[0].editable, false);
  releaseOld();
  assert.equal((await old).projects[0].projectName, 'node-a');
  assert.equal((await api('/projects')).projects[0].projectName, 'node-b');
  await api('/hosts/active', { hostId: 'local' }, 'PUT');
});
