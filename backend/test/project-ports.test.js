import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPorts, extractHostPorts, scanProjectWebPorts, buildWebUiLinks } from '../src/services/project-ports.js';

test('each app retains typical and custom ports with IPv4/IPv6 deduplicated', () => {
  const entries = scanProjectWebPorts({ containers: [
    { id: 'a', name: 'frontend-1', service: 'frontend', state: 'running', ports: [{ public: 8080, private: 80 }, { public: 18081, private: 8081 }, { public: 8080, private: 80 }] },
    { id: 'b', name: 'sync-1', service: 'sync', state: 'running', ports: [{ public: 5244, private: 5244 }] },
  ] });
  assert.deepEqual(entries.map(entry => [entry.containerId, entry.serviceName, entry.ports]), [['a', 'frontend', [8080, 18081]], ['b', 'sync', [5244]]]);
});

test('remapped database ports and UDP do not become HTTP links; web mapping may use a data-like host port', () => {
  const { candidates } = classifyPorts({ ports: [{ public: 15432, private: 5432 }, { public: 9000, private: 9000, type: 'udp' }, { public: 3306, private: 80 }] });
  assert.deepEqual(candidates, [3306]);
});

test('HTTPS uses container target 443 and IPv6 addresses stay bracketed', () => {
  const entries = scanProjectWebPorts({ containers: [{ id: 'a', name: 'app', state: 'running', ports: [{ public: 18443, private: 443 }] }] });
  assert.equal(buildWebUiLinks('[::1]:3001', entries)[0].ports[0].url, 'https://[::1]:18443');
  assert.equal(buildWebUiLinks('nas.example:28765', entries)[0].ports[0].url, 'https://nas.example:18443');
});

test('stopped and unmapped services never get invented links', () => {
  assert.deepEqual(scanProjectWebPorts({ containers: [
    { id: 'stopped', state: 'exited', ports: [{ public: 8080, private: 80 }] },
    { id: 'host', state: 'running', networkMode: 'host', ports: [] },
  ] }), []);
});

test('host network uses declared TCP ports without pretending they are published mappings', () => {
  const entries = scanProjectWebPorts({ containers: [{ id: 'sync', name: 'tao-sync', state: 'running', networkMode: 'host', ports: [],
    hostPorts: [{ port: 8023, type: 'tcp' }, { port: 8023, type: 'udp' }] }] });
  const links = buildWebUiLinks('nas.example:28765', entries);
  assert.equal(links[0].source, 'host-exposed');
  assert.deepEqual(links[0].ports, [{ port: 8023, url: 'http://nas.example:8023' }]);
});

test('host network without EXPOSE uses explicit web configuration and creates the optimizer entry', () => {
  const hostPorts = extractHostPorts({ Config: { Env: ['WEB_PORT=18846', 'PASSWORD=do-not-return', 'PROXY_PORT=19800'] } });
  assert.deepEqual(hostPorts, [{ port: 18846, type: 'tcp', source: 'environment', scheme: 'http' }]);
  const entries = scanProjectWebPorts({ containers: [{ id: 'optimizer', name: 'optimizer-1', service: 'optimizer', state: 'running', networkMode: 'host', ports: [], hostPorts }] });
  const links = buildWebUiLinks('nas.example:28765', entries);
  assert.equal(links[0].source, 'host-environment');
  assert.deepEqual(links[0].ports, [{ port: 18846, url: 'http://nas.example:18846' }]);
  assert.equal(JSON.stringify(links).includes('do-not-return'), false);
});

test('host web configuration accepts valid local port numbers only and keeps HTTPS scheme', () => {
  const hostPorts = extractHostPorts({ Config: { Env: [
    'WEB_PORT=0', 'WEBUI_PORT=65536', 'WEB_UI_PORT=http://example.test:8080', 'HTTP_PORT= 18080 ', 'HTTPS_PORT=18443',
    'PORT=8123', 'DATABASE_PORT=5432', 'REMOTE_PORT=9000', 'API_TOKEN=never-expose', 'bad-entry', null,
  ] } });
  assert.deepEqual(hostPorts, [
    { port: 18080, type: 'tcp', source: 'environment', scheme: 'http' },
    { port: 18443, type: 'tcp', source: 'environment', scheme: 'https' },
  ]);
  const links = buildWebUiLinks('nas.example', scanProjectWebPorts({ containers: [{ id: 'a', state: 'running', networkMode: 'host', hostPorts }] }));
  assert.deepEqual(links[0].ports, [{ port: 18080, url: 'http://nas.example:18080' }, { port: 18443, url: 'https://nas.example:18443' }]);
});

test('EXPOSE TCP remains authoritative; UDP declarations do not hide the web fallback', () => {
  assert.deepEqual(extractHostPorts({ Config: { ExposedPorts: { '8023/tcp': {} }, Env: ['WEB_PORT=18846'] } }), [{ port: 8023, type: 'tcp' }]);
  assert.deepEqual(extractHostPorts({ Config: { ExposedPorts: { '53/udp': {} }, Env: ['WEB_PORT=18846', 'HTTP_PORT=18846'] } }), [
    { port: 53, type: 'udp' }, { port: 18846, type: 'tcp', source: 'environment', scheme: 'http' },
  ]);
});

test('invalid or absent web port configuration never invents a host port', () => {
  for (const value of ['-80', '1e3', '80/tcp', '80,443', '${WEB_PORT}', '1.5']) {
    assert.deepEqual(extractHostPorts({ Config: { Env: [`WEB_PORT=${value}`] } }), []);
  }
  assert.deepEqual(extractHostPorts(), []);
});
