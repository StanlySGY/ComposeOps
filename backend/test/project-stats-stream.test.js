import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setProjectPreference } from '../src/lib/db.js';
import projectsRoutes from '../src/routes/projects.js';
import { getDockerForHost, setActiveHost } from '../src/services/docker-hosts.js';
import { invalidateScanCache, scanProjects } from '../src/services/scanner.js';

let route;
await projectsRoutes({ get() {}, put() {}, patch() {}, delete() {}, post(url, options, handler) { if (url === '/stats/stream') route = handler; } });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Output extends EventEmitter {
  constructor(blocked = false) { super(); this.blocked = blocked; this.frames = []; this.destroyed = false; this.writableEnded = false; this.headersFlushed = false; }
  writeHead() {}
  flushHeaders() { this.headersFlushed = true; }
  write(frame) { this.frames.push(frame); return !this.blocked; }
  end() { if (this.writableEnded) return; this.writableEnded = true; this.emit('finish'); this.emit('close'); }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); }
}
async function fixture(t, listContainers, ids = ['missing'], blocked = false) {
  setActiveHost('local'); invalidateScanCache();
  t.mock.method(getDockerForHost('local'), 'listContainers', listContainers);
  const raw = new Output(blocked);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => { raw.destroy(); t.mock.timers.reset(); invalidateScanCache(); });
  await route({ body: { projectIds: ids, interval: 1000 } }, { raw });
  return raw;
}

test('项目指标流立即刷新响应头，慢扫描期间发送心跳且关闭后停止', async t => {
  const raw = await fixture(t, () => new Promise(() => {}));
  assert.equal(raw.headersFlushed, true);
  t.mock.timers.tick(15_001); await settle();
  assert.ok(raw.frames.some(frame => frame.includes('heartbeat')));
  raw.destroy(); const count = raw.frames.length;
  t.mock.timers.tick(120_000); await settle();
  assert.equal(raw.frames.length, count);
});

test('指标客户端持续不读取时，队列有界并关闭该连接', async t => {
  const ids = Array.from({ length: 1000 }, (_, index) => 'missing-project-' + index);
  const raw = await fixture(t, async () => [], ids, true);
  for (let i = 0; i < 15; i++) { await settle(); t.mock.timers.tick(1001); }
  await settle();
  assert.equal(raw.destroyed, true);
  assert.equal(raw.frames.length, 1);
});


test('关闭项目指标流时取消在途 Docker 采样，迟到结果不再写入', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'composeops-stats-stream-')), file = path.join(root, 'compose.yml');
  await writeFile(file, 'services: {}\n'); t.after(() => rm(root, { recursive: true, force: true }));
  const docker = getDockerForHost('local');
  const rows = [{ Id: 'stats-container', Names: ['/stats-container'], State: 'running', Labels: {
    'com.docker.compose.project': path.basename(root), 'com.docker.compose.project.working_dir': root, 'com.docker.compose.project.config_files': file,
  } }];
  t.mock.method(docker, 'listContainers', async () => rows);
  invalidateScanCache(); const [project] = await scanProjects('local'); setProjectPreference(project.id, { managed: true });
  let signal, release;
  t.mock.method(docker, 'getContainer', () => ({ stats: ({ abortSignal }) => { signal = abortSignal; return new Promise(resolve => { release = resolve; }); } }));
  const raw = await fixture(t, async () => rows, [project.id]);
  for (let i = 0; i < 20 && !signal; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(signal); raw.destroy();
  assert.equal(signal.aborted, true);
  const count = raw.frames.length;
  release({}); await settle(); t.mock.timers.tick(60_001); await settle();
  assert.equal(raw.frames.length, count);
});
