import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import './helpers/isolated-db.js';
import { upsertHost, deleteHost, setActiveHost } from '../src/services/docker-hosts.js';
import { scanProjects, invalidateScanCache } from '../src/services/scanner.js';
import { setProjectPreference } from '../src/lib/db.js';
import { buildRuntimeSnapshot, invalidateRuntimeSnapshot } from '../src/services/runtime-context.js';

async function node(t, name) {
  let hold = null;
  const server = createServer((req, res) => {
    const respond = () => res.end(JSON.stringify([0, 1].map(i => ({
      Id: name + i, Names: ['/' + name + i], State: 'running', Image: 'fixture',
      Labels: { 'com.docker.compose.project': name + i },
    }))));
    if (hold) hold(respond); else respond();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = upsertHost({ name, type: 'tcp', host: '127.0.0.1', port: server.address().port });
  t.after(async () => { setActiveHost('local'); deleteHost(host.id); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); invalidateRuntimeSnapshot(); });
  for (const project of await scanProjects(host.id)) setProjectPreference(project.id, { managed: true });
  return { host, hold: callback => { hold = callback; } };
}

test('AI snapshot follows node selection, latest management permission and per-call project limit', async t => {
  const a = await node(t, 'snapshot-a'); const b = await node(t, 'snapshot-b');
  setActiveHost(a.host.id); const first = await buildRuntimeSnapshot();
  assert.match(first, /snapshot-a0/); assert.match(first, /snapshot-a1/);
  setActiveHost(b.host.id); const second = await buildRuntimeSnapshot({ maxProjects: 1 });
  assert.match(second, /snapshot-b0/); assert.doesNotMatch(second, /snapshot-a|snapshot-b1/);
  for (const project of await scanProjects(b.host.id)) setProjectPreference(project.id, { managed: false });
  const revoked = await buildRuntimeSnapshot();
  assert.match(revoked, /纳管项目 0 个/); assert.doesNotMatch(revoked, /snapshot-b0/);
});

test('AI snapshot discards a scan finishing after a node switch instead of mixing host and projects', async t => {
  const a = await node(t, 'delayed-a'); const b = await node(t, 'delayed-b');
  let release, began; const started = new Promise(resolve => { began = resolve; });
  a.hold(respond => { release = respond; began(); });
  setActiveHost(a.host.id); invalidateScanCache(); invalidateRuntimeSnapshot();
  const pending = buildRuntimeSnapshot(); await started; setActiveHost(b.host.id); release();
  assert.equal(await pending, '');
  assert.doesNotMatch(await buildRuntimeSnapshot(), /delayed-a/);
});
