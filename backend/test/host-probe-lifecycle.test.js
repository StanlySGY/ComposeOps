import './helpers/isolated-db.js';
import { issueSession as issueHealthSession } from '../src/lib/auth.js';
function healthHeaders() { let cookie; issueHealthSession({ header: (_name, value) => { cookie = value.split(';')[0]; } }); return { cookie }; }
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { upsertHost, deleteHost, getHost, listHosts, pingHost } from '../src/services/docker-hosts.js';

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = upsertHost({ name: 'probe lifecycle', type: 'tcp', host: '127.0.0.1', port: server.address().port });
  t.after(async () => { if (getHost(host.id)) deleteHost(host.id); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { host, server };
}
const healthy = (req, res) => {
  if (req.url.endsWith('/_ping')) return res.end('OK');
  res.setHeader('Content-Type', 'application/json');
  res.end(req.url.endsWith('/version') ? JSON.stringify({ Version: 'acceptance-engine' }) : JSON.stringify([{ State: 'running' }, { State: 'exited' }]));
};

test('node probe persists online and offline observations across list reloads, then clears recovered errors', async t => {
  let failed = false;
  const { host } = await fixture(t, (req, res) => {
    if (failed) { res.statusCode = 500; return res.end(JSON.stringify({ message: 'fixture offline' })); }
    healthy(req, res);
  });
  assert.equal((await pingHost(host.id)).ok, true);
  assert.equal(listHosts().find(row => row.id === host.id).status, 'online');
  assert.equal(getHost(host.id).containerCount, 2);
  assert.equal(getHost(host.id).runningCount, 1);
  failed = true;
  assert.equal((await pingHost(host.id)).ok, false);
  assert.equal(getHost(host.id).status, 'offline');
  assert.equal(getHost(host.id).containerCount, null);
  assert.match(getHost(host.id).error, /fixture offline/);
  failed = false;
  await pingHost(host.id);
  assert.equal(getHost(host.id).error, '');
});

test('hung node probe cancels its actual HTTP connection within the total deadline', async t => {
  let closed = false;
  const { host, server } = await fixture(t, req => req.on('close', () => { closed = true; }));
  // Safety timer makes the regression fail cleanly instead of hanging the test process.
  const rescue = setTimeout(() => server.closeAllConnections(), 1200);
  t.after(() => clearTimeout(rescue));
  const started = Date.now();
  const result = await pingHost(host.id, null, { timeoutMs: 80 });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 1000, 'probe must honor its deadline');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, true);
  assert.match(result.message, /超时/);
  assert.equal(result.containerCount, null);
});

test('probe completion preserves concurrent edits and never recreates a removed node', async t => {
  let release, began;
  let started = new Promise(resolve => { began = resolve; });
  const { host } = await fixture(t, (req, res) => {
    if (req.url.endsWith('/_ping')) { release = () => res.end('OK'); began(); }
    else healthy(req, res);
  });
  const first = pingHost(host.id);
  await started;
  upsertHost({ ...getHost(host.id), name: 'renamed during probe' });
  release(); await first;
  assert.equal(getHost(host.id).name, 'renamed during probe');
  assert.equal(getHost(host.id).status, 'online');
  started = new Promise(resolve => { began = resolve; });
  const next = pingHost(host.id); await started;
  upsertHost({ ...getHost(host.id), host: '127.0.0.2' });
  release(); await next;
  assert.equal(getHost(host.id).host, '127.0.0.2');
  assert.notEqual(getHost(host.id).status, 'online', 'connection edits must invalidate prior observations');
  upsertHost({ ...getHost(host.id), host: '127.0.0.1' });
  started = new Promise(resolve => { began = resolve; });
  const removed = pingHost(host.id); await started;
  deleteHost(host.id); release(); await removed;
  assert.equal(getHost(host.id), null);
});

test('older failed probe cannot overwrite a newer successful observation', async t => {
  let release, began, first = true;
  const started = new Promise(resolve => { began = resolve; });
  const { host } = await fixture(t, (req, res) => {
    if (first && req.url.endsWith('/_ping')) {
      first = false; began(); release = () => { res.statusCode = 500; res.end('{"message":"old failure"}'); };
    } else healthy(req, res);
  });
  const old = pingHost(host.id); await started;
  assert.equal((await pingHost(host.id)).ok, true);
  release(); await old;
  assert.equal(getHost(host.id).status, 'online');
  assert.equal(getHost(host.id).error, '');
});


test('platform health degrades for an unresponsive node and closes the probe socket', async t => {
  let closed = false;
  await fixture(t, req => req.on('close', () => { closed = true; }));
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp({ logger: false }); t.after(() => app.close());
  const response = await app.inject({ url: '/health', headers: await healthHeaders() });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().docker, 'degraded');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, true, 'timed-out health probes must not accumulate connections');
});


test('local node observations also reject an older failed probe', async t => {
  const { default: docker } = await import('../src/services/docker.js');
  const original = { ping: docker.ping, version: docker.version, listContainers: docker.listContainers };
  t.after(() => Object.assign(docker, original));
  let rejectOld, first = true;
  docker.ping = () => first ? (first = false, new Promise((_, reject) => { rejectOld = reject; })) : Promise.resolve('OK');
  docker.version = async () => ({ Version: 'test' }); docker.listContainers = async () => [];
  const old = pingHost('local'); await pingHost('local'); rejectOld(new Error('old local failure')); await old;
  assert.equal(getHost('local').status, 'online'); assert.equal(getHost('local').error, '');
});
